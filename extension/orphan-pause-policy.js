// extension/orphan-pause-policy.js — which debugger events are pauses that
// Chrome holds until a debugger replies, and the reply that releases each one.
// Pure so it is unit-testable (extension code needs chrome.* APIs), following
// tab-update-policy.js.
//
// Playwright leaves `waitForDebuggerOnStart` auto-attach (and, after
// page.route, Fetch interception) enabled on every tab it drives, and the
// debugger stays attached after the agent disconnects. Without a reply a
// reload hangs: a paused service worker blocks the navigation request.
// The relay resolves these while it is up; the extension uses this helper only
// when the relay cannot see the event. See AGENTS.md "Orphaned Debugger Pauses".

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * @returns {{ method: string, params: object, sessionId?: string } | null}
 *   `sessionId` overrides the debuggee session; undefined means the event's own
 *   source session. Malformed events return null: a child resume without its
 *   session id would fall back to the parent session, i.e. a top-level resume.
 */
export function resolveOrphanedPause(method, params) {
  if (!params || typeof params !== 'object') return null;
  switch (method) {
    case 'Target.attachedToTarget':
      if (params.waitingForDebugger !== true || !isNonEmptyString(params.sessionId)) return null;
      return { method: 'Runtime.runIfWaitingForDebugger', params: {}, sessionId: params.sessionId };
    case 'Fetch.requestPaused':
      if (!isNonEmptyString(params.requestId)) return null;
      return { method: 'Fetch.continueRequest', params: { requestId: params.requestId } };
    case 'Fetch.authRequired':
      if (!isNonEmptyString(params.requestId)) return null;
      // 'Default' hands the challenge back to Chrome's own auth prompt.
      return {
        method: 'Fetch.continueWithAuth',
        params: { requestId: params.requestId, authChallengeResponse: { response: 'Default' } },
      };
    default:
      return null;
  }
}
