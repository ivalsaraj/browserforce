import { applyEvent, initialState, reduceState } from './agent-panel-state.js';
import {
  assignSessionRunId,
  classifyRunStepIcon,
  clearSessionRunId,
  formatContextUsage,
  getSessionRunId,
  renderInlineContent,
  shouldApplySessionSelection,
} from './agent-panel-runtime.js';

const state = {
  value: initialState,
  auth: null,
  modelPresets: [{ value: null, label: 'Default' }],
  currentRunBySession: {},
  initialTabAttachInFlight: false,
  initialTabAttachStarted: false,
  editingSessionId: null,
  sessionTitleDrafts: {},
  eventController: null,
  eventLoopToken: 0,
  sessionSelectionToken: 0,
  popover: 'none',
  status: {
    kind: 'info',
    text: 'Starting...',
  },
};

const statusEl = document.getElementById('bf-agent-status');
const statusIconEl = document.getElementById('bf-agent-status-icon');
const statusTextEl = document.getElementById('bf-agent-status-text');
const contextUsageEl = document.getElementById('bf-context-usage');
const modelTriggerBtn = document.getElementById('bf-model-trigger');
const modelLabelEl = document.getElementById('bf-model-label');
const sessionTriggerBtn = document.getElementById('bf-session-trigger');
const sessionLabelEl = document.getElementById('bf-session-label');
const newSessionBtn = document.getElementById('bf-new-session');
const popoverBackdropEl = document.getElementById('bf-popover-backdrop');
const modelPanelEl = document.getElementById('bf-model-panel');
const sessionPanelEl = document.getElementById('bf-session-panel');
const modelListEl = document.getElementById('bf-model-list');
const switchSessionListEl = document.getElementById('bf-switch-session-list');
const transcriptEl = document.getElementById('bf-transcript');
const chatFormEl = document.getElementById('bf-chat-form');
const chatInputEl = document.getElementById('bf-chat-input');
const stopRunBtn = document.getElementById('bf-stop-run');
const sendBtn = chatFormEl.querySelector('button[type="submit"]');
const tabAttachBannerEl = document.getElementById('bf-tab-attach-banner');
const tabAttachTextEl = document.getElementById('bf-tab-attach-text');
const attachCurrentTabBtn = document.getElementById('bf-attach-current-tab');
let tabAttachRefreshTimer = null;
let tabAttachRefreshToken = 0;

function getActiveSession() {
  return state.value.sessions.find((item) => item.sessionId === state.value.activeSessionId) || null;
}

function getActiveMessages() {
  return state.value.messagesBySession[state.value.activeSessionId] || [];
}

function getActiveRun() {
  const sessionId = state.value.activeSessionId;
  if (!sessionId) return null;
  const runId = getSessionRunId(state.currentRunBySession, sessionId);
  if (!runId) return null;
  return state.value.runs[runId] || null;
}

function isActiveRunInProgress() {
  const run = getActiveRun();
  return !!(run && !run.done);
}

