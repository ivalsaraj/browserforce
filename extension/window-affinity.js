// Pure, synchronous resolver for where a new agent tab should be created.
//
// All async Chrome IO (validating the requested window still exists, reading the
// current focused window, creating a new window) happens in background.js; this
// module only encodes the decision so it is unit-testable without Chrome APIs.
// Centralizes the single windowId validity predicate (Number.isInteger).
//
// Returns a plan describing what background.js should do:
//   { action: 'use-window', windowId }     → open a tab in this existing window
//                                            (under dedicated mode, only when
//                                             the agent opened that window)
//   { action: 'new-window' }               → create a fresh dedicated window
//   { action: 'current-window', windowId } → open a tab in the current window
//                                            (windowId may be undefined when
//                                             Chrome reports no current window)
//
// When the requested (relay-pinned) window is gone and dedicated mode is on, we
// deliberately return 'new-window' rather than dropping the agent's tab into the
// user's current window — keeping the agent's work isolated is the whole point.
export function resolveCreateWindowPlan({
  requestedWindowId,
  isRequestedWindowValid,
  isRequestedWindowDedicated = false,
  currentWindowId,
  dedicatedWindowEnabled = false,
} = {}) {
  const canReuse = Number.isInteger(requestedWindowId) && isRequestedWindowValid === true;
  // A pinned window is not necessarily an AGENT window: a pin established while
  // dedicated mode was OFF names the user's own window, and it stays valid when
  // the setting is later turned ON. Only the extension knows which windows it
  // opened as dedicated, so that is the predicate dedicated mode must trust.
  if (canReuse && (dedicatedWindowEnabled !== true || isRequestedWindowDedicated === true)) {
    return { action: 'use-window', windowId: requestedWindowId };
  }
  if (dedicatedWindowEnabled === true) {
    return { action: 'new-window' };
  }
  return { action: 'current-window', windowId: currentWindowId };
}
