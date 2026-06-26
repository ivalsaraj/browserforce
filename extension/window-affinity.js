// Pure, synchronous resolver for the window a new agent tab should be created in.
//
// All async Chrome IO (validating the requested window still exists, reading the
// current focused window) happens in background.js; this module only encodes the
// decision so it is unit-testable without Chrome APIs. Centralizes the single
// windowId validity predicate (Number.isInteger).
//
// Returns the requested window when it is an integer AND still valid; otherwise
// falls back to the current focused window (which may itself be undefined when
// Chrome could not report one).
export function resolveCreateWindowId({
  requestedWindowId,
  isRequestedWindowValid,
  currentWindowId,
} = {}) {
  if (Number.isInteger(requestedWindowId) && isRequestedWindowValid === true) {
    return requestedWindowId;
  }
  return currentWindowId;
}