function autoResizeInput() {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 160)}px`;
}

function syncComposerState() {
  const enabled = !chatInputEl.disabled;
  const hasText = chatInputEl.value.trim().length > 0;
  const runInProgress = isActiveRunInProgress();

  stopRunBtn.disabled = !enabled || !runInProgress;
  stopRunBtn.classList.toggle('active', enabled && runInProgress);
  sendBtn.disabled = !enabled || runInProgress || !hasText;
}

function syncStatusIndicator() {
  const runInProgress = isActiveRunInProgress();
  const hasError = state.status.kind === 'error';
  const text = hasError
    ? state.status.text
    : runInProgress
      ? 'Thinking...'
      : state.status.text;

  statusEl.classList.toggle('error', hasError);
  statusEl.classList.toggle('thinking', runInProgress && !hasError);
  statusEl.title = text || 'Ready';
  statusTextEl.textContent = text || '';
  statusIconEl.textContent = '';
}

function renderContextUsageChip() {
  if (!contextUsageEl) return;
  const sessionId = state.value.activeSessionId;
  const usage = sessionId ? state.value.latestUsageBySession?.[sessionId] : null;
  const formatted = formatContextUsage(usage || {});
  const note = state.initialTabAttachInFlight
    ? 'Attaching active tab...'
    : (formatted ? `Context: ${formatted}` : '');
  contextUsageEl.classList.toggle('hidden', !note);
  if (!note) {
    contextUsageEl.textContent = '';
    contextUsageEl.removeAttribute('title');
    return;
  }
  contextUsageEl.textContent = note;
  contextUsageEl.title = note;
}

function setStatus(kind, text) {
  state.status = { kind, text };
  syncStatusIndicator();
}

function setComposerEnabled(enabled) {
  chatInputEl.disabled = !enabled;
  autoResizeInput();
  syncComposerState();
}

function setTabAttachBannerState({
  hidden = true,
  text = 'Current tab is not connected',
  canAttach = false,
  busy = false,
} = {}) {
  if (!tabAttachBannerEl || !tabAttachTextEl || !attachCurrentTabBtn) return;
  tabAttachBannerEl.classList.toggle('hidden', !!hidden);
  if (hidden) return;
  tabAttachTextEl.textContent = text;
  attachCurrentTabBtn.disabled = busy || !canAttach;
  attachCurrentTabBtn.textContent = busy ? 'Attaching...' : 'Attach current tab';
}

function dispatch(action) {
  state.value = reduceState(state.value, action);
  render();
}

function dispatchEvent(evt) {
  state.value = applyEvent(state.value, evt);
  if (evt?.event === 'run.started' && evt.sessionId && evt.runId) {
    state.currentRunBySession = assignSessionRunId(state.currentRunBySession, evt.sessionId, evt.runId);
  }
  if (evt?.sessionId && evt?.runId && (evt.event === 'chat.final' || evt.event === 'run.error' || evt.event === 'run.aborted')) {
    state.currentRunBySession = clearSessionRunId(state.currentRunBySession, evt.sessionId, evt.runId);
  }
  render();
}

function formatModelLabel(model) {
  return model && String(model).trim() ? model : 'Default';
}

function isDefaultSessionTitle(title) {
  const lowered = String(title || '').trim().toLowerCase();
  return !lowered || lowered === 'new session' || lowered === 'new chat';
}

function formatShortSessionId(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw) return 'unknown';
  return raw.slice(0, 8);
}

function formatSessionDisplayName(session) {
  if (!session) return 'Session';
  const title = String(session.title || '').trim();
  if (!isDefaultSessionTitle(title)) return title;
  return session.sessionId || 'Session';
}

function formatSessionLabel(session) {
  if (!session) return 'Session';
  const title = String(session.title || '').trim();
  if (!isDefaultSessionTitle(title)) return title;
  return formatShortSessionId(session.sessionId);
}

function formatSessionTimestamp(session) {
  const raw = session?.updatedAt || session?.createdAt;
  if (!raw) return 'Unknown time';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderSelectors() {
  const activeSession = getActiveSession();
  const modelLabel = `Model: ${formatModelLabel(activeSession?.model)}`;
  const sessionLabel = formatSessionLabel(activeSession);

  if (modelLabelEl) {
    modelLabelEl.textContent = modelLabel;
  } else {
    modelTriggerBtn.textContent = modelLabel;
  }

  if (sessionLabelEl) {
    sessionLabelEl.textContent = sessionLabel;
  } else {
    sessionTriggerBtn.textContent = sessionLabel;
  }
}

function renderModelList() {
  const activeSession = getActiveSession();
  const activeModel = activeSession?.model || null;

  const rows = state.modelPresets.map((preset) => {
    const active = (preset.value || null) === activeModel ? 'active' : '';
    return `<li><button type="button" data-model="${escapeHtml(preset.value || '')}" class="popover-item ${active}"><span>${escapeHtml(preset.label)}</span></button></li>`;
  });
  rows.push('<li><button type="button" data-model-custom="1" class="popover-item custom-item"><span>Custom...</span></button></li>');

  modelListEl.innerHTML = rows.join('');

  modelListEl.querySelectorAll('button[data-model]').forEach((button) => {
    button.addEventListener('click', () => {
      const model = button.dataset.model || null;
      updateActiveSessionModel(model).catch((error) => {
        setStatus('error', error.message || 'Unable to update model');
      });
    });
  });

  const customBtn = modelListEl.querySelector('button[data-model-custom]');
  if (customBtn) {
    customBtn.addEventListener('click', async () => {
      const current = activeModel || '';
      const value = window.prompt('Enter model id', current);
      if (value === null) return;
      const model = value.trim() || null;
      try {
        await updateActiveSessionModel(model);
      } catch (error) {
        setStatus('error', error.message || 'Unable to update model');
      }
    });
  }
}

function renderSessions() {
  const sessions = state.value.sessions;
  if (!sessions.length) {
    switchSessionListEl.innerHTML = '<li class="empty-item">No sessions</li>';
    return;
  }

  switchSessionListEl.innerHTML = sessions
    .map((session) => {
      const active = session.sessionId === state.value.activeSessionId ? 'active' : '';
      const displayName = formatSessionDisplayName(session);
      const timestamp = formatSessionTimestamp(session);
      const shortId = formatShortSessionId(session.sessionId);
      const editing = session.sessionId === state.editingSessionId;
      const draftTitle = Object.prototype.hasOwnProperty.call(state.sessionTitleDrafts, session.sessionId)
        ? state.sessionTitleDrafts[session.sessionId]
        : (isDefaultSessionTitle(session.title) ? '' : String(session.title || '').trim());

      if (editing) {
        return `
          <li class="session-row editing">
            <form class="session-edit-form" data-session-edit-form="${escapeHtml(session.sessionId)}">
              <input
                type="text"
                data-session-edit-input="${escapeHtml(session.sessionId)}"
                value="${escapeHtml(draftTitle)}"
                placeholder="Session name"
                maxlength="180"
              >
              <button type="submit" class="session-edit-save">Save</button>
              <button type="button" class="session-edit-cancel" data-session-edit-cancel="${escapeHtml(session.sessionId)}">Cancel</button>
            </form>
          </li>
        `;
      }

      return `
        <li class="session-row">
          <button type="button" data-session-id="${escapeHtml(session.sessionId)}" class="popover-item session-item ${active}">
            <span class="session-main">${escapeHtml(displayName)}</span>
            <span class="session-meta">${escapeHtml(`${shortId} · ${timestamp}`)}</span>
          </button>
          <button type="button" class="session-edit-btn" data-session-edit-btn="${escapeHtml(session.sessionId)}" aria-label="Rename session" title="Rename session">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 20h9"></path>
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4 12.5-12.5z"></path>
            </svg>
          </button>
        </li>
      `;
    })
    .join('');

  switchSessionListEl.querySelectorAll('button[data-session-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      await selectSession(button.dataset.sessionId);
      setPopover('none');
    });
  });

  switchSessionListEl.querySelectorAll('button[data-session-edit-btn]').forEach((button) => {
    button.addEventListener('click', () => {
      beginSessionEdit(button.getAttribute('data-session-edit-btn') || '');
    });
  });

  switchSessionListEl.querySelectorAll('form[data-session-edit-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const sessionId = form.getAttribute('data-session-edit-form') || '';
      const input = form.querySelector('input[data-session-edit-input]');
      const title = input?.value || '';
      try {
        await updateSessionTitle(sessionId, title);
      } catch (error) {
        setStatus('error', error?.message || 'Unable to rename session');
      }
    });
  });

  switchSessionListEl.querySelectorAll('button[data-session-edit-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      cancelSessionEdit(button.getAttribute('data-session-edit-cancel') || '');
    });
  });

  switchSessionListEl.querySelectorAll('input[data-session-edit-input]').forEach((input) => {
    input.addEventListener('input', () => {
      const sessionId = input.getAttribute('data-session-edit-input') || '';
      state.sessionTitleDrafts = {
        ...(state.sessionTitleDrafts || {}),
        [sessionId]: input.value,
      };
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const sessionId = input.getAttribute('data-session-edit-input') || '';
      cancelSessionEdit(sessionId);
    });
  });
}

function normalizeRunTimeline(run, fallbackText = '') {
  if (!run) return [];
  if (Array.isArray(run.timeline) && run.timeline.length > 0) {
    return run.timeline.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (entry.type === 'text') return typeof entry.text === 'string' && entry.text.length > 0;
      if (entry.type === 'step') return typeof entry.label === 'string' && entry.label.trim().length > 0;
      return false;
    });
  }

  const steps = Array.isArray(run.steps) ? run.steps : [];
  const timeline = steps.map((step) => ({
    type: 'step',
    kind: step?.kind || 'reasoning',
    status: step?.status || 'running',
    label: step?.label || '',
  }));

  const text = typeof fallbackText === 'string' && fallbackText
    ? fallbackText
    : (typeof run.text === 'string' ? run.text : '');
  if (text) timeline.push({ type: 'text', text });
  return timeline;
}

function getLatestInFlightTimelineStepIndex(run, timeline) {
  if (!run || run.done) return -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.type !== 'step') continue;
    const status = String(entry.status || 'running').toLowerCase();
    if (status === 'running') return index;
  }
  return -1;
}

function renderRunTimeline(run, fallbackText = '') {
  const timeline = normalizeRunTimeline(run, fallbackText);
  if (!timeline.length) return '';
  const latestStepIndex = getLatestInFlightTimelineStepIndex(run, timeline);
  return `
    <div class="run-timeline">
      ${timeline.map((entry, index) => {
    if (entry.type === 'text') {
      return `<div class="bubble-assistant"><p>${renderContent(entry.text || '')}</p></div>`;
    }
    const status = entry?.status || 'running';
    const icon = classifyRunStepIcon(entry);
    const isLatest = index === latestStepIndex;
    const shouldPulse = isLatest && status === 'running';
    const classes = ['step-item', 'timeline-step', escapeHtml(status)];
    if (isLatest) classes.push('latest');
    if (shouldPulse) classes.push('pulse');
    return `<div class="${classes.join(' ')}"><span class="run-step-icon icon-${escapeHtml(icon)}" aria-hidden="true"></span><span class="step-label">${renderInlineContent(entry.label || 'Step')}</span></div>`;
  }).join('')}
    </div>
  `;
}

function renderContent(value) {
  return renderInlineContent(value);
}

function bindTranscriptHandlers() {
  // Transcript rows are static render output; no delegated actions required.
}

function renderTranscript() {
  const messages = getActiveMessages();
  const sessionId = state.value.activeSessionId;
  const sessionRunId = getSessionRunId(state.currentRunBySession, sessionId);
  const run = sessionRunId ? state.value.runs[sessionRunId] : null;

  const chunks = messages.map((msg) => {
    const role = msg.role || 'assistant';
    if (role === 'user') {
      return `
        <article class="message user">
          <div class="msg-meta"><span class="msg-author">You</span></div>
          <div class="bubble-user">${escapeHtml(msg.text || '')}</div>
        </article>
      `;
    }

    const messageRun = msg.runId ? state.value.runs[msg.runId] : null;
    const timelineHtml = renderRunTimeline(messageRun, msg.text || '');
    const fallbackHtml = `<div class="bubble-assistant"><p>${renderContent(msg.text || '')}</p></div>`;
    return `
      <article class="message assistant">
        <div class="msg-meta"><span class="msg-author">BrowserForce</span></div>
        <div class="msg-content-wrap">
          ${timelineHtml || fallbackHtml}
        </div>
      </article>
    `;
  });

  if (run && !run.done) {
    const timelineHtml = renderRunTimeline(run, run.text || '');
    const shouldShowThinking = !(run.text && run.text.trim());
    chunks.push(`
      <article class="message assistant">
        <div class="msg-meta"><span class="msg-author">BrowserForce</span></div>
        <div class="msg-content-wrap">
          ${timelineHtml}
          ${shouldShowThinking ? '<div class="thinking-bubble"><div class="spinner"></div><span>Thinking...</span></div>' : ''}
        </div>
      </article>
    `);
  }

  if (!chunks.length) {
    transcriptEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">B</div>
        <div>
          <p class="empty-title">Start a conversation</p>
          <p class="empty-sub">Ask BrowserForce to inspect your active tab or run a browser task.</p>
        </div>
      </div>
    `;
  } else {
    transcriptEl.innerHTML = chunks.join('');
  }

  bindTranscriptHandlers();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  syncStatusIndicator();
  syncComposerState();
}

