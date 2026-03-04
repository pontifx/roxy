/**
 * extension/popup.js
 *
 * Roxy Popup — UI Controller
 */

'use strict';

const statusDot    = document.getElementById('statusDot');
const statusLabel  = document.getElementById('statusLabel');
const sessionInfo  = document.getElementById('sessionInfo');
const sessionIdEl  = document.getElementById('sessionId');
const activeSection = document.getElementById('activeSession');
const activeTierEl = document.getElementById('activeTier');
const activeSessionIdEl = document.getElementById('activeSessionId');
const earnToday    = document.getElementById('earnToday');
const earnWeek     = document.getElementById('earnWeek');
const earnAllTime  = document.getElementById('earnAllTime');
const loginPrompt  = document.getElementById('loginPrompt');
const actionSection = document.getElementById('actionSection');
const toggleBtn    = document.getElementById('toggleBtn');
const toggleLabel  = document.getElementById('toggleLabel');
const loginEmail   = document.getElementById('loginEmail');
const loginPassword = document.getElementById('loginPassword');
const loginBtn     = document.getElementById('loginBtn');
const loginError   = document.getElementById('loginError');

let isLoggedIn = false;
let isLive = false;

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['authToken', 'isLive', 'apiBaseUrl']);

  if (!stored.authToken) {
    showLoginUI();
    return;
  }

  isLoggedIn = true;
  isLive = stored.isLive || false;
  showMainUI();

  const status = await sendToBackground({ type: 'get_status' });
  if (status) {
    updateStatusUI(status.state);
  } else {
    updateStatusUI('idle');
  }

  loadEarnings(stored.authToken, stored.apiBaseUrl || 'http://localhost:3000');
});

loginBtn.addEventListener('click', async () => {
  const email = loginEmail.value.trim();
  const password = loginPassword.value;

  if (!email || !password) {
    showLoginError('Email and password are required');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';
  loginError.style.display = 'none';

  try {
    const stored = await chrome.storage.local.get('apiBaseUrl');
    const apiBase = stored.apiBaseUrl || 'http://localhost:3000';

    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, role: 'host' }),
    });

    const data = await res.json();

    if (!res.ok) {
      showLoginError(data.message || 'Login failed');
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
      return;
    }

    await chrome.storage.local.set({
      authToken: data.token,
      hostEmail: data.user.email,
      hostId: data.user.id,
    });

    isLoggedIn = true;
    showMainUI();
    updateStatusUI('idle');
    loadEarnings(data.token, apiBase);

  } catch (err) {
    showLoginError('Could not reach the Roxy gateway. Check your connection.');
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

loginPassword.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});

toggleBtn.addEventListener('click', async () => {
  if (toggleBtn.disabled) return;
  toggleBtn.disabled = true;

  if (!isLive) {
    const stored = await chrome.storage.local.get(['authToken', 'gatewayUrl']);
    if (!stored.authToken) {
      showLoginUI();
      return;
    }

    await sendToBackground({
      type: 'go_live',
      token: stored.authToken,
      gatewayUrl: stored.gatewayUrl || 'wss://localhost:10000/ws/host',
    });

    isLive = true;
    setToggleState(true);
    updateStatusUI('connecting');
  } else {
    await sendToBackground({ type: 'go_offline' });
    isLive = false;
    setToggleState(false);
    updateStatusUI('idle');
    sessionInfo.style.display = 'none';
    activeSection.style.display = 'none';
  }

  toggleBtn.disabled = false;
});

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'state':
      updateStatusUI(message.state);
      break;
    case 'session_registered':
      updateStatusUI('available');
      if (message.sessionId) {
        sessionIdEl.textContent = message.sessionId.slice(0, 20) + '…';
        sessionInfo.style.display = 'block';
      }
      break;
    case 'session_claimed':
      updateStatusUI('claimed');
      if (message.tier) {
        activeTierEl.textContent = message.tier.charAt(0).toUpperCase() + message.tier.slice(1);
      }
      if (message.sessionId) {
        activeSessionIdEl.textContent = message.sessionId.slice(0, 16) + '…';
      }
      activeSection.style.display = 'block';
      break;
    case 'session_released':
      updateStatusUI('available');
      activeSection.style.display = 'none';
      break;
  }
});

const STATE_LABELS = {
  idle:       'Offline',
  connecting: 'Connecting…',
  available:  'Live — Available',
  claimed:    'Live — Session Active',
  active:     'Live — Proxying',
};

function updateStatusUI(state) {
  statusDot.setAttribute('data-state', state);
  statusLabel.textContent = STATE_LABELS[state] || state;

  if (state !== 'idle' && state !== 'connecting') {
    isLive = true;
    setToggleState(true);
  }
}

function setToggleState(live) {
  isLive = live;
  toggleBtn.setAttribute('data-live', String(live));
  toggleLabel.textContent = live ? 'Go Offline' : 'Go Live';
}

function showMainUI() {
  loginPrompt.style.display = 'none';
  actionSection.style.display = 'block';
}

function showLoginUI() {
  loginPrompt.style.display = 'block';
  actionSection.style.display = 'none';
  isLive = false;
  setToggleState(false);
  updateStatusUI('idle');
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.style.display = 'block';
}

async function loadEarnings(token, apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/earnings`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return;

    const data = await res.json();

    earnAllTime.textContent = data.formatted?.total || '$0.00';
    earnToday.textContent = '$0.00';
    earnWeek.textContent = data.formatted?.session_fees || '$0.00';

  } catch (e) {
    console.warn('[popup] Failed to load earnings:', e.message);
  }
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}
