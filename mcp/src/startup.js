// BrowserForce — Crash-safe MCP startup preflight
//
// Centralizes the attached-page preflight that MUST run before any
// ensureBrowser() / chromium.connectOverCDP() call. Both the live execute/reset
// handlers (via preflightAttachedPageBeforeCdp) and the behavior tests (via
// runExecuteStartupForTest / runResetStartupForTest) share the same assertion
// path so the test proves the real gating logic, not a stub.

import {
  ensureRelay,
  getRelayHttpUrl,
  getExtensionStatus,
  isAttachedPageIntent,
  assertAttachedPageAvailable,
  assertOpenIntentAllowed,
  BrowserForceMcpError,
} from './exec-engine.js';

// ─── Shared assertion gate (no I/O) ──────────────────────────────────────────

/**
 * Format a BrowserForceMcpError into a stable machine-readable MCP response so
 * clients can branch on `error.code`. Shared by execute/reset catch blocks and
 * the behavior tests.
 */
export function formatBrowserForceMcpError(err) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: {
          code: err.code,
          message: err.message,
          details: err.details,
        },
      }, null, 2),
    }],
    isError: true,
  };
}

/**
 * Run the attached-page / open-intent assertions against already-fetched
 * restrictions + extension status. Throws BrowserForceMcpError on failure.
 * Returns the restrictions so callers can reuse them for the rest of the turn.
 */
function runPreflightAssertions({ intent, restrictions, extensionStatus }) {
  if (isAttachedPageIntent(intent)) {
    assertAttachedPageAvailable({ extensionStatus, restrictions, intent });
  } else {
    assertOpenIntentAllowed(restrictions);
  }
  return restrictions;
}

// ─── Live preflight (does I/O) ───────────────────────────────────────────────

/**
 * Live preflight used by execute/reset handlers before ensureBrowser().
 * Fetches fresh restrictions (forceRefresh, bypasses cache) and extension
 * status from the relay, then runs the assertion gate. Returns the fresh
 * restrictions so the handler reuses them for the rest of the turn.
 *
 * Fail-closed: if the restrictions fetch itself throws (extension missing,
 * timeout, malformed, network error), the safety gate throws
 * BF_RESTRICTIONS_UNAVAILABLE so CDP startup is never reached with an unknown
 * policy. The tolerant `getBrowserforceRestrictionsForSession` in index.js
 * still returns a default for the exec-context UI value — the preflight is
 * the only startup safety gate, and it must not fall back silently here.
 *
 * `fetchBrowserforceRestrictions` is injected by the caller (index.js) because
 * the restrictions cache lives there — this keeps startup.js free of a circular
 * import with index.js.
 */
export async function preflightAttachedPageBeforeCdp({
  intent = 'inspect',
  fetchBrowserforceRestrictions,
} = {}) {
  await ensureRelay();
  const baseUrl = getRelayHttpUrl();
  let restrictions;
  try {
    restrictions = await fetchBrowserforceRestrictions({ forceRefresh: true });
  } catch (err) {
    throw new BrowserForceMcpError(
      'BrowserForce restrictions are unavailable. Retry once the extension and relay are reachable.',
      {
        code: 'BF_RESTRICTIONS_UNAVAILABLE',
        details: { intent, reason: err?.message || String(err) },
      },
    );
  }
  const extensionStatus = await getExtensionStatus({ baseUrl });
  return runPreflightAssertions({ intent, restrictions, extensionStatus });
}

// ─── Testable startup runners (no I/O — deps injected) ───────────────────────

/**
 * Execute startup path with injected restrictions/status/ensureBrowser so tests
 * can prove ensureBrowser is NOT called when preflight fails. Returns
 * `{ restrictions }` on success or `{ error: { code, message, details } }` when
 * the preflight throws a BrowserForceMcpError.
 */
export async function runExecuteStartupForTest({
  intent = 'inspect',
  restrictions,
  extensionStatus,
  ensureBrowser,
}) {
  try {
    runPreflightAssertions({ intent, restrictions, extensionStatus });
  } catch (err) {
    if (err instanceof BrowserForceMcpError) {
      return { error: { code: err.code, message: err.message, details: err.details } };
    }
    throw err;
  }
  await ensureBrowser();
  return { restrictions };
}

/**
 * Reset startup path — always inspects (reset reconnects to the attached page,
 * never opens a new tab). Same injection contract as runExecuteStartupForTest.
 */
export async function runResetStartupForTest({
  restrictions,
  extensionStatus,
  ensureBrowser,
}) {
  return runExecuteStartupForTest({
    intent: 'inspect',
    restrictions,
    extensionStatus,
    ensureBrowser,
  });
}