function setPopover(popover) {
  state.popover = popover;
  renderPopovers();
}

function renderPopovers() {
  const modelOpen = state.popover === 'model';
  const sessionOpen = state.popover === 'session';
  const anyOpen = modelOpen || sessionOpen;

  modelTriggerBtn.setAttribute('aria-expanded', modelOpen ? 'true' : 'false');
  sessionTriggerBtn.setAttribute('aria-expanded', sessionOpen ? 'true' : 'false');
  popoverBackdropEl.classList.toggle('hidden', !anyOpen);
  modelPanelEl.classList.toggle('hidden', !modelOpen);
  sessionPanelEl.classList.toggle('hidden', !sessionOpen);
}

function render() {
  renderSelectors();
  renderContextUsageChip();
  renderModelList();
  renderSessions();
  renderTranscript();
  renderPopovers();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'runtime message failed'));
          return;
        }
        resolve(response || null);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function isIgnoredAttachError(errorMessage) {
  const text = String(errorMessage || '').toLowerCase();
  return (
    text.includes('already attached')
    || text.includes('cannot attach internal')
    || text.includes('no active tab')
  );
}

async function ensureCurrentTabAttached() {
  try {
    const response = await runtimeMessage({ type: 'attachCurrentTab' });
    if (response?.error && !isIgnoredAttachError(response.error)) {
      console.warn('[bf-agent] attachCurrentTab failed:', response.error);
    }
    return response || null;
  } catch {
    // best-effort only
    return null;
  }
}

function isTabAttachableUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  return !(
    value.startsWith('chrome://')
    || value.startsWith('chrome-extension://')
    || value.startsWith('edge://')
    || value.startsWith('devtools://')
  );
}

async function getCurrentTabAttachmentState() {
  if (!chrome?.tabs?.query) return { hidden: true };
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return { hidden: true };
  }
  if (!tab || typeof tab.id !== 'number') return { hidden: true };
  if (!isTabAttachableUrl(tab.url)) {
    return {
      hidden: false,
      text: 'This tab cannot be attached',
      canAttach: false,
    };
  }

  try {
    const status = await runtimeMessage({ type: 'getStatus' });
    if (status?.connectionState && status.connectionState !== 'connected') {
      return {
        hidden: false,
        text: 'Relay disconnected',
        canAttach: false,
      };
    }

    const attachedTabs = Array.isArray(status?.tabs) ? status.tabs : [];
    const attached = attachedTabs.some((item) => Number(item?.tabId) === tab.id);
    if (attached) return { hidden: true };
    return {
      hidden: false,
      text: 'Current tab is not connected',
      canAttach: true,
    };
  } catch {
    return {
      hidden: false,
      text: 'Unable to check tab connection',
      canAttach: false,
    };
  }
}

async function refreshTabAttachBanner() {
  const token = ++tabAttachRefreshToken;
  const next = await getCurrentTabAttachmentState();
  if (token !== tabAttachRefreshToken) return;
  setTabAttachBannerState(next);
}

