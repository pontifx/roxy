/**
 * session-manager/src/routes/bounties.js
 *
 * Bug Bounty Split System Routes
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createBounty, getBounty,
  getBountiesByBuyer, getBountiesByHost,
  confirmBounty, addEarning, updateHostTotalEarnings,
  getSession,
} = require('../db/store');

const router = express.Router();

const DEFAULT_HOST_SHARE = parseFloat(process.env.BOUNTY_HOST_SHARE || '0.30');

router.post('/report', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const { sessionId, amount, proofUrl } = req.body;

    if (!sessionId || !amount || !proofUrl) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'sessionId, amount (in cents), and proofUrl are required',
      });
    }

    if (typeof amount !== 'number' || amount <= 0 || !Number.isInteger(amount)) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'amount must be a positive integer (cents)',
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Minimum reportable bounty is $1.00 (100 cents)',
      });
    }

    if (typeof proofUrl !== 'string' || !proofUrl.startsWith('http')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'proofUrl must be a valid URL to the bounty report',
      });
    }

    const session = await getSession(sessionId);

    if (!session || !session.hostId) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Session not found. Note: sessions expire from the pool after 48h.',
      });
    }

    if (session.claimedBy !== req.user.id && session.claimedBy !== undefined) {
      if (session.claimedBy && session.claimedBy !== req.user.id) {
        return res.status(403).json({
          error: 'Forbidden',
          message: 'This session was not claimed by your account',
        });
      }
    }

    const hostShare = Math.round(amount * DEFAULT_HOST_SHARE);
    const buyerShare = amount - hostShare;

    const bountyId = `bnty_${uuidv4().replace(/-/g, '')}`;

    createBounty({
      id: bountyId,
      session_id: sessionId,
      buyer_id: req.user.id,
      host_id: session.hostId,
      amount,
      buyer_share: buyerShare,
      host_share: hostShare,
      proof_url: proofUrl,
    });

    console.log(`[bounties] Bounty ${bountyId} reported — buyer=${req.user.id} host=${session.hostId} amount=${amount}`);

    return res.status(201).json({
      id: bountyId,
      sessionId,
      amount_cents: amount,
      buyerShare_cents: buyerShare,
      hostShare_cents: hostShare,
      splitPercentage: { buyer: Math.round((1 - DEFAULT_HOST_SHARE) * 100), host: Math.round(DEFAULT_HOST_SHARE * 100) },
      proofUrl,
      status: 'pending',
      message: 'Bounty reported. Call /api/bounties/:id/confirm once you receive the payout.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/confirm', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const bounty = getBounty(req.params.id);

    if (!bounty) {
      return res.status(404).json({ error: 'Not Found', message: 'Bounty not found' });
    }

    if (bounty.buyer_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', message: 'Not your bounty to confirm' });
    }

    if (bounty.status !== 'pending') {
      return res.status(409).json({
        error: 'Conflict',
        message: `Bounty is already ${bounty.status}`,
      });
    }

    confirmBounty(bounty.id);

    const earningId = `earn_${uuidv4().replace(/-/g, '')}`;
    addEarning({
      id: earningId,
      host_id: bounty.host_id,
      type: 'bounty_share',
      amount: bounty.host_share,
      reference_id: bounty.id,
    });

    updateHostTotalEarnings(bounty.host_id, bounty.host_share);

    console.log(`[bounties] Bounty ${bounty.id} confirmed — crediting host ${bounty.host_id} ${bounty.host_share} cents`);

    return res.json({
      id: bounty.id,
      status: 'confirmed',
      hostShare_cents: bounty.host_share,
      message: 'Bounty confirmed. Host earnings credited.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    let bounties;

    if (req.user.role === 'host') {
      bounties = getBountiesByHost(req.user.id);
    } else if (req.user.role === 'buyer') {
      bounties = getBountiesByBuyer(req.user.id);
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const formatted = bounties.map(b => ({
      id: b.id,
      sessionId: b.session_id,
      amount_cents: b.amount,
      buyerShare_cents: b.buyer_share,
      hostShare_cents: b.host_share,
      proofUrl: b.proof_url,
      status: b.status,
      createdAt: b.created_at,
    }));

    return res.json({ bounties: formatted, total: formatted.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
