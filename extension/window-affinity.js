// Pure, synchronous resolver for where a new agent tab should be created.
//
// All async Chrome IO (validating the requested window still exists, reading the
// current focused window, creating a new window) happens in background.js; this
// module only encodes the decision so it is unit-testable without Chrome APIs.
// Centralizes the single windowId validity predicate (Number.isInteger).
//
// Returns a plan describing what background.js should do:
//   { action: 'use-window', windowId }     → open a tab in this existing window
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
  currentWindowId,
  dedicatedWindowEnabled = false,
} = {}) {
  if (Number.isInteger(requestedWindowId) && isRequestedWindowValid === true) {
    return { action: 'use-window', windowId: requestedWindowId };
  }
  if (dedicatedWindowEnabled === true) {
    return { action: 'new-window' };
  }
  return { action: 'current-window', windowId: currentWindowId };
}
