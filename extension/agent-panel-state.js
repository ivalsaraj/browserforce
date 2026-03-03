export const initialState = {
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  runs: {},
  latestUsageBySession: {},
};

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function trimStepLabel(label) {
  const text = String(label || '').trim();
  if (!text) return '';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const label = trimStepLabel(step.label);
  if (!label) return null;
  return {
    kind: step.kind || 'reasoning',
    status: step.status || 'running',
    label,
  };
}

function pushStep(run, step) {
  const steps = Array.isArray(run?.steps) ? run.steps.slice() : [];
  const normalized = normalizeStep(step);
  if (!normalized || !normalized.label) return steps;
  const last = steps[steps.length - 1];
  if (last && last.label === normalized.label && last.kind === normalized.kind && last.status === normalized.status) {
    return steps;
  }
  steps.push(normalized);
  if (steps.length > 100) steps.shift();
  return steps;
}

function pushTimelineEntry(run, entry) {
  const timeline = Array.isArray(run?.timeline) ? run.timeline.slice() : [];
  if (!entry || typeof entry !== 'object') return timeline;

  if (entry.type === 'text') {
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text) return timeline;
    const last = timeline[timeline.length - 1];
    if (last?.type === 'text') {
      last.text = `${last.text || ''}${text}`;
    } else {
      timeline.push({ type: 'text', text });
    }
  } else if (entry.type === 'step') {
    const normalized = normalizeStep(entry);
    if (!normalized) return timeline;
    const candidate = { type: 'step', ...normalized };
    const last = timeline[timeline.length - 1];
    if (
      last
      && last.type === 'step'
      && last.label === candidate.label
      && last.kind === candidate.kind
      && last.status === candidate.status
    ) {
      return timeline;
    }
    timeline.push(candidate);
  }

  if (timeline.length > 200) timeline.shift();
  return timeline;
}

function normalizeStoredTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type === 'text') {
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text) return null;
    return { type: 'text', text };
  }
  const step = normalizeStep(entry);
  if (!step) return null;
  return { type: 'step', ...step };
}

function fallbackTimelineFromMessage({ steps, text }) {
  const timeline = [];
  for (const step of steps) {
    timeline.push({ type: 'step', ...step });
  }
  if (typeof text === 'string' && text) {
    timeline.push({ type: 'text', text });
  }
  return timeline;
}

function hasTimelineText(timeline) {
  return Array.isArray(timeline) && timeline.some((entry) => entry?.type === 'text' && entry.text);
}

function applyFinalTextToTimeline(run, finalText) {
  let timeline = Array.isArray(run?.timeline) ? run.timeline.slice() : [];
  const currentText = String(run?.text || '');
  const resolved = String(finalText || '');
  if (!resolved) return timeline;

  if (!timeline.length || !hasTimelineText(timeline)) {
    timeline = pushTimelineEntry({ timeline }, { type: 'text', text: resolved });
    return timeline;
  }

  if (resolved === currentText) return timeline;

  if (currentText && resolved.startsWith(currentText)) {
    const suffix = resolved.slice(currentText.length);
    if (suffix) {
      timeline = pushTimelineEntry({ timeline }, { type: 'text', text: suffix });
    }
    return timeline;
  }

  timeline = pushTimelineEntry({ timeline }, { type: 'text', text: resolved });
  return timeline;
}

function stepLabelForToolEvent(evt) {
  const payload = evt?.payload || {};
  if (evt.event === 'tool.started') {
    return firstString([
      payload.title,
      payload.name,
      payload.tool,
      payload.toolName,
      payload.command,
    ]) || 'Tool call started';
  }
  if (evt.event === 'tool.final') {
    return firstString([
      payload.title,
      payload.name,
      payload.tool,
      payload.toolName,
      payload.command,
    ]) || 'Tool call completed';
  }
  if (evt.event === 'tool.delta') {
    return firstString([
      payload.text,
      payload.message,
      payload.delta,
      payload.command,
      payload.name,
      payload.tool,
      payload.toolName,
      payload.type === 'reasoning' ? 'Reasoning' : '',
    ]) || 'Working...';
  }
  return '';
}

