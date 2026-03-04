/**
 * extension/options.js
 *
 * Roxy Options Page — Settings Controller
 */

'use strict';

const gatewayUrlInput   = document.getElementById('gatewayUrl');
const apiBaseUrlInput   = document.getElementById('apiBaseUrl');
const blockedDomainsEl  = document.getElementById('blockedDomains');
const scheduleStartEl   = document.getElementById('scheduleStart');
const scheduleEndEl     = document.getElementById('scheduleEnd');
const minPayoutEl       = document.getElementById('minPayout');
const saveBtn           = document.getElementById('saveBtn');
const saveStatus        = document.getElementById('saveStatus');
const signOutBtn        = document.getElementById('signOutBtn');

const dayCheckboxes = Array.from(document.querySelectorAll('#scheduleDays input[type="checkbox"]'));

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get([
    'gatewayUrl', 'apiBaseUrl', 'blockedDomains', 'schedule', 'minPayout',
  ]);

  gatewayUrlInput.value = stored.gatewayUrl || 'wss://localhost:10000/ws/host';
  apiBaseUrlInput.value = stored.apiBaseUrl || 'http://localhost:3000';

  if (stored.blockedDomains && Array.isArray(stored.blockedDomains)) {
    blockedDomainsEl.value = stored.blockedDomains.join('\n');
  }

  if (stored.schedule) {
    if (Array.isArray(stored.schedule.days)) {
      dayCheckboxes.forEach(cb => {
        cb.checked = stored.schedule.days.includes(cb.value);
      });
    }
    if (stored.schedule.start) scheduleStartEl.value = stored.schedule.start;
    if (stored.schedule.end)   scheduleEndEl.value   = stored.schedule.end;
  }

  if (stored.minPayout !== undefined) {
    minPayoutEl.value = stored.minPayout;
  }
});

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;

  const blockedRaw = blockedDomainsEl.value;
  const blockedDomains = blockedRaw
    .split('\n')
    .map(d => d.trim().toLowerCase())
    .filter(d => d.length > 0 && isValidDomain(d));

  const selectedDays = dayCheckboxes
    .filter(cb => cb.checked)
    .map(cb => cb.value);

  const minPayout = Math.max(1, parseInt(minPayoutEl.value || '10', 10));

  const settings = {
    gatewayUrl:   gatewayUrlInput.value.trim() || 'wss://localhost:10000/ws/host',
    apiBaseUrl:   apiBaseUrlInput.value.trim() || 'http://localhost:3000',
    blockedDomains,
    schedule: {
      days:  selectedDays,
      start: scheduleStartEl.value || '09:00',
      end:   scheduleEndEl.value   || '22:00',
    },
    minPayout,
  };

  await chrome.storage.local.set(settings);

  chrome.runtime.sendMessage({ type: 'settings_updated', settings }).catch(() => {});

  saveStatus.style.display = 'inline';
  setTimeout(() => { saveStatus.style.display = 'none'; }, 2500);
  saveBtn.disabled = false;
});

signOutBtn.addEventListener('click', async () => {
  if (!confirm('Sign out of Roxy on this device?')) return;

  chrome.runtime.sendMessage({ type: 'go_offline' }).catch(() => {});
  await chrome.storage.local.remove(['authToken', 'hostEmail', 'hostId', 'sessionId', 'isLive']);

  signOutBtn.textContent = 'Signed out';
  signOutBtn.disabled = true;

  setTimeout(() => window.close(), 1200);
});

function isValidDomain(domain) {
  if (domain.includes('://') || domain.includes('/')) return false;
  if (!domain.includes('.')) return false;
  return /^[a-z0-9][a-z0-9\-\.]*[a-z0-9]$/.test(domain);
}
