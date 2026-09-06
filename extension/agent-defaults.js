// Single source of truth for agent-behaviour setting defaults.
//
// Kept out of background.js so the resolvers are unit-testable without Chrome
// APIs (same rationale as window-affinity.js). popup.js is a classic script and
// cannot import this module, so it mirrors DEFAULT_AUTO_CLOSE_MINUTES inline;
// test/agent/agent-defaults.test.js asserts the two stay in agreement.

/**
 * Minutes of inactivity before an agent-created tab is closed.
 * Agent tabs are disposable: left ON, a long session otherwise accumulates
 * dozens of abandoned tabs in the agent's window.
 */
export const DEFAULT_AUTO_CLOSE_MINUTES = 10;

/**
 * Resolve the auto-close interval from stored settings.
 * Uses an explicit integer check rather than `||` so an explicit "Off" (0) —
 * a real user choice — is never silently replaced by the default.
 * @returns {number} minutes; 0 means disabled
 */
export function resolveAutoCloseMinutes(settings) {
  const stored = settings?.autoCloseMinutes;
  return Number.isInteger(stored) && stored >= 0 ? stored : DEFAULT_AUTO_CLOSE_MINUTES;
}

/**
 * Agent tabs belong in the agent's own window, so this is ON unless the user
 * explicitly turned it off.
 */
export function resolveDedicatedWindow(settings) {
  return settings?.dedicatedWindow !== false;
}
