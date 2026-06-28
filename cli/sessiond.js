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
// The daemon is the single writer of its lock sidecar: it negotiates a browser
// backend (real Chrome bridge vs managed/headless), then writes the lock once
// it is listening (with its own pid) and clears it on shutdown. Atomic verbs
// (Tasks 8-10) route through the runtime execution boundary, added later.

import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pickChatdPort } from '../agent/src/port-resolver.js';
import { createBrowserSessionRuntime } from '../mcp/src/browser-session-runtime.js';
import { resolveRequestedBackend, selectBrowserBackend } from '../mcp/src/backend-selection.js';
import {
  ensureRelay,
  getExtensionStatus,
  getRelayHttpUrl,
  getCdpUrl,
  getRelayHttpUrlFromCdpUrl,
  assertExtensionConnected,
  buildExecContext,
  runCode,
} from '../mcp/src/exec-engine.js';
import {
  writeSessiondLock,
  clearSessiondLock,
  writeSessiondUrl,
  clearSessiondUrl,
  normalizeRef,
} from './session-client.js';

const HOST = '127.0.0.1';
const SESSIOND_PORT_RANGE = { rangeStart: 19340, rangeEnd: 19380 };
const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// ─── Backend connect factories (lazy: the browser is launched/connected only on
// the first command, never during startup negotiation) ──────────────────────

async function connectRealBrowser() {
  // Mirror bin.js connectBrowser: relay is already ensured by negotiation.
  const cReq = createRequire(fileURLToPath(new URL('../mcp/src/exec-engine.js', import.meta.url)));
  const pwPath = cReq.resolve('playwright-core');
  const { default: pw } = await import(pwPath);
  const { chromium } = pw;
  const cdpUrl = await getCdpUrl();
  const baseUrl = getRelayHttpUrlFromCdpUrl(cdpUrl);
  await assertExtensionConnected({ baseUrl });
  return chromium.connectOverCDP(cdpUrl);
}

async function connectManagedBrowser({ headless }) {
  // Defer loading managed-browser (and thus playwright-core) until first use.
  const { launchManagedBrowser } = await import('../mcp/src/managed-browser.js');
  const { browser } = await launchManagedBrowser({ headless });
  if (!browser) {
    throw new Error('Managed browser launch did not expose a Browser handle (persistent context only).');
  }
  return browser;
}

/**
 * Negotiate the browser backend for this daemon: resolve the requested mode,
 * probe the real Chrome bridge (relay + extension) for auto/real, pick the
 * backend via the shared policy, wire a lazy connect into the runtime, and
 * record { backend, requestedBackend, fallbackReason, warning } on the runtime.
 * Throws when `real` is requested but the bridge is unavailable (fail loud).
 */
export async function negotiateBackend({ runtime, env = process.env } = {}) {
  const requested = resolveRequestedBackend({ argv: {}, env });

  let extensionConnected = false;
  if (requested === 'auto' || requested === 'real') {
    try {
      await ensureRelay();
      const status = await getExtensionStatus();
      extensionConnected = !!status?.connected;
    } catch {
      extensionConnected = false;
    }
  }

  const selection = selectBrowserBackend({ requested, extensionConnected });

  if (selection.backend === 'real') {
    runtime.setConnectBrowser(connectRealBrowser);
  } else if (selection.backend === 'headless') {
    runtime.setConnectBrowser(() => connectManagedBrowser({ headless: true }));
  } else {
    runtime.setConnectBrowser(() => connectManagedBrowser({ headless: false }));
  }

  const warning = selection.shouldWarn
    ? `Real Chrome bridge unavailable; using managed ${selection.backend === 'headless' ? 'headless ' : ''}Chrome (${selection.reason}).`
    : null;

  runtime.setBackendInfo({
    backend: selection.backend,
    requestedBackend: requested,
    fallbackReason: selection.shouldWarn ? selection.reason : null,
    warning,
  });

  return { ...selection, requestedBackend: requested, warning };
}

