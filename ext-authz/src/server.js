'use strict';

const express = require('express');

const app = express();

app.use(express.json());

const PORT = process.env.PORT || 9191;
const SESSION_MANAGER_URL = process.env.SESSION_MANAGER_URL || 'http://session-manager:3000';
const VALIDATE_URL = `${SESSION_MANAGER_URL}/api/internal/validate`;
const VALIDATE_TIMEOUT_MS = 1500;

let fetch;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ext-authz', timestamp: new Date().toISOString() });
});

app.post('*', async (req, res) => {
  const token = req.headers['x-roxy-token'];
  const sessionId = req.headers['x-roxy-session'];
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (!token || !sessionId) {
    console.log(`[authz] DENY missing headers — ip=${clientIp} token=${!!token} session=${!!sessionId}`);
    return res.status(403).json({
      error: 'Unauthorized',
      message: 'X-Roxy-Token and X-Roxy-Session headers are required',
      code: 'MISSING_HEADERS',
    });
  }

  let validationResult;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

    const response = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service': 'ext-authz',
      },
      body: JSON.stringify({ token, sessionId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    validationResult = await response.json();

    if (!response.ok || !validationResult.authorized) {
      const reason = validationResult.message || 'Session validation failed';
      console.log(`[authz] DENY validation failed — session=${sessionId} reason="${reason}"`);
      return res.status(403).json({
        error: 'Forbidden',
        message: reason,
        code: validationResult.code || 'VALIDATION_FAILED',
      });
    }

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`[authz] DENY timeout calling session-manager — session=${sessionId}`);
      return res.status(403).json({
        error: 'Service Unavailable',
        message: 'Authorization service timeout',
        code: 'AUTHZ_TIMEOUT',
      });
    }

    console.error(`[authz] DENY internal error — session=${sessionId}`, err.message);
    return res.status(403).json({
      error: 'Internal Server Error',
      message: 'Authorization service error',
      code: 'AUTHZ_ERROR',
    });
  }

  console.log(`[authz] ALLOW session=${sessionId} buyer=${validationResult.buyerId} tier=${validationResult.tier}`);

  res
    .set('x-roxy-host-id', validationResult.hostId || '')
    .set('x-roxy-buyer-id', validationResult.buyerId || '')
    .set('x-roxy-tier', validationResult.tier || 'scout')
    .status(200)
    .json({ status: 'ok' });
});

async function start() {
  fetch = (await import('node-fetch')).default;

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ext-authz] HTTP authorization service listening on port ${PORT}`);
    console.log(`[ext-authz] Validation endpoint: ${VALIDATE_URL}`);
  });
}

start().catch((err) => {
  console.error('[ext-authz] Failed to start:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('[ext-authz] SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[ext-authz] SIGINT received, shutting down gracefully');
  process.exit(0);
});
