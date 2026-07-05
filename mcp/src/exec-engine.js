// BrowserForce — Shared Execution Engine
// Used by both MCP server and CLI.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import {
  createSmartDiff, parseSearchPattern,
} from './snapshot.js';
import { getAriaSnapshot, renderRefLines, renderFrameErrors } from './aria-snapshot-engine.js';
import { Semaphore, injectA11yClient, showLabels, hideLabels } from './a11y-labels.js';
import { getCleanHTML } from './clean-html.js';
import { getPageMarkdown } from './page-markdown.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_PORT = 19222;
const LABEL_SCREENSHOT_MAX_DIMENSION = 1568;
const LABEL_BOX_CONCURRENCY = 16;
const MAX_LABEL_OVERLAY_REFS = 300;
const EXEC_CONSOLE_MAX_ENTRIES = 200;
const ATTACHED_PAGE_LOOKUP_TIMEOUT_MS = 5000;
const ATTACHED_PAGE_LOOKUP_POLL_MS = 50;

// Canonical "is this page handle still usable" predicate: it must exist, expose
// isClosed(), and not be closed. Wrapped in try/catch so a detached/destroyed
// handle whose isClosed() throws is treated as unusable rather than crashing the
// verb. NOTE: browser-session-runtime.js keeps an IDENTICAL local copy on purpose
// (that module is import-free by design — see its header). Keep the two in sync.
function isUsablePage(page) {
  try {
    return !!page && typeof page.isClosed === 'function' && !page.isClosed();
  } catch {
    return false;
  }
}
export const BF_DIR = join(homedir(), '.browserforce');
export const CDP_URL_FILE = join(BF_DIR, 'cdp-url');
const RELAY_SCRIPT = fileURLToPath(new URL('../../relay/src/index.js', import.meta.url));

