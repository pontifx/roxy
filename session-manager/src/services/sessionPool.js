/**
 * session-manager/src/services/sessionPool.js
 *
 * Session Pool — Matching Engine
 */

'use strict';

const {
  getAvailableSessions, getSession, updateSessionField,
  atomicClaimSession, deleteSession,
} = require('../db/store');
const { notifyHostOfClaim } = require('../ws/hostConnection');

const MAX_CLAIM_HOURS = parseInt(process.env.SESSION_MAX_CLAIM_HOURS || '48', 10);

async function findAvailableSession(criteria = {}) {
  const sessionIds = await getAvailableSessions();

  if (!sessionIds.length) return null;

  const sessions = await Promise.all(sessionIds.map(id => getSession(id)));
  const valid = sessions.filter(s => s && s.status === 'available');

  if (!valid.length) return null;

  if (!criteria.geo && !criteria.browser) {
    return valid[Math.floor(Math.random() * valid.length)];
  }

  const scored = valid.map(session => {
    let score = 0;
    if (criteria.geo && session.geo === criteria.geo) score += 10;
    if (criteria.browser && session.browser === criteria.browser) score += 5;
    return { session, score };
  });

  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);

  return scored[0].session;
}

async function claimSession(buyerId, packageId, criteria = {}) {
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const candidate = await findAvailableSession(criteria);
    if (!candidate) return null;

    const success = await atomicClaimSession(candidate.id, buyerId, packageId);

    if (success) {
      const claimedSession = await getSession(candidate.id);

      notifyHostOfClaim(candidate.id, { tier: 'unknown', buyerId })
        .catch(err => console.warn('[sessionPool] Failed to notify host:', err.message));

      console.log(`[sessionPool] Session ${candidate.id} claimed by buyer ${buyerId}`);
      return claimedSession;
    }

    await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
  }

  console.warn(`[sessionPool] Could not claim a session after ${MAX_RETRIES} attempts`);
  return null;
}

async function releaseSession(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return;

  const pipeline = require('../db/store').redisClient.pipeline();
  const sessionKey = `session:${sessionId}`;

  pipeline.hset(sessionKey, {
    status: 'available',
    claimedBy: '',
    packageId: '',
    claimedAt: '',
  });

  pipeline.sadd('sessions:available', sessionId);
  await pipeline.exec();

  console.log(`[sessionPool] Session ${sessionId} released back to pool`);
}

async function getSessionStats() {
  const availableIds = await getAvailableSessions();

  const sampleSize = Math.min(availableIds.length, 50);
  const sample = availableIds.slice(0, sampleSize);
  const sessions = await Promise.all(sample.map(id => getSession(id)));
  const valid = sessions.filter(Boolean);

  const geoCounts = {};
  const browserCounts = {};
  for (const s of valid) {
    geoCounts[s.geo || 'unknown'] = (geoCounts[s.geo || 'unknown'] || 0) + 1;
    browserCounts[s.browser || 'unknown'] = (browserCounts[s.browser || 'unknown'] || 0) + 1;
  }

  return {
    available: availableIds.length,
    sampled: sampleSize,
    geoCounts,
    browserCounts,
    timestamp: new Date().toISOString(),
  };
}

async function expireStaleClaimedSessions() {
  const availableIds = await getAvailableSessions();
  console.log(`[sessionPool] Expiry check: ${availableIds.length} sessions in available pool`);
}

setInterval(expireStaleClaimedSessions, 15 * 60 * 1000).unref();

module.exports = {
  findAvailableSession,
  claimSession,
  releaseSession,
  getSessionStats,
};
