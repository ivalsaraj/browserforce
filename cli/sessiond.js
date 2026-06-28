// cli/sessiond.js — BrowserForce CLI session daemon.
//
// A small localhost HTTP daemon that holds a persistent browser session (shared
// runtime) so the CLI's atomic verbs (snapshot/click/fill/wait/get/eval) share
// state across invocations. Security contract (mirrors the relay):
//   - binds 127.0.0.1 ONLY (never 0.0.0.0)
//   - generates a random 32-byte base64url token, written into the 0o600 lock
//   - requires `Authorization: Bearer <token>` on every state route
//     (/status, /reset, /stop, /command/*); /health stays unauthenticated and
//     leaks no token/secret
//
// The daemon is the single writer of its lock sidecar: it writes the lock once
// it is listening (with its own pid) and clears it on shutdown. Backend
// negotiation (Task 7) and atomic verbs (Tasks 8-10) are layered on later.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pickChatdPort } from '../agent/src/port-resolver.js';
import { createBrowserSessionRuntime } from '../mcp/src/browser-session-runtime.js';
import {
  writeSessiondLock,
  clearSessiondLock,
  writeSessiondUrl,
  clearSessiondUrl,
} from './session-client.js';

const HOST = '127.0.0.1';
const SESSIOND_PORT_RANGE = { rangeStart: 19340, rangeEnd: 19380 };
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

function getSessiondVersion() {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function resolveIdleMs() {
  const raw = Number(process.env.BF_SESSIOND_IDLE_MS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_MS;
  return Math.floor(raw);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function envelope({ success = true, data = null, error = null, warning = null } = {}) {
  return { success, data, error, warning };
}

export async function startSessiond({ lockPath, urlPath } = {}) {
  const token = process.env.BF_SESSIOND_TOKEN || randomBytes(32).toString('base64url');
  const envPort = Number(process.env.BF_SESSIOND_PORT || 0);
  const port = await pickChatdPort({ envPort, ...SESSIOND_PORT_RANGE });
  const version = getSessiondVersion();
  const idleMs = resolveIdleMs();

  // The runtime is constructed now; the backend connect is wired in Task 7.
  const runtime = createBrowserSessionRuntime({});

  let idleTimer = null;
  let shuttingDown = false;

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleMs > 0) {
      idleTimer = setTimeout(() => { shutdown('idle-timeout'); }, idleMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    }
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      sendJson(res, 500, envelope({ success: false, error: String(err?.message || err) }));
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://${HOST}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // Liveness — unauthenticated, leaks no token/secret.
    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, version });
      return;
    }

    // Every other route requires a valid bearer token.
    if (getBearerToken(req) !== token) {
      sendJson(res, 401, envelope({ success: false, error: 'unauthorized' }));
      return;
    }

    resetIdleTimer();

    if (method === 'GET' && path === '/status') {
      sendJson(res, 200, {
        running: true,
        pid: process.pid,
        port,
        version,
        backend: null,
        requestedBackend: null,
        fallbackReason: null,
        warning: null,
      });
      return;
    }

    if (method === 'POST' && path === '/reset') {
      await runtime.reset();
      sendJson(res, 200, envelope({ data: { reset: true } }));
      return;
    }

    if (method === 'POST' && path === '/stop') {
      sendJson(res, 200, { stopped: true });
      shutdown('stop-requested');
      return;
    }

    if (path.startsWith('/command/')) {
      // Atomic verbs are added in Tasks 8-10; the route exists + is auth-gated now.
      sendJson(res, 501, envelope({ success: false, error: `command not implemented: ${path.slice('/command/'.length)}` }));
      return;
    }

    sendJson(res, 404, envelope({ success: false, error: `not found: ${path}` }));
  }

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    try { await runtime.reset(); } catch { /* best effort */ }
    try { await clearSessiondLock({ lockPath }); } catch { /* best effort */ }
    try { await clearSessiondUrl({ urlPath, lockPath }); } catch { /* best effort */ }
    server.close(() => {
      process.exit(0);
    });
    // Safety net: force-exit if the server does not close promptly.
    const forced = setTimeout(() => process.exit(0), 1000);
    if (typeof forced.unref === 'function') forced.unref();
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });

  await writeSessiondLock({ pid: process.pid, port, token, version, lockPath });
  await writeSessiondUrl({ port, token, urlPath, lockPath });
  resetIdleTimer();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, port, token, version, runtime, shutdown };
}

// Run as a standalone daemon when invoked directly (spawned by `session start`,
// or directly in tests). Errors during startup are surfaced on stderr so the
// parent can capture fast-fail output.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // When spawned detached with a piped stderr, the parent closes the read end
  // after startup; swallow the resulting EPIPE so the daemon keeps running.
  process.stderr.on('error', () => {});
  startSessiond().catch((err) => {
    try { process.stderr.write(`[bf-sessiond] Fatal: ${err?.message || err}\n`); } catch { /* stderr gone */ }
    process.exit(1);
  });
}
