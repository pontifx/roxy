/**
 * session-manager/src/routes/sessions.js
 *
 * Session Lifecycle Routes
 */

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  setSession, getSession, deleteSession,
  getAvailableSessions, getHostSessions,
  decrementPackageSessions,
  getBuyerPackages,
} = require('../db/store');
const { claimSession, releaseSession } = require('../services/sessionPool');

const router = express.Router();

router.post('/register', requireAuth, requireRole('host'), async (req, res, next) => {
  try {
    const { browser, geo } = req.body || {};
    const sessionId = `sess_${uuidv4().replace(/-/g, '')}`;

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
              || req.socket.remoteAddress
              || 'unknown';

    const session = {
      id: sessionId,
      hostId: req.user.id,
      ip,
      geo: geo || 'unknown',
      browser: browser || req.headers['user-agent'] || 'unknown',
      status: 'available',
      claimedBy: null,
      packageId: null,
      claimedAt: null,
      registeredAt: new Date().toISOString(),
    };

    await setSession(session);
    console.log(`[sessions] Host ${req.user.id} registered session ${sessionId}`);
    return res.status(201).json({ sessionId, status: 'available' });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requireAuth, requireRole('host'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const session = await getSession(id);

    if (!session) {
      return res.status(404).json({ error: 'Not Found', message: 'Session not found' });
    }

    if (session.hostId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden', message: 'Not your session' });
    }

    await deleteSession(id, req.user.id);
    console.log(`[sessions] Host ${req.user.id} deregistered session ${id}`);
    return res.json({ message: 'Session deregistered' });
  } catch (err) {
    next(err);
  }
});

router.get('/available', requireAuth, async (req, res, next) => {
  try {
    const sessionIds = await getAvailableSessions();
    const sessions = await Promise.all(sessionIds.map(id => getSession(id)));
    const valid = sessions.filter(Boolean).map(s => ({
      id: s.id, geo: s.geo, browser: s.browser, status: s.status, registeredAt: s.registeredAt,
    }));
    return res.json({ count: valid.length, sessions: valid });
  } catch (err) {
    next(err);
  }
});

router.post('/claim', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const { packageId, geo, browser } = req.body || {};

    if (!packageId) {
      return res.status(400).json({ error: 'Bad Request', message: 'packageId is required' });
    }

    const buyerPackages = getBuyerPackages(req.user.id);
    const pkg = buyerPackages.find(p => p.id === packageId);

    if (!pkg) {
      return res.status(404).json({ error: 'Not Found', message: 'Package not found or not active' });
    }

    if (pkg.sessions_remaining <= 0) {
      return res.status(402).json({
        error: 'Quota Exceeded',
        message: 'No session credits remaining on this package',
        code: 'NO_SESSION_CREDITS',
      });
    }

    const criteria = { geo, browser };
    const claimedSession = await claimSession(req.user.id, packageId, criteria);

    if (!claimedSession) {
      return res.status(503).json({
        error: 'No Sessions Available',
        message: 'No matching sessions available right now. Try again shortly.',
        code: 'NO_SESSIONS',
      });
    }

    decrementPackageSessions(packageId);
    console.log(`[sessions] Buyer ${req.user.id} claimed session ${claimedSession.id} from package ${packageId}`);

    const maxClaim = new Date();
    maxClaim.setHours(maxClaim.getHours() + 48);
    const expiresAt = new Date(Math.min(maxClaim, new Date(pkg.expires_at))).toISOString();

    return res.json({
      sessionId: claimedSession.id,
      proxyHost: process.env.PROXY_HOST || 'localhost',
      proxyPort: parseInt(process.env.PROXY_PORT || '10000', 10),
      headers: {
        'X-Roxy-Token': req.headers['authorization']?.slice(7) || '',
        'X-Roxy-Session': claimedSession.id,
      },
      tier: pkg.tier,
      expiresAt,
      quotaRemaining: {
        sessions: pkg.sessions_remaining - 1,
        reqRes: pkg.req_res_remaining,
      },
      hostInfo: {
        geo: claimedSession.geo,
        browser: claimedSession.browser ? claimedSession.browser.slice(0, 80) : 'unknown',
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/release', requireAuth, requireRole('buyer'), async (req, res, next) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Bad Request', message: 'sessionId is required' });
    }

    const session = await getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Not Found', message: 'Session not found' });
    }

    if (session.claimedBy !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'This session is not claimed by your account',
      });
    }

    await releaseSession(sessionId);
    console.log(`[sessions] Buyer ${req.user.id} released session ${sessionId}`);
    return res.json({ message: 'Session released', sessionId });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', requireAuth, requireRole('host'), async (req, res, next) => {
  try {
    const sessionIds = await getHostSessions(req.user.id);
    const sessions = await Promise.all(sessionIds.map(id => getSession(id)));
    const valid = sessions.filter(Boolean).map(s => ({
      id: s.id,
      status: s.status,
      geo: s.geo,
      browser: s.browser ? s.browser.slice(0, 80) : 'unknown',
      registeredAt: s.registeredAt,
      claimedAt: s.status === 'claimed' ? s.claimedAt : null,
    }));
    return res.json({ sessions: valid, total: valid.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