function humanizeToken(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/[_./-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function stepStatusForRunEvent(evt) {
  const payload = evt?.payload || {};
  const type = String(payload.type || '').toLowerCase();
  if (/error|failed|aborted/.test(type)) return 'failed';
  if (/completed|final|done|finished|succeeded|success|end/.test(type)) return 'done';
  return 'running';
}

function stepKindForRunEvent(evt) {
  const payload = evt?.payload || {};
  const itemType = String(payload?.item?.type || '').toLowerCase();
  const eventType = String(payload?.type || '').toLowerCase();
  if (/reason/.test(itemType) || /reason/.test(eventType)) return 'reasoning';
  return 'tool';
}

function stepLabelForRunEvent(evt) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  return firstString([
    payload.title,
    payload.message,
    payload.text,
    payload.status,
    item.summary,
    item.text,
    item.message,
    item.title,
    item.name,
    item.tool,
    item.command,
    item.type ? humanizeToken(item.type) : '',
    payload.type ? humanizeToken(payload.type) : '',
  ]) || 'Working...';
}

function upsertRun(state, runId, patch) {
  return {
    ...state.runs,
    [runId]: {
      ...(state.runs[runId] || { runId, text: '', done: false, steps: [] }),
      ...patch,
    },
  };
}

function normalizeUsageValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function normalizeUsagePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const normalized = {
    modelContextWindow: normalizeUsageValue(payload.modelContextWindow),
    totalTokens: normalizeUsageValue(payload.totalTokens),
    inputTokens: normalizeUsageValue(payload.inputTokens),
    cachedInputTokens: normalizeUsageValue(payload.cachedInputTokens),
    outputTokens: normalizeUsageValue(payload.outputTokens),
    reasoningOutputTokens: normalizeUsageValue(payload.reasoningOutputTokens),
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (value == null) delete normalized[key];
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeStoredStep(step) {
  return normalizeStep(step);
}

function hydrateRunsFromMessages(messages, sessionId, currentRuns) {
  const hydrated = {};
  for (const message of messages) {
    const runId = typeof message?.runId === 'string' ? message.runId.trim() : '';
    if (!runId) continue;
    const steps = Array.isArray(message?.steps)
      ? message.steps.map(normalizeStoredStep).filter(Boolean)
      : [];
    const timeline = Array.isArray(message?.timeline)
      ? message.timeline.map(normalizeStoredTimelineEntry).filter(Boolean)
      : [];
    const resolvedText = typeof message?.text === 'string' ? message.text : (currentRuns?.[runId]?.text || '');
    hydrated[runId] = {
      ...(currentRuns?.[runId] || { runId, text: '', done: false, steps: [] }),
      runId,
      sessionId,
      text: resolvedText,
      done: true,
      steps: steps.length > 0 ? steps : (currentRuns?.[runId]?.steps || []),
      timeline: timeline.length > 0
        ? timeline
        : fallbackTimelineFromMessage({
          steps: steps.length > 0 ? steps : (currentRuns?.[runId]?.steps || []),
          text: resolvedText,
        }),
    };
  }
  return hydrated;
}

export function reduceState(state = initialState, action = {}) {
  if (action.type === 'session.list.loaded') {
    const sessions = Array.isArray(action.sessions) ? action.sessions : [];
    const activeSessionId = action.activeSessionId
      || state.activeSessionId
      || sessions[0]?.sessionId
      || null;
    return {
      ...state,
      sessions,
      activeSessionId,
    };
  }

  if (action.type === 'session.selected') {
    return {
      ...state,
      activeSessionId: action.sessionId,
    };
  }

  if (action.type === 'messages.loaded') {
    const messages = Array.isArray(action.messages) ? action.messages : [];
    const hydratedRuns = hydrateRunsFromMessages(messages, action.sessionId, state.runs);
    return {
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        [action.sessionId]: messages,
      },
      runs: {
        ...state.runs,
        ...hydratedRuns,
      },
    };
  }

  if (action.type === 'session.metadata.loaded') {
    const usage = normalizeUsagePayload(action.session?.providerState?.codex?.latestUsage);
    if (!usage || !action.sessionId) return state;
    return {
      ...state,
      latestUsageBySession: {
        ...(state.latestUsageBySession || {}),
        [action.sessionId]: usage,
      },
    };
  }

  return state;
}

export function applyEvent(state = initialState, evt = {}) {
  if (!evt || !evt.event) return state;

  if (evt.event === 'run.started') {
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        text: '',
        done: false,
        error: null,
        steps: [],
        timeline: [],
      }),
    };
  }

  if (evt.event === 'chat.delta') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const delta = evt.payload?.delta || '';
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        text: `${run.text || ''}${delta}`,
        timeline: pushTimelineEntry(run, { type: 'text', text: delta }),
      }),
    };
  }

  if (evt.event === 'chat.final') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const finalText = evt.payload?.text || run.text || '';
    const timeline = applyFinalTextToTimeline(run, finalText);
    const currentMessages = state.messagesBySession[evt.sessionId] || [];
    const hasStoredFinal = currentMessages.some(
      (message) => message.runId === evt.runId && message.role === 'assistant',
    );
    const nextMessages = (!hasStoredFinal && (finalText || timeline.length > 0))
      ? [...currentMessages, {
        role: 'assistant',
        text: finalText,
        runId: evt.runId,
        timeline,
      }]
      : currentMessages;

    return {
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        [evt.sessionId]: nextMessages,
      },
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        text: finalText,
        done: true,
        timeline,
      }),
    };
  }

  if (evt.event === 'run.error') {
    const run = state.runs[evt.runId] || { steps: [], timeline: [] };
    const error = evt.payload?.error || 'Unknown error';
    const step = {
      kind: 'status',
      status: 'failed',
      label: `Failed: ${error}`,
    };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: true,
        error,
        steps: pushStep(run, step),
        timeline: pushTimelineEntry(run, { type: 'step', ...step }),
      }),
    };
  }

  if (evt.event === 'run.aborted') {
    const run = state.runs[evt.runId] || { text: '', steps: [], timeline: [] };
    const step = {
      kind: 'status',
      status: 'aborted',
      label: 'Stopped',
    };
    const timeline = pushTimelineEntry(run, { type: 'step', ...step });
    const hasContentBeforeStop = Boolean(
      (typeof run.text === 'string' && run.text)
      || (Array.isArray(run.timeline) && run.timeline.length > 0),
    );
    const currentMessages = state.messagesBySession[evt.sessionId] || [];
    const hasStoredFinal = currentMessages.some(
      (message) => message.runId === evt.runId && message.role === 'assistant',
    );
    const nextMessages = (!hasStoredFinal && hasContentBeforeStop)
      ? [...currentMessages, {
        role: 'assistant',
        text: run.text || '',
        runId: evt.runId,
        timeline,
      }]
      : currentMessages;
    return {
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        [evt.sessionId]: nextMessages,
      },
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: true,
        aborted: true,
        steps: pushStep(run, step),
        timeline,
      }),
    };
  }

  if (evt.event === 'tool.started' || evt.event === 'tool.delta' || evt.event === 'tool.final') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const status = evt.event === 'tool.final'
      ? 'done'
      : 'running';
    const kind = evt.event === 'tool.delta'
      ? 'reasoning'
      : 'tool';
    const label = stepLabelForToolEvent(evt);
    const step = { kind, status, label };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: false,
        steps: pushStep(run, step),
        timeline: pushTimelineEntry(run, { type: 'step', ...step }),
      }),
    };
  }

  if (evt.event === 'run.event') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const status = stepStatusForRunEvent(evt);
    const kind = stepKindForRunEvent(evt);
    const label = stepLabelForRunEvent(evt);
    const step = { kind, status, label };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: false,
        steps: pushStep(run, step),
        timeline: pushTimelineEntry(run, { type: 'step', ...step }),
      }),
    };
  }

  if (evt.event === 'run.usage') {
    const usage = normalizeUsagePayload(evt.payload);
    if (!usage) return state;
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: run.done || false,
        usage,
      }),
      latestUsageBySession: {
        ...(state.latestUsageBySession || {}),
        [evt.sessionId]: usage,
      },
    };
  }

  return state;
}