function getSessiondVersion() {
  // Test/diagnostic seam: pin the reported version so the version-mismatch
  // restart path (a daemon left running by an older install) can be exercised
  // deterministically. Falls back to the package version in production.
  if (process.env.BF_SESSIOND_VERSION) return process.env.BF_SESSIOND_VERSION;
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

// Constant-time bearer comparison. Hashing both sides to a fixed-length digest
// keeps timingSafeEqual from throwing on length mismatch AND avoids leaking the
// token length via an early length check — the comparison cost is identical for
// a missing, short, long, or near-miss token.
function tokensMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function envelope({ success = true, data = null, error = null, warning = null } = {}) {
  return { success, data, error, warning };
}

// Build a ref-interaction snippet that resolves a stored ref via locatorForRef()
// inside runCode(), then runs `actionLine` (already containing JSON-encoded
// literals) and returns `returnExpr`. Refs/text are passed as JSON literals, so
// untrusted input is never concatenated as executable code.
function refLocatorSnippet(ref, actionLine, returnExpr) {
  const unknown = `Unknown ref: ${ref}. Run \`browserforce snapshot --sessiond\` again to refresh refs.`;
  return [
    `const locator = locatorForRef({ ref: ${JSON.stringify(ref)} });`,
    `if (!locator) throw new Error(${JSON.stringify(unknown)});`,
    actionLine,
    `return ${returnExpr};`,
  ].join('\n');
}

// Build a `wait` snippet using Playwright's own waiters (their internal polling
// + the passed timeout keep it abort-safe). The value is always a JSON literal.
function waitSnippet(kind, value, timeout) {
  const v = JSON.stringify(value ?? '');
  const t = Number(timeout) || 30000;
  switch (kind) {
    case 'text':
      return `await page.waitForFunction((s) => !!document.body && document.body.innerText.includes(s), ${v}, { timeout: ${t}, polling: 100 });\nreturn { waited: 'text', text: ${v} };`;
    case 'url':
      return `await page.waitForURL(${v}, { timeout: ${t} });\nreturn { waited: 'url', url: page.url() };`;
    case 'load': {
      const state = value || 'load';
      return `await page.waitForLoadState(${JSON.stringify(state)}, { timeout: ${t} });\nreturn { waited: 'load', state: ${JSON.stringify(state)} };`;
    }
    case 'fn':
      return `await page.waitForFunction(${v}, undefined, { timeout: ${t}, polling: 100 });\nreturn { waited: 'fn' };`;
    default:
      return null;
  }
}

export async function startSessiond({ lockPath, urlPath } = {}) {
  const token = process.env.BF_SESSIOND_TOKEN || randomBytes(32).toString('base64url');
  const envPort = Number(process.env.BF_SESSIOND_PORT || 0);
  const port = await pickChatdPort({ envPort, ...SESSIOND_PORT_RANGE });
  const version = getSessiondVersion();
  const idleMs = resolveIdleMs();

  // Shared runtime; the backend connect is wired by negotiateBackend() below.
  // getRelayHttpUrl lets the runtime fetch agent preferences/restrictions for
  // the real backend (no-op for managed/headless). buildExecContext + runCode
  // give the runtime its guarded execution boundary for atomic verbs.
  const runtime = createBrowserSessionRuntime({ getRelayHttpUrl, buildExecContext, runCode });

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

    // Every other route requires a valid bearer token (constant-time compare).
    if (!tokensMatch(getBearerToken(req), token)) {
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
        ...runtime.getBackendInfo(),
      });
      return;
    }

    if (method === 'POST' && path === '/reset') {
      await runtime.reset();
      sendJson(res, 200, envelope({ data: { reset: true } }));
      return;
    }

    if (method === 'POST' && path === '/stop') {
      sendJson(res, 200, envelope({ data: { stopped: true } }));
      shutdown('stop-requested');
      return;
    }

    if (method === 'POST' && path.startsWith('/command/')) {
      const verb = path.slice('/command/'.length);
      const body = await readJsonBody(req);
      await handleCommand(verb, body, res);
      return;
    }

    sendJson(res, 404, envelope({ success: false, error: `not found: ${path}` }));
  }

  // Atomic verbs. Each verb builds a snippet that calls an exec-context helper
  // and routes it through runtime.runCommand() → runCode() (the guarded
  // execution boundary). No helper is ever called outside runCode().
  async function handleCommand(verb, body, res) {
    const requested = Number(body?.timeout);
    const timeout = Number.isFinite(requested) && requested > 0 ? requested : 30000;
    // Attach the managed-fallback warning to EVERY command envelope (not just
    // snapshot) so the mandatory warning is visible regardless of which verb the
    // user runs first. It is null when no fallback occurred.
    const withWarning = (data) => envelope({ data, warning: runtime.getBackendInfo().warning });
    try {
      if (verb === 'snapshot') {
        const args = {
          selector: body?.selector,
          search: body?.search,
          interactiveOnly: body?.interactiveOnly === true,
        };
        const code = `return await snapshotData(${JSON.stringify(args)});`;
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'click') {
        const ref = normalizeRef(body?.ref);
        const code = refLocatorSnippet(ref, `await locator.click();`, `{ clicked: ${JSON.stringify(ref)} }`);
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'fill') {
        const ref = normalizeRef(body?.ref);
        const text = String(body?.text ?? '');
        const code = refLocatorSnippet(ref, `await locator.fill(${JSON.stringify(text)});`, `{ filled: ${JSON.stringify(ref)} }`);
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'type') {
        const ref = normalizeRef(body?.ref);
        const text = String(body?.text ?? '');
        const code = refLocatorSnippet(ref, `await locator.pressSequentially(${JSON.stringify(text)});`, `{ typed: ${JSON.stringify(ref)} }`);
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'press') {
        const key = String(body?.key ?? '');
        if (!key) { sendJson(res, 200, envelope({ success: false, error: 'press requires a key' })); return; }
        const code = `await page.keyboard.press(${JSON.stringify(key)});\nreturn { pressed: ${JSON.stringify(key)} };`;
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'wait') {
        const kind = String(body?.kind ?? '');
        const value = body?.value;
        const code = waitSnippet(kind, value, timeout);
        if (!code) { sendJson(res, 200, envelope({ success: false, error: `unknown wait kind: ${kind}` })); return; }
        // Give runCode headroom beyond the inner Playwright waiter so the waiter
        // times out first with a precise message before the hard run abort.
        const data = await runtime.runCommand({ code, timeout: timeout + 5000 });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'get') {
        const what = String(body?.what ?? '');
        let code;
        if (what === 'url') code = `return { url: page.url() };`;
        else if (what === 'title') code = `return { title: await page.title() };`;
        else if (what === 'text') {
          code = refLocatorSnippet(normalizeRef(body?.ref), '', `{ text: await locator.textContent() }`);
        } else {
          sendJson(res, 200, envelope({ success: false, error: `unknown get target: ${what}` }));
          return;
        }
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      if (verb === 'eval') {
        const code = String(body?.code ?? '');
        if (!code.trim()) { sendJson(res, 200, envelope({ success: false, error: 'eval requires code' })); return; }
        // The user's code IS the snippet — same guarded runCode() boundary as
        // MCP execute / CLI -e. Never eval()/new Function() at the caller.
        const data = await runtime.runCommand({ code, timeout });
        sendJson(res, 200, withWarning(data));
        return;
      }

      sendJson(res, 501, envelope({ success: false, error: `command not implemented: ${verb}` }));
    } catch (err) {
      // Request was valid + authed but the command failed: keep the envelope
      // contract (HTTP 200, success:false) so the CLI reads body.success.
      sendJson(res, 200, envelope({ success: false, error: String(err?.message || err) }));
    }
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

  // Negotiate the backend before publishing the lock so a `--real` request with
  // no bridge fails loud (non-zero exit, no lock written). auto never throws.
  await negotiateBackend({ runtime, env: process.env });

  // Test seam: inject a fake browser BELOW buildExecContext so the real CLI →
  // session-client → sessiond → runCommand → runCode → snapshotData path runs
  // against a fake page/CDP (the only way to fake a subprocess daemon's
  // browser). Never set in production.
  if (process.env.BF_SESSIOND_CONNECT_MODULE) {
    const mod = await import(process.env.BF_SESSIOND_CONNECT_MODULE);
    const connect = mod.default || mod.connect;
    if (typeof connect === 'function') runtime.setConnectBrowser(connect);
  }

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
