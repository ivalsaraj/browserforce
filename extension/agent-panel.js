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

const REASONING_PRESETS = [
  { value: null, label: 'Default (Config)' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];
const BROWSERFORCE_AGENT_OPEN_REQUEST_KEY = 'browserforceAgentOpenRequest';
const BROWSERFORCE_AGENT_OPEN_REQUEST_MAX_AGE_MS = 60_000;

const state = {
  value: initialState,
  auth: null,
  modelPresets: [{ value: null, label: 'Default' }],
  defaultReasoningEffort: 'medium',
  currentRunBySession: {},
  expandedTimelineEntries: {},
  latestReasoningTitleByRun: {},
  transcriptHandlersBound: false,
  tabAttachWatchersBound: false,
  agentOpenRequestWatcherBound: false,
  lastHandledAgentOpenRequestId: null,
  pendingAgentOpenRequest: null,
  initialTabAttachInFlight: false,
  initialTabAttachStarted: false,
  editingSessionId: null,
  sessionTitleDrafts: {},
  eventController: null,
  eventLoopToken: 0,
  sessionSelectionToken: 0,
  popover: 'none',
  startupIssue: null,
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
const thinkingListEl = document.getElementById('bf-thinking-list');
const switchSessionListEl = document.getElementById('bf-switch-session-list');
const transcriptEl = document.getElementById('bf-transcript');
const chatFormEl = document.getElementById('bf-chat-form');
const composerBoxEl = chatFormEl.querySelector('.composer-box');
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

function reconcileSessionRunState(sessionId) {
  if (!sessionId) return false;
  const runId = getSessionRunId(state.currentRunBySession, sessionId);
  if (!runId) return false;
  const run = state.value.runs[runId] || null;
  if (!run || run.done) {
    state.currentRunBySession = clearSessionRunId(state.currentRunBySession, sessionId, runId);
    return true;
  }
  return false;
}

function autoResizeInput() {
  chatInputEl.style.height = 'auto';
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 160)}px`;
}

function syncComposerLayoutState() {
  const styles = window.getComputedStyle(chatInputEl);
  const lineHeight = Number.parseFloat(styles.lineHeight) || 21;
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
  const singleLineHeight = lineHeight + paddingTop + paddingBottom;
  const hasContent = chatInputEl.value.trim().length > 0;
  const isMultiline = hasContent && chatInputEl.scrollHeight > (singleLineHeight + 6);
  composerBoxEl.classList.toggle('is-multiline', isMultiline);
}

function syncComposerState() {
  const enabled = !chatInputEl.disabled;
  const hasText = chatInputEl.value.trim().length > 0;
  const runInProgress = isActiveRunInProgress();

  stopRunBtn.disabled = !enabled || !runInProgress;
  stopRunBtn.classList.toggle('active', enabled && runInProgress);
  stopRunBtn.hidden = !runInProgress;
  sendBtn.disabled = !enabled || runInProgress || !hasText;
  sendBtn.hidden = runInProgress;
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
  const note = formatted ? `Context: ${formatted}` : '';
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

function normalizeStartupError(code = '', fallbackMessage = 'Unable to connect to BrowserForce Agent') {
  const normalized = String(code || '').trim().toLowerCase();
  if (normalized === 'agent_not_running') {
    return {
      code: 'agent_not_running',
      statusText: 'Agent not running',
      title: 'BrowserForce Agent is not running',
      detail: 'Relay is reachable, but the local agent daemon (chatd) is offline.',
      command: 'browserforce agent start',
    };
  }
  if (normalized === 'extension_not_connected') {
    return {
      code: 'extension_not_connected',
      statusText: 'Extension not connected',
      title: 'Extension is not connected to relay',
      detail: 'Open the BrowserForce extension popup and reconnect it to the relay.',
      command: null,
    };
  }
  if (normalized === 'relay_unreachable') {
    return {
      code: 'relay_unreachable',
      statusText: 'Relay unreachable',
      title: 'Relay is not reachable',
      detail: 'Start relay first, then retry opening this side panel.',
      command: 'browserforce serve',
    };
  }
  return {
    code: 'unknown',
    statusText: 'Connection failed',
    title: 'Unable to connect to BrowserForce Agent',
    detail: fallbackMessage || 'Check relay and agent daemon status, then try again.',
    command: null,
  };
}

function startupActionsForIssue(startupIssue) {
  const code = String(startupIssue?.code || '').trim().toLowerCase();
  const actions = [{ key: 'retry', label: 'Retry' }];
  if (code === 'extension_not_connected' || code === 'relay_unreachable') {
    actions.push({ key: 'refresh-connection', label: 'Refresh connection' });
  }
  return actions;
}

function setComposerEnabled(enabled) {
  chatInputEl.disabled = !enabled;
  autoResizeInput();
  syncComposerLayoutState();
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

function getTabAttachInProgressState() {
  if (!state.initialTabAttachInFlight) return null;
  return {
    hidden: false,
    text: 'Currently attaching active tab...',
    canAttach: false,
    busy: true,
  };
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

function normalizeReasoningEffort(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return null;
}

function formatReasoningEffortLabel(value) {
  const normalized = normalizeReasoningEffort(value);
  if (normalized === 'low') return 'Low';
  if (normalized === 'medium') return 'Medium';
  if (normalized === 'high') return 'High';
  if (normalized === 'xhigh') return 'Extra High';
  return 'Medium';
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
  if (!modelListEl || !thinkingListEl) return;
  const activeSession = getActiveSession();
  const activeModel = activeSession?.model || null;
  const activeReasoningEffort = normalizeReasoningEffort(activeSession?.reasoningEffort);

  const rows = state.modelPresets.map((preset) => {
    const active = (preset.value || null) === activeModel ? 'active' : '';
    return `<li><button type="button" data-model="${escapeHtml(preset.value || '')}" class="popover-item ${active}"><span>${escapeHtml(preset.label)}</span></button></li>`;
  });
  rows.push('<li><button type="button" data-model-custom="1" class="popover-item custom-item"><span>Custom...</span></button></li>');

  modelListEl.innerHTML = rows.join('');
  thinkingListEl.innerHTML = REASONING_PRESETS.map((preset) => {
    const active = (preset.value || null) === (activeReasoningEffort || null) ? 'active' : '';
    let label = preset.label;
    if (preset.value == null) {
      label = `Default (Config: ${formatReasoningEffortLabel(state.defaultReasoningEffort)})`;
    }
    return `<li><button type="button" data-reasoning-effort="${escapeHtml(preset.value || '')}" class="popover-item ${active}"><span>${escapeHtml(label)}</span></button></li>`;
  }).join('');

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

  thinkingListEl.querySelectorAll('button[data-reasoning-effort]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.reasoningEffort || null;
      const reasoningEffort = normalizeReasoningEffort(value);
      updateActiveSessionReasoningEffort(reasoningEffort).catch((error) => {
        setStatus('error', error.message || 'Unable to update thinking level');
      });
    });
  });
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

const EXECUTE_HELPER_EXCLUDE_CALLS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'snapshot',
  'reftolocator',
  'waitforpageload',
  'getlogs',
  'clearlogs',
  'screenshotwithaccessibilitylabels',
  'cleanhtml',
  'pagemarkdown',
  'getcdpsession',
  'plugincatalog',
  'pluginhelp',
  'fetch',
  'settimeout',
  'cleartimeout',
  'promise',
  'array',
  'object',
  'number',
  'string',
  'boolean',
  'date',
  'math',
  'json',
  'parseint',
  'parsefloat',
  'isnan',
  'isfinite',
  'encodeuri',
  'decodeuri',
]);

function isBrowserForceExecuteStep(entry) {
  const label = String(entry?.label || '').trim().toLowerCase();
  return (
    label === 'browserforce:execute'
    || label === 'browserforce execute'
    || label === 'mcp__browserforce__execute'
    || label === 'execute'
  );
}

function extractExecuteHelperCalls(details) {
  if (!Array.isArray(details) || details.length === 0) return [];
  const helperCalls = [];
  const seen = new Set();
  const callPattern = /(^|[^.\w$])([A-Za-z_$][\w$]{2,})\s*\(/g;

  for (const line of details) {
    const text = String(line || '');
    if (!text) continue;
    callPattern.lastIndex = 0;
    for (const match of text.matchAll(callPattern)) {
      const callName = String(match[2] || '').trim();
      if (!callName) continue;
      const normalized = callName.toLowerCase();
      if (EXECUTE_HELPER_EXCLUDE_CALLS.has(normalized)) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      helperCalls.push(callName);
      if (helperCalls.length >= 3) return helperCalls;
    }
  }

  return helperCalls;
}

function renderExecuteHelperTreePreview(entry, expanded) {
  if (expanded) return '';
  if (!isBrowserForceExecuteStep(entry)) return '';
  const details = Array.isArray(entry?.details) ? entry.details : [];
  const helperCalls = extractExecuteHelperCalls(details);
  if (!helperCalls.length) return '';
  const status = String(entry?.status || '').toLowerCase() === 'done' ? 'done' : 'running';
  return `
    <ul class="step-branch-preview ${status}">
      ${helperCalls.map((callName) => `
        <li class="step-branch-node">
          <span class="step-branch-call">${escapeHtml(callName)}()</span>
        </li>
      `).join('')}
    </ul>
  `;
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

function shouldAnimateLatestReasoningTitle({ run, entry, isLatest, isRunningReasoning }) {
  if (!isLatest || !isRunningReasoning) return false;
  const runId = String(run?.runId || '').trim();
  if (!runId) return false;
  const signature = `${String(entry?.key || '').trim()}::${String(entry?.label || '').trim()}`;
  if (!signature || signature === '::') return false;
  const previous = state.latestReasoningTitleByRun[runId];
  if (previous === signature) return false;
  state.latestReasoningTitleByRun = {
    ...state.latestReasoningTitleByRun,
    [runId]: signature,
  };
  return true;
}

function renderRunTimeline(run, fallbackText = '') {
  const timeline = normalizeRunTimeline(run, fallbackText);
  if (!timeline.length) return '';
  const latestStepIndex = getLatestInFlightTimelineStepIndex(run, timeline);
  const getTimelineEntryKey = (entry, index) => {
    const runId = String(run?.runId || 'run');
    const stableKey = String(entry?.key || '').trim();
    if (stableKey) return `${runId}:${stableKey}`;
    const kind = String(entry?.kind || '');
    const status = String(entry?.status || '');
    const label = String(entry?.label || '');
    return `${runId}:${index}:${kind}:${status}:${label}`;
  };
  return `
    <div class="run-timeline">
      ${timeline.map((entry, index) => {
    if (entry.type === 'text') {
      return `<div class="bubble-assistant"><p>${renderContent(entry.text || '')}</p></div>`;
    }
    const status = entry?.status || 'running';
    const normalizedStatus = String(status || '').toLowerCase();
    const icon = classifyRunStepIcon(entry);
    const isLatest = index === latestStepIndex;
    const shouldPulse = isLatest && status === 'running';
    const isReasoningTitle = String(entry?.kind || '').toLowerCase() === 'reasoning';
    const isRunningReasoning = isReasoningTitle && normalizedStatus === 'running';
    const labelClasses = ['step-label'];
    if (isReasoningTitle) labelClasses.push('title-label');
    if (isRunningReasoning && isLatest) {
      labelClasses.push('shimmer-text');
      if (shouldAnimateLatestReasoningTitle({ run, entry, isLatest, isRunningReasoning })) {
        labelClasses.push('title-transition-in');
      }
    }
    const details = Array.isArray(entry?.details) ? entry.details.filter(Boolean) : [];
    const isCollapsible = details.length > 0;
    const classes = ['step-item', 'timeline-step', escapeHtml(status)];
    if (isLatest) classes.push('latest');
    if (shouldPulse) classes.push('pulse');
    if (!isCollapsible) {
      return `<div class="${classes.join(' ')}"><span class="run-step-icon icon-${escapeHtml(icon)}" aria-hidden="true"></span><span class="${labelClasses.join(' ')}">${renderInlineContent(entry.label || 'Step')}</span></div>`;
    }
    classes.push('collapsible');
    const key = getTimelineEntryKey(entry, index);
    const expanded = !!state.expandedTimelineEntries[key];
    if (expanded) classes.push('expanded');
    const helperTreePreviewHtml = renderExecuteHelperTreePreview(entry, expanded);
    const detailsHtml = details
      .map((line) => `<li>${renderInlineContent(line)}</li>`)
      .join('');
    return `
      <div class="${classes.join(' ')}">
        <span class="run-step-icon icon-${escapeHtml(icon)}" aria-hidden="true"></span>
        <div class="step-body">
          <button type="button" class="step-toggle" data-step-key="${escapeHtml(key)}" aria-expanded="${expanded ? 'true' : 'false'}">
            <span class="step-toggle-main">
              <span class="${labelClasses.join(' ')}">${renderInlineContent(entry.label || 'Step')}</span>
              <span class="step-caret" aria-hidden="true"></span>
            </span>
            ${helperTreePreviewHtml}
          </button>
          ${expanded ? `<ul class="step-details">${detailsHtml}</ul>` : ''}
        </div>
      </div>
    `;
  }).join('')}
    </div>
  `;
}

function renderContent(value) {
  return renderInlineContent(value);
}

function bindTranscriptHandlers() {
  if (state.transcriptHandlersBound) return;
  transcriptEl.addEventListener('click', async (event) => {
    const startupActionBtn = event.target.closest('button[data-startup-action]');
    if (startupActionBtn && transcriptEl.contains(startupActionBtn)) {
      event.preventDefault();
      const msgAction = startupActionBtn.getAttribute('data-startup-action');
      if (msgAction === 'retry') {
        await retryStartup();
        return;
      }
      if (msgAction === 'refresh-connection') {
        await retryStartup({ refreshConnection: true });
        return;
      }
    }
    const toggleBtn = event.target.closest('button[data-step-key]');
    if (!toggleBtn || !transcriptEl.contains(toggleBtn)) return;
    const stepKey = toggleBtn.getAttribute('data-step-key');
    if (!stepKey) return;
    const nextExpanded = !state.expandedTimelineEntries[stepKey];
    state.expandedTimelineEntries = {
      ...state.expandedTimelineEntries,
      [stepKey]: nextExpanded,
    };
    const scrollTop = transcriptEl.scrollTop;
    renderTranscript({ preserveScrollTop: scrollTop });
  });
  state.transcriptHandlersBound = true;
}

function renderTranscript({ preserveScrollTop = null } = {}) {
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
    const startupIssue = state.startupIssue;
    if (startupIssue) {
      const commandHtml = startupIssue.command
        ? `<p class="empty-command"><code>${escapeHtml(startupIssue.command)}</code></p>`
        : '';
      const actions = startupActionsForIssue(startupIssue);
      const actionsHtml = actions.length > 0
        ? `
          <div class="empty-actions">
            ${actions.map((action) => `
              <button
                type="button"
                class="empty-action-btn${action.key === 'refresh-connection' ? ' secondary' : ''}"
                data-startup-action="${escapeHtml(action.key)}"
              >${escapeHtml(action.label)}</button>
            `).join('')}
          </div>
        `
        : '';
      transcriptEl.innerHTML = `
        <div class="empty-state error-state">
          <div class="empty-icon error">!</div>
          <div>
            <p class="empty-title">${escapeHtml(startupIssue.title || 'Unable to connect')}</p>
            <p class="empty-sub">${escapeHtml(startupIssue.detail || '')}</p>
            ${commandHtml}
            ${actionsHtml}
          </div>
        </div>
      `;
      bindTranscriptHandlers();
      if (Number.isFinite(preserveScrollTop)) {
        transcriptEl.scrollTop = preserveScrollTop;
      } else {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
      syncStatusIndicator();
      syncComposerState();
      return;
    }
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
  if (Number.isFinite(preserveScrollTop)) {
    transcriptEl.scrollTop = preserveScrollTop;
  } else {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
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

function normalizeAgentOpenRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const requestId = String(raw.requestId || '').trim();
  const requestedAt = Number(raw.requestedAt);
  if (!requestId || !Number.isFinite(requestedAt)) return null;
  if ((Date.now() - requestedAt) > BROWSERFORCE_AGENT_OPEN_REQUEST_MAX_AGE_MS) return null;
  return {
    requestId,
    requestedAt,
    source: String(raw.source || '').trim() || null,
  };
}

async function consumePendingAgentOpenRequest() {
  if (!chrome?.storage?.local?.get || !chrome?.storage?.local?.remove) return null;
  try {
    const stored = await chrome.storage.local.get([BROWSERFORCE_AGENT_OPEN_REQUEST_KEY]);
    const request = normalizeAgentOpenRequest(stored?.[BROWSERFORCE_AGENT_OPEN_REQUEST_KEY]);
    if (!request) return null;
    await chrome.storage.local.remove(BROWSERFORCE_AGENT_OPEN_REQUEST_KEY);
    state.lastHandledAgentOpenRequestId = request.requestId;
    return request;
  } catch {
    return null;
  }
}

async function startFreshSessionFromOpenRequest(rawRequest) {
  const request = normalizeAgentOpenRequest(rawRequest);
  if (!request) return;
  if (state.lastHandledAgentOpenRequestId === request.requestId) return;
  state.lastHandledAgentOpenRequestId = request.requestId;
  if (!state.auth) {
    state.pendingAgentOpenRequest = request;
    return;
  }
  try {
    await chrome.storage.local.remove(BROWSERFORCE_AGENT_OPEN_REQUEST_KEY);
  } catch {
    // best-effort cleanup
  }
  state.pendingAgentOpenRequest = null;
  await createSession();
}

function bindAgentOpenRequestWatcher() {
  if (state.agentOpenRequestWatcherBound) return;
  if (!chrome?.storage?.onChanged?.addListener) return;
  state.agentOpenRequestWatcherBound = true;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes?.[BROWSERFORCE_AGENT_OPEN_REQUEST_KEY];
    if (!change?.newValue) return;
    startFreshSessionFromOpenRequest(change.newValue).catch((error) => {
      setStatus('error', error?.message || 'Unable to start a new conversation');
    });
  });
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
  const inProgressState = getTabAttachInProgressState();
  if (inProgressState) {
    setTabAttachBannerState(inProgressState);
    return;
  }
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
  if (state.tabAttachWatchersBound) return;
  state.tabAttachWatchersBound = true;
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
  setTabAttachBannerState(getTabAttachInProgressState() || undefined);
  renderContextUsageChip();
  window.setTimeout(() => {
    ensureCurrentTabAttached()
      .catch(() => {
        // best-effort only
      })
      .finally(() => {
        state.initialTabAttachInFlight = false;
        renderContextUsageChip();
        scheduleTabAttachRefresh(0);
      });
  }, 2000);
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

async function refreshExtensionConnection() {
  const stored = await chrome.storage.local.get(['relayUrl']);
  const relayUrl = stored.relayUrl || 'ws://127.0.0.1:19222/extension';
  const response = await runtimeMessage({ type: 'updateRelayUrl', relayUrl });
  if (response?.error) throw new Error(response.error);
}

async function loadAuth() {
  const relayHttpUrl = await getRelayHttpUrl();
  const extensionId = chrome?.runtime?.id;
  let res;
  try {
    res = await fetch(`${relayHttpUrl}/chatd-url`, {
      headers: extensionId ? { 'x-browserforce-extension-id': extensionId } : {},
    });
  } catch {
    const error = new Error('relay_unreachable');
    error.code = 'relay_unreachable';
    throw error;
  }
  if (!res.ok) {
    const body = await readJsonOrEmpty(res);
    const relayError = String(body?.error || '').toLowerCase();
    if (res.status === 404 && relayError.includes('chatd not running')) {
      const error = new Error('agent_not_running');
      error.code = 'agent_not_running';
      throw error;
    }
    if (res.status === 503 && relayError.includes('extension not connected')) {
      const error = new Error('extension_not_connected');
      error.code = 'extension_not_connected';
      throw error;
    }
    const error = new Error(body?.error || `chatd-url failed (${res.status})`);
    error.code = 'daemon_unavailable';
    throw error;
  }
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
  state.defaultReasoningEffort = normalizeReasoningEffort(body.defaultReasoningEffort) || 'medium';
}

async function loadMessages(sessionId) {
  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`, {
    method: 'GET',
    headers: {},
  });
  await ensureOk(res, 'Failed to load messages');
  const body = await readJsonOrEmpty(res);
  dispatch({ type: 'messages.loaded', sessionId, messages: body.messages || [] });
  if (reconcileSessionRunState(sessionId)) {
    render();
  }
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

