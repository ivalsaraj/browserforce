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
