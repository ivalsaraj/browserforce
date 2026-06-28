// mcp/src/doctor.js — read-only BrowserForce diagnostics (`browserforce doctor`).
//
// runDoctor() is a pure orchestrator over a set of injectable probes so each
// check is unit-testable without a live relay/browser/fs. It is read-only by
// default; with `fix: true` it removes ONLY stale sidecars (the leftover
// cdp-url file and a dead session daemon's lock/url sidecars). It NEVER removes
// the auth token or a managed-browser profile — destructive cleanup of secrets
// requires explicit, separate action by the user.

import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  BF_DIR,
  CDP_URL_FILE,
  getExtensionStatus,
  getRelayHttpUrl,
} from './exec-engine.js';
import {
  resolveSessiondLockPath,
  resolveSessiondUrlPath,
  sessiondHttpRequest,
} from '../../cli/session-client.js';
import { isLockAlive } from '../../agent/src/lockfile.js';

export const OK = 'ok';
export const WARN = 'warn';
export const FAIL = 'fail';

const TOKEN_FILE = join(BF_DIR, 'auth-token');

function check(id, label, status, detail, extra = {}) {
  return { id, label, status, detail, ...extra };
}

function defaultFileStat(p) {
  try {
    const st = statSync(p);
    return { exists: true, mode: st.mode & 0o777 };
  } catch {
    return { exists: false, mode: null };
  }
}

function defaultReadText(p) {
  try {
    const s = readFileSync(p, 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

function defaultReadRawLock(p) {
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    if (!Number.isInteger(data?.pid) || !Number.isInteger(data?.port)) return null;
    return data;
  } catch {
    return null;
  }
}

function defaultRemoveFile(p) {
  try { unlinkSync(p); } catch { /* already gone */ }
}

async function defaultProbeSessiondStatus(lock) {
  const { status, body } = await sessiondHttpRequest(
    'GET', `http://127.0.0.1:${lock.port}/status`, null, lock.token,
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return body;
}

function defaultPaths() {
  return {
    tokenFile: TOKEN_FILE,
    cdpUrlFile: CDP_URL_FILE,
    sessiondLockFile: resolveSessiondLockPath(),
    sessiondUrlFile: resolveSessiondUrlPath(),
  };
}

/**
 * Run the diagnostic checks. Returns { ok, checks, fixes }.
 *   - `ok` is false iff any check is FAIL (warnings never fail the run).
 *   - `fixes` lists sidecar paths removed when `fix` is true.
 */
export async function runDoctor({
  fix = false,
  probeExtensionStatus = () => getExtensionStatus(),
  relayHttpUrl = getRelayHttpUrl(),
  fileStat = defaultFileStat,
  readText = defaultReadText,
  readRawLock = defaultReadRawLock,
  lockAlive = (lock) => isLockAlive({ lock }),
  probeSessiondStatus = defaultProbeSessiondStatus,
  removeFile = defaultRemoveFile,
  paths = defaultPaths(),
} = {}) {
  const checks = [];
  const fixes = [];

  // 1. Relay reachable + 2. extension connected (same probe).
  let relayStatus = null;
  let relayUp = false;
  try {
    relayStatus = await probeExtensionStatus();
    relayUp = true;
    checks.push(check('relay', 'Relay server', OK, `reachable at ${relayHttpUrl}`));
  } catch (err) {
    checks.push(check('relay', 'Relay server', FAIL,
      `not reachable at ${relayHttpUrl} — start it with \`browserforce serve\` (${err.message})`));
  }

  if (!relayUp) {
    checks.push(check('extension', 'Chrome extension', WARN, 'cannot check — relay not reachable'));
  } else if (relayStatus?.connected) {
    checks.push(check('extension', 'Chrome extension', OK, 'connected to the relay'));
  } else {
    checks.push(check('extension', 'Chrome extension', FAIL,
      'relay is up but the extension is not connected — open Chrome and check the BrowserForce extension'));
  }

  // 3. Stale cdp-url sidecar: present on disk while the relay is unreachable.
  const cdpUrl = readText(paths.cdpUrlFile);
  if (!cdpUrl) {
    checks.push(check('cdp-url', 'CDP URL sidecar', OK, 'none on disk'));
  } else if (relayUp) {
    checks.push(check('cdp-url', 'CDP URL sidecar', OK, 'present and relay is reachable'));
  } else if (fix) {
    removeFile(paths.cdpUrlFile);
    fixes.push(paths.cdpUrlFile);
    checks.push(check('cdp-url', 'CDP URL sidecar', OK, 'removed stale sidecar (relay not reachable)', { fixed: true }));
  } else {
    checks.push(check('cdp-url', 'CDP URL sidecar', WARN,
      'stale — points at a relay that is not reachable; run `browserforce doctor --fix` to remove', { fixable: true }));
  }

  // 4. Secret file permissions: auth token + sessiond sidecars must be 0600.
  const permIssues = [];
  for (const [label, p] of [
    ['auth-token', paths.tokenFile],
    ['sessiond lock', paths.sessiondLockFile],
    ['sessiond url', paths.sessiondUrlFile],
  ]) {
    const st = fileStat(p);
    if (st.exists && st.mode != null && (st.mode & 0o077) !== 0) {
      permIssues.push(`${label} is ${st.mode.toString(8)} (expected 600)`);
    }
  }
  if (permIssues.length === 0) {
    checks.push(check('permissions', 'Secret file permissions', OK, 'auth token + sessiond sidecars are 0600 (or absent)'));
  } else {
    checks.push(check('permissions', 'Secret file permissions', WARN, permIssues.join('; ')));
  }

  // 5. Active backend status from the session daemon.
  const lock = readRawLock(paths.sessiondLockFile);
  if (!lock) {
    checks.push(check('backend', 'Session daemon backend', OK, 'no session daemon running'));
  } else if (!(await lockAlive(lock))) {
    if (fix) {
      removeFile(paths.sessiondLockFile);
      removeFile(paths.sessiondUrlFile);
      fixes.push(paths.sessiondLockFile);
      checks.push(check('backend', 'Session daemon backend', OK,
        `removed stale sessiond lock (pid ${lock.pid} not alive)`, { fixed: true }));
    } else {
      checks.push(check('backend', 'Session daemon backend', WARN,
        `stale sessiond lock (pid ${lock.pid} not alive); run \`browserforce doctor --fix\` to remove`, { fixable: true }));
    }
  } else {
    try {
      const status = await probeSessiondStatus(lock);
      const backend = status?.backend || 'unknown';
      if (status?.warning) {
        checks.push(check('backend', 'Session daemon backend', WARN, `${backend} — ${status.warning}`));
      } else {
        checks.push(check('backend', 'Session daemon backend', OK,
          `${backend} (requested ${status?.requestedBackend || 'auto'})`));
      }
    } catch (err) {
      checks.push(check('backend', 'Session daemon backend', WARN,
        `daemon lock is alive but /status failed: ${err.message}`));
    }
  }

  return { ok: checks.every((c) => c.status !== FAIL), checks, fixes };
}
