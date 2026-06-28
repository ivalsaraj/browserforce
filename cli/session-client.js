// cli/session-client.js — client-side helpers for the BrowserForce session
// daemon (sessiond). Shared by `bin.js` (CLI verbs) and `cli/sessiond.js`.
//
// Lock handling reuses `agent/src/lockfile.js` (already `0o600`, with an
// additive `version` field) so chatd and sessiond share one battle-tested
// implementation. This module layers on: sessiond-scoped path resolution, a
// `0o600` URL sidecar for clients, and an authenticated localhost HTTP client.
//
// The token lives only in the `0o600` lock (and url) sidecar; it is sent as
// `Authorization: Bearer <token>` and never placed in a URL/query string.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import { writeLock, readLock, clearLock, isLockAlive } from '../agent/src/lockfile.js';

export const DEFAULT_SESSIOND_LOCK_PATH = join(homedir(), '.browserforce', 'sessiond-lock.json');

export function resolveSessiondLockPath(lockPath) {
  return lockPath || process.env.BF_SESSIOND_LOCK_PATH || DEFAULT_SESSIOND_LOCK_PATH;
}

/**
 * Normalize a ref input into its canonical short form. The CLI accepts the
 * agent-browser-style aliases `@e1`, `ref=e1`, and bare `e1`; all map to `e1`
 * (snapshot output keeps the `[ref=e1]` contract). Normalizing in both the CLI
 * and sessiond keeps any client's aliases working.
 */
export function normalizeRef(input) {
  if (input == null) return '';
  let s = String(input).trim();
  if (s.startsWith('@')) s = s.slice(1);
  else if (s.slice(0, 4).toLowerCase() === 'ref=') s = s.slice(4);
  return s.trim();
}

// The URL sidecar lives next to the lock so test-isolated lock paths
// (BF_SESSIOND_LOCK_PATH=/tmp/...) keep their url sidecar isolated too, while an
// explicit override always wins.
export function resolveSessiondUrlPath({ urlPath, lockPath } = {}) {
  if (urlPath) return urlPath;
  if (process.env.BF_SESSIOND_URL_PATH) return process.env.BF_SESSIOND_URL_PATH;
  const lock = resolveSessiondLockPath(lockPath);
  return `${lock.replace(/\.json$/i, '')}-url.json`;
}

export async function writeSessiondLock({ pid, port, token, version = null, lockPath } = {}) {
  return writeLock({ pid, port, token, version, lockPath: resolveSessiondLockPath(lockPath) });
}

export async function readSessiondLock({ lockPath } = {}) {
  return readLock({ lockPath: resolveSessiondLockPath(lockPath) });
}

export async function clearSessiondLock({ lockPath } = {}) {
  return clearLock({ lockPath: resolveSessiondLockPath(lockPath) });
}

export async function writeSessiondUrl({ port, token, urlPath, lockPath } = {}) {
  const finalPath = resolveSessiondUrlPath({ urlPath, lockPath });
  await fs.mkdir(dirname(finalPath), { recursive: true });
  // The bearer token lives here too (same 0o600 protection as the lock), never
  // embedded in the URL itself.
  const payload = { url: `http://127.0.0.1:${port}`, token };
  await fs.writeFile(finalPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return payload;
}

export async function clearSessiondUrl({ urlPath, lockPath } = {}) {
  const finalPath = resolveSessiondUrlPath({ urlPath, lockPath });
  try {
    await fs.unlink(finalPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

/** Low-level authenticated localhost HTTP request to a running sessiond. */
export function sessiondHttpRequest(method, url, body, token, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`sessiond request timed out after ${timeoutMs}ms`)));
    }
    if (payload) req.write(payload);
    req.end();
  });
}

class SessiondNotRunningError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessiondNotRunningError';
    this.code = 'SESSIOND_NOT_RUNNING';
  }
}

/**
 * Send an authenticated request to the running sessiond, resolving the port +
 * token from the lock sidecar. Throws SessiondNotRunningError when no live
 * daemon lock exists.
 */
export async function sessiondCommand({ method = 'POST', path, body = null, lockPath } = {}) {
  const lock = await readSessiondLock({ lockPath });
  if (!lock) {
    throw new SessiondNotRunningError('BrowserForce session daemon is not running. Run `browserforce session start`.');
  }
  const url = `http://127.0.0.1:${lock.port}${path}`;
  return sessiondHttpRequest(method, url, body, lock.token);
}

/**
 * Probe the daemon's unauthenticated `/health` with a short timeout. Returns the
 * liveness body ({ ok, pid, version }) when a sessiond answers, else null
 * (connection refused, timeout, non-200, or non-JSON). Never throws.
 */
export async function probeSessiondHealth({ port, timeoutMs = 1500 } = {}) {
  try {
    const { status, body } = await sessiondHttpRequest(
      'GET', `http://127.0.0.1:${port}/health`, null, '', { timeoutMs },
    );
    if (status === 200 && body && typeof body === 'object' && body.ok === true) return body;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve whether a *BrowserForce* sessiond is actually live behind the lock —
 * not merely whether some process owns the lock's PID (which is unsafe under PID
 * reuse: the daemon can die and the OS hand its PID to an unrelated process).
 * Reads the lock, probes `/health`, and confirms the responding daemon's PID
 * matches the lock. Returns one of:
 *   { running: true,  lock, version }            — our daemon is live + verified
 *   { running: false, lock: null }               — no lock on disk
 *   { running: false, stale: true, lock, reason } — lock present but no matching
 *                                                   live daemon (safe to clear,
 *                                                   never kill the lock's PID)
 */
export async function getLiveSessiondStatus({ lockPath } = {}) {
  const lock = await readSessiondLock({ lockPath });
  if (!lock) return { running: false, lock: null };
  const health = await probeSessiondHealth({ port: lock.port });
  if (!health || health.pid !== lock.pid) {
    return { running: false, stale: true, lock, reason: health ? 'pid-mismatch' : 'health-unreachable' };
  }
  return { running: true, lock, version: health.version ?? lock.version ?? null };
}

export { isLockAlive, SessiondNotRunningError };
