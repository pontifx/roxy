/**
 * session-manager/src/routes/internal.js
 *
 * Internal Routes — only accessible within the Docker network (roxy-net)
 *
 * These endpoints have NO JWT authentication by design. They are called by
 * other services (ext-authz) within the container network. In production,
 * ensure port 3000 is NOT exposed to the public internet — these routes would
 * be exploitable without auth if reachable externally.
 *
 * An additional guard: we check for the X-Internal-Service header that
 * ext-authz sets. This isn't cryptographic security but provides a minimal
 * sanity check against accidental exposure.
 *
 * POST /api/internal/validate — Called by ext-authz on every proxied request
 */

'use strict';

const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { getSession, getPackage, getBuyerPackages, decrementPackageReqRes } = require('../db/store');

const router = express.Router();

// ─── Internal-only guard middleware ───────────────────────────────────────
// Reject calls that don't include the internal service header.
// This prevents buyers from calling internal routes directly even if they
// somehow reach port 3000.
function internalOnly(req, res, next) {
  const internalHeader = req.headers['x-internal-service'];
  if (!internalHeader) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint is for internal service use only',
    });
  }
  next();
}

router.use(internalOnly);

// ─── POST /api/internal/validate ─────────────────────────────────────────
/**
 * Called by ext-authz on every proxied buyer request through Envoy.
 *
 * Flow:
 *   1. Decode and verify the buyer's JWT
 *   2. Check that the session exists in Redis and is claimed
 *   3. Verify the session is claimed by this specific buyer
 *   4. Check that the buyer has an active package with req/res quota remaining
 *   5. Decrement the req/res counter (this request is about to be forwarded)
 *   6. Return authorization result with metadata
 *
 * This endpoint is called on the hot path — every proxied request goes through
 * here. Keep it fast: no heavy computation, no external calls, Redis + SQLite only.
 *
 * Request body:
 *   { token: string, sessionId: string }
 *
 * Response 200 (authorized):
 *   { authorized: true, hostId, buyerId, tier, remaining: { reqRes } }
 *
 * Response 200 (denied — note: 200 not 403 so ext-authz can parse the JSON):
 *   { authorized: false, code: string, message: string }
 */
router.post('/validate', async (req, res, next) => {
  try {
    const { token, sessionId } = req.body;

    if (!token || !sessionId) {
      return res.json({
        authorized: false,
        code: 'MISSING_PARAMS',
        message: 'token and sessionId are required',
      });
    }

    // ── 1. Verify JWT ──────────────────────────────────────────────────
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.json({
        authorized: false,
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired token',
      });
    }

    if (decoded.role !== 'buyer') {
      return res.json({
        authorized: false,
        code: 'WRONG_ROLE',
        message: 'Only buyer accounts can proxy requests',
      });
    }

    // ── 2. Verify session exists and is claimed ────────────────────────
    const session = await getSession(sessionId);

    if (!session) {
      return res.json({
        authorized: false,
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found or expired',
      });
    }

    if (session.status !== 'claimed') {
      return res.json({
        authorized: false,
        code: 'SESSION_NOT_CLAIMED',
        message: `Session status is '${session.status}', not 'claimed'`,
      });
    }

    // ── 3. Verify session is claimed by THIS buyer ─────────────────────
    if (session.claimedBy !== decoded.id) {
      return res.json({
        authorized: false,
        code: 'SESSION_NOT_YOURS',
        message: 'This session is claimed by a different buyer',
      });
    }

    // ── 4. Check package quota ─────────────────────────────────────────
    // The session records which package it was claimed from
    const packageId = session.packageId;

    if (!packageId) {
      return res.json({
        authorized: false,
        code: 'NO_PACKAGE',
        message: 'Session has no associated package',
      });
    }

    const pkg = getPackage(packageId);

    if (!pkg) {
      return res.json({
        authorized: false,
        code: 'PACKAGE_NOT_FOUND',
        message: 'Associated package not found',
      });
    }

    if (pkg.req_res_remaining <= 0) {
      return res.json({
        authorized: false,
        code: 'QUOTA_EXHAUSTED',
        message: 'Req/res quota exhausted on this package',
      });
    }

    // Check package expiry
    if (new Date(pkg.expires_at) < new Date()) {
      return res.json({
        authorized: false,
        code: 'PACKAGE_EXPIRED',
        message: 'Package has expired',
      });
    }

    // ── 5. Decrement req/res counter ───────────────────────────────────
    // We decrement BEFORE sending the authorized response.
    // This means if the decrement fails (e.g., race condition brings it to 0),
    // we deny the request rather than allowing an over-quota request through.
    const decrementResult = decrementPackageReqRes(packageId);

    if (decrementResult.changes === 0) {
      // The UPDATE ran but changed nothing — quota hit 0 between our check and decrement
      return res.json({
        authorized: false,
        code: 'QUOTA_EXHAUSTED',
        message: 'Req/res quota exhausted',
      });
    }

    // ── 6. Return authorization result ────────────────────────────────
    return res.json({
      authorized: true,
      hostId: session.hostId,
      buyerId: decoded.id,
      tier: pkg.tier,
      remaining: {
        reqRes: pkg.req_res_remaining - 1,  // After decrement
      },
    });

  } catch (err) {
    // On internal error, deny the request (fail closed)
    console.error('[internal/validate] Error:', err.message);
    return res.json({
      authorized: false,
      code: 'INTERNAL_ERROR',
      message: 'Authorization service error',
    });
  }
});

module.exports = router;
