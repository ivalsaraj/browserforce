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

function isBrowserForceExecutePayload(payload = {}) {
  const name = String(firstString([
    payload.name,
    payload.toolName,
    payload.tool,
  ]) || '').trim().toLowerCase();

  if (name === 'browserforce:execute' || name === 'mcp__browserforce__execute') return true;
  if (name !== 'execute') return false;

  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
  if (args && typeof args.code === 'string') return true;
  if (typeof payload.code === 'string') return true;

  const rawArgs = String(firstString([payload.arguments, payload.input]) || '').trim();
  return /"code"\s*:/.test(rawArgs);
}

function isBrowserForceResetPayload(payload = {}) {
  const name = String(firstString([
    payload.name,
    payload.toolName,
    payload.tool,
  ]) || '').trim().toLowerCase();

  if (name === 'browserforce:reset' || name === 'mcp__browserforce__reset') return true;
  if (name !== 'reset') return false;

  const args = payload?.args && typeof payload.args === 'object' ? payload.args : null;
  if (args && Object.keys(args).length > 0) return false;

  const rawArgs = String(firstString([payload.arguments, payload.input]) || '').trim();
  return !rawArgs || rawArgs === '{}' || rawArgs === 'null';
}

function normalizeToolLabel(label, payload = {}) {
  const raw = String(label || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();

  if (
    isBrowserForceExecutePayload(payload)
    && (normalized === 'execute' || normalized === 'mcp__browserforce__execute' || normalized === 'browserforce:execute')
  ) {
    return 'BrowserForce:execute';
  }

  if (
    isBrowserForceResetPayload(payload)
    && (normalized === 'reset' || normalized === 'mcp__browserforce__reset' || normalized === 'browserforce:reset')
  ) {
    return 'BrowserForce:reset';
  }

  return raw;
}

const SHELL_LC_WRAPPER_RE = /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i;

function unwrapShellLcCommand(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(SHELL_LC_WRAPPER_RE);
  if (!match) return text;
  let command = String(match[1] || '').trim();
  if (!command) return text;
  if (command.length >= 2 && command.startsWith("'") && command.endsWith("'")) {
    command = command.slice(1, -1).replace(/'"'"'/g, "'");
  } else if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) {
    command = command.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return command.trim() || text;
}

function trimStepLabel(label) {
  const text = unwrapShellLcCommand(label);
  if (!text) return '';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function trimStepKey(key) {
  const text = String(key || '').trim();
  if (!text) return '';
  return text.length > 220 ? text.slice(0, 220) : text;
}

function normalizeStepStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return 'running';
  if (normalized === 'completed' || normalized === 'success' || normalized === 'succeeded') return 'done';
  return normalized;
}

function isTerminalStepStatus(status) {
  const normalized = normalizeStepStatus(status);
  return normalized === 'done' || normalized === 'failed' || normalized === 'aborted';
}

function isGenericToolLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  return normalized === 'tool call started' || normalized === 'tool call completed' || normalized === 'working...';
}

function shouldLegacyTerminalCollapseMatch(existing, candidate) {
  if (!existing || existing.key) return false;
  if (isTerminalStepStatus(existing.status)) return false;
  if (String(existing.kind || '') !== String(candidate.kind || '')) return false;
  const wildcardLabel = candidate.kind === 'tool' && isGenericToolLabel(candidate.label);
  if (wildcardLabel) return true;
  return String(existing.label || '') === String(candidate.label || '');
}

function detailsEqual(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function normalizeStepDetails(details, label = '') {
  const lines = [];
  const pushLine = (value) => {
    const line = unwrapShellLcCommand(value)
      .split('\n')
      .map((part) => part.trim())
      .filter(Boolean);
    for (const rawPart of line) {
      const part = rawPart.replace(/^[-*]\s+/, '').trim();
      if (!part) continue;
      if (part === label) continue;
      if (lines.includes(part)) continue;
      lines.push(part.length > 220 ? `${part.slice(0, 217)}...` : part);
      if (lines.length >= 8) return;
    }
  };
  const visit = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (lines.length >= 8) return;
        visit(item);
      }
      return;
    }
    if (typeof value === 'object') {
      visit(value.text);
      visit(value.message);
      visit(value.output);
      visit(value.command);
      visit(value.cmd);
      visit(value.code);
      visit(value.input);
      visit(value.args);
      visit(value.parameters);
      visit(value.params);
      visit(value.payload);
      visit(value.arguments);
      visit(value.path);
      visit(value.query);
      visit(value.pattern);
      return;
    }
    pushLine(value);
  };
  visit(details);
  return lines;
}

