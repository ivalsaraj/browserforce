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

// ─── Accessibility Tree via DOM ──────────────────────────────────────────────
// Replaces page.accessibility.snapshot() which was removed in Playwright 1.58.
// Walks the DOM and builds an AX tree using ARIA roles, HTML semantics, and
// computed accessible names. Supports Shadow DOM (open roots).

async function getAccessibilityTree(page, rootSelector) {
  return page.evaluate((sel) => {
    function getRole(el) {
      if (el.nodeType !== 1) return null;
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      switch (el.tagName) {
        case 'A': return el.hasAttribute('href') ? 'link' : null;
        case 'BUTTON': case 'SUMMARY': return 'button';
        case 'INPUT': {
          const t = (el.type || 'text').toLowerCase();
          if (t === 'hidden') return null;
          return { text: 'textbox', search: 'searchbox', email: 'textbox', url: 'textbox',
            tel: 'textbox', password: 'textbox', number: 'spinbutton',
            checkbox: 'checkbox', radio: 'radio', range: 'slider',
            button: 'button', submit: 'button', reset: 'button', image: 'button',
          }[t] || 'textbox';
        }
        case 'SELECT': return 'combobox';
        case 'TEXTAREA': return 'textbox';
        case 'IMG': return 'img';
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
        case 'NAV': return 'navigation';
        case 'MAIN': return 'main';
        case 'HEADER': return el.closest('article, aside, main, nav, section') ? null : 'banner';
        case 'FOOTER': return el.closest('article, aside, main, nav, section') ? null : 'contentinfo';
        case 'ASIDE': return 'complementary';
        case 'FORM': return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('name')) ? 'form' : null;
        case 'TABLE': return 'table';
        case 'THEAD': case 'TBODY': case 'TFOOT': return 'rowgroup';
        case 'TR': return 'row';
        case 'TH': return 'columnheader';
        case 'TD': return 'cell';
        case 'UL': case 'OL': return 'list';
        case 'LI': return 'listitem';
        case 'DIALOG': return 'dialog';
        case 'DETAILS': case 'FIELDSET': return 'group';
        case 'PROGRESS': return 'progressbar';
        case 'METER': return 'meter';
        case 'OPTION': return 'option';
        case 'SECTION': return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : null;
        case 'ARTICLE': return 'article';
        case 'SEARCH': return 'search';
        default: return null;
      }
    }

    function getName(el) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean).join(' ');
        if (t) return t;
      }
      if (el.tagName === 'IMG') return (el.alt || '').trim();
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
        if (el.id) {
          const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lab) return lab.textContent?.trim() || '';
        }
        const parentLabel = el.closest('label');
        if (parentLabel) {
          const clone = parentLabel.cloneNode(true);
          clone.querySelectorAll('input,select,textarea').forEach(i => i.remove());
          const t = clone.textContent?.trim();
          if (t) return t;
        }
        if (el.placeholder) return el.placeholder.trim();
      }
      if (el.title && !['A', 'BUTTON'].includes(el.tagName)) return el.title.trim();
      const textTags = ['BUTTON', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'OPTION', 'LEGEND', 'CAPTION'];
      if (textTags.includes(el.tagName)) {
        return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      }
      return '';
    }

    function isHidden(el) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.hidden) return true;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(el.tagName)) return true;
      try {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return true;
      } catch { /* ignore */ }
      return false;
    }

    function getChildren(el) {
      const kids = [];
      // Regular DOM children
      for (const child of el.children) {
        kids.push(child);
      }
      // Open Shadow DOM
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          kids.push(child);
        }
      }
      return kids;
    }

    function buildTree(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      if (isHidden(el)) return null;
      if (depth > 30) return null; // prevent runaway recursion

      const role = getRole(el);
      const children = [];
      for (const child of getChildren(el)) {
        const r = buildTree(child, depth + 1);
        if (r) {
          if (Array.isArray(r)) children.push(...r);
          else children.push(r);
        }
      }

      if (role) {
        const node = { role, name: getName(el) };
        if (/^H[1-6]$/.test(el.tagName)) node.level = parseInt(el.tagName[1]);
        if (['checkbox', 'radio', 'switch'].includes(role)) {
          node.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
        }
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
        const exp = el.getAttribute('aria-expanded');
        if (exp !== null) node.expanded = exp === 'true';
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) {
          node.value = el.value.slice(0, 500);
        }
        if (el.tagName === 'SELECT' && el.selectedOptions?.length) {
          node.value = el.selectedOptions[0]?.text || '';
        }
        if (children.length > 0) node.children = children;
        return node;
      }

      // No role: pass through children
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return children; // flatten
    }

    const scope = sel ? document.querySelector(sel) : document.body;
    if (!scope) return null;

    const result = buildTree(scope, 0);
    if (!result) return { role: 'WebArea', name: document.title, children: [] };
    const kids = Array.isArray(result) ? result : (result.children || [result]);
    return { role: 'WebArea', name: document.title, children: kids };
  }, rootSelector || null);
}

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