async function updateActiveSessionReasoningEffort(reasoningEffort) {
  const sessionId = state.value.activeSessionId;
  if (!sessionId) return;

  const res = await api(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ reasoningEffort }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to update thinking level');
  }

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
        await loadMessages(sessionId).catch(() => {});
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

async function initializePanel() {
  state.startupIssue = null;
  setComposerEnabled(false);
  setStatus('info', 'Connecting...');
  render();
  bindAgentOpenRequestWatcher();
  const openRequest = await consumePendingAgentOpenRequest();
  let shouldStartFreshSession = !!openRequest;
  if (shouldStartFreshSession) {
    state.pendingAgentOpenRequest = null;
  } else if (state.pendingAgentOpenRequest) {
    shouldStartFreshSession = true;
    state.pendingAgentOpenRequest = null;
  }
  startInitialTabAttach();
  await loadAuth();
  bindTabAttachWatchers();
  try {
    await loadModelPresets();
  } catch {
    state.modelPresets = [{ value: null, label: 'Default' }];
    state.defaultReasoningEffort = 'medium';
  }
  await loadSessions();
  if (shouldStartFreshSession || !state.value.activeSessionId) {
    await createSession();
  } else {
    await selectSession(state.value.activeSessionId);
  }
  setComposerEnabled(true);
  scheduleTabAttachRefresh(0);
  setStatus('ready', 'Ready');
  render();
}

async function retryStartup({ refreshConnection = false } = {}) {
  try {
    setStatus('info', refreshConnection ? 'Refreshing connection...' : 'Retrying...');
    render();
    if (refreshConnection) {
      await refreshExtensionConnection();
    }
    await initializePanel();
  } catch (error) {
    state.startupIssue = normalizeStartupError(error?.code, error?.message);
    setComposerEnabled(false);
    setTabAttachBannerState({ hidden: true });
    setStatus('error', state.startupIssue.statusText || 'Daemon unavailable');
    render();
  }
}

chatFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = chatInputEl.value;
  try {
    await sendMessage(text);
    chatInputEl.value = '';
    autoResizeInput();
    syncComposerLayoutState();
    syncComposerState();
  } catch (error) {
    chatInputEl.value = text;
    autoResizeInput();
    syncComposerLayoutState();
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
  syncComposerLayoutState();
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
    await initializePanel();
  } catch (error) {
    state.startupIssue = normalizeStartupError(error?.code, error?.message);
    setComposerEnabled(false);
    setTabAttachBannerState({ hidden: true });
    setStatus('error', state.startupIssue.statusText || 'Daemon unavailable');
    render();
  }
})();
