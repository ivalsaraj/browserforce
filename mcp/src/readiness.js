// mcp/src/readiness.js — pure classification of BrowserForce readiness.
//
// Four states used to arrive as one failure, and an agent that cannot tell
// "not installed" from "Chrome is closed" reports no browser available and
// skips the work. Kept pure and I/O-free so both callers share one wording:
// the CLI assertion (exec-engine) and the MCP preflight (startup), which are
// deliberately separate code paths.

export const READY = 'READY';
export const RELAY_UNREACHABLE = 'RELAY_UNREACHABLE';
export const EXTENSION_DISCONNECTED = 'EXTENSION_DISCONNECTED';
export const NO_TABS = 'NO_TABS';

export const NO_TABS_MESSAGE = 'BrowserForce is connected but Chrome has no tabs. Open a tab and retry.';

/**
 * @param statusError   error thrown while reading /extension/status, if any
 * @param status        the /extension/status body, if it was read
 * @param discoveredPageCount  pages the CDP client can see. OMIT pre-connect:
 *   `attachedTabs` is empty on a healthy browser until Target.setAutoAttach, so
 *   asking the no-tabs question before discovery rejects working sessions.
 */
export function classifyReadiness({ statusError = null, status = null, discoveredPageCount } = {}) {
  if (statusError) {
    return {
      code: RELAY_UNREACHABLE,
      message: 'Cannot reach BrowserForce relay — it is not reachable and did not auto-start. '
        + `Start it with \`browserforce serve\`, then check nothing else holds the port (${statusError.message}).`,
    };
  }
  // Strict equality: a malformed body such as { connected: "false" } is truthy
  // and would classify a broken relay as READY, permitting CDP startup.
  if (status?.connected !== true) {
    return {
      code: EXTENSION_DISCONNECTED,
      message: 'BrowserForce relay is up but the Chrome extension is not connected to it. '
        + 'Open Chrome, then enable the BrowserForce extension at chrome://extensions.',
    };
  }
  if (discoveredPageCount === 0) {
    return { code: NO_TABS, message: NO_TABS_MESSAGE };
  }
  return { code: READY, message: '' };
}