function getExplicitCdpUrlOverride() {
  const value = process.env.BF_CDP_URL;
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parseRelayHttpUrlFromCdpUrl(cdpUrl) {
  try {
    const parsed = new URL(cdpUrl);
    if (!parsed.hostname || !parsed.port) return null;
    return `http://${parsed.hostname}:${parsed.port}`;
  } catch {
    return null;
  }
}

function readCdpUrlFromFile() {
  try {
    const url = readFileSync(CDP_URL_FILE, 'utf8').trim();
    return url || null;
  } catch { /* fall through */ }
  return null;
}

export async function getCdpUrl({ baseUrl = getRelayHttpUrl(), timeoutMs = 2000 } = {}) {
  const explicit = getExplicitCdpUrlOverride();
  if (explicit) return explicit;

  const resolvedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  try {
    const response = await fetch(`${resolvedBaseUrl}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      const data = await response.json();
      if (typeof data?.webSocketDebuggerUrl === 'string' && data.webSocketDebuggerUrl.trim()) {
        return data.webSocketDebuggerUrl.trim();
      }
    }
  } catch { /* fall through */ }

  const legacyFileUrl = readCdpUrlFromFile();
  if (legacyFileUrl) return legacyFileUrl;

  throw new Error(
    'Cannot find CDP URL. Either:\n' +
    '  1. Start the relay first: browserforce serve\n' +
    `  2. Ensure relay is reachable at ${resolvedBaseUrl}\n` +
    '  3. Set BF_CDP_URL environment variable'
  );
}

/** Derive the relay HTTP base URL from the CDP WebSocket URL. */
export function getRelayHttpUrl() {
  const explicit = getExplicitCdpUrlOverride();
  if (explicit) {
    return parseRelayHttpUrlFromCdpUrl(explicit) || `http://127.0.0.1:${getRelayPort()}`;
  }
  return `http://127.0.0.1:${getRelayPort()}`;
}

export function getRelayHttpUrlFromCdpUrl(cdpUrl) {
  return parseRelayHttpUrlFromCdpUrl(cdpUrl) || getRelayHttpUrl();
}

export async function assertExtensionConnected({ baseUrl = getRelayHttpUrl(), timeoutMs = 2000 } = {}) {
  // Use the relay-owned /extension/status endpoint (not the root / health check)
  // so this never doubles as proof that an attached page exists — it only proves
  // the extension is connected. Attached-page readiness is asserted separately
  // via assertAttachedPageAvailable() in the MCP startup preflight.
  const resolvedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  let status;
  try {
    status = await getExtensionStatus({ baseUrl: resolvedBaseUrl, timeoutMs });
  } catch (err) {
    throw new Error(
      `Cannot reach BrowserForce relay at ${resolvedBaseUrl}. ` +
      'Start it with `browserforce serve`.'
    );
  }

  if (!status?.connected) {
    throw new Error(
      `BrowserForce extension is not connected to relay at ${resolvedBaseUrl}.`
    );
  }

  return status;
}

// ─── Attached-Page Status Helpers ────────────────────────────────────────────

/** Inspect/open intent predicate. Anything that is not an explicit "open" is
 * treated as attached-page-safe (inspect/current/auto all reuse existing tabs). */
export function isAttachedPageIntent(intent) {
  return intent !== 'open';
}

/** Structured MCP error carrying a stable machine-readable code + details. */
export class BrowserForceMcpError extends Error {
  constructor(message, { code, details = {} }) {
    super(message);
    this.name = 'BrowserForceMcpError';
    this.code = code;
    this.details = details;
  }
}

/** Read relay-owned attached-tab introspection without opening a CDP connection. */
export async function getExtensionStatus({ baseUrl = getRelayHttpUrl(), timeoutMs = 2000 } = {}) {
  const resolvedBaseUrl = String(baseUrl).replace(/\/+$/, '');
  const response = await fetch(`${resolvedBaseUrl}/extension/status`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Cannot read BrowserForce extension status (HTTP ${response.status}).`);
  }
  return await response.json();
}

/**
 * Assert that a manually attached page is available when policy requires one.
 * Auto-mode inspect flows may connect so relay discovery can expose existing
 * open tabs; attached-only modes still fail before CDP when no manual tab is
 * attached.
 */
export function assertAttachedPageAvailable({ extensionStatus, restrictions, intent = 'inspect' }) {
  const isAttachedOnly =
    restrictions?.mode === 'manual' ||
    restrictions?.noNewTabs === true ||
    process.env.BF_REQUIRE_ATTACHED_PAGE === '1';
  if (!isAttachedOnly) return;
  if (extensionStatus?.activeManualTargets > 0 || extensionStatus?.manualAttachedTabs?.length > 0) return;
  throw new BrowserForceMcpError(
    'No attached BrowserForce page available. Attach a tab with the BrowserForce extension, then retry.',
    {
      code: 'BF_NO_ATTACHED_PAGE',
      details: {
        connected: !!extensionStatus?.connected,
        activeTargets: Number(extensionStatus?.activeTargets || 0),
        activeManualTargets: Number(extensionStatus?.activeManualTargets || 0),
        attachedTabs: extensionStatus?.attachedTabs || [],
        manualAttachedTabs: extensionStatus?.manualAttachedTabs || [],
        restrictions: restrictions || {},
        intent,
      },
    },
  );
}

/** Throw BF_NEW_TABS_DISABLED when an explicit "open" intent is not permitted. */
export function assertOpenIntentAllowed(restrictions) {
  if (restrictions?.mode === 'manual' || restrictions?.noNewTabs) {
    throw new BrowserForceMcpError(
      'New tabs are disabled in this BrowserForce session.',
      {
        code: 'BF_NEW_TABS_DISABLED',
        details: { restrictions: restrictions || {}, intent: 'open' },
      },
    );
  }
}

/**
 * Predicate gating implicit startup page creation. BrowserForce no longer
 * auto-creates a tab by default; legacy auto-mode bootstrap is opt-in via
 * BF_ALLOW_IMPLICIT_STARTUP_PAGE=1. Manual/no-new-tabs modes never create.
 */
export function shouldCreateImplicitStartupPage(restrictions) {
  if (restrictions?.mode === 'manual') return false;
  if (restrictions?.noNewTabs) return false;
  return process.env.BF_ALLOW_IMPLICIT_STARTUP_PAGE === '1';
}

export function isCdpBusyError(err) {
  const message = String(err?.message || '').toLowerCase();
  return (
    message.includes('409') ||
    message.includes('slot busy') ||
    message.includes('slot is busy') ||
    message.includes('busy') ||
    message.includes('already connected') ||
    message.includes('already in use') ||
    message.includes('another cdp client')
  );
}

export async function waitForFreeClientSlot({ timeoutMs = 30000, baseUrl } = {}) {
  const start = Date.now();
  const resolvedBaseUrl = String(baseUrl || getRelayHttpUrl()).replace(/\/+$/, '');
  const slotUrl = `${resolvedBaseUrl}/client-slot`;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(slotUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        if (data && data.busy === false) return true;
      }
    } catch { /* keep polling until timeout */ }

    const elapsed = Date.now() - start;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) break;
    const jitteredDelayMs = 200 + Math.floor(Math.random() * 200);
    await new Promise((r) => globalThis.setTimeout(r, Math.min(jitteredDelayMs, remaining)));
  }

  return false;
}

export async function connectOverCdpWithBusyRetry({
  connect,
  cdpUrl,
  baseUrl = getRelayHttpUrl(),
  timeoutMs = 30000,
  waitForFreeSlot = waitForFreeClientSlot,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastBusyError = null;

  while (Date.now() < deadline) {
    try {
      return await connect(cdpUrl);
    } catch (err) {
      if (!isCdpBusyError(err)) throw err;
      lastBusyError = err;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const slotFreed = await waitForFreeSlot({ timeoutMs: remainingMs, baseUrl });
      if (!slotFreed) break;
    }
  }

  throw lastBusyError || new Error('Failed to connect to CDP relay');
}

// ─── Auto-start relay ───────────────────────────────────────────────────────

function getRelayPort() {
  if (process.env.RELAY_PORT) {
    const parsed = parseInt(process.env.RELAY_PORT, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

async function isRelayRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * Ensure the relay server is running. If not, spawn it as a detached
 * background process and wait for it to become reachable.
 */
export async function ensureRelay() {
  if (getExplicitCdpUrlOverride()) return;

  const port = getRelayPort();
  if (await isRelayRunning(port)) return;

  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RELAY_PORT: String(port) },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (await isRelayRunning(port)) {
      process.stderr.write('[browserforce] Relay auto-started\n');
      return;
    }
  }
  throw new Error('Failed to auto-start relay server within 5s');
}

// ─── Smart Page Load Detection ───────────────────────────────────────────────
// Filters analytics/ad requests that never finish, polls document.readyState +
// pending resource count.

const FILTERED_DOMAINS = [
  'doubleclick', 'googlesyndication', 'googleadservices', 'google-analytics',
  'googletagmanager', 'facebook.net', 'fbcdn.net', 'twitter.com', 'linkedin.com',
  'hotjar', 'mixpanel', 'segment.io', 'segment.com', 'newrelic', 'datadoghq',
  'sentry.io', 'fullstory', 'amplitude', 'intercom', 'crisp.chat', 'zdassets.com',
  'zendesk', 'tawk.to', 'hubspot', 'marketo', 'pardot', 'optimizely', 'crazyegg',
  'mouseflow', 'clarity.ms', 'bing.com/bat', 'ads.', 'analytics.', 'tracking.',
  'pixel.',
];

const FILTERED_EXTENSIONS = ['.gif', '.ico', '.cur', '.woff', '.woff2', '.ttf', '.otf', '.eot'];

const STUCK_THRESHOLD_MS = 10000;
const SLOW_RESOURCE_THRESHOLD_MS = 3000;

export async function smartWaitForPageLoad(page, timeout, pollInterval = 100, minWait = 500, { signal } = {}) {
  const startTime = Date.now();
  let lastReadyState = '';
  let lastPendingRequests = [];

  const checkArgs = {
    filteredDomains: FILTERED_DOMAINS,
    filteredExtensions: FILTERED_EXTENSIONS,
    stuckThreshold: STUCK_THRESHOLD_MS,
    slowResourceThreshold: SLOW_RESOURCE_THRESHOLD_MS,
  };

  const checkPageReady = () => page.evaluate((args) => {
    const readyState = document.readyState;
    if (readyState !== 'complete') {
      return { ready: false, readyState, pendingRequests: [`document.readyState: ${readyState}`] };
    }

    const resources = performance.getEntriesByType('resource');
    const now = performance.now();

    const pendingRequests = resources
      .filter((r) => {
        if (r.responseEnd > 0) return false;
        const elapsed = now - r.startTime;
        const url = r.name.toLowerCase();
        if (url.startsWith('data:')) return false;
        if (args.filteredDomains.some((d) => url.includes(d))) return false;
        if (elapsed > args.stuckThreshold) return false;
        if (elapsed > args.slowResourceThreshold &&
            args.filteredExtensions.some((ext) => url.includes(ext))) return false;
        return true;
      })
      .map((r) => r.name);

    return { ready: pendingRequests.length === 0, readyState, pendingRequests };
  }, checkArgs);

  try {
    const first = await checkPageReady();
    if (first.ready) {
      return {
        success: true, readyState: first.readyState,
        pendingRequests: 0, waitTimeMs: Date.now() - startTime, timedOut: false,
      };
    }
    lastReadyState = first.readyState;
    lastPendingRequests = first.pendingRequests;
  } catch {
    // page may not be ready for evaluate yet
  }

  await abortableDelay(minWait, signal);

  while (Date.now() - startTime < timeout) {
    try {
      const { ready, readyState, pendingRequests } = await checkPageReady();
      lastReadyState = readyState;
      lastPendingRequests = pendingRequests;
      if (ready) {
        return {
          success: true, readyState,
          pendingRequests: 0, waitTimeMs: Date.now() - startTime, timedOut: false,
        };
      }
    } catch {
      return {
        success: false, readyState: 'error',
        pendingRequests: ['page.evaluate failed — page may have closed or navigated'],
        waitTimeMs: Date.now() - startTime, timedOut: false,
      };
    }
    await abortableDelay(pollInterval, signal);
  }

  return {
    success: false, readyState: lastReadyState,
    pendingRequests: lastPendingRequests.slice(0, 10),
    waitTimeMs: Date.now() - startTime, timedOut: true,
  };
}

// ─── Execution Engine ────────────────────────────────────────────────────────

export class CodeExecutionTimeoutError extends Error {
  constructor(ms) {
    super(`Code execution timed out after ${ms}ms`);
    this.name = 'CodeExecutionTimeoutError';
  }
}

// buildExecContext takes userState and optional console helpers as params
// instead of referencing module-level singletons.
export function buildExecContext(
  defaultPage,
  ctx,
  userState,
  consoleHelpers = {},
  pluginHelpers = {},
  agentPreferences = {},
  runtimeRestrictions = {},
  pluginSkillRuntime = {},
) {
  // `pinnedPage` (per-run target, e.g. a command's --tab page) rides on the
  // caps argument. It outranks the persistent userState.page for THIS run only
  // and is never written back to state — concurrent runs against other tabs
  // keep their own targets.
  const { consoleLogs, setupConsoleCapture, pinnedPage = null } = consoleHelpers;
  const lastSnapshots = userState.__lastSnapshots || (userState.__lastSnapshots = new WeakMap());
  // ref → { locator, frameChain } (engine-built; frameChain pierces OOPIF/same-origin frames)
  const lastRefToLocator = userState.__lastRefToLocator || (userState.__lastRefToLocator = new WeakMap());

  const buildRefLocator = (rootPage, entry) => {
    if (!entry || !entry.locator) return null;
    let scope = rootPage;
    for (const frameSelector of entry.frameChain || []) scope = scope.frameLocator(frameSelector);
    return scope.locator(entry.locator);
  };

  const storeRefs = (page, refs) => {
    const map = new Map();
    for (const r of refs) {
      const entry = { locator: r.locator ?? null, frameChain: r.frameChain || [] };
      map.set(r.ref, entry);
      if (r.shortRef) map.set(r.shortRef, entry);
    }
    lastRefToLocator.set(page, map);
  };

  const searchToRefFilter = (search) => {
    const pattern = parseSearchPattern(search);
    if (!pattern) return undefined;
    return ({ role, name }) => pattern.test(`${role} ${name || ''}`);
  };

  const execConsoleLogs = Array.isArray(userState.__execConsoleLogs)
    ? userState.__execConsoleLogs
    : (userState.__execConsoleLogs = []);

  const serializeExecConsoleArg = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    if (typeof value === 'symbol') return value.toString();
    try {
      return JSON.stringify(value);
    } catch {
      try {
        return String(value);
      } catch {
        return '[unserializable]';
      }
    }
  };

  const pushExecConsole = (level, args) => {
    const text = args.map((arg) => serializeExecConsoleArg(arg)).join(' ');
    execConsoleLogs.push({
      level,
      text,
      timestamp: new Date().toISOString(),
    });
    if (execConsoleLogs.length > EXEC_CONSOLE_MAX_ENTRIES) {
      execConsoleLogs.splice(0, execConsoleLogs.length - EXEC_CONSOLE_MAX_ENTRIES);
    }
  };

  const execConsole = Object.freeze({
    log: (...args) => pushExecConsole('log', args),
    info: (...args) => pushExecConsole('info', args),
    warn: (...args) => pushExecConsole('warn', args),
    error: (...args) => pushExecConsole('error', args),
    debug: (...args) => pushExecConsole('debug', args),
    trace: (...args) => pushExecConsole('trace', args),
    assert: (condition, ...args) => {
      if (condition) return;
      const payload = args.length > 0 ? args : ['Assertion failed'];
      pushExecConsole('error', payload);
    },
  });

  const getExecConsoleLogs = ({ count } = {}) => {
    const logs = Array.isArray(execConsoleLogs) ? execConsoleLogs : [];
    if (!Number.isInteger(count) || count <= 0) {
      return logs.map((entry) => ({ ...entry }));
    }
    return logs.slice(-count).map((entry) => ({ ...entry }));
  };

  const clearExecConsoleLogs = () => {
    if (!Array.isArray(execConsoleLogs)) return;
    execConsoleLogs.length = 0;
  };

  const activePage = () => {
    if (isUsablePage(pinnedPage)) return pinnedPage;
    if (isUsablePage(userState.page)) return userState.page;
    if (isUsablePage(defaultPage)) return defaultPage;
    throw new Error("No active page. Reuse an existing one first: state.page = context.pages()[0]. If there isn't one, create one with: state.page = await context.newPage()");
  };

  const snapshot = async ({ frame, locator, selector, interactiveOnly = false, search, showDiffSinceLastCall = true } = {}) => {
    const page = activePage();
    // When a frame is given, resolve the CSS selector inside that frame so the scope/locator
    // is in the right document (the engine evaluates it on the frame's session).
    const scopeRoot = frame || page;
    const scopeLocator = locator || (selector ? scopeRoot.locator(selector).first() : null);
    const cdp = await getCDPSession({ page });
    let result;
    try {
      result = await getAriaSnapshot({
        page, frame, locator: scopeLocator, interactiveOnly,
        refFilter: searchToRefFilter(search), cdp,
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
    storeRefs(page, result.refs);

    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    const refTable = result.refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + result.refs.map((r) => `${r.shortRef} (${r.role}${r.name ? ` "${r.name}"` : ''}): ${r.locator ?? '(frame-scoped; use locatorForRef)'}`).join('\n')
      : '';
    const frameWarning = renderFrameErrors(result.frameErrors);
    const fullSnapshot = `Page: ${title} (${pageUrl})\nRefs: ${result.refs.length} interactive elements${frameWarning}\n\n${renderRefLines(result.tree)}${refTable}`;

    let pageSnapshots = lastSnapshots.get(page);
    if (!(pageSnapshots instanceof Map)) {
      const migrated = new Map();
      if (typeof pageSnapshots === 'string') migrated.set('__full_page__', pageSnapshots);
      pageSnapshots = migrated;
      lastSnapshots.set(page, pageSnapshots);
    }
    // Key each scope into its own bucket so a scoped snapshot never overwrites the full-page
    // baseline that the next full-page diff compares against (only full-page calls diff).
    const snapshotKey = selector || (frame ? '__frame__' : locator ? '__locator__' : '__full_page__');
    const previousSnapshot = pageSnapshots.get(snapshotKey);
    pageSnapshots.set(snapshotKey, fullSnapshot);

    if (!selector && !locator && !frame && !search && showDiffSinceLastCall && previousSnapshot) {
      const diffResult = createSmartDiff(previousSnapshot, fullSnapshot);
      if (diffResult.type === 'no-change') {
        return 'No changes since last snapshot. Use showDiffSinceLastCall: false to see full content.';
      }
      return diffResult.content;
    }
    return fullSnapshot;
  };

  const buildSnapshotData = async ({ frame, locator, selector, search, interactiveOnly = true } = {}) => {
    const page = activePage();
    const scopeRoot = frame || page;
    const scopeLocator = locator || (selector ? scopeRoot.locator(selector).first() : null);
    const cdp = await getCDPSession({ page });
    let result;
    try {
      result = await getAriaSnapshot({
        page, frame, locator: scopeLocator, interactiveOnly,
        refFilter: searchToRefFilter(search), cdp,
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
    storeRefs(page, result.refs);
    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    const refTable = result.refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + result.refs.map((r) => `${r.shortRef} (${r.role}): ${r.locator ?? '(frame-scoped)'}`).join('\n')
      : '';
    const frameWarning = renderFrameErrors(result.frameErrors);
    return {
      text: `Page: ${title} (${pageUrl})\nRefs: ${result.refs.length} labeled elements${frameWarning}\n\n${renderRefLines(result.tree)}${refTable}`,
      refs: result.refs,
      page,
    };
  };

  // Structured snapshot for JSON consumers (the CLI atomic `snapshot` verb).
  // Same engine path as snapshot()/buildSnapshotData(), but returns a plain
  // JSON-serializable object (no text/diff) and still calls storeRefs() so
  // `click @eN` can resolve refs from a prior snapshot in the same session.
  const snapshotData = async ({ frame, locator, selector, search, interactiveOnly = false } = {}) => {
    const page = activePage();
    const scopeRoot = frame || page;
    const scopeLocator = locator || (selector ? scopeRoot.locator(selector).first() : null);
    const cdp = await getCDPSession({ page });
    let result;
    try {
      result = await getAriaSnapshot({
        page, frame, locator: scopeLocator, interactiveOnly,
        refFilter: searchToRefFilter(search), cdp,
      });
    } finally {
      await cdp.detach().catch(() => {});
    }
    storeRefs(page, result.refs);
    const title = await page.title().catch(() => '');
    return {
      url: page.url(),
      title,
      tree: renderRefLines(result.tree),
      refs: result.refs.map((r) => ({
        ref: r.shortRef ?? r.ref,
        role: r.role,
        name: r.name ?? null,
        locator: r.locator ?? null,
        frameChain: r.frameChain || [],
      })),
      frameErrors: result.frameErrors,
    };
  };

  const refToLocator = ({ ref, page: targetPage } = {}) => {
    const p = targetPage || activePage();
    const entry = lastRefToLocator.get(p)?.get(ref);
    return entry?.locator ?? null;
  };

  const locatorForRef = ({ ref, page: targetPage } = {}) => {
    const p = targetPage || activePage();
    const entry = lastRefToLocator.get(p)?.get(ref);
    return buildRefLocator(p, entry);
  };

  const waitForPageLoad = (opts = {}) =>
    smartWaitForPageLoad(activePage(), opts.timeout ?? 30000, undefined, undefined, { signal: opts.signal });

  const getLogs = ({ count } = {}) => {
    if (!consoleLogs || !setupConsoleCapture) return [];
    const page = activePage();
    setupConsoleCapture(page);
    const logs = consoleLogs.get(page) || [];
    return count ? logs.slice(-count) : [...logs];
  };

  const clearLogs = () => {
    if (consoleLogs) consoleLogs.set(activePage(), []);
  };

  const getCDPSession = async ({ page: targetPage, frame } = {}) => {
    const p = targetPage || activePage();
    if (!p || p.isClosed()) {
      throw new Error('Cannot create CDP session for closed page');
    }
    // newCDPSession(frame) is OOPIF-only and throws for same-origin frames (Reconciliation 7).
    // The engine handles that fallback itself; this param is for callers that explicitly want
    // a frame session.
    return p.context().newCDPSession(frame || p);
  };

  const getBrowserforceStatus = (opts = {}) => getExtensionStatus(opts);

  const getBrowserforcePageForTab = async ({
    tab,
    tabId,
    targetId,
    url,
    manualOnly = true,
    timeoutMs = ATTACHED_PAGE_LOOKUP_TIMEOUT_MS,
    signal,
  } = {}) => {
    const status = await getBrowserforceStatus();
    const tabs = manualOnly ? status?.manualAttachedTabs : status?.attachedTabs;
    const availableTabs = Array.isArray(tabs) ? tabs : [];
    const requestedTab = tab || availableTabs.find((candidate) => (
      (tabId !== undefined && candidate.tabId === tabId) ||
      (targetId !== undefined && candidate.targetId === targetId) ||
      (url !== undefined && candidate.url === url)
    )) || availableTabs[0];

    if (!requestedTab?.url) {
      throw new Error(
        manualOnly
          ? 'No manually attached BrowserForce tab is available.'
          : 'No BrowserForce tab metadata is available.'
      );
    }

    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    do {
      const matches = ctx.pages().filter((candidate) => candidate.url() === requestedTab.url);
      const page = requestedTab.origin === 'manual' ? matches.at(-1) : matches[0];
      if (page) return page;
      await abortableDelay(ATTACHED_PAGE_LOOKUP_POLL_MS, signal);
    } while (Date.now() < deadline);

    throw new Error(
      `BrowserForce tab metadata is visible, but no Playwright page matched attached tab URL: ${requestedTab.url}`
    );
  };

  const screenshotWithAccessibilityLabels = async ({ selector, interactiveOnly = true } = {}) => {
    const { text: snapText, refs, page } = await buildSnapshotData({
      selector,
      search: null,
      interactiveOnly,
    });

    const sema = new Semaphore(LABEL_BOX_CONCURRENCY);
    const labelCandidates = refs
      .map((ref) => ({ ref: ref.shortRef ?? ref.ref, role: ref.role, locator: ref.locator, frameChain: ref.frameChain || [] }))
      .filter((c) => c.locator)
      .slice(0, MAX_LABEL_OVERLAY_REFS);
    const labels = (await Promise.all(labelCandidates.map(async (candidate) => {
      await sema.acquire();
      try {
        const loc = buildRefLocator(page, { locator: candidate.locator, frameChain: candidate.frameChain });
        const box = await loc.first().boundingBox();
        if (!box || box.width <= 0 || box.height <= 0) return null;
        return { ref: candidate.ref, role: candidate.role, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
      } catch {
        return null;
      } finally {
        sema.release();
      }
    }))).filter(Boolean);

    let labelsInjected = false;
    let labelCount = 0;
    if (labels.length > 0) {
      await injectA11yClient(page);
      labelCount = await showLabels(page, labels);
      labelsInjected = true;
    }

    const viewport = await page.evaluate((maxDim) => ({
      width: Math.min(window.innerWidth, maxDim),
      height: Math.min(window.innerHeight, maxDim),
    }), LABEL_SCREENSHOT_MAX_DIMENSION);
    try {
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 80,
        scale: 'css',
        clip: { x: 0, y: 0, ...viewport },
      });
      return { _bf_type: 'labeled_screenshot', screenshot, snapshot: snapText, labelCount };
    } finally {
      if (labelsInjected) {
        try { await hideLabels(page); } catch { /* page may have navigated */ }
      }
    }
  };

  const cleanHTML = (selector, opts) => getCleanHTML(activePage(), selector, opts);

  const pageMarkdown = (opts) => getPageMarkdown(activePage(), opts);

  const browserforceSettings = {
    executionMode: agentPreferences?.executionMode === 'sequential' ? 'sequential' : 'parallel',
    parallelVisibilityMode: 'foreground-tab',
  };
  const browserforceRestrictions = {
    mode: runtimeRestrictions?.mode === 'manual' ? 'manual' : 'auto',
    lockUrl: !!runtimeRestrictions?.lockUrl,
    noNewTabs: !!runtimeRestrictions?.noNewTabs,
    readOnly: !!runtimeRestrictions?.readOnly,
    instructions: typeof runtimeRestrictions?.instructions === 'string' ? runtimeRestrictions.instructions : '',
  };

  const pluginCatalog = () => {
    const catalog = Array.isArray(pluginSkillRuntime?.catalog) ? pluginSkillRuntime.catalog : [];
    return catalog.map((entry) => ({
      ...entry,
      helpers: Array.isArray(entry?.helpers) ? [...entry.helpers] : [],
      ...(Array.isArray(entry?.helperAliases) ? { helperAliases: [...entry.helperAliases] } : {}),
      sections: Array.isArray(entry?.sections) ? [...entry.sections] : [],
    }));
  };

  const pluginHelp = (name, section) => {
    const requestedName = String(name || '').trim().toLowerCase();
    if (!requestedName) {
      throw new Error('pluginHelp(name, section?) requires a plugin name');
    }

    const lookup = pluginSkillRuntime?.byName && typeof pluginSkillRuntime.byName === 'object'
      ? pluginSkillRuntime.byName
      : {};
    const plugin = lookup[requestedName];
    if (!plugin) {
      const available = pluginCatalog().map((entry) => entry.name).join(', ') || '(none)';
      throw new Error(`Unknown plugin "${name}". Available plugins: ${available}`);
    }

    if (section === undefined || section === null || String(section).trim() === '') {
      if (plugin.text && plugin.text.trim()) return plugin.text;
      if (plugin.description && plugin.description.trim()) {
        return `${plugin.name}: ${plugin.description.trim()}`;
      }
      return `${plugin.name} has no SKILL.md help text.`;
    }

    const normalizedSection = String(section)
      .toLowerCase()
      .trim()
      .replace(/^[\d.)\s-]+/, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    const sections = plugin.sections && typeof plugin.sections === 'object' ? plugin.sections : {};
    if (sections[normalizedSection]) return sections[normalizedSection];
    const availableSections = Object.keys(sections).join(', ') || '(none)';
    throw new Error(
      `Unknown section "${section}" for plugin "${plugin.name}". Available sections: ${availableSections}`
    );
  };

  const reservedContextNames = new Set([
    'browserforceSettings',
    'browserforceRestrictions',
    'page',
    'context',
    'state',
    'snapshot',
    'snapshotData',
    'refToLocator',
    'locatorForRef',
    'waitForPageLoad',
    'getLogs',
    'clearLogs',
    'getCDPSession',
    'getBrowserforceStatus',
    'getBrowserforcePageForTab',
    'screenshotWithAccessibilityLabels',
    'cleanHTML',
    'pageMarkdown',
    'pluginCatalog',
    'pluginHelp',
    'console',
    'getExecConsoleLogs',
    'clearExecConsoleLogs',
    'fetch',
    'URL',
    'URLSearchParams',
    'Buffer',
    'setTimeout',
    'clearTimeout',
    'TextEncoder',
    'TextDecoder',
    'executeSignal',
    'throwIfExecutionAborted',
  ]);

  // Wrap plugin helpers to auto-inject (page, ctx, state) as first three args
  const wrappedPluginHelpers = {};
  for (const [name, fn] of Object.entries(pluginHelpers)) {
    if (reservedContextNames.has(name)) {
      process.stderr.write(`[bf-plugins] Ignoring helper "${name}" because it conflicts with a built-in\n`);
      continue;
    }
    wrappedPluginHelpers[name] = (...args) => {
      let pg = null;
      try { pg = activePage(); } catch { /* no active page */ }
      return fn(pg, ctx, userState, ...args);
    };
  }

  return {
    ...wrappedPluginHelpers,           // plugin helpers spread first — built-ins always win
    browserforceSettings,
    browserforceRestrictions,
    // The run's top-level `page` binding is the pinned page when present, so
    // canned snippets (`page.url()`, `page.keyboard.press`) target it too.
    page: isUsablePage(pinnedPage) ? pinnedPage : defaultPage,
    context: ctx, state: userState,
    snapshot, snapshotData, refToLocator, locatorForRef, waitForPageLoad, getLogs, clearLogs, getCDPSession,
    getBrowserforceStatus, getBrowserforcePageForTab,
    screenshotWithAccessibilityLabels, cleanHTML, pageMarkdown,
    pluginCatalog, pluginHelp,
    console: execConsole,
    getExecConsoleLogs,
    clearExecConsoleLogs,
    fetch, URL, URLSearchParams, Buffer, setTimeout, clearTimeout,
    TextEncoder, TextDecoder,
  };
}

function wrapExecuteCode(code) {
  return `(async function() {\n${code}\n})()`;
}

// vm.runInContext's synchronous timeout throws ERR_SCRIPT_EXECUTION_TIMEOUT;
// map it back to BrowserForce's CodeExecutionTimeoutError so the MCP boundary
// keeps the terse, no-reset-hint timeout response.
function normalizeRunError(err, timeoutMs) {
  if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /Script execution timed out/.test(String(err?.message || ''))) {
    return new CodeExecutionTimeoutError(timeoutMs);
  }
  return err;
}

// Per-run cancellation state. abort() aborts the signal with a
// CodeExecutionTimeoutError reason and cancels every still-pending run timer, so
// continuations suspended on a run timer never resume after the timeout fires.
function createRunController(timeoutMs) {
  const controller = new AbortController();
  const pendingTimers = new Set();
  let hasTimedOut = false;

  const abort = () => {
    hasTimedOut = true;
    controller.abort(new CodeExecutionTimeoutError(timeoutMs));
    for (const timerId of pendingTimers) globalThis.clearTimeout(timerId);
    pendingTimers.clear();
  };

  const throwIfAborted = () => {
    if (controller.signal.aborted) {
      throw controller.signal.reason || new CodeExecutionTimeoutError(timeoutMs);
    }
  };

  return { signal: controller.signal, pendingTimers, abort, throwIfAborted, get hasTimedOut() { return hasTimedOut; } };
}

// Run-scoped setTimeout/clearTimeout exposed to user snippets. A scheduled
// callback never fires after the run aborts, and pending timers are tracked so
// abort() can clear them.
function createRunTimers(run) {
  const setTimeoutForRun = (callback, delay = 0, ...args) => {
    run.throwIfAborted();
    const timerId = globalThis.setTimeout(() => {
      run.pendingTimers.delete(timerId);
      if (run.signal.aborted) return;
      callback(...args);
    }, delay);
    run.pendingTimers.add(timerId);
    return timerId;
  };

  const clearTimeoutForRun = (timerId) => {
    run.pendingTimers.delete(timerId);
    return globalThis.clearTimeout(timerId);
  };

  return { setTimeout: setTimeoutForRun, clearTimeout: clearTimeoutForRun };
}

// Reject value for an aborted run-scoped delay. signal.reason is the
// CodeExecutionTimeoutError set by createRunController(); the fallback Error is
// purely defensive for an abort with no reason.
function abortReason(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Execution aborted before its scheduled delay completed');
}

// setTimeout-style delay that rejects (and removes its listener) the moment the
// run aborts, so BrowserForce polling loops stop promptly on timeout. User
// snippets still receive the run-scoped setTimeout, not this.
function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timerId = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      globalThis.clearTimeout(timerId);
      cleanup();
      reject(abortReason(signal));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Guard an exposed function so a call cannot start, and its awaited result cannot
// be used, once the run has aborted. Results are re-guarded so handles reached
// through a helper stay fenced too.
function guardAsyncFunction(fn, run, seen) {
  return function guardedFunction(...args) {
    run.throwIfAborted();
    const value = fn.apply(this, args);
    if (!value || typeof value.then !== 'function') {
      run.throwIfAborted();
      return guardObject(value, run, seen);
    }
    return value.then((resolved) => {
      run.throwIfAborted();
      return guardObject(resolved, run, seen);
    });
  };
}

// Maps every guard proxy back to its raw target so a proxy is never re-wrapped or
// persisted. Module-scoped WeakMap so a proxy created in one run can still be
// unwrapped in a later run; entries are GC'd once the proxy is unreachable.
const GUARD_TARGET = new WeakMap();
function unwrapGuard(value) {
  while (value && GUARD_TARGET.has(value)) value = GUARD_TARGET.get(value);
  return value;
}

// A value is "behavioral" — worth fencing — when it can act on Chrome or carry
// methods: a class instance (Playwright Page/Locator/Response have a custom
// prototype) or a plain object/array exposing a callable own property (the mock
// handles used in tests, helper-returned handle objects). Plain data — POJOs and
// arrays of values like pluginCatalog()/getBrowserforceStatus() results — is left
// raw so deepStrictEqual and JSON.stringify see the original value, not a proxy.
function hasGuardableBehavior(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) return true;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && typeof descriptor.value === 'function') return true;
  }
  return false;
}

// Only guard values that can drive Chrome or mutate persistent state: state,
// BrowserForce helpers, Playwright-like handles, and functions. Binary/result
// value types and plain data stay raw so formatResult()'s Buffer/labeled-screenshot
// contract and plain JSON/deepStrictEqual results survive untouched.
function shouldGuardObject(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (typeof value === 'function') return true;
  if (Buffer.isBuffer(value)) return false;
  if (value._bf_type === 'labeled_screenshot') return false;
  if (value instanceof URL || value instanceof URLSearchParams) return false;
  if (value instanceof TextEncoder || value instanceof TextDecoder) return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  return hasGuardableBehavior(value);
}

// Targeted guard (not a broad membrane). Reads/writes/deletes check the run, and
// object-valued reads + method results are re-guarded. Uses the raw object as the
// receiver so Playwright private-field getters keep working. `force` always wraps
// (used for the persistent `state` object, which is plain-shaped yet must be
// fenced); nested reads re-enter without force and defer to shouldGuardObject.
// Writes store the unwrapped value so a timed-out run never persists a run-bound
// proxy onto state and poison the next run that reads it.
function guardObject(target, run, seen = new WeakMap(), { force = false } = {}) {
  target = unwrapGuard(target);
  if (force) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return target;
  } else if (!shouldGuardObject(target)) {
    return target;
  }
  if (seen.has(target)) return seen.get(target);

  const proxy = new Proxy(target, {
    get(obj, prop) {
      run.throwIfAborted();
      const value = Reflect.get(obj, prop, obj);
      if (typeof value === 'function') return guardAsyncFunction(value.bind(obj), run, seen);
      return guardObject(value, run, seen);
    },
    set(obj, prop, value) {
      run.throwIfAborted();
      return Reflect.set(obj, prop, unwrapGuard(value), obj);
    },
    deleteProperty(obj, prop) {
      run.throwIfAborted();
      return Reflect.deleteProperty(obj, prop);
    },
  });

  seen.set(target, proxy);
  GUARD_TARGET.set(proxy, target);
  return proxy;
}

// Exposed built-in constructors/utilities that must stay raw: wrapping a
// constructor breaks `new URL(...)` and drops static methods like Buffer.from.
const RAW_CONTEXT_BUILTINS = new Set([
  'URL', 'URLSearchParams', 'Buffer', 'TextEncoder', 'TextDecoder', 'setTimeout', 'clearTimeout',
]);

export async function runCode(code, execCtx, timeoutMs) {
  const run = createRunController(timeoutMs);
  const runTimers = createRunTimers(run);
  const seen = new WeakMap();

  // Guard exposed BrowserForce helpers + persistent state; keep top-level page and
  // context raw (identity-sensitive Playwright handles), and keep exposed built-in
  // constructors/utilities raw. Stored handles read through state are guarded
  // lazily by the state proxy.
  const guardedExecCtx = {};
  for (const [key, value] of Object.entries(execCtx)) {
    if (key === 'state' || key === 'page' || key === 'context') continue;
    guardedExecCtx[key] = (typeof value === 'function' && !RAW_CONTEXT_BUILTINS.has(key))
      ? guardAsyncFunction(value, run, seen)
      : value;
  }
  guardedExecCtx.state = guardObject(execCtx.state, run, seen, { force: true });
  guardedExecCtx.page = execCtx.page;
  guardedExecCtx.context = execCtx.context;

  // Polling helpers observe this run's cancellation signal by default so their
  // internal wait loops stop promptly on timeout (still overridable per call).
  if (typeof execCtx.waitForPageLoad === 'function') {
    guardedExecCtx.waitForPageLoad = guardAsyncFunction(
      (opts = {}) => execCtx.waitForPageLoad({ signal: run.signal, ...opts }),
      run, seen,
    );
  }
  if (typeof execCtx.getBrowserforcePageForTab === 'function') {
    guardedExecCtx.getBrowserforcePageForTab = guardAsyncFunction(
      (opts = {}) => execCtx.getBrowserforcePageForTab({ signal: run.signal, ...opts }),
      run, seen,
    );
  }

  // Run-scoped timers + cancellation handle override any same-named entries.
  guardedExecCtx.setTimeout = runTimers.setTimeout;
  guardedExecCtx.clearTimeout = runTimers.clearTimeout;
  guardedExecCtx.executeSignal = run.signal;
  guardedExecCtx.throwIfExecutionAborted = run.throwIfAborted;

  const vmContext = vm.createContext(guardedExecCtx);

  let userPromise;
  try {
    userPromise = vm.runInContext(wrapExecuteCode(code), vmContext, {
      timeout: timeoutMs,
      displayErrors: true,
    });
  } catch (err) {
    run.abort();
    throw normalizeRunError(err, timeoutMs);
  }

  let result;
  let isComplete = false;
  let timeoutId;
  try {
    await Promise.race([
      userPromise.then((value) => {
        run.throwIfAborted();
        result = value;
        isComplete = true;
      }),
      new Promise((_, reject) => {
        timeoutId = globalThis.setTimeout(() => {
          run.abort();
          reject(new CodeExecutionTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) globalThis.clearTimeout(timeoutId);
    if (!isComplete) run.abort();
  }
  return result;
}

export function formatResult(result) {
  if (result === undefined || result === null) {
    return { type: 'text', text: String(result) };
  }
  if (result && typeof result === 'object' && result._bf_type === 'labeled_screenshot') {
    return [
      { type: 'image', data: result.screenshot.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: `Labels: ${result.labelCount} interactive elements\n\n${result.snapshot}` },
    ];
  }
  if (Buffer.isBuffer(result)) {
    return { type: 'image', data: result.toString('base64'), mimeType: 'image/png' };
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { type: 'text', text: text ?? 'undefined' };
}