function scheduleTabAttachRefresh(delayMs = 0) {
  if (tabAttachRefreshTimer) clearTimeout(tabAttachRefreshTimer);
  tabAttachRefreshTimer = setTimeout(() => {
    refreshTabAttachBanner().catch(() => {});
  }, delayMs);
}

function bindTabAttachWatchers() {
  if (chrome?.tabs?.onActivated?.addListener) {
    chrome.tabs.onActivated.addListener(() => {
      scheduleTabAttachRefresh(40);
    });
  }
  if (chrome?.tabs?.onUpdated?.addListener) {
    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      if (!tab?.active) return;
      if (!('status' in changeInfo) && !('url' in changeInfo) && !('title' in changeInfo)) return;
      scheduleTabAttachRefresh(80);
    });
  }
  if (chrome?.windows?.onFocusChanged?.addListener) {
    chrome.windows.onFocusChanged.addListener(() => {
      scheduleTabAttachRefresh(80);
    });
  }
}

function startInitialTabAttach() {
  if (state.initialTabAttachStarted) return;
  state.initialTabAttachStarted = true;
  state.initialTabAttachInFlight = true;
  renderContextUsageChip();
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      ensureCurrentTabAttached()
        .catch(() => {
          // best-effort only
        })
        .finally(() => {
          state.initialTabAttachInFlight = false;
          renderContextUsageChip();
        });
    }, 0);
  });
}

