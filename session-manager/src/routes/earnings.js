/**
 * session-manager/src/routes/earnings.js
 *
 * Host Earnings Routes
 *
 * GET /api/earnings         — Summary of total, pending, and paid earnings
 * GET /api/earnings/history — Paginated earnings ledger
 *
 * All earnings are stored in cents (USD integers) in the database.
 * The API returns values in cents with a `_cents` suffix and also a
 * human-readable formatted string for convenience.
 */

'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getHostEarningsSummary, getHostEarningsHistory, getBountiesByHost } = require('../db/store');

const router = express.Router();

// ─── GET /api/earnings ────────────────────────────────────────────────────
/**
 * Returns earnings summary for the authenticated host.
 *
 * Response:
 *   {
 *     total_cents, session_fees_cents, bounty_shares_cents, pricing_data_cents,
 *     pending_bounties_cents,  // bounties not yet confirmed
 *     event_count,
 *     formatted: { total, session_fees, bounty_shares, pricing_data }
 *   }
 */
router.get('/', requireAuth, requireRole('host'), async (req, res, next) => {
  try {
    const summary = getHostEarningsSummary(req.user.id);

    // Sum pending bounty amounts — money owed but not yet confirmed by buyer
    const pendingBounties = getBountiesByHost(req.user.id)
      .filter(b => b.status === 'pending')
      .reduce((sum, b) => sum + b.host_share, 0);

    const confirmed = getBountiesByHost(req.user.id)
      .filter(b => b.status === 'confirmed')
      .reduce((sum, b) => sum + b.host_share, 0);

    return res.json({
      total_cents: summary.total || 0,
      session_fees_cents: summary.session_fees || 0,
      bounty_shares_cents: summary.bounty_shares || 0,
      pricing_data_cents: summary.pricing_data || 0,
      pending_bounties_cents: pendingBounties,
      confirmed_bounties_cents: confirmed,
      event_count: summary.event_count || 0,
      // Human-readable formatted amounts (USD)
      formatted: {
        total: formatUSD(summary.total || 0),
        session_fees: formatUSD(summary.session_fees || 0),
        bounty_shares: formatUSD(summary.bounty_shares || 0),
        pricing_data: formatUSD(summary.pricing_data || 0),
        pending_bounties: formatUSD(pendingBounties),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/earnings/history ────────────────────────────────────────────
/**
 * Paginated earnings ledger for the authenticated host.
 *
 * Query params:
 *   limit  — records per page (default 50, max 200)
 *   offset — records to skip (default 0)
 *
 * Response:
 *   { events: [...], total: number, limit: number, offset: number }
 */
router.get('/history', requireAuth, requireRole('host'), async (req, res, next) => {
  try {
    // Parse and clamp pagination params
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const events = getHostEarningsHistory(req.user.id, limit, offset);

    const formatted = events.map(e => ({
      id: e.id,
      type: e.type,
      amount_cents: e.amount,
      amount_formatted: formatUSD(e.amount),
      reference_id: e.reference_id,
      created_at: e.created_at,
    }));

    return res.json({
      events: formatted,
      limit,
      offset,
      has_more: events.length === limit,  // Hint for pagination
    });
  } catch (err) {
    next(err);
  }
});

// ─── Utility ──────────────────────────────────────────────────────────────

/**
 * Format an integer cent value as a USD string.
 * e.g., 14950 → "$149.50"
 */
function formatUSD(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

module.exports = router;