function buildExecContext(defaultPage, ctx) {
  // Resolve the active page: state.page if set and alive, else the default
  const activePage = () => {
    if (userState.page && !userState.page.isClosed()) return userState.page;
    if (defaultPage && !defaultPage.isClosed()) return defaultPage;
    throw new Error('No active page. Create one first: state.page = await context.newPage()');
  };

  const snapshot = async ({ selector, search } = {}) => {
    const page = activePage();
    const axRoot = await getAccessibilityTree(page, selector);
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
    smartWaitForPageLoad(activePage(), opts.timeout ?? 30000);

  const getLogs = ({ count } = {}) => {
    const page = activePage();
    setupConsoleCapture(page);
    const logs = consoleLogs.get(page) || [];
    return count ? logs.slice(-count) : [...logs];
  };

  const clearLogs = () => {
    consoleLogs.set(activePage(), []);
  };

  return {
    page: defaultPage,
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

// ─── Execute Tool Prompt ───────────────────────────────────────────────────

const EXECUTE_PROMPT = `Run Playwright JavaScript in the user's real Chrome browser.
This is their actual browser with real cookies, sessions, and tabs — not a sandbox.

═══ AVAILABLE SCOPE ═══

Variables:
  page        Default page (first tab in context — shared, avoid navigating it)
  context     Browser context — access all pages via context.pages()
  state       Persistent object across calls (cleared on reset). Store your working page here.

Helpers:
  snapshot({ selector?, search? })   Accessibility tree as text. 10-100x cheaper than screenshots.
  waitForPageLoad({ timeout? })      Smart load detection (filters analytics/ads, polls readyState).
  getLogs({ count? })                Browser console logs captured for current page.
  clearLogs()                        Clear captured console logs.

Globals: fetch, URL, URLSearchParams, Buffer, setTimeout, clearTimeout, TextEncoder, TextDecoder

═══ FIRST CALL — PAGE SETUP ═══

IMPORTANT: Do NOT navigate the user's existing tabs. Always create or reuse a dedicated tab.

On your first call, initialize state.page:
  // Reuse an about:blank tab if one exists, otherwise create a new one
  state.page = context.pages().find(p => p.url() === 'about:blank') || await context.newPage();
  await state.page.goto('https://example.com');
  await waitForPageLoad();
  return await snapshot();

After setup, use state.page for ALL subsequent operations — not the default page variable.
If state.page was closed or navigated away, recreate it:
  if (!state.page || state.page.isClosed()) {
    state.page = await context.newPage();
  }

═══ WORKFLOW — OBSERVE → ACT → OBSERVE ═══

After every action, verify its result before proceeding:

1. OBSERVE: snapshot() to understand current page state
2. ACT: Perform ONE action (click, type, navigate, etc.)
3. OBSERVE: snapshot() again to verify the action worked

Never chain multiple actions blindly. If you click a button, verify it worked before clicking the next.
Each execute call should do ONE meaningful action and return verification.

When navigating:
  await state.page.goto(url);
  await waitForPageLoad();
  return await snapshot();

When clicking:
  await state.page.locator('role=button[name="Submit"]').click();
  await waitForPageLoad();
  return await snapshot();

When filling forms:
  await state.page.locator('role=textbox[name="Email"]').fill('user@example.com');
  return await snapshot();

═══ SNAPSHOT FIRST ═══

ALWAYS prefer snapshot() over screenshot():
- snapshot() returns a text accessibility tree — fast, cheap, searchable
- screenshot() returns a PNG image — expensive, requires vision processing

Use snapshot() for:
  ✓ Reading page content and text
  ✓ Finding interactive elements (buttons, links, inputs)
  ✓ Verifying actions succeeded
  ✓ Checking if a page loaded correctly

Use screenshot() ONLY for:
  ✓ Visual layout verification (grids, alignment, spacing)
  ✓ Seeing images, charts, or visual content
  ✓ Debugging when snapshot doesn't show the issue

Targeted snapshots: snapshot({ search: /pattern/i }) filters the tree.
Scoped snapshots: snapshot({ selector: '#main' }) limits to a subtree.

═══ PAGE MANAGEMENT ═══

Listing tabs:       const pages = context.pages();
Creating a tab:     const p = await context.newPage();
Navigating:         await state.page.goto(url);
Current URL:        state.page.url()
Page title:         await state.page.title()

context.pages() returns ALL open tabs. Index 0 is usually the user's original tab.
Store your working page in state.page to avoid losing track of it.

For multi-tab workflows:
  const pages = context.pages();
  // Find a specific tab by URL
  const gmail = pages.find(p => p.url().includes('mail.google'));

═══ INTERACTING WITH ELEMENTS ═══

Use Playwright locators with accessibility roles (from snapshot output):
  await state.page.locator('role=button[name="Sign in"]').click();
  await state.page.locator('role=textbox[name="Search"]').fill('query');
  await state.page.locator('role=link[name="Settings"]').click();

If snapshot shows [ref=some-id] for an element with a data-testid or id:
  await state.page.locator('[data-testid="some-id"]').click();

For text content:
  const text = await state.page.locator('role=heading').textContent();

═══ COMMON PATTERNS ═══

Navigate and read:
  await state.page.goto('https://example.com');
  await waitForPageLoad();
  return await snapshot();

Click and verify:
  await state.page.locator('role=button[name="Next"]').click();
  await waitForPageLoad();
  return await snapshot();

Fill form and submit:
  await state.page.locator('role=textbox[name="Username"]').fill('user');
  await state.page.locator('role=textbox[name="Password"]').fill('pass');
  await state.page.locator('role=button[name="Login"]').click();
  await waitForPageLoad();
  return await snapshot();

Extract data:
  return await state.page.evaluate(() => {
    return document.querySelector('.price').textContent;
  });

Wait for specific element:
  await state.page.locator('role=heading[name="Dashboard"]').waitFor();
  return await snapshot();

Debug with console logs:
  return getLogs({ count: 20 });

═══ ANTI-PATTERNS ═══

✗ Don't navigate the user's existing tabs — create your own via context.newPage()
✗ Don't screenshot() to read text — use snapshot()
✗ Don't chain actions without verifying — observe after each action
✗ Don't use page.waitForTimeout() — use waitForPageLoad() or waitFor()
✗ Don't forget to return a value — every call should return verification
✗ Don't write complex multi-step scripts — split into separate execute calls
✗ Don't use page variable directly — use state.page after first call setup

═══ ERROR RECOVERY ═══

If page closed:      state.page = await context.newPage();
If navigation fails: Check state.page.url() to see where you actually are
If element missing:   Use snapshot({ search: /element/ }) to find it
If connection lost:   Call the reset tool, then re-initialize state.page
If timeout:          Increase timeout param, or break into smaller steps

═══ API REFERENCE ═══

snapshot(options?)
  options.selector  CSS selector to scope the snapshot (e.g., '#main', '.sidebar')
  options.search    Regex string to filter tree nodes (e.g., 'button|link')
  Returns: Text accessibility tree with interactive element refs

waitForPageLoad(options?)
  options.timeout   Max wait in ms (default: 30000)
  Returns: { success, readyState, pendingRequests, waitTimeMs, timedOut }
  Filters analytics/ad requests that never finish. Polls document.readyState.

getLogs(options?)
  options.count     Number of recent entries (default: all)
  Returns: Array of "[type] message" strings from browser console

clearLogs()
  Clears captured console logs for current page.

state
  Persistent object — survives across execute calls. Cleared on reset.
  Use state.page, state.data, state.anything to preserve working state.`;

server.tool(
  'execute',
  EXECUTE_PROMPT,
  {
    code: z.string().describe('JavaScript to run — page/context/state/snapshot/waitForPageLoad/getLogs in scope'),
    timeout: z.number().optional().describe('Max execution time in ms (default: 30000)'),
  },
  async ({ code, timeout = 30000 }) => {
    await ensureBrowser();
    ensureAllPagesCapture();
    const ctx = getContext();
    const pages = ctx.pages();
    const page = pages[0] || null;

    if (page) setupConsoleCapture(page);
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
    if (browser) {
      try { await browser.close(); } catch { /* connection may already be dead */ }
    }
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