async function getActiveTabContext() {
  if (!chrome?.tabs?.query) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') return null;
    const title = String(tab.title || '').trim().slice(0, 180);
    const url = String(tab.url || '').trim();
    if (!isTabAttachableUrl(url)) {
      return { tabId: tab.id, title, url: null };
    }
    return { tabId: tab.id, title, url: url.slice(0, 500) };
  } catch {
    return null;
  }
}

async function getRelayHttpUrl() {
  const stored = await chrome.storage.local.get(['relayUrl']);
  const relayUrl = stored.relayUrl || 'ws://127.0.0.1:19222/extension';
  if (relayUrl.startsWith('ws://')) return relayUrl.replace('ws://', 'http://').replace('/extension', '');
  if (relayUrl.startsWith('wss://')) return relayUrl.replace('wss://', 'https://').replace('/extension', '');
  return 'http://127.0.0.1:19222';
}

async function loadAuth() {
  const relayHttpUrl = await getRelayHttpUrl();
  const extensionId = chrome?.runtime?.id;
  const res = await fetch(`${relayHttpUrl}/chatd-url`, {
    headers: extensionId ? { 'x-browserforce-extension-id': extensionId } : {},
  });
  if (!res.ok) throw new Error('daemon_unavailable');
  const body = await res.json();
  state.auth = {
    baseUrl: `http://127.0.0.1:${body.port}`,
    token: body.token,
  };
}

async function api(path, init = {}) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${state.auth.token}`,
    ...(init.headers || {}),
  };
  return fetch(`${state.auth.baseUrl}${path}`, { ...init, headers });
}

async function readJsonOrEmpty(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function ensureOk(response, fallbackMessage) {
  if (response.ok) return response;
  const body = await readJsonOrEmpty(response);
  throw new Error(body.error || `${fallbackMessage} (${response.status})`);
}

async function loadSessions(preferredSessionId = null) {
  const res = await api('/v1/sessions');
  await ensureOk(res, 'Failed to load sessions');
  const body = await readJsonOrEmpty(res);
  const sessions = body.sessions || [];
  const activeFromPreference = preferredSessionId && sessions.some((s) => s.sessionId === preferredSessionId)
    ? preferredSessionId
    : null;
  dispatch({
    type: 'session.list.loaded',
    sessions,
    activeSessionId: activeFromPreference || sessions[0]?.sessionId || null,
  });
}

function normalizeModelRows(input) {
  const source = Array.isArray(input) ? input : [];
  const seen = new Set(['__default__']);
  const rows = [{ value: null, label: 'Default' }];
  for (const row of source) {
    if (!row || typeof row !== 'object') continue;
    const value = row.value == null ? null : String(row.value).trim();
    const key = value || '__default__';
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      value,
      label: row.label && String(row.label).trim() ? String(row.label).trim() : (value || 'Default'),
    });
  }
  return rows;
}

async function loadModelPresets() {
  const res = await api('/v1/models', { method: 'GET', headers: {} });
  await ensureOk(res, 'Failed to load models');
  const body = await readJsonOrEmpty(res);
  state.modelPresets = normalizeModelRows(body.models);
}

async function loadMessages(sessionId) {
  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`, {
    method: 'GET',
    headers: {},
  });
  await ensureOk(res, 'Failed to load messages');
  const body = await readJsonOrEmpty(res);
  dispatch({ type: 'messages.loaded', sessionId, messages: body.messages || [] });
}