function stripInlineMarkdown(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^>\s*/gm, '')
    .trim();
}

function clipHeadingAtClauseBoundary(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const clauseMatch = source.match(
    /^(.{24,}?)(?:\s*;\s+|\s*,\s*(?:then|so|because|while|after)\b|\s+(?:and then|and i['’]?ll|and i am|then|so that|so i can|so we can|in order to|while|after that)\b)/i,
  );
  if (!clauseMatch) return source;
  return String(clauseMatch[1] || '').trim();
}

function commentaryHeadingFromDelta(delta) {
  const source = String(delta || '').trim();
  if (!source) return '';
  const firstLine = source
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
  if (!firstLine) return '';

  let heading = stripInlineMarkdown(firstLine)
    .replace(/^[\-*•\d.)\s]+/, '')
    .replace(/^\s*(?:i['’]?m|i am|i['’]?ll|i will)\s+/i, '')
    .replace(/^\s*(?:going to|about to|trying to|plan(?:ning)? to|want to)\s+/i, '')
    .replace(/^let me\s+/i, '')
    .replace(/^(?:next|now)\s*,?\s+/i, '')
    .replace(/[.?!:;,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  heading = clipHeadingAtClauseBoundary(heading);
  if (!heading) return '';
  if (/^(browserforce|recovery action|error[:\s])/i.test(heading)) return '';
  if (/^[`'"]?\//.test(heading) || /^[a-z]:\\/i.test(heading)) return '';
  if (heading.length > 72) {
    const clipped = heading.slice(0, 69).trimEnd();
    const wordBoundary = clipped.lastIndexOf(' ');
    const base = wordBoundary >= 56 ? clipped.slice(0, wordBoundary).trimEnd() : clipped;
    heading = `${base}...`;
  }
  return heading.charAt(0).toUpperCase() + heading.slice(1);
}

function applyCommentaryDeltaToRun(run, delta) {
  const sourceRun = run || {};
  let steps = Array.isArray(sourceRun.steps) ? sourceRun.steps : [];
  let timeline = Array.isArray(sourceRun.timeline) ? sourceRun.timeline : [];
  let commentarySequence = Number.isInteger(sourceRun.commentarySequence) ? sourceRun.commentarySequence : 0;
  let activeCommentaryStepKey = String(sourceRun.activeCommentaryStepKey || '');
  const hasActiveCommentary = !!activeCommentaryStepKey && timeline.at(-1)?.type === 'text';

  if (!hasActiveCommentary) {
    commentarySequence += 1;
    activeCommentaryStepKey = `commentary:${commentarySequence}`;
    const heading = commentaryHeadingFromDelta(delta);
    if (heading) {
      const step = {
        kind: 'reasoning',
        status: 'running',
        key: activeCommentaryStepKey,
        label: heading,
      };
      steps = pushStep({ steps }, step);
      timeline = pushTimelineEntry({ timeline }, { type: 'step', ...step });
    }
    timeline = pushTimelineEntry({ timeline }, { type: 'text', text: delta });
    return {
      steps,
      timeline,
      activeCommentaryStepKey,
      commentarySequence,
    };
  }

  timeline = pushTimelineEntry({ timeline }, { type: 'text', text: delta });
  const mergedText = timeline.at(-1)?.type === 'text' ? timeline.at(-1)?.text || '' : delta;
  const heading = commentaryHeadingFromDelta(mergedText);
  if (heading) {
    const step = {
      kind: 'reasoning',
      status: 'running',
      key: activeCommentaryStepKey,
      label: heading,
    };
    steps = pushStep({ steps }, step);
    timeline = pushTimelineEntry({ timeline }, { type: 'step', ...step });
  }

  return {
    steps,
    timeline,
    activeCommentaryStepKey,
    commentarySequence,
  };
}

function normalizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const label = trimStepLabel(step.label);
  if (!label) return null;
  const details = normalizeStepDetails(step.details, label);
  return {
    kind: step.kind || 'reasoning',
    status: normalizeStepStatus(step.status),
    label,
    ...(trimStepKey(step.key) ? { key: trimStepKey(step.key) } : {}),
    ...(details.length > 0 ? { details } : {}),
  };
}

function pushStep(run, step) {
  const steps = Array.isArray(run?.steps) ? run.steps.slice() : [];
  const normalized = normalizeStep(step);
  if (!normalized || !normalized.label) return steps;
  const keyedIndex = normalized.key
    ? (() => {
      for (let idx = steps.length - 1; idx >= 0; idx -= 1) {
        if (steps[idx]?.key === normalized.key) return idx;
      }
      return -1;
    })()
    : -1;
  if (keyedIndex >= 0) {
    const existing = steps[keyedIndex];
    steps[keyedIndex] = {
      ...existing,
      ...normalized,
      label: (isGenericToolLabel(normalized.label) && existing?.label) ? existing.label : normalized.label,
      details: normalized.details && normalized.details.length > 0 ? normalized.details : existing?.details,
    };
    return steps;
  }

  if (!normalized.key && isTerminalStepStatus(normalized.status)) {
    let fallbackIndex = -1;
    for (let idx = steps.length - 1; idx >= 0; idx -= 1) {
      const entry = steps[idx];
      if (shouldLegacyTerminalCollapseMatch(entry, normalized)) {
        fallbackIndex = idx;
        break;
      }
    }
    if (fallbackIndex >= 0) {
      const existing = steps[fallbackIndex];
      steps[fallbackIndex] = {
        ...existing,
        ...normalized,
        label: (isGenericToolLabel(normalized.label) && existing?.label) ? existing.label : normalized.label,
        details: normalized.details && normalized.details.length > 0 ? normalized.details : existing?.details,
      };
      return steps;
    }
  }

  const last = steps[steps.length - 1];
  if (
    last
    && last.label === normalized.label
    && last.kind === normalized.kind
    && last.status === normalized.status
    && detailsEqual(last.details, normalized.details)
  ) {
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
    const keyedIndex = candidate.key
      ? (() => {
        for (let idx = timeline.length - 1; idx >= 0; idx -= 1) {
          const item = timeline[idx];
          if (item?.type === 'step' && item.key === candidate.key) return idx;
        }
        return -1;
      })()
      : -1;
    if (keyedIndex >= 0) {
      const existing = timeline[keyedIndex];
      timeline[keyedIndex] = {
        ...existing,
        ...candidate,
        label: (isGenericToolLabel(candidate.label) && existing?.label) ? existing.label : candidate.label,
        details: candidate.details && candidate.details.length > 0 ? candidate.details : existing?.details,
      };
      return timeline;
    }

    if (!candidate.key && isTerminalStepStatus(candidate.status)) {
      let fallbackIndex = -1;
      for (let idx = timeline.length - 1; idx >= 0; idx -= 1) {
        const item = timeline[idx];
        if (item?.type === 'step' && shouldLegacyTerminalCollapseMatch(item, candidate)) {
          fallbackIndex = idx;
          break;
        }
      }
      if (fallbackIndex >= 0) {
        const existing = timeline[fallbackIndex];
        timeline[fallbackIndex] = {
          ...existing,
          ...candidate,
          label: (isGenericToolLabel(candidate.label) && existing?.label) ? existing.label : candidate.label,
          details: candidate.details && candidate.details.length > 0 ? candidate.details : existing?.details,
        };
        return timeline;
      }
    }

    if (!candidate.key && String(candidate.kind || '') === 'reasoning') {
      for (let idx = timeline.length - 1; idx >= 0; idx -= 1) {
        const item = timeline[idx];
        if (!item) continue;
        if (item.type === 'text') continue;
        if (item.type !== 'step') break;
        if (String(item.kind || '') !== 'reasoning') break;
        if (String(item.label || '') !== String(candidate.label || '')) break;
        timeline[idx] = {
          ...item,
          ...candidate,
          details: candidate.details && candidate.details.length > 0 ? candidate.details : item.details,
        };
        return timeline;
      }
    }

    const last = timeline[timeline.length - 1];
    if (
      last
      && last.type === 'step'
      && last.label === candidate.label
      && last.kind === candidate.kind
      && last.status === candidate.status
      && detailsEqual(last.details, candidate.details)
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

function normalizeStoredTimeline(timeline) {
  if (!Array.isArray(timeline)) return [];
  let entries = [];
  for (const item of timeline.slice(-200)) {
    const normalized = normalizeStoredTimelineEntry(item);
    if (!normalized) continue;
    entries = pushTimelineEntry({ timeline: entries }, normalized);
  }
  return entries;
}

function fallbackTimelineFromMessage({ steps, text }) {
  let timeline = [];
  for (const step of steps) {
    timeline = pushTimelineEntry({ timeline }, { type: 'step', ...step });
  }
  if (typeof text === 'string' && text) {
    timeline = pushTimelineEntry({ timeline }, { type: 'text', text });
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
  const toolLabel = normalizeToolLabel(firstString([
    payload.command,
    payload.title,
    payload.name,
    payload.tool,
    payload.toolName,
  ]), payload);
  if (evt.event === 'tool.started') {
    return toolLabel || 'Tool call started';
  }
  if (evt.event === 'tool.final') {
    return toolLabel || 'Tool call completed';
  }
  if (evt.event === 'tool.delta') {
    if (String(payload.type || '').toLowerCase() === 'reasoning') {
      const heading = commentaryHeadingFromDelta(firstString([
        payload.text,
        payload.message,
        payload.delta,
      ]));
      return heading || 'Reasoning';
    }
    return normalizeToolLabel(firstString([
      payload.text,
      payload.message,
      payload.delta,
      payload.command,
      payload.name,
      payload.tool,
      payload.toolName,
      payload.type === 'reasoning' ? 'Reasoning' : '',
    ]), payload) || 'Working...';
  }
  return '';
}

function stepKeyForToolEvent(evt) {
  const payload = evt?.payload || {};
  const key = firstString([
    payload.stepKey,
    payload.step_key,
    payload.callId,
    payload.call_id,
    payload.toolCallId,
    payload.tool_call_id,
    payload.id,
  ]);
  if (!key) return '';
  return key.startsWith('tool:') ? key : `tool:${key}`;
}

function stepDetailsForToolEvent(evt, label) {
  const payload = evt?.payload || {};
  if (String(payload.type || '').toLowerCase() === 'reasoning') return [];
  return normalizeStepDetails([
    payload.details,
    payload.text,
    payload.message,
    payload.delta,
    payload.command,
    payload.cmd,
    payload.code,
    payload.arguments,
    payload.path,
    payload.query,
    payload.pattern,
    payload.args,
    payload.paths,
    payload.items,
    payload.item,
  ], label);
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
  const label = firstString([
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
  ]);

  const normalized = normalizeToolLabel(label, {
    ...payload,
    ...item,
    name: firstString([item.name, payload.name]),
    toolName: firstString([item.toolName, payload.toolName]),
    tool: firstString([item.tool, payload.tool]),
    args: item.args || payload.args,
    arguments: firstString([item.arguments, payload.arguments]),
    input: item.input || payload.input,
    code: firstString([item.code, payload.code]),
  });
  return normalized || 'Working...';
}

function stepKeyForRunEvent(evt) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  const key = firstString([
    payload.stepKey,
    payload.step_key,
    item.stepKey,
    item.step_key,
    payload.callId,
    payload.call_id,
    item.callId,
    item.call_id,
    item.id,
    payload.id,
  ]);
  if (!key) return '';
  return key.startsWith('tool:') ? key : `tool:${key}`;
}

function stepDetailsForRunEvent(evt, label) {
  const payload = evt?.payload || {};
  const item = payload?.item && typeof payload.item === 'object' ? payload.item : {};
  return normalizeStepDetails([
    payload.details,
    payload.text,
    payload.message,
    payload.delta,
    payload.command,
    payload.path,
    payload.query,
    payload.pattern,
    payload.args,
    payload.paths,
    payload.items,
    payload.item,
    item?.details,
    item?.text,
    item?.message,
    item?.summary,
    item?.command,
    item?.path,
    item?.query,
    item?.pattern,
    item?.args,
    item?.paths,
    item?.input,
    item?.arguments,
  ], label);
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
    const timeline = normalizeStoredTimeline(message?.timeline);
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
        activeCommentaryStepKey: '',
        commentarySequence: 0,
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
        activeCommentaryStepKey: '',
      }),
    };
  }

  if (evt.event === 'chat.commentary') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const delta = evt.payload?.delta || '';
    const commentaryState = applyCommentaryDeltaToRun(run, delta);
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        steps: commentaryState.steps,
        timeline: commentaryState.timeline,
        activeCommentaryStepKey: commentaryState.activeCommentaryStepKey,
        commentarySequence: commentaryState.commentarySequence,
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
        activeCommentaryStepKey: '',
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
    const timeline = pushTimelineEntry(run, { type: 'step', ...step });
    const currentMessages = state.messagesBySession[evt.sessionId] || [];
    const hasStoredFinal = currentMessages.some(
      (message) => message.runId === evt.runId && message.role === 'assistant',
    );
    const nextMessages = (!hasStoredFinal && (timeline.length > 0 || error))
      ? [...currentMessages, {
        role: 'assistant',
        text: '',
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
        error,
        steps: pushStep(run, step),
        timeline,
        activeCommentaryStepKey: '',
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
        activeCommentaryStepKey: '',
      }),
    };
  }

  if (evt.event === 'tool.started' || evt.event === 'tool.delta' || evt.event === 'tool.final') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const status = evt.event === 'tool.final'
      ? 'done'
      : 'running';
    const kind = (evt.event === 'tool.delta' && String(evt?.payload?.type || '').toLowerCase() === 'reasoning')
      ? 'reasoning'
      : 'tool';
    const label = stepLabelForToolEvent(evt);
    const details = stepDetailsForToolEvent(evt, label);
    const stepKey = stepKeyForToolEvent(evt);
    const step = {
      kind,
      status,
      label,
      ...(stepKey ? { key: stepKey } : {}),
      ...(details.length > 0 ? { details } : {}),
    };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: false,
        steps: pushStep(run, step),
        timeline: pushTimelineEntry(run, { type: 'step', ...step }),
        activeCommentaryStepKey: '',
      }),
    };
  }

  if (evt.event === 'run.event') {
    const run = state.runs[evt.runId] || { text: '', done: false, steps: [], timeline: [] };
    const status = stepStatusForRunEvent(evt);
    const kind = stepKindForRunEvent(evt);
    const label = stepLabelForRunEvent(evt);
    const details = stepDetailsForRunEvent(evt, label);
    const stepKey = stepKeyForRunEvent(evt);
    const step = {
      kind,
      status,
      label,
      ...(stepKey ? { key: stepKey } : {}),
      ...(details.length > 0 ? { details } : {}),
    };
    return {
      ...state,
      runs: upsertRun(state, evt.runId, {
        sessionId: evt.sessionId,
        done: false,
        steps: pushStep(run, step),
        timeline: pushTimelineEntry(run, { type: 'step', ...step }),
        activeCommentaryStepKey: '',
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
