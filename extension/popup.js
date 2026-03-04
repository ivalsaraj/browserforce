// BrowserForce — Popup UI

const RELAY_URL_DEFAULT = 'ws://127.0.0.1:19222/extension';

// Auto-generated instruction lines per restriction
const RESTRICTION_LINES = {
  lockUrl: '- Do not navigate away from the current page URL. Refreshing is allowed.',
  noNewTabs: '- Do not create new tabs. Only work with the attached tab(s).',
  readOnly: '- Do not click, type, or submit forms. Only observe using snapshot/screenshot/evaluate.',
};

// --- DOM refs ---

const statusEl = document.getElementById('bf-status');
const statusTextEl = document.getElementById('bf-status-text');
const mcpClientsEl = document.getElementById('bf-mcp-clients');
const autoModeNoteEl = document.getElementById('bf-auto-mode-note');
const relayUrlInput = document.getElementById('bf-relay-url');
const saveUrlBtn = document.getElementById('bf-save-url');
const tabCountEl = document.getElementById('bf-tab-count');
const tabsListEl = document.getElementById('bf-tabs-list');
const autoTimerEl = document.getElementById('bf-auto-timer');
const attachBtn = document.getElementById('bf-attach-tab');
const openAgentBtn = document.getElementById('bf-open-agent');
const openLogsBtn = document.getElementById('bf-open-logs');
const modeSelect = document.getElementById('bf-mode');
const executionModeSelect = document.getElementById('bf-execution-mode');
const parallelVisibilitySelect = document.getElementById('bf-parallel-visibility');
const lockUrlCb = document.getElementById('bf-lock-url');
const noNewTabsCb = document.getElementById('bf-no-new-tabs');
const readOnlyCb = document.getElementById('bf-read-only');
const autoDetachSelect = document.getElementById('bf-auto-detach');
const autoCloseSelect = document.getElementById('bf-auto-close');
const instructionsEl = document.getElementById('bf-instructions');

// --- Tab Navigation ---

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// --- Load Settings ---

const SETTINGS_KEYS = [
  'relayUrl', 'autoDetachMinutes', 'autoCloseMinutes',
  'mode', 'lockUrl', 'noNewTabs', 'readOnly', 'userInstructions',
  'executionMode', 'parallelVisibilityMode',
];

chrome.storage.local.get(SETTINGS_KEYS, (s) => {
  relayUrlInput.value = s.relayUrl || RELAY_URL_DEFAULT;
  autoDetachSelect.value = String(s.autoDetachMinutes || 0);
  autoCloseSelect.value = String(s.autoCloseMinutes || 0);
  modeSelect.value = s.mode || 'auto';
  executionModeSelect.value = s.executionMode || 'parallel';
  parallelVisibilitySelect.value = s.parallelVisibilityMode || 'foreground-tab';
  lockUrlCb.checked = !!s.lockUrl;
  noNewTabsCb.checked = !!s.noNewTabs;
  readOnlyCb.checked = !!s.readOnly;
  instructionsEl.value = s.userInstructions || '';
  setAutoModeState(s.mode || 'auto');
});

// --- Save Handlers ---

function setSaveUrlFeedback(label, disabled) {
  saveUrlBtn.textContent = label;
  saveUrlBtn.disabled = !!disabled;
}

saveUrlBtn.addEventListener('click', () => {
  const url = relayUrlInput.value.trim();
  if (!url) return;
  setSaveUrlFeedback('Connecting...', true);
  setStatus('connecting', 'connecting');

  chrome.runtime.sendMessage({ type: 'updateRelayUrl', relayUrl: url }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setSaveUrlFeedback('Connection failed', false);
      setStatus('disconnected', 'connection failed');
      setTimeout(() => setSaveUrlFeedback('Save', false), 1800);
      return;
    }

    if (response.error) {
      setSaveUrlFeedback('Connection failed', false);
      setStatus('disconnected', response.error);
      setTimeout(() => {
        setSaveUrlFeedback('Save', false);
        refreshStatus();
      }, 1800);
      return;
    }

    setSaveUrlFeedback('Connected', false);
    setStatus(response.connectionState || 'connected', response.connectionState || 'connected');
    setTimeout(() => {
      setSaveUrlFeedback('Save', false);
      refreshStatus();
    }, 1200);
  });
});

modeSelect.addEventListener('change', () => {
  chrome.storage.local.set({ mode: modeSelect.value });
  setAutoModeState(modeSelect.value);
});

