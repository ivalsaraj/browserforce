// BrowserForce — MCP Server
// 2-tool architecture: execute (run Playwright code) + reset (reconnect)
// Connects to the relay via Playwright's CDP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  TEST_ID_ATTRS,
  buildSnapshotText, parseSearchPattern, annotateStableAttrs,
} from './snapshot.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const BF_DIR = join(homedir(), '.browserforce');
const CDP_URL_FILE = join(BF_DIR, 'cdp-url');

function getCdpUrl() {
  if (process.env.BF_CDP_URL) return process.env.BF_CDP_URL;
  try {
    const url = readFileSync(CDP_URL_FILE, 'utf8').trim();
    if (url) return url;
  } catch { /* fall through */ }
  throw new Error(
    'Cannot find CDP URL. Either:\n' +
    '  1. Start the relay first: pnpm relay\n' +
    '  2. Set BF_CDP_URL environment variable'
  );
}

// ─── Console Log Capture ─────────────────────────────────────────────────────

const MAX_LOGS_PER_PAGE = 5000;
const consoleLogs = new Map();
const pagesWithListeners = new WeakSet();
let contextListenerAttached = false;

function setupConsoleCapture(page) {
  if (pagesWithListeners.has(page)) return;
  pagesWithListeners.add(page);

  consoleLogs.set(page, []);

  page.on('console', (msg) => {
    try {
      const entry = `[${msg.type()}] ${msg.text()}`;
      let logs = consoleLogs.get(page);
      if (!logs) {
        logs = [];
        consoleLogs.set(page, logs);
      }
      logs.push(entry);
      if (logs.length > MAX_LOGS_PER_PAGE) {
        logs.shift();
      }
    } catch { /* msg.text() can throw if page navigated */ }
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      consoleLogs.set(page, []);
    }
  });

  page.on('close', () => {
    consoleLogs.delete(page);
  });
}

function ensureAllPagesCapture() {
  try {
    const pages = getPages();
    for (const page of pages) {
      setupConsoleCapture(page);
    }
  } catch { /* not connected yet */ }
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

async function smartWaitForPageLoad(page, timeout, pollInterval = 100, minWait = 500) {
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

  await new Promise((r) => globalThis.setTimeout(r, minWait));

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
    await new Promise((r) => globalThis.setTimeout(r, pollInterval));
  }

  return {
    success: false, readyState: lastReadyState,
    pendingRequests: lastPendingRequests.slice(0, 10),
    waitTimeMs: Date.now() - startTime, timedOut: true,
  };
}

// ─── Browser Connection ──────────────────────────────────────────────────────

let browser = null;

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  const cdpUrl = getCdpUrl();
  browser = await chromium.connectOverCDP(cdpUrl);
  browser.on('disconnected', () => {
    browser = null;
    contextListenerAttached = false;
    consoleLogs.clear();
  });

  try {
    const ctx = browser.contexts()[0];
    if (ctx && !contextListenerAttached) {
      ctx.on('page', (page) => setupConsoleCapture(page));
      contextListenerAttached = true;
      for (const page of ctx.pages()) {
        setupConsoleCapture(page);
      }
    }
  } catch { /* context not ready yet — capture will attach lazily */ }
}

function getContext() {
  if (!browser?.isConnected()) throw new Error('Not connected to relay. Is the relay running?');
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error('No browser context available');
  return contexts[0];
}

function getPages() {
  return getContext().pages();
}

// ─── Persistent State ────────────────────────────────────────────────────────

let userState = {};

// ─── Snapshot Helper ─────────────────────────────────────────────────────────

async function getStableIds(page, rootSelector) {
  return page.evaluate(({ testIdAttrs, root }) => {
    const scope = root ? document.querySelector(root) : document;
    if (!scope) return {};
    const result = {};
    const selectors = testIdAttrs.map(a => `[${a}]`).join(',');
    const elements = scope.querySelectorAll(selectors + ',[id]');
    for (const el of elements) {
      const name = el.getAttribute('aria-label') ||
                   el.textContent?.trim().slice(0, 100) || '';
      if (!name) continue;
      for (const attr of testIdAttrs) {
        const value = el.getAttribute(attr);
        if (value) {
          if (!result[name]) {
            result[name] = { attr, value };
          }
          break;
        }
      }
      if (!result[name]) {
        const id = el.getAttribute('id');
        if (id && !/^[:\d]/.test(id) && !id.includes('__')) {
          result[name] = { attr: 'id', value: id };
        }
      }
    }
    return result;
  }, { testIdAttrs: TEST_ID_ATTRS, root: rootSelector || null });
}

// ─── Execution Engine ────────────────────────────────────────────────────────

class CodeExecutionTimeoutError extends Error {
  constructor(ms) {
    super(`Code execution timed out after ${ms}ms`);
    this.name = 'CodeExecutionTimeoutError';
  }
}

