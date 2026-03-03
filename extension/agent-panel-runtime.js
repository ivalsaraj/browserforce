export function getSessionRunId(currentRunBySession, sessionId) {
  if (!sessionId) return null;
  return currentRunBySession?.[sessionId] || null;
}

export function assignSessionRunId(currentRunBySession, sessionId, runId) {
  if (!sessionId || !runId) return currentRunBySession || {};
  return {
    ...(currentRunBySession || {}),
    [sessionId]: runId,
  };
}

export function clearSessionRunId(currentRunBySession, sessionId, runId) {
  if (!sessionId) return currentRunBySession || {};
  const next = { ...(currentRunBySession || {}) };
  if (!runId || next[sessionId] === runId) {
    delete next[sessionId];
  }
  return next;
}

export function shouldApplySessionSelection({ requestToken, latestRequestToken, requestedSessionId, activeSessionId }) {
  return (
    requestToken === latestRequestToken
    && requestedSessionId === activeSessionId
  );
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineContent(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function getLatestInFlightStepIndex(run = {}) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  if (!steps.length || run?.done) return -1;
  return steps.length - 1;
}

export function classifyRunStepIcon(step = {}) {
  const status = String(step.status || '').toLowerCase();
  if (status === 'failed') return 'failed';
  if (status === 'done' || /\bdone\b/.test(String(step.label || '').toLowerCase())) return 'done';

  const label = String(step.label || '').toLowerCase();
  const kind = String(step.kind || '').toLowerCase();

  if (kind === 'reasoning') return 'reasoning';

  if (/screenshot|screen shot|capture|image/.test(label)) return 'camera';
  if (/extract|read|open|search|scan|inspect|lookup|page text|document/.test(label)) return 'view';
  if (/plan|steps|todo|checklist/.test(label)) return 'plan';
  if (kind === 'tool') return 'tool';
  return 'reasoning';
}

function normalizeUsageValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

export function formatContextUsage({ totalTokens, modelContextWindow } = {}) {
  const total = normalizeUsageValue(totalTokens);
  const windowSize = normalizeUsageValue(modelContextWindow);
  if (total == null || windowSize == null) return null;
  const percent = ((total / windowSize) * 100).toFixed(1);
  return `${total.toLocaleString()} / ${windowSize.toLocaleString()} (${percent}%)`;
}
