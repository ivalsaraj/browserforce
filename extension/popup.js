// BrowserForce — Popup UI

const RELAY_URL_DEFAULT = 'ws://127.0.0.1:19222/extension';

const statusEl = document.getElementById('bf-status');
const statusTextEl = document.getElementById('bf-status-text');
const relayUrlInput = document.getElementById('bf-relay-url');
const saveUrlBtn = document.getElementById('bf-save-url');
const tabCountEl = document.getElementById('bf-tab-count');
const tabsListEl = document.getElementById('bf-tabs-list');
const memoryEl = document.getElementById('bf-memory');
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
    setMemory(response.memory);
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

function setMemory(memory) {
  if (!memory) {
    memoryEl.innerHTML = '<span class="memory-na">Not available</span>';
    return;
  }

  const used = formatBytes(memory.usedJSHeapSize);
  const total = formatBytes(memory.totalJSHeapSize);
  const pct = Math.round((memory.usedJSHeapSize / memory.totalJSHeapSize) * 100);

  memoryEl.innerHTML = `
    <div class="memory-bar-track">
      <div class="memory-bar-fill" style="width: ${pct}%"></div>
    </div>
    <div class="memory-text">${used} / ${total} (${pct}%)</div>
  `;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Refresh every second while popup is open
refreshStatus();
setInterval(refreshStatus, 1000);