function buildExecContext(page, ctx) {
  const snapshot = async ({ selector, search } = {}) => {
    let axRoot;
    if (selector) {
      const handle = await page.locator(selector).elementHandle({ timeout: 10000 });
      if (!handle) return `No element found for selector: ${selector}`;
      axRoot = await page.accessibility.snapshot({ interestingOnly: false, root: handle });
    } else {
      axRoot = await page.accessibility.snapshot({ interestingOnly: false });
    }

    if (!axRoot) return 'No accessibility tree available for this page.';

    const stableIds = await getStableIds(page, selector);
    annotateStableAttrs(axRoot, stableIds);

    const searchPattern = parseSearchPattern(search);
    const { text: snapshotText, refs } = buildSnapshotText(axRoot, null, searchPattern);

    const refTable = refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + refs.map(r => `${r.ref}: ${r.locator}`).join('\n')
      : '';

    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    return `Page: ${title} (${pageUrl})\nRefs: ${refs.length} interactive elements\n\n${snapshotText}${refTable}`;
  };

  const waitForPageLoad = (opts = {}) =>
    smartWaitForPageLoad(page, opts.timeout ?? 30000);

  const getLogs = ({ count } = {}) => {
    const logs = consoleLogs.get(page) || [];
    return count ? logs.slice(-count) : [...logs];
  };

  const clearLogs = () => {
    consoleLogs.set(page, []);
  };

  return {
    page,
    context: ctx,
    state: userState,
    snapshot,
    waitForPageLoad,
    getLogs,
    clearLogs,
    fetch,
    URL,
    URLSearchParams,
    Buffer,
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
  };
}

async function runCode(code, execCtx, timeoutMs) {
  const keys = Object.keys(execCtx);
  const vals = Object.values(execCtx);
  const fn = new Function(...keys, `return (async function() {\n${code}\n})()`);

  let result;
  const nativeSetTimeout = globalThis.setTimeout;
  await Promise.race([
    (async () => { result = await fn(...vals); })(),
    new Promise((_, reject) =>
      nativeSetTimeout(() => reject(new CodeExecutionTimeoutError(timeoutMs)), timeoutMs)),
  ]);

  if (result === undefined || result === null) {
    return { content: [{ type: 'text', text: String(result) }] };
  }
  if (Buffer.isBuffer(result)) {
    return { content: [{ type: 'image', data: result.toString('base64'), mimeType: 'image/png' }] };
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: 'text', text: text ?? 'undefined' }] };
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'browserforce',
  version: '1.0.0',
});

server.tool(
  'execute',
  `Run Playwright JavaScript in your real Chrome browser.

Scope: page, context, state, snapshot(), waitForPageLoad(), getLogs(), clearLogs()
Globals: fetch, URL, Buffer, setTimeout, TextEncoder, TextDecoder

Use 'return' to send a value back. Screenshots: return await page.screenshot().
Multiple tabs: context.pages()[n]. state persists between calls. reset() clears it.

Examples:
  return await page.title()
  return await page.screenshot()
  await page.goto('https://example.com'); return await snapshot()
  const [tab1, tab2] = context.pages(); return await tab2.title()
  state.count = (state.count || 0) + 1; return state.count`,
  {
    code: z.string().describe('JavaScript to run — page/context/state/snapshot/waitForPageLoad/getLogs in scope'),
    timeout: z.number().optional().describe('Max execution time in ms (default: 30000)'),
  },
  async ({ code, timeout = 30000 }) => {
    await ensureBrowser();
    ensureAllPagesCapture();
    const ctx = getContext();
    const pages = getPages();
    if (pages.length === 0) throw new Error('No pages available. Open a tab first.');
    const page = pages[0];
    setupConsoleCapture(page);
    const execCtx = buildExecContext(page, ctx);
    try {
      return await runCode(code, execCtx, timeout);
    } catch (err) {
      const isTimeout = err instanceof CodeExecutionTimeoutError;
      const hint = isTimeout ? '' : '\n\n[If connection lost, call reset tool to reconnect]';
      return {
        content: [{ type: 'text', text: `Error: ${err.message}${hint}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'reset',
  'Reconnects to the relay, reinitializes the browser context, and clears persistent state. Use when: connection lost, pages closed unexpectedly, or state is corrupt.',
  {},
  async () => {
    browser = null;
    userState = {};
    contextListenerAttached = false;
    consoleLogs.clear();
    try {
      await ensureBrowser();
      ensureAllPagesCapture();
      const pages = getPages();
      return {
        content: [{ type: 'text', text: `Reset complete. ${pages.length} page(s) available. Current URL: ${pages[0]?.url() ?? 'none'}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Reset failed: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  try {
    await ensureBrowser();
    process.stderr.write('[bf-mcp] Connected to relay\n');
  } catch (err) {
    process.stderr.write(`[bf-mcp] Warning: ${err.message}\n`);
    process.stderr.write('[bf-mcp] Tools will attempt to connect on first use\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[bf-mcp] MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`[bf-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
