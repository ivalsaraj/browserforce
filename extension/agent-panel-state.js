export const initialState = {
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  runs: {},
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

function pushStep(run, step) {
  const steps = Array.isArray(run?.steps) ? run.steps.slice() : [];
  const normalized = {
    kind: step.kind || 'reasoning',
    status: step.status || 'running',
    label: trimStepLabel(step.label),
  };
  if (!normalized.label) return steps;
  const last = steps[steps.length - 1];
  if (last && last.label === normalized.label && last.kind === normalized.kind && last.status === normalized.status) {
    return steps;
  }
  steps.push(normalized);
  if (steps.length > 100) steps.shift();
  return steps;
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

function upsertRun(state, runId, patch) {
  return {
    ...state.runs,
    [runId]: {
      ...(state.runs[runId] || { runId, text: '', done: false, steps: [] }),
      ...patch,
    },
  };
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
    return {
      ...state,
      messagesBySession: {
        ...state.messagesBySession,
        [action.sessionId]: Array.isArray(action.messages) ? action.messages : [],
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
      }),
    };
  }

  if (evt.event === 'chat.delta') {
    const run = state.runs[evt.runId] || { text: '', done: false };
    const delta = evt.payload?.delta || '';
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        text: `${run.text || ''}${delta}`,
      }),
    };
  }

  if (evt.event === 'chat.final') {
    const finalText = evt.payload?.text || state.runs[evt.runId]?.text || '';
    const currentMessages = state.messagesBySession[evt.sessionId] || [];
    const hasStoredFinal = currentMessages.some(
      (message) => message.runId === evt.runId && message.role === 'assistant',
    );
    const nextMessages = (!hasStoredFinal && finalText)
      ? [...currentMessages, { role: 'assistant', text: finalText, runId: evt.runId }]
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
      }),
    };
  }

  if (evt.event === 'run.error') {
    const run = state.runs[evt.runId] || { steps: [] };
    const error = evt.payload?.error || 'Unknown error';
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: true,
        error,
        steps: pushStep(run, {
          kind: 'status',
          status: 'failed',
          label: `Failed: ${error}`,
        }),
      }),
    };
  }

  if (evt.event === 'run.aborted') {
    const run = state.runs[evt.runId] || { steps: [] };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: true,
        aborted: true,
        steps: pushStep(run, {
          kind: 'status',
          status: 'aborted',
          label: 'Stopped',
        }),
      }),
    };
  }

  if (evt.event === 'tool.started' || evt.event === 'tool.delta' || evt.event === 'tool.final') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [] };
    const status = evt.event === 'tool.final'
      ? 'done'
      : 'running';
    const kind = evt.event === 'tool.delta'
      ? 'reasoning'
      : 'tool';
    const label = stepLabelForToolEvent(evt);
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: false,
        steps: pushStep(run, { kind, status, label }),
      }),
    };
  }

  return state;
}
