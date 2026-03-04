/**
 * session-manager/src/services/packageManager.js
 *
 * Package Lifecycle Service
 *
 * Manages the full lifecycle of buyer session packages:
 *   - Creation with correct quotas based on tier
 *   - Consumption of sessions and req/res credits
 *   - Quota status queries
 *   - Expiry enforcement
 *
 * This module wraps the raw SQLite operations from store.js with business
 * logic: quota validation, expiry calculation, and tier enforcement.
 *
 * Why a service layer instead of calling store.js directly from routes?
 *   The routes validate HTTP input; the service validates business rules.
 *   This separation means we can call packageManager from WebSocket handlers
 *   and the internal validate route without duplicating the business logic.
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  createPackage: dbCreatePackage,
  getPackage,
  getBuyerPackages,
  decrementPackageSessions,
  decrementPackageReqRes,
} = require('../db/store');

// Package validity duration: 30 days from purchase
const PACKAGE_VALIDITY_DAYS = 30;

// ─── createPackage ────────────────────────────────────────────────────────
/**
 * Create a new package for a buyer.
 *
 * @param {string} buyerId - Buyer's user ID
 * @param {string} tier - 'scout'|'recon'|'breach'|'siege'
 * @param {object} tierDef - { sessions, reqRes, price, rateLimit }
 * @param {string} paymentRef - Payment processor reference (Stripe intent ID, etc.)
 * @returns {object} The created package record
 */
async function createPackage(buyerId, tier, tierDef, paymentRef = null) {
  const id = `pkg_${uuidv4().replace(/-/g, '')}`;

  // Calculate expiry: 30 days from now
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + PACKAGE_VALIDITY_DAYS);

  const pkg = {
    id,
    buyer_id: buyerId,
    tier,
    sessions_total: tierDef.sessions,
    sessions_remaining: tierDef.sessions,
    req_res_total: tierDef.reqRes,
    req_res_remaining: tierDef.reqRes,
    purchased_at: new Date().toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  dbCreatePackage(pkg);

  console.log(`[packageManager] Created package ${id} — tier=${tier} buyer=${buyerId} expires=${expiresAt.toISOString()}`);

  return pkg;
}

// ─── consumeSession ───────────────────────────────────────────────────────
/**
 * Decrement the session counter when a buyer claims a session from a package.
 *
 * Returns the remaining session count after decrement, or -1 if the package
 * has no sessions remaining (caller should prevent this happening via pre-check).
 *
 * @param {string} packageId
 * @returns {number} sessions remaining after decrement, or -1 on failure
 */
function consumeSession(packageId) {
  const result = decrementPackageSessions(packageId);
  if (result.changes === 0) {
    console.warn(`[packageManager] consumeSession: no sessions remaining on ${packageId}`);
    return -1;
  }

  const pkg = getPackage(packageId);
  return pkg ? pkg.sessions_remaining : -1;
}

// ─── consumeRequest ───────────────────────────────────────────────────────
/**
 * Decrement the req/res counter when a proxied request is made.
 * Called by the internal /validate endpoint on every authorized request.
 *
 * @param {string} packageId
 * @returns {number} req/res remaining after decrement, or -1 on failure
 */
function consumeRequest(packageId) {
  const result = decrementPackageReqRes(packageId);
  if (result.changes === 0) {
    console.warn(`[packageManager] consumeRequest: quota exhausted on ${packageId}`);
    return -1;
  }

  const pkg = getPackage(packageId);
  return pkg ? pkg.req_res_remaining : -1;
}

// ─── getPackageStatus ─────────────────────────────────────────────────────
/**
 * Return the current quota status for a package.
 *
 * @param {string} packageId
 * @returns {object|null}
 */
function getPackageStatus(packageId) {
  const pkg = getPackage(packageId);
  if (!pkg) return null;

  const now = new Date();
  const expiresAt = new Date(pkg.expires_at);
  const isExpired = expiresAt < now;

  return {
    id: pkg.id,
    tier: pkg.tier,
    sessionsRemaining: pkg.sessions_remaining,
    sessionsTotal: pkg.sessions_total,
    reqResRemaining: pkg.req_res_remaining,
    reqResTotal: pkg.req_res_total,
    active: !!pkg.active && !isExpired,
    expired: isExpired,
    expiresAt: pkg.expires_at,
    daysUntilExpiry: isExpired ? 0 : Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)),
  };
}

// ─── hasQuota ─────────────────────────────────────────────────────────────
/**
 * Quick boolean check: does this package have sessions and req/res remaining?
 * Used as a fast pre-check before attempting to claim a session.
 *
 * @param {string} packageId
 * @returns {boolean}
 */
function hasQuota(packageId) {
  const status = getPackageStatus(packageId);
  if (!status) return false;
  return status.active && status.sessionsRemaining > 0 && status.reqResRemaining > 0;
}

module.exports = {
  createPackage,
  consumeSession,
  consumeRequest,
  getPackageStatus,
  hasQuota,
};
