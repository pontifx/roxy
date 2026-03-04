/**
 * session-manager/src/routes/packages.js
 *
 * Package Purchase and Quota Management Routes
 */

'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { createPackage: dbCreatePackage, getPackage, getBuyerPackages } = require('../db/store');
const { createPackage } = require('../services/packageManager');

const router = express.Router();

const TIERS = {
  scout:  { sessions: 10,    reqRes: 500,    price: 2900,   rateLimit: 10  },
  recon:  { sessions: 50,    reqRes: 3000,   price: 11900,  rateLimit: 25  },
  breach: { sessions: 200,   reqRes: 15000,  price: 39900,  rateLimit: 50  },
  siege:  { sessions: 1000,  reqRes: 100000, price: 149900, rateLimit: 100 },
};

router.post('/purchase', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const { tier } = req.body;

    if (!tier || !TIERS[tier]) {
      return res.status(400).json({
        error: 'Bad Request',
        message: `tier must be one of: ${Object.keys(TIERS).join(', ')}`,
        tiers: Object.keys(TIERS),
      });
    }

    const tierDef = TIERS[tier];
    const paymentRef = `dev_${Date.now()}`;
    const pkg = await createPackage(req.user.id, tier, tierDef, paymentRef);

    return res.status(201).json({
      id: pkg.id,
      tier: pkg.tier,
      sessionsRemaining: pkg.sessions_remaining,
      sessionsTotal: pkg.sessions_total,
      reqResRemaining: pkg.req_res_remaining,
      reqResTotal: pkg.req_res_total,
      purchasedAt: pkg.purchased_at,
      expiresAt: pkg.expires_at,
      price: tierDef.price,
      rateLimit: tierDef.rateLimit,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const packages = getBuyerPackages(req.user.id);

    const formatted = packages.map(p => ({
      id: p.id,
      tier: p.tier,
      sessionsRemaining: p.sessions_remaining,
      sessionsTotal: p.sessions_total,
      reqResRemaining: p.req_res_remaining,
      reqResTotal: p.req_res_total,
      purchasedAt: p.purchased_at,
      expiresAt: p.expires_at,
      rateLimit: TIERS[p.tier]?.rateLimit || 10,
    }));

    return res.json({ packages: formatted, total: formatted.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const pkg = getPackage(req.params.id);

    if (!pkg) {
      return res.status(404).json({ error: 'Not Found', message: 'Package not found' });
    }

    if (pkg.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', message: 'Not your package' });
    }

    const tierDef = TIERS[pkg.tier] || {};

    return res.json({
      id: pkg.id,
      tier: pkg.tier,
      sessionsRemaining: pkg.sessions_remaining,
      sessionsTotal: pkg.sessions_total,
      reqResRemaining: pkg.req_res_remaining,
      reqResTotal: pkg.req_res_total,
      purchasedAt: pkg.purchased_at,
      expiresAt: pkg.expires_at,
      active: !!pkg.active,
      rateLimit: tierDef.rateLimit || 10,
      utilizationSessions: Math.round((1 - pkg.sessions_remaining / pkg.sessions_total) * 100),
      utilizationReqRes: Math.round((1 - pkg.req_res_remaining / pkg.req_res_total) * 100),
    });
  } catch (err) {
    next(err);
  }
});

router.TIERS = TIERS;
module.exports = router;
