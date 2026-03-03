import { applyEvent, initialState, reduceState } from './agent-panel-state.js';
import {
  assignSessionRunId,
  classifyRunStepIcon,
  clearSessionRunId,
  getSessionRunId,
  shouldApplySessionSelection,
} from './agent-panel-runtime.js';

const state = {
  value: initialState,
  auth: null,
  modelPresets: [{ value: null, label: 'Default' }],
  currentRunBySession: {},
  expandedRunSteps: {},
  eventController: null,
  eventLoopToken: 0,
  sessionSelectionToken: 0,
  popover: 'none',
};

const statusEl = document.getElementById('bf-agent-status');
const statusIconEl = document.getElementById('bf-agent-status-icon');
const statusTextEl = document.getElementById('bf-agent-status-text');
const modelTriggerBtn = document.getElementById('bf-model-trigger');
const sessionTriggerBtn = document.getElementById('bf-session-trigger');
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

function setStatus(kind, text) {
  statusTextEl.textContent = text;
  statusEl.classList.toggle('error', kind === 'error');
  statusIconEl.textContent = kind === 'error' ? '!' : '●';
}

function setComposerEnabled(enabled) {
  chatInputEl.disabled = !enabled;
  stopRunBtn.disabled = !enabled;
  sendBtn.disabled = !enabled;
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

function getActiveSession() {
  return state.value.sessions.find((item) => item.sessionId === state.value.activeSessionId) || null;
}

function getActiveMessages() {
  return state.value.messagesBySession[state.value.activeSessionId] || [];
}

function formatModelLabel(model) {
  return model && String(model).trim() ? model : 'Default';
}

function renderSelectors() {
  const activeSession = getActiveSession();
  modelTriggerBtn.textContent = `Model: ${formatModelLabel(activeSession?.model)}`;
  sessionTriggerBtn.textContent = activeSession?.title || 'Session';
}

function renderModelList() {
  const activeSession = getActiveSession();
  const activeModel = activeSession?.model || null;

  const rows = state.modelPresets.map((preset) => {
    const active = (preset.value || null) === activeModel ? 'active' : '';
    return `<li><button type="button" data-model="${escapeHtml(preset.value || '')}" class="${active}">${escapeHtml(preset.label)}</button></li>`;
  });
  rows.push('<li><button type="button" data-model-custom="1">Custom...</button></li>');

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

  const titleCounts = new Map();
  for (const session of sessions) {
    const title = (session.title || '').trim() || session.sessionId;
    titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
  }

  switchSessionListEl.innerHTML = sessions
    .map((session) => {
      const active = session.sessionId === state.value.activeSessionId ? 'active' : '';
      const title = session.title || session.sessionId;
      const suffix = (titleCounts.get(title) || 0) > 1 ? ` · ${session.sessionId.slice(0, 8)}` : '';
      return `<li><button type="button" data-session-id="${session.sessionId}" class="${active}">${escapeHtml(`${title}${suffix}`)}</button></li>`;
    })
    .join('');

  switchSessionListEl.querySelectorAll('button[data-session-id]').forEach((button) => {
    button.addEventListener('click', async () => {
      await selectSession(button.dataset.sessionId);
      setPopover('none');
    });
  });
}

function isRunStepsExpanded(runId) {
  return !!state.expandedRunSteps?.[runId];
}

function toggleRunSteps(runId) {
  if (!runId) return;
  state.expandedRunSteps = {
    ...(state.expandedRunSteps || {}),
    [runId]: !isRunStepsExpanded(runId),
  };
  renderTranscript();
}

function renderRunSteps(runId, run) {
  if (!runId || !run || !Array.isArray(run.steps) || run.steps.length === 0) return '';
  const count = run.steps.length;
  const expanded = isRunStepsExpanded(runId);
  const summary = `<button type="button" class="run-steps-trigger" data-run-steps-toggle="${escapeHtml(runId)}">${count} step${count === 1 ? '' : 's'}</button>`;
  if (!expanded) {
    return `<div class="run-steps-summary">${summary}</div>`;
  }

  const items = run.steps
    .map((step) => {
      const kind = step?.kind || 'reasoning';
      const status = step?.status || 'running';
      const label = step?.label || 'Step';
      const icon = classifyRunStepIcon(step);
      return `<li class="run-step ${escapeHtml(kind)} ${escapeHtml(status)}"><span class="run-step-icon icon-${escapeHtml(icon)}" aria-hidden="true"></span><span class="run-step-label">${escapeHtml(label)}</span></li>`;
    })
    .join('');

  return `<div class="run-steps-summary expanded">${summary}<ol class="run-steps-list">${items}</ol></div>`;
}

function bindTranscriptHandlers() {
  transcriptEl.querySelectorAll('button[data-run-steps-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      toggleRunSteps(button.getAttribute('data-run-steps-toggle'));
    });
  });
}

function renderTranscript() {
  const messages = getActiveMessages();
  const sessionId = state.value.activeSessionId;
  const sessionRunId = getSessionRunId(state.currentRunBySession, sessionId);
  const run = sessionRunId ? state.value.runs[sessionRunId] : null;

  const chunks = messages.map((msg) => {
    const role = msg.role || 'assistant';
    if (role === 'user') {
      return `<article class="message-row user"><div class="message user">${escapeHtml(msg.text || '')}</div></article>`;
    }

    const messageRun = msg.runId ? state.value.runs[msg.runId] : null;
    return `<article class="message-row assistant">${renderRunSteps(msg.runId, messageRun)}<div class="message assistant">${escapeHtml(msg.text || '')}</div></article>`;
  });

  if (run && !run.done) {
    const liveText = run.text ? `<div class="message assistant">${escapeHtml(run.text || '')}</div>` : '';
    chunks.push(`<article class="message-row assistant">${renderRunSteps(sessionRunId, run)}${liveText}</article>`);
  }

  transcriptEl.innerHTML = chunks.join('') || '<article class="message-row assistant"><div class="message assistant">No messages yet.</div></article>';
  bindTranscriptHandlers();
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
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
  } catch {
    // best-effort only
  }
}

async function getActiveTabContext() {
  if (!chrome?.tabs?.query) return null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') return null;
    const title = String(tab.title || '').trim().slice(0, 180);
    const url = String(tab.url || '').trim();
    if (
      !url
      || url.startsWith('chrome://')
      || url.startsWith('chrome-extension://')
      || url.startsWith('edge://')
      || url.startsWith('devtools://')
    ) {
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

async function selectSession(sessionId) {
  state.sessionSelectionToken += 1;
  const selectionToken = state.sessionSelectionToken;
  dispatch({ type: 'session.selected', sessionId });
  await loadMessages(sessionId);
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
  } catch (error) {
    chatInputEl.value = text;
    setStatus('error', error?.message || 'Failed to send message');
  }
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
    setStatus('info', 'Connecting...');
    await loadAuth();
    await ensureCurrentTabAttached();
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
    setStatus('ready', 'Ready');
  } catch {
    setComposerEnabled(false);
    setStatus('error', 'Daemon unavailable');
  }
})();
