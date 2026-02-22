// BrowserForce — Popup UI

const RELAY_URL_DEFAULT = 'ws://127.0.0.1:19222/extension';

const statusEl = document.getElementById('bf-status');
const statusTextEl = document.getElementById('bf-status-text');
const relayUrlInput = document.getElementById('bf-relay-url');
const saveUrlBtn = document.getElementById('bf-save-url');
const tabCountEl = document.getElementById('bf-tab-count');
const tabsListEl = document.getElementById('bf-tabs-list');
const autoTimerEl = document.getElementById('bf-auto-timer');
const autoDetachSelect = document.getElementById('bf-auto-detach');
const autoCloseSelect = document.getElementById('bf-auto-close');

// Load saved relay URL
chrome.storage.local.get(['relayUrl', 'autoDetachMinutes', 'autoCloseMinutes'], (result) => {
  relayUrlInput.value = result.relayUrl || RELAY_URL_DEFAULT;
  autoDetachSelect.value = String(result.autoDetachMinutes || 0);
  autoCloseSelect.value = String(result.autoCloseMinutes || 0);
});

// Save relay URL
saveUrlBtn.addEventListener('click', () => {
  const url = relayUrlInput.value.trim();
  if (!url) return;
  chrome.storage.local.set({ relayUrl: url }, () => {
    saveUrlBtn.textContent = 'Saved';
    setTimeout(() => { saveUrlBtn.textContent = 'Save'; }, 1200);
  });
});

autoDetachSelect.addEventListener('change', () => {
  chrome.storage.local.set({ autoDetachMinutes: Number(autoDetachSelect.value) });
});

autoCloseSelect.addEventListener('change', () => {
  chrome.storage.local.set({ autoCloseMinutes: Number(autoCloseSelect.value) });
});

// Poll status from background
function refreshStatus() {
  // Use message passing to get state from service worker
  chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('disconnected', 'Service worker inactive');
      setTabs([]);
      return;
    }

    setStatus(response.connectionState, response.connectionState);
    setTabs(response.tabs || []);
    setAutoTimer(response.nextAutoActionSecs);
  });
}

function setStatus(state, text) {
  statusEl.className = `status ${state}`;
  statusTextEl.textContent = text.charAt(0).toUpperCase() + text.slice(1);
}

function setTabs(tabs) {
  tabCountEl.textContent = tabs.length;

  if (tabs.length === 0) {
    tabsListEl.innerHTML = '<div class="empty">No tabs attached</div>';
    return;
  }

  tabsListEl.innerHTML = tabs
    .map((t) => `
      <div class="tab-item">
        <div class="tab-title">${escapeHtml(t.title || 'Untitled')}</div>
        <div class="tab-url">${escapeHtml(t.url || '')}</div>
      </div>
    `)
    .join('');
}

function setAutoTimer(secs) {
  if (secs == null) {
    autoTimerEl.textContent = '';
    return;
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  autoTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Refresh every second while popup is open
refreshStatus();
setInterval(refreshStatus, 1000);