async function loadSessionMetadata(sessionId) {
  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'GET',
    headers: {},
  });
  await ensureOk(res, 'Failed to load session metadata');
  const session = await readJsonOrEmpty(res);
  dispatch({ type: 'session.metadata.loaded', sessionId, session });
}

async function selectSession(sessionId) {
  state.sessionSelectionToken += 1;
  const selectionToken = state.sessionSelectionToken;
  dispatch({ type: 'session.selected', sessionId });
  await loadMessages(sessionId);
  await loadSessionMetadata(sessionId);
  if (!shouldApplySessionSelection({
    requestToken: selectionToken,
    latestRequestToken: state.sessionSelectionToken,
    requestedSessionId: sessionId,
    activeSessionId: state.value.activeSessionId,
  })) {
    return;
  }
  connectEvents(sessionId);
}

async function createSession() {
  const res = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'New Session' }),
  });
  await ensureOk(res, 'Failed to create session');
  const created = await readJsonOrEmpty(res);
  await loadSessions(created.sessionId);
  await selectSession(created.sessionId);
}

function beginSessionEdit(sessionId) {
  if (!sessionId) return;
  const session = state.value.sessions.find((item) => item.sessionId === sessionId);
  if (!session) return;

  const current = isDefaultSessionTitle(session.title) ? '' : String(session.title || '').trim();
  state.editingSessionId = sessionId;
  state.sessionTitleDrafts = {
    ...(state.sessionTitleDrafts || {}),
    [sessionId]: current,
  };
  renderSessions();

  window.requestAnimationFrame(() => {
    const input = switchSessionListEl.querySelector(`input[data-session-edit-input="${sessionId}"]`);
    if (!input) return;
    input.focus();
    input.select();
  });
}

function cancelSessionEdit(sessionId) {
  if (!sessionId) return;
  state.editingSessionId = null;
  const nextDrafts = { ...(state.sessionTitleDrafts || {}) };
  delete nextDrafts[sessionId];
  state.sessionTitleDrafts = nextDrafts;
  renderSessions();
}

async function updateSessionTitle(sessionId, rawTitle) {
  const title = String(rawTitle || '').trim();
  if (!sessionId) return;
  if (!title) {
    throw new Error('Session name cannot be empty');
  }

  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: title }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to rename session');
  }

  state.editingSessionId = null;
  const nextDrafts = { ...(state.sessionTitleDrafts || {}) };
  delete nextDrafts[sessionId];
  state.sessionTitleDrafts = nextDrafts;

  const activeSessionId = state.value.activeSessionId || sessionId;
  await loadSessions(activeSessionId);
  setStatus('ready', 'Ready');
}

async function updateActiveSessionModel(model) {
  const sessionId = state.value.activeSessionId;
  if (!sessionId) return;

  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to update model');
  }

  await loadModelPresets().catch(() => {});
  await loadSessions(sessionId);
  setPopover('none');
  setStatus('ready', 'Ready');
}

async function consumeEventStream(body, loopToken) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (state.eventLoopToken === loopToken) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const evt = JSON.parse(line.slice(6));
          dispatchEvent(evt);
        } catch {
          // ignore malformed event
        }
      }
    }
  }
}

function connectEvents(sessionId) {
  state.eventLoopToken += 1;
  const loopToken = state.eventLoopToken;
  if (state.eventController) state.eventController.abort();

  (async () => {
    let backoffMs = 250;
    while (state.eventLoopToken === loopToken && state.value.activeSessionId === sessionId) {
      const controller = new AbortController();
      state.eventController = controller;

      try {
        const response = await fetch(
          `${state.auth.baseUrl}/v1/events?sessionId=${encodeURIComponent(sessionId)}`,
          {
            headers: { authorization: `Bearer ${state.auth.token}` },
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`Event stream failed (${response.status})`);
        }

        backoffMs = 250;
        await consumeEventStream(response.body, loopToken);
      } catch {
        if (controller.signal.aborted || state.eventLoopToken !== loopToken) break;
        const jitter = Math.floor(Math.random() * 150);
        await sleep(backoffMs + jitter);
        backoffMs = Math.min(backoffMs * 2, 4000);
      }
    }
  })().catch(() => {
    // no-op
  });
}

