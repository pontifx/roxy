/**
 * session-manager/src/db/store.js
 *
 * Roxy Persistence Layer
 *
 * Provides a unified interface over SQLite (better-sqlite3) and Redis (ioredis).
 */

'use strict';

const Database = require('better-sqlite3');
const Redis = require('ioredis');
const path = require('path');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../../data/roxy.db');

const fs = require('fs');
const dataDir = path.dirname(SQLITE_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(SQLITE_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 10000);
    console.log(`[redis] Reconnecting in ${delay}ms (attempt ${times})`);
    return delay;
  },
  enableOfflineQueue: true,
});

redisClient.on('connect', () => console.log('[redis] Connected'));
redisClient.on('error', (err) => console.error('[redis] Error:', err.message));
redisClient.on('reconnecting', () => console.log('[redis] Reconnecting...'));

const KEYS = {
  session: (id) => `session:${id}`,
  hostSessions: (hostId) => `host:${hostId}:sessions`,
  availableSessions: () => 'sessions:available',
  sessionTTL: 48 * 60 * 60,
};

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hosts (
      id              TEXT PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      total_earnings  INTEGER NOT NULL DEFAULT 0,
      sessions_served INTEGER NOT NULL DEFAULT 0,
      rating          REAL NOT NULL DEFAULT 5.0,
      blocked_domains TEXT NOT NULL DEFAULT '[]',
      schedule        TEXT NOT NULL DEFAULT '{}',
      min_payout      INTEGER NOT NULL DEFAULT 1000
    );

    CREATE TABLE IF NOT EXISTS buyers (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      sessions_used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS packages (
      id                TEXT PRIMARY KEY,
      buyer_id          TEXT NOT NULL REFERENCES buyers(id),
      tier              TEXT NOT NULL CHECK(tier IN ('scout','recon','breach','siege')),
      sessions_total    INTEGER NOT NULL,
      sessions_remaining INTEGER NOT NULL,
      req_res_total     INTEGER NOT NULL,
      req_res_remaining INTEGER NOT NULL,
      purchased_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT NOT NULL,
      active            INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS bounties (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      buyer_id    TEXT NOT NULL REFERENCES buyers(id),
      host_id     TEXT NOT NULL REFERENCES hosts(id),
      amount      INTEGER NOT NULL,
      buyer_share INTEGER NOT NULL,
      host_share  INTEGER NOT NULL,
      proof_url   TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','confirmed','paid')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS earnings_ledger (
      id           TEXT PRIMARY KEY,
      host_id      TEXT NOT NULL REFERENCES hosts(id),
      type         TEXT NOT NULL CHECK(type IN ('session_fee','bounty_share','pricing_data')),
      amount       INTEGER NOT NULL,
      reference_id TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pricing_signals (
      id          TEXT PRIMARY KEY,
      url_pattern TEXT NOT NULL,
      price       INTEGER,
      currency    TEXT,
      geo         TEXT,
      timestamp   TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_packages_buyer ON packages(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_bounties_buyer ON bounties(buyer_id);
    CREATE INDEX IF NOT EXISTS idx_bounties_host ON bounties(host_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_host ON earnings_ledger(host_id);
    CREATE INDEX IF NOT EXISTS idx_ledger_host_created ON earnings_ledger(host_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_signals_pattern ON pricing_signals(url_pattern, geo);
  `);
}

async function setSession(session) {
  const key = KEYS.session(session.id);
  const pipeline = redisClient.pipeline();
  pipeline.hset(key, flattenForRedis(session));
  pipeline.expire(key, KEYS.sessionTTL);

  if (session.status === 'available') {
    pipeline.sadd(KEYS.availableSessions(), session.id);
  }
  if (session.hostId) {
    pipeline.sadd(KEYS.hostSessions(session.hostId), session.id);
  }

  await pipeline.exec();
}

async function getSession(sessionId) {
  const data = await redisClient.hgetall(KEYS.session(sessionId));
  if (!data || Object.keys(data).length === 0) return null;
  return data;
}

async function deleteSession(sessionId, hostId) {
  const pipeline = redisClient.pipeline();
  pipeline.del(KEYS.session(sessionId));
  pipeline.srem(KEYS.availableSessions(), sessionId);
  if (hostId) {
    pipeline.srem(KEYS.hostSessions(hostId), sessionId);
  }
  await pipeline.exec();
}

async function getAvailableSessions() {
  return redisClient.smembers(KEYS.availableSessions());
}

async function getHostSessions(hostId) {
  return redisClient.smembers(KEYS.hostSessions(hostId));
}

async function updateSessionField(sessionId, field, value) {
  await redisClient.hset(KEYS.session(sessionId), field, value);
}

async function atomicClaimSession(sessionId, buyerId, packageId) {
  const watchClient = redisClient.duplicate();

  try {
    const sessionKey = KEYS.session(sessionId);

    await watchClient.watch(sessionKey);

    const status = await watchClient.hget(sessionKey, 'status');
    if (status !== 'available') {
      await watchClient.unwatch();
      await watchClient.quit();
      return false;
    }

    const multi = watchClient.multi();
    multi.hset(sessionKey, {
      status: 'claimed',
      claimedBy: buyerId,
      packageId,
      claimedAt: new Date().toISOString(),
    });
    multi.srem(KEYS.availableSessions(), sessionId);

    const results = await multi.exec();

    await watchClient.quit();

    return results !== null;
  } catch (err) {
    await watchClient.quit();
    throw err;
  }
}

function getUserByEmail(email, role) {
  const table = role === 'host' ? 'hosts' : 'buyers';
  return db.prepare(`SELECT * FROM ${table} WHERE email = ?`).get(email);
}

function getUserById(id, role) {
  const table = role === 'host' ? 'hosts' : 'buyers';
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

function createUser(user, role) {
  const table = role === 'host' ? 'hosts' : 'buyers';
  if (role === 'host') {
    return db.prepare(`
      INSERT INTO hosts (id, email, password_hash)
      VALUES (@id, @email, @password_hash)
    `).run(user);
  }
  return db.prepare(`
    INSERT INTO buyers (id, email, password_hash)
    VALUES (@id, @email, @password_hash)
  `).run(user);
}

function createPackage(pkg) {
  return db.prepare(`
    INSERT INTO packages (id, buyer_id, tier, sessions_total, sessions_remaining,
                          req_res_total, req_res_remaining, purchased_at, expires_at)
    VALUES (@id, @buyer_id, @tier, @sessions_total, @sessions_remaining,
            @req_res_total, @req_res_remaining, @purchased_at, @expires_at)
  `).run(pkg);
}

function getPackage(id) {
  return db.prepare('SELECT * FROM packages WHERE id = ?').get(id);
}

function getBuyerPackages(buyerId) {
  return db.prepare(`
    SELECT * FROM packages
    WHERE buyer_id = ? AND active = 1 AND expires_at > datetime('now')
    ORDER BY purchased_at DESC
  `).all(buyerId);
}

function decrementPackageSessions(packageId) {
  return db.prepare(`
    UPDATE packages SET sessions_remaining = sessions_remaining - 1
    WHERE id = ? AND sessions_remaining > 0
  `).run(packageId);
}

function decrementPackageReqRes(packageId) {
  return db.prepare(`
    UPDATE packages SET req_res_remaining = req_res_remaining - 1
    WHERE id = ? AND req_res_remaining > 0
  `).run(packageId);
}

function createBounty(bounty) {
  return db.prepare(`
    INSERT INTO bounties (id, session_id, buyer_id, host_id, amount,
                          buyer_share, host_share, proof_url)
    VALUES (@id, @session_id, @buyer_id, @host_id, @amount,
            @buyer_share, @host_share, @proof_url)
  `).run(bounty);
}

function getBounty(id) {
  return db.prepare('SELECT * FROM bounties WHERE id = ?').get(id);
}

function getBountiesByBuyer(buyerId) {
  return db.prepare('SELECT * FROM bounties WHERE buyer_id = ? ORDER BY created_at DESC').all(buyerId);
}

function getBountiesByHost(hostId) {
  return db.prepare('SELECT * FROM bounties WHERE host_id = ? ORDER BY created_at DESC').all(hostId);
}

function confirmBounty(id) {
  return db.prepare(`
    UPDATE bounties SET status = 'confirmed' WHERE id = ? AND status = 'pending'
  `).run(id);
}

function addEarning(earning) {
  return db.prepare(`
    INSERT INTO earnings_ledger (id, host_id, type, amount, reference_id)
    VALUES (@id, @host_id, @type, @amount, @reference_id)
  `).run(earning);
}

function getHostEarningsSummary(hostId) {
  return db.prepare(`
    SELECT
      SUM(amount) as total,
      SUM(CASE WHEN type = 'session_fee' THEN amount ELSE 0 END) as session_fees,
      SUM(CASE WHEN type = 'bounty_share' THEN amount ELSE 0 END) as bounty_shares,
      SUM(CASE WHEN type = 'pricing_data' THEN amount ELSE 0 END) as pricing_data,
      COUNT(*) as event_count
    FROM earnings_ledger
    WHERE host_id = ?
  `).get(hostId);
}

function getHostEarningsHistory(hostId, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT * FROM earnings_ledger
    WHERE host_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(hostId, limit, offset);
}

function updateHostTotalEarnings(hostId, additionalAmount) {
  return db.prepare(`
    UPDATE hosts SET total_earnings = total_earnings + ?
    WHERE id = ?
  `).run(additionalAmount, hostId);
}

function insertPricingSignal(signal) {
  return db.prepare(`
    INSERT INTO pricing_signals (id, url_pattern, price, currency, geo, timestamp, session_id)
    VALUES (@id, @url_pattern, @price, @currency, @geo, @timestamp, @session_id)
  `).run(signal);
}

function aggregatePricingByPattern(urlPattern) {
  return db.prepare(`
    SELECT url_pattern, geo, currency,
           AVG(price) as avg_price, MIN(price) as min_price, MAX(price) as max_price,
           COUNT(*) as sample_count,
           MAX(timestamp) as latest_observation
    FROM pricing_signals
    WHERE url_pattern = ?
    GROUP BY url_pattern, geo, currency
  `).all(urlPattern);
}

function flattenForRedis(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = v === null || v === undefined ? '' : String(v);
  }
  return result;
}

module.exports = {
  db,
  redisClient,
  initDatabase,
  setSession,
  getSession,
  deleteSession,
  getAvailableSessions,
  getHostSessions,
  updateSessionField,
  atomicClaimSession,
  getUserByEmail,
  getUserById,
  createUser,
  createPackage,
  getPackage,
  getBuyerPackages,
  decrementPackageSessions,
  decrementPackageReqRes,
  createBounty,
  getBounty,
  getBountiesByBuyer,
  getBountiesByHost,
  confirmBounty,
  addEarning,
  getHostEarningsSummary,
  getHostEarningsHistory,
  updateHostTotalEarnings,
  insertPricingSignal,
  aggregatePricingByPattern,
};
