/**
 * extension/background.js
 *
 * Roxy Extension — Service Worker (Manifest V3)
 *
 * Manages WebSocket connection to gateway, session state machine,
 * proxy request forwarding, price signal detection, and keepalive.
 */

const STATES = {
  IDLE:       'idle',
  CONNECTING: 'connecting',
  AVAILABLE:  'available',
  CLAIMED:    'claimed',
  ACTIVE:     'active',
};

let state = STATES.IDLE;
let ws = null;
let currentSessionId = null;
let authToken = null;
let gatewayUrl = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

const MAX_RECONNECT_DELAY_MS = 30000;

async function init() {
  const stored = await chrome.storage.local.get([
    'authToken', 'gatewayUrl', 'isLive', 'sessionId',
  ]);

  authToken = stored.authToken || null;
  gatewayUrl = stored.gatewayUrl || 'wss://localhost:10000/ws/host';
  currentSessionId = stored.sessionId || null;

  if (stored.isLive && authToken) {
    console.log('[bg] SW woke with isLive=true — reconnecting');
    connect();
  }
}

function connect() {
  if (!authToken) {
    console.warn('[bg] Cannot connect: no auth token');
    updateState(STATES.IDLE);
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log('[bg] Already connected or connecting');
    return;
  }

  updateState(STATES.CONNECTING);
  broadcastToPopup({ type: 'state', state: STATES.CONNECTING });

  const url = `${gatewayUrl}?token=${encodeURIComponent(authToken)}&geo=US`;

  console.log('[bg] Connecting to gateway:', gatewayUrl);

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error('[bg] WebSocket construction error:', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[bg] WebSocket connected');
    reconnectAttempts = 0;
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn('[bg] Malformed WS message:', event.data);
      return;
    }
    handleGatewayMessage(msg);
  };

  ws.onclose = (event) => {
    console.log(`[bg] WebSocket closed — code=${event.code} reason=${event.reason}`);
    ws = null;
    currentSessionId = null;
    chrome.storage.local.set({ sessionId: null });

    chrome.storage.local.get('isLive', (stored) => {
      if (stored.isLive) {
        scheduleReconnect();
      } else {
        updateState(STATES.IDLE);
      }
    });
  };

  ws.onerror = (err) => {
    console.error('[bg] WebSocket error:', err);
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close(1000, 'Host went offline');
    ws = null;
  }
  currentSessionId = null;
  updateState(STATES.IDLE);
  chrome.storage.local.set({ isLive: false, sessionId: null });
  broadcastToPopup({ type: 'state', state: STATES.IDLE });
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);

  console.log(`[bg] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  updateState(STATES.CONNECTING);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleGatewayMessage(msg) {
  console.log('[bg] Gateway message:', msg.type);

  switch (msg.type) {
    case 'session_registered':
      currentSessionId = msg.sessionId;
      chrome.storage.local.set({ sessionId: msg.sessionId });
      updateState(STATES.AVAILABLE);
      broadcastToPopup({ type: 'session_registered', sessionId: msg.sessionId });
      console.log(`[bg] Session registered: ${msg.sessionId}`);
      break;

    case 'session_claimed':
      updateState(STATES.CLAIMED);
      broadcastToPopup({
        type: 'session_claimed',
        tier: msg.tier,
        sessionId: msg.sessionId,
      });
      console.log(`[bg] Session claimed by a ${msg.tier} buyer`);
      break;

    case 'proxy_request':
      handleProxyRequest(msg);
      break;

    case 'ping':
      sendToGateway({ type: 'pong' });
      break;

    case 'pong':
      break;

    default:
      console.warn('[bg] Unknown message type from gateway:', msg.type);
  }
}

async function handleProxyRequest(msg) {
  const { requestId, method, url: targetUrl, headers: inboundHeaders, body } = msg;

  updateState(STATES.ACTIVE);

  const { blockedDomains } = await chrome.storage.local.get('blockedDomains');
  if (blockedDomains && blockedDomains.length > 0) {
    try {
      const targetHost = new URL(targetUrl).hostname;
      const isBlocked = blockedDomains.some(domain =>
        targetHost === domain || targetHost.endsWith(`.${domain}`)
      );
      if (isBlocked) {
        console.log(`[bg] Blocked request to ${targetHost}`);
        sendToGateway({
          type: 'proxy_response',
          requestId,
          response: {
            status: 403,
            statusText: 'Forbidden',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Domain blocked by host' }),
          },
        });
        return;
      }
    } catch (e) {
      console.warn('[bg] Invalid target URL:', targetUrl);
      sendProxyError(requestId, 400, 'Invalid URL');
      return;
    }
  }

  const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
    'x-roxy-token', 'x-roxy-session',
  ]);

  const safeHeaders = {};
  if (inboundHeaders) {
    for (const [k, v] of Object.entries(inboundHeaders)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) {
        safeHeaders[k] = v;
      }
    }
  }

  let response;
  try {
    const fetchOptions = {
      method: method || 'GET',
      headers: safeHeaders,
      redirect: 'follow',
      credentials: 'omit',
    };

    if (body && !['GET', 'HEAD'].includes(method)) {
      fetchOptions.body = body;
    }

    response = await fetch(targetUrl, fetchOptions);
  } catch (err) {
    console.error('[bg] fetch error for', targetUrl, err.message);
    sendProxyError(requestId, 502, `Fetch failed: ${err.message}`);
    updateState(STATES.CLAIMED);
    return;
  }

  const STRIP_RESPONSE = new Set(['set-cookie', 'www-authenticate', 'proxy-authenticate']);
  const responseHeaders = {};
  response.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) {
      responseHeaders[key] = value;
    }
  });

  detectAndSendPriceSignal(targetUrl, responseHeaders);

  let responseBody;
  try {
    const arrayBuffer = await response.arrayBuffer();
    responseBody = bufferToBase64(arrayBuffer);
  } catch (e) {
    responseBody = '';
  }

  sendToGateway({
    type: 'proxy_response',
    requestId,
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      encoding: 'base64',
    },
  });

  updateState(STATES.CLAIMED);
}

function sendProxyError(requestId, status, message) {
  sendToGateway({
    type: 'proxy_response',
    requestId,
    response: {
      status,
      statusText: message,
      headers: { 'Content-Type': 'application/json' },
      body: btoa(JSON.stringify({ error: message })),
      encoding: 'base64',
    },
  });
}

function detectAndSendPriceSignal(url, headers) {
  const priceHeader = headers['x-price'] || headers['x-product-price'];
  if (priceHeader) {
    const price = parseFloat(priceHeader);
    if (!isNaN(price) && price > 0) {
      sendToGateway({
        type: 'price_signal',
        data: {
          url_pattern: url,
          price: Math.round(price * 100),
          currency: headers['x-currency'] || 'USD',
          timestamp: new Date().toISOString(),
        },
      });
    }
  }
}

function sendToGateway(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function updateState(newState) {
  state = newState;
  console.log('[bg] State →', newState);
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'go_live':
      authToken = message.token;
      if (message.gatewayUrl) gatewayUrl = message.gatewayUrl;
      chrome.storage.local.set({ authToken, gatewayUrl, isLive: true });
      connect();
      sendResponse({ state: STATES.CONNECTING });
      break;

    case 'go_offline':
      disconnect();
      sendResponse({ state: STATES.IDLE });
      break;

    case 'get_status':
      sendResponse({
        state,
        sessionId: currentSessionId,
        connected: ws?.readyState === WebSocket.OPEN,
      });
      break;

    case 'get_earnings':
      fetchEarnings().then(earnings => sendResponse(earnings)).catch(() => sendResponse(null));
      return true;

    default:
      console.warn('[bg] Unknown message from popup:', message.type);
  }

  return true;
});

async function fetchEarnings() {
  if (!authToken) return null;

  const stored = await chrome.storage.local.get('apiBaseUrl');
  const apiBase = stored.apiBaseUrl || 'http://localhost:3000';

  try {
    const res = await fetch(`${apiBase}/api/earnings`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

chrome.alarms.create('roxy_keepalive', { periodInMinutes: 0.4 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'roxy_keepalive') return;

  chrome.storage.local.get('isLive', (stored) => {
    if (!stored.isLive) return;

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      console.log('[bg] Alarm: reconnecting dead WSS');
      if (!reconnectTimer) connect();
    } else if (ws.readyState === WebSocket.OPEN) {
      sendToGateway({ type: 'ping' });
    }
  });
});

init();
