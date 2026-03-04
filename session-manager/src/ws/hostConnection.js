/**
 * session-manager/src/ws/hostConnection.js
 *
 * WebSocket Handler for Host Extensions
 */

'use strict';

const url = require('url');
const WebSocket = require('ws');
const { verifyToken } = require('../middleware/auth');
const { setSession, deleteSession, getSession } = require('../db/store');
const { v4: uuidv4 } = require('uuid');

const connectedHosts = new Map();
const sessionToSocket = new Map();

function setupHostWebSocket(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);

    if (pathname !== '/ws/host') {
      socket.destroy();
      return;
    }

    const token = query.token;
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const decoded = verifyToken(token);
    if (!decoded || decoded.role !== 'host') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, decoded, token);
    });
  });

  wss.on('connection', handleHostConnection);

  console.log('[ws] Host WebSocket server attached to /ws/host');
  return wss;
}

async function handleHostConnection(ws, req, hostUser, token) {
  const sessionId = `sess_${uuidv4().replace(/-/g, '')}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const browser = parseBrowserName(userAgent);
  const { query } = url.parse(req.url, true);
  const geo = query.geo || 'unknown';

  const sessionInfo = {
    id: sessionId,
    hostId: hostUser.id,
    ip,
    geo,
    browser,
    status: 'available',
    claimedBy: null,
    packageId: null,
    claimedAt: null,
    registeredAt: new Date().toISOString(),
  };

  await setSession(sessionInfo);
  connectedHosts.set(ws, sessionInfo);
  sessionToSocket.set(sessionId, ws);

  console.log(`[ws] Host ${hostUser.id} connected — session ${sessionId} (${geo}, ${browser})`);

  sendToHost(ws, {
    type: 'session_registered',
    sessionId,
    message: 'Your session is live and available in the pool',
  });

  ws.on('message', async (rawMessage) => {
    let msg;
    try {
      msg = JSON.parse(rawMessage.toString());
    } catch (e) {
      console.warn(`[ws] Malformed message from host ${hostUser.id}`);
      return;
    }

    switch (msg.type) {
      case 'pong':
        if (connectedHosts.has(ws)) {
          connectedHosts.get(ws).lastPong = new Date().toISOString();
        }
        break;

      case 'ping':
        sendToHost(ws, { type: 'pong' });
        break;

      case 'proxy_response':
        handleProxyResponse(ws, msg);
        break;

      case 'price_signal':
        handlePriceSignal(hostUser.id, sessionId, msg.data);
        break;

      case 'status_update':
        if (msg.geo) {
          sessionInfo.geo = msg.geo;
          await setSession(sessionInfo);
        }
        break;

      default:
        console.warn(`[ws] Unknown message type '${msg.type}' from host ${hostUser.id}`);
    }
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      sendToHost(ws, { type: 'ping' });
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  ws.on('close', async (code, reason) => {
    clearInterval(pingInterval);

    const session = connectedHosts.get(ws);
    if (!session) return;

    console.log(`[ws] Host ${hostUser.id} disconnected — session ${session.id} code=${code}`);

    connectedHosts.delete(ws);
    sessionToSocket.delete(session.id);

    await deleteSession(session.id, hostUser.id);
  });

  ws.on('error', (err) => {
    console.error(`[ws] Error on host ${hostUser.id} socket:`, err.message);
    ws.terminate();
  });
}

async function routeToHost(sessionId, proxyRequest) {
  const ws = sessionToSocket.get(sessionId);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  sendToHost(ws, {
    type: 'proxy_request',
    requestId: proxyRequest.requestId,
    method: proxyRequest.method,
    url: proxyRequest.url,
    headers: proxyRequest.headers,
    body: proxyRequest.body || null,
  });

  return true;
}

const pendingRequests = new Map();

function waitForProxyResponse(requestId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Proxy response timeout'));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, timer });
  });
}

function handleProxyResponse(ws, msg) {
  const pending = pendingRequests.get(msg.requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRequests.delete(msg.requestId);
  pending.resolve(msg.response);
}

const { ingestPriceSignal } = require('../services/pricingPipeline');

function handlePriceSignal(hostId, sessionId, data) {
  if (!data) return;

  ingestPriceSignal({ ...data, sessionId, hostId }).catch(err => {
    console.error('[ws] Failed to ingest price signal:', err.message);
  });
}

function sendToHost(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function notifyHostOfClaim(sessionId, buyerInfo) {
  const ws = sessionToSocket.get(sessionId);
  if (!ws) return false;

  sendToHost(ws, {
    type: 'session_claimed',
    sessionId,
    tier: buyerInfo.tier,
    message: 'A buyer has claimed your session',
  });

  return true;
}

function parseBrowserName(ua) {
  if (!ua) return 'unknown';
  const lower = ua.toLowerCase();
  if (lower.includes('edg/') || lower.includes('edge/')) return 'edge';
  if (lower.includes('chrome')) return 'chrome';
  if (lower.includes('firefox')) return 'firefox';
  if (lower.includes('safari')) return 'safari';
  return 'other';
}

function getPoolStats() {
  return {
    connectedHosts: connectedHosts.size,
    sessions: Array.from(connectedHosts.values()).map(s => ({
      id: s.id,
      geo: s.geo,
      browser: s.browser,
      status: s.status,
    })),
  };
}

module.exports = {
  setupHostWebSocket,
  routeToHost,
  waitForProxyResponse,
  notifyHostOfClaim,
  getPoolStats,
};