executionModeSelect.addEventListener('change', () => {
  chrome.storage.local.set({ executionMode: executionModeSelect.value });
});

parallelVisibilitySelect.addEventListener('change', () => {
  chrome.storage.local.set({ parallelVisibilityMode: parallelVisibilitySelect.value });
});

autoDetachSelect.addEventListener('change', () => {
  chrome.storage.local.set({ autoDetachMinutes: Number(autoDetachSelect.value) });
});

autoCloseSelect.addEventListener('change', () => {
  chrome.storage.local.set({ autoCloseMinutes: Number(autoCloseSelect.value) });
});

// --- Restriction Toggles with Auto-Fill ---

// Separator between auto-generated and user lines
const AUTO_MARKER = '---';

function updateInstructions() {
  const autoLines = [];
  if (lockUrlCb.checked) autoLines.push(RESTRICTION_LINES.lockUrl);
  if (noNewTabsCb.checked) autoLines.push(RESTRICTION_LINES.noNewTabs);
  if (readOnlyCb.checked) autoLines.push(RESTRICTION_LINES.readOnly);

  // Extract user lines (everything after the marker, or everything if no marker)
  const current = instructionsEl.value;
  const markerIdx = current.indexOf(AUTO_MARKER);
  const userPart = markerIdx !== -1
    ? current.slice(markerIdx + AUTO_MARKER.length).trim()
    : current.trim();

  // Rebuild: auto lines + marker + user lines
  const parts = [];
  if (autoLines.length > 0) {
    parts.push(autoLines.join('\n'));
    parts.push(AUTO_MARKER);
  }
  if (userPart) parts.push(userPart);

  const newValue = parts.join('\n');
  instructionsEl.value = newValue;
  chrome.storage.local.set({ userInstructions: newValue });
}

function onRestrictionToggle() {
  chrome.storage.local.set({
    lockUrl: lockUrlCb.checked,
    noNewTabs: noNewTabsCb.checked,
    readOnly: readOnlyCb.checked,
  });
  updateInstructions();
}

lockUrlCb.addEventListener('change', onRestrictionToggle);
noNewTabsCb.addEventListener('change', onRestrictionToggle);
readOnlyCb.addEventListener('change', onRestrictionToggle);

// Save user edits to instructions (debounced)
let instrTimeout;
instructionsEl.addEventListener('input', () => {
  clearTimeout(instrTimeout);
  instrTimeout = setTimeout(() => {
    chrome.storage.local.set({ userInstructions: instructionsEl.value });
  }, 500);
});

// --- Attach Current Tab ---

attachBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'attachCurrentTab' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      attachBtn.textContent = 'Failed';
    } else if (response.error) {
      attachBtn.textContent = response.error;
    } else {
      attachBtn.textContent = 'Attached!';
    }
    setTimeout(() => { attachBtn.textContent = '+ Attach Current Tab'; }, 1500);
  });
});

openAgentBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab?.windowId });
    window.close();
  } catch {
    openAgentBtn.textContent = 'Failed to open';
    setTimeout(() => { openAgentBtn.textContent = 'Open BrowserForce Agent'; }, 1500);
  }
});

openLogsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Status Polling ---

function refreshStatus() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('disconnected', 'Service worker inactive');
      setTabs([]);
      return;
    }

    setStatus(response.connectionState, response.connectionState);
    setTabs(response.tabs || []);
    setAutoTimer(response.nextAutoActionSecs);
    setMcpClientCount(response.mcpClientCount);
    setAutoModeState(response.mode || modeSelect.value || 'auto');
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
        <div class="tab-title-row">
          <span class="tab-title">${escapeHtml(t.title || 'Untitled')}</span>
          <button class="detach-btn" data-tab-id="${t.tabId}" title="Detach tab">×</button>
        </div>
        <div class="tab-url">${escapeHtml(t.url || '')}</div>
      </div>
    `)
    .join('');

  // Wire up detach buttons
  tabsListEl.querySelectorAll('.detach-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tabId = Number(btn.dataset.tabId);
      chrome.runtime.sendMessage({ type: 'detachTab', tabId }, () => {
        refreshStatus();
      });
    });
  });
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

function setMcpClientCount(count) {
  const safeCount = Number.isFinite(count) ? count : 0;
  mcpClientsEl.textContent = `MCP ${safeCount}`;
}

function setAutoModeState(mode) {
  if (!autoModeNoteEl) return;
  autoModeNoteEl.hidden = mode !== 'auto';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

refreshStatus();
setInterval(refreshStatus, 1000);
