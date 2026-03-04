/**
 * session-manager/src/services/pricingPipeline.js
 *
 * Dynamic Pricing Data Pipeline
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { insertPricingSignal, aggregatePricingByPattern, db } = require('../db/store');

const PRICE_SIGNAL_MIN_AMOUNT = 0;
const PRICE_SIGNAL_MAX_AMOUNT = 10000000;

async function ingestPriceSignal(data) {
  if (!data.url_pattern || typeof data.url_pattern !== 'string') {
    return { accepted: false, reason: 'url_pattern is required' };
  }

  const normalizedPattern = normalizeUrlPattern(data.url_pattern);
  if (!normalizedPattern) {
    return { accepted: false, reason: 'Could not normalize url_pattern' };
  }

  if (data.price !== null && data.price !== undefined) {
    const price = Number(data.price);
    if (isNaN(price) || price < PRICE_SIGNAL_MIN_AMOUNT || price > PRICE_SIGNAL_MAX_AMOUNT) {
      return { accepted: false, reason: `price out of valid range (0 - ${PRICE_SIGNAL_MAX_AMOUNT})` };
    }
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const existing = db.prepare(`
    SELECT id FROM pricing_signals
    WHERE url_pattern = ? AND session_id = ? AND timestamp > ?
    LIMIT 1
  `).get(normalizedPattern, data.sessionId, oneHourAgo);

  if (existing) {
    return { accepted: false, reason: 'Duplicate signal from this session within 1 hour' };
  }

  const id = `sig_${uuidv4().replace(/-/g, '')}`;
  const signal = {
    id,
    url_pattern: normalizedPattern,
    price: data.price !== undefined ? data.price : null,
    currency: (data.currency || 'USD').toUpperCase().slice(0, 3),
    geo: (data.geo || 'unknown').toUpperCase().slice(0, 2),
    timestamp: data.timestamp || new Date().toISOString(),
    session_id: data.sessionId,
  };

  insertPricingSignal(signal);

  return { accepted: true, id };
}

async function aggregateByPattern(urlPattern) {
  const normalized = normalizeUrlPattern(urlPattern);
  if (!normalized) return [];
  return aggregatePricingByPattern(normalized);
}

async function getRecentSignals(limit = 100) {
  return db.prepare(`
    SELECT id, url_pattern, price, currency, geo, timestamp, session_id, created_at
    FROM pricing_signals
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

function normalizeUrlPattern(rawUrl) {
  try {
    const parsed = new URL(rawUrl);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`
      .toLowerCase()
      .replace(/\/+$/, '');

    return normalized;
  } catch (e) {
    return null;
  }
}

module.exports = {
  ingestPriceSignal,
  aggregateByPattern,
  getRecentSignals,
};
