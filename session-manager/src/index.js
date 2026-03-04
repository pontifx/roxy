/**
 * session-manager/src/index.js
 *
 * Roxy Session Manager — Express Application Entry Point
 */

'use strict';

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const { initDatabase, redisClient } = require('./db/store');
const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/sessions');
const packageRoutes = require('./routes/packages');
const earningsRoutes = require('./routes/earnings');
const bountiesRoutes = require('./routes/bounties');
const internalRoutes = require('./routes/internal');
const { setupHostWebSocket } = require('./ws/hostConnection');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Internal-Service'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/api/health', async (req, res) => {
  let redisStatus = 'ok';
  try {
    const pong = await redisClient.ping();
    if (pong !== 'PONG') redisStatus = 'degraded';
  } catch (err) {
    redisStatus = 'error';
  }

  const status = redisStatus === 'ok' ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status,
    redis: redisStatus,
    sqlite: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '0.1.0',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/packages', packageRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/bounties', bountiesRoutes);
app.use('/api/internal', internalRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.path });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const isDev = process.env.NODE_ENV !== 'production';

  if (err.name === 'UnauthorizedError' || err.status === 401) {
    return res.status(401).json({ error: 'Unauthorized', message: err.message });
  }

  console.error('[session-manager] Unhandled error:', err);

  res.status(err.status || 500).json({
    error: 'Internal Server Error',
    message: isDev ? err.message : 'An unexpected error occurred',
    ...(isDev && { stack: err.stack }),
  });
});

const server = http.createServer(app);
setupHostWebSocket(server);

async function start() {
  try {
    initDatabase();
    console.log('[session-manager] SQLite database initialized');

    try {
      await redisClient.ping();
      console.log('[session-manager] Redis connection verified');
    } catch (err) {
      console.warn('[session-manager] Redis ping failed at startup (will retry):', err.message);
    }

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[session-manager] Listening on port ${PORT}`);
      console.log(`[session-manager] Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('[session-manager] Startup error:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`[session-manager] ${signal} received, shutting down gracefully`);

  server.close(async () => {
    await redisClient.quit();
    console.log('[session-manager] Shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[session-manager] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