async function sendMessage(text) {
  const sessionId = state.value.activeSessionId;
  if (!sessionId || !text.trim()) return;

  const existing = getActiveMessages();
  dispatch({ type: 'messages.loaded', sessionId, messages: [...existing, { role: 'user', text }] });

  await ensureCurrentTabAttached();
  scheduleTabAttachRefresh(0);
  const browserContext = await getActiveTabContext();

  const res = await api('/v1/runs', {
    method: 'POST',
    body: JSON.stringify({ sessionId, message: text, browserContext }),
  });
  if (!res.ok) {
    dispatch({ type: 'messages.loaded', sessionId, messages: existing });
    const body = await readJsonOrEmpty(res);
    throw new Error(body.error || `Failed to send message (${res.status})`);
  }
  const body = await readJsonOrEmpty(res);
  if (body.runId) {
    state.currentRunBySession = assignSessionRunId(state.currentRunBySession, sessionId, body.runId);
  }
  render();
}

async function stopRun() {
  const sessionId = state.value.activeSessionId;
  const runId = getSessionRunId(state.currentRunBySession, sessionId);
  if (!runId) return;
  await api(`/v1/runs/${encodeURIComponent(runId)}/abort`, {
    method: 'DELETE',
    headers: {},
  });
}

chatFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInputEl.value;
  try {
    await sendMessage(text);
    chatInputEl.value = '';
    autoResizeInput();
    syncComposerState();
  } catch (error) {
    chatInputEl.value = text;
    syncComposerState();
    setStatus('error', error?.message || 'Failed to send message');
  }
});

chatInputEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  if (event.isComposing) return;
  event.preventDefault();
  if (sendBtn.disabled) return;
  chatFormEl.requestSubmit();
});

if (attachCurrentTabBtn) {
  attachCurrentTabBtn.addEventListener('click', async () => {
    setTabAttachBannerState({
      hidden: false,
      text: tabAttachTextEl?.textContent || 'Current tab is not connected',
      canAttach: false,
      busy: true,
    });
    const response = await ensureCurrentTabAttached();
    if (response?.error && !isIgnoredAttachError(response.error)) {
      setStatus('error', response.error || 'Unable to attach current tab');
    }
    scheduleTabAttachRefresh(0);
  });
}

chatInputEl.addEventListener('input', () => {
  autoResizeInput();
  syncComposerState();
});

newSessionBtn.addEventListener('click', () => {
  createSession()
    .then(() => setPopover('none'))
    .catch((err) => setStatus('error', err.message || 'Unable to create session'));
});

stopRunBtn.addEventListener('click', () => {
  stopRun().catch((err) => setStatus('error', err.message || 'Unable to stop run'));
});

modelTriggerBtn.addEventListener('click', () => {
  setPopover(state.popover === 'model' ? 'none' : 'model');
});

sessionTriggerBtn.addEventListener('click', () => {
  setPopover(state.popover === 'session' ? 'none' : 'session');
});

popoverBackdropEl.addEventListener('click', () => {
  setPopover('none');
});

(async function init() {
  try {
    setComposerEnabled(false);
    setStatus('info', 'Connecting...');
    render();
    startInitialTabAttach();
    await loadAuth();
    bindTabAttachWatchers();
    try {
      await loadModelPresets();
    } catch {
      state.modelPresets = [{ value: null, label: 'Default' }];
    }
    await loadSessions();
    if (!state.value.activeSessionId) {
      await createSession();
    } else {
      await selectSession(state.value.activeSessionId);
    }
    setComposerEnabled(true);
    scheduleTabAttachRefresh(0);
    setStatus('ready', 'Ready');
    render();
  } catch {
    setComposerEnabled(false);
    setTabAttachBannerState({ hidden: true });
    setStatus('error', 'Daemon unavailable');
  }
})();
