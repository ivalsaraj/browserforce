// backend-selection.js — pure, dependency-free browser backend policy.
//
// Two responsibilities, kept side-effect free so every consumer (CLI,
// session-client, sessiond) shares identical decisions:
//   1. resolveRequestedBackend({ argv, env }) — the ONE place backend flags/env
//      are normalized into a requested mode.
//   2. selectBrowserBackend({ requested, extensionConnected }) — maps a
//      requested mode + live extension state to the backend to actually use.
//
// Policy: real Chrome (relay + extension) is primary. `auto` falls back to a
// managed headed Chrome with a warning when the real bridge is unavailable;
// `real` never falls back; `managed`/`headless` are explicit.

export const BACKEND_MODES = Object.freeze(['auto', 'real', 'managed', 'headless']);

const VALID_MODES = new Set(BACKEND_MODES);
const EXPLICIT_FLAGS = ['real', 'managed', 'headless'];

/**
 * Normalize backend selection from CLI flags + environment into one of
 * BACKEND_MODES. Precedence (highest first):
 *   explicit boolean flag (--real/--managed/--headless)
 *   > --backend <mode>
 *   > BF_BROWSER_BACKEND
 *   > 'auto'
 * Throws on an unknown value and on mutually-exclusive explicit flags.
 */
export function resolveRequestedBackend({ argv = {}, env = {} } = {}) {
  const setFlags = EXPLICIT_FLAGS.filter((flag) => argv[flag]);
  if (setFlags.length > 1) {
    throw new Error(
      `Conflicting backend flags: ${setFlags.map((f) => `--${f}`).join(', ')} are mutually exclusive. Pick one.`,
    );
  }
  if (setFlags.length === 1) {
    return setFlags[0];
  }

  if (argv.backend != null && argv.backend !== '') {
    return validateMode(String(argv.backend), '--backend');
  }

  const envValue = env.BF_BROWSER_BACKEND;
  if (envValue != null && envValue !== '') {
    return validateMode(String(envValue), 'BF_BROWSER_BACKEND');
  }

  return 'auto';
}

function validateMode(value, source) {
  if (!VALID_MODES.has(value)) {
    throw new Error(
      `Unknown backend "${value}"${source ? ` from ${source}` : ''}. Valid backends: ${BACKEND_MODES.join(', ')}.`,
    );
  }
  return value;
}

/**
 * Resolve the backend to actually use given a requested mode and whether the
 * real Chrome bridge (relay extension) is connected.
 * Returns { backend, shouldWarn, reason }. Throws when `real` is requested but
 * the bridge is unavailable (it must never silently fall back).
 */
export function selectBrowserBackend({ requested, extensionConnected }) {
  switch (requested) {
    case 'auto':
      return extensionConnected
        ? { backend: 'real', shouldWarn: false, reason: 'real-chrome-bridge-available' }
        : { backend: 'managed', shouldWarn: true, reason: 'real-chrome-bridge-unavailable' };

    case 'real':
      if (!extensionConnected) {
        throw new Error(
          'Requested backend "real" but the real Chrome bridge is unavailable (BrowserForce extension not connected). '
          + 'Start Chrome with the BrowserForce extension, or use --managed / --headless.',
        );
      }
      return { backend: 'real', shouldWarn: false, reason: 'real-chrome-bridge-available' };

    case 'managed':
      return { backend: 'managed', shouldWarn: false, reason: 'managed-explicit' };

    case 'headless':
      return { backend: 'headless', shouldWarn: false, reason: 'headless-explicit' };

    default:
      throw new Error(`Unknown backend "${requested}". Valid backends: ${BACKEND_MODES.join(', ')}.`);
  }
}
