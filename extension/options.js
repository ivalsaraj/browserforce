const RELAY_URL_DEFAULT = 'ws://127.0.0.1:19222/extension';
const POLL_INTERVAL_MS = 1000;
const MAX_RENDERED_ENTRIES = 10000;

const relayUrlEl = document.getElementById('bf-relay-url');
const relayHealthEl = document.getElementById('bf-relay-health');
const connSummaryEl = document.getElementById('bf-conn-summary');
const clientsEl = document.getElementById('bf-clients');
const logSummaryEl = document.getElementById('bf-log-summary');
const lastUpdatedEl = document.getElementById('bf-last-updated');
const errorEl = document.getElementById('bf-error');
const entryCountEl = document.getElementById('bf-entry-count');
const rowsEl = document.getElementById('bf-log-rows');
const detailsEl = document.getElementById('bf-entry-details');
const refreshBtn = document.getElementById('bf-refresh');
const pauseBtn = document.getElementById('bf-pause');
const clearBtn = document.getElementById('bf-clear');

const state = {
  relayWsUrl: RELAY_URL_DEFAULT,
  relayHttpBase: wsToHttpBase(RELAY_URL_DEFAULT),
  timer: null,
  inFlight: false,
  paused: false,
  lastSeq: 0,
  entries: [],
  selectedSeq: null,
};

chrome.storage.local.get(['relayUrl'], (stored) => {
  const relayUrl = stored.relayUrl || RELAY_URL_DEFAULT;
  state.relayWsUrl = relayUrl;
  state.relayHttpBase = wsToHttpBase(relayUrl);
  relayUrlEl.textContent = state.relayHttpBase;
  pollOnce();
});

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.relayUrl) return;
  const nextRelay = changes.relayUrl.newValue || RELAY_URL_DEFAULT;
  state.relayWsUrl = nextRelay;
  state.relayHttpBase = wsToHttpBase(nextRelay);
  relayUrlEl.textContent = state.relayHttpBase;
  state.lastSeq = 0;
  state.entries = [];
  state.selectedSeq = null;
  renderEntries();
  pollOnce();
});

refreshBtn.addEventListener('click', () => {
  pollOnce();
});

pauseBtn.addEventListener('click', () => {
  state.paused = !state.paused;
  pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
  if (state.paused) {
    stopPolling();
  } else if (!document.hidden) {
    startPolling();
    pollOnce();
  }
});

clearBtn.addEventListener('click', () => {
  state.entries = [];
  state.selectedSeq = null;
  renderEntries();
  detailsEl.textContent = 'Select a row to inspect full JSON payload.';
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  if (!state.paused) {
    startPolling();
    pollOnce();
  }
});

window.addEventListener('beforeunload', () => {
  stopPolling();
});

relayUrlEl.textContent = state.relayHttpBase;
startPolling();
pollOnce();

function wsToHttpBase(wsUrl) {
  try {
    const parsed = new URL(wsUrl);
    const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${protocol}//${parsed.host}`;
  } catch {
    return 'http://127.0.0.1:19222';
  }
}

function startPolling() {
  if (state.timer || state.paused) return;
  state.timer = setInterval(() => {
    if (state.inFlight) return;
    pollOnce();
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}

async function pollOnce() {
  if (state.inFlight) return;
  state.inFlight = true;

  try {
    const [status, logs] = await Promise.all([
      fetchJson('/logs/status'),
      fetchJson(`/logs/cdp?after=${state.lastSeq}&limit=500`),
    ]);

    if (logs.resetRequired) {
      state.entries = [];
      state.selectedSeq = null;
      detailsEl.textContent = 'Log buffer rotated. Showing current buffered entries.';
    }

    if (Array.isArray(logs.entries) && logs.entries.length > 0) {
      state.entries.push(...logs.entries);
      if (state.entries.length > MAX_RENDERED_ENTRIES) {
        state.entries.splice(0, state.entries.length - MAX_RENDERED_ENTRIES);
      }
    }

    state.lastSeq = logs.latestSeq || state.lastSeq;
    renderStatus(status);
    renderEntries();
    setError('');
  } catch (err) {
    setError(err.message || String(err));
  } finally {
    state.inFlight = false;
  }
}

async function fetchJson(pathname) {
  const response = await fetch(`${state.relayHttpBase}${pathname}`, {
    method: 'GET',
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed (${response.status}): ${body || response.statusText}`);
  }

  return response.json();
}

function renderStatus(status) {
  const ext = status.extension?.connected
    ? `Extension connected (${status.extension.origin || 'unknown origin'})`
    : 'Extension disconnected';
  relayHealthEl.textContent = `${ext} • targets: ${status.targets}`;

  connSummaryEl.textContent = `${status.clients.count} active CDP client(s)`;
  clientsEl.innerHTML = '';
  const clients = status.clients.items || [];
  if (clients.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No active clients.';
    clientsEl.appendChild(li);
  } else {
    for (const client of clients) {
      const li = document.createElement('li');
      const origin = client.origin || 'no origin';
      const label = client.label || 'unlabeled';
      li.textContent = `${label} (${client.id}) • ${origin}`;
      clientsEl.appendChild(li);
    }
  }

  const counts = status.logs.directionCounts;
  logSummaryEl.textContent = `from-playwright ${counts.fromPlaywright} • to-playwright ${counts.toPlaywright} • from-extension ${counts.fromExtension} • to-extension ${counts.toExtension}`;
  lastUpdatedEl.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

function renderEntries() {
  entryCountEl.textContent = `${state.entries.length} entries`;

  if (state.entries.length === 0) {
    rowsEl.innerHTML = '<tr><td colspan="6" class="empty">No logs yet.</td></tr>';
    return;
  }

  rowsEl.innerHTML = '';
  for (const entry of state.entries) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    if (state.selectedSeq === entry.seq) row.classList.add('active');

    const method = entry.message?.method || 'response';
    const sessionId = entry.message?.sessionId || '';
    const time = formatTime(entry.timestamp);

    row.innerHTML = [
      `<td class="mono">${entry.seq}</td>`,
      `<td class="mono">${time}</td>`,
      `<td>${entry.direction}</td>`,
      `<td class="mono">${escapeHtml(entry.clientLabel || entry.clientId || '-')}</td>`,
      `<td class="mono">${escapeHtml(method)}</td>`,
      `<td class="mono">${escapeHtml(sessionId)}</td>`,
    ].join('');

    row.addEventListener('click', () => {
      state.selectedSeq = entry.seq;
      detailsEl.textContent = JSON.stringify(entry, null, 2);
      renderEntries();
    });

    rowsEl.appendChild(row);
  }
}

function formatTime(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

function setError(message) {
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = '';
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}
