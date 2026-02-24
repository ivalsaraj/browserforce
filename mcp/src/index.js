// BrowserForce — MCP Server
// 2-tool architecture: execute (run Playwright code) + reset (reconnect)
// Connects to the relay via Playwright's CDP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import {
  getCdpUrl, ensureRelay, CodeExecutionTimeoutError, buildExecContext, runCode, formatResult,
} from './exec-engine.js';
import { loadPlugins, buildPluginHelpers, buildPluginSkillAppendix } from './plugin-loader.js';
import { checkForUpdate } from './update-check.js';

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

// ─── Browser Connection ──────────────────────────────────────────────────────

let browser = null;

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  await ensureRelay();
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

// ─── Plugin State ────────────────────────────────────────────────────────────

let plugins = [];
let pluginHelpers = {};

// ─── Update State ────────────────────────────────────────────────────────────
// Checked once at startup; notice injected into first execute response only.

let pendingUpdate = null;    // { current, latest } or null
let updateNoticeSent = false;

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
  screenshotWithAccessibilityLabels({ selector?, interactiveOnly? })
                                     Vimium-style labeled screenshot + accessibility snapshot.
                                     Returns image with color-coded element labels (e1, e2...) and
                                     matching text snapshot. Use when visual layout matters.
  cleanHTML(selector?, opts?)        Cleaned HTML — strips scripts, styles, decorative elements.
                                     Keeps semantic attrs: href, src, role, aria-*, data-testid.
                                     opts: { maxAttrLen?, maxContentLen? }
  pageMarkdown()                     Article content via Mozilla Readability (Firefox Reader View).
                                     Strips nav/ads/sidebars. Returns title + metadata + body text.
                                     Falls back to raw body text for non-article pages.

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

function registerExecuteTool(skillAppendix = '') {
  server.tool(
    'execute',
    EXECUTE_PROMPT + skillAppendix,
    {
      code: z.string().describe('JavaScript to run — page/context/state/snapshot/waitForPageLoad/getLogs/cleanHTML/pageMarkdown in scope'),
      timeout: z.number().optional().describe('Max execution time in ms (default: 30000)'),
    },
    async ({ code, timeout = 30000 }) => {
      await ensureBrowser();
      ensureAllPagesCapture();
      const ctx = getContext();
      const pages = ctx.pages();
      const page = pages[0] || null;

      if (page) setupConsoleCapture(page);
      const execCtx = buildExecContext(page, ctx, userState, {
        consoleLogs, setupConsoleCapture,
      }, pluginHelpers);
      try {
        const result = await runCode(code, execCtx, timeout);
        const formatted = formatResult(result);
        const content = Array.isArray(formatted) ? [...formatted] : [formatted];
        // Append update notice as a separate content item (once only per session)
        if (pendingUpdate && !updateNoticeSent && content[0]?.type === 'text') {
          updateNoticeSent = true;
          content.push({ type: 'text', text: `[BrowserForce update available: ${pendingUpdate.current} → ${pendingUpdate.latest}]\n[Run: browserforce update   or: npm install -g browserforce]` });
        }
        return { content };
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
}

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

// ─── Plugin Init ─────────────────────────────────────────────────────────────

async function initPlugins() {
  try {
    plugins = await loadPlugins();
    pluginHelpers = buildPluginHelpers(plugins);
    if (plugins.length > 0) {
      process.stderr.write(`[bf-mcp] Loaded ${plugins.length} plugin(s): ${plugins.map(p => p.name).join(', ')}\n`);
    }
  } catch (err) {
    process.stderr.write(`[bf-mcp] Plugin load error: ${err.message}\n`);
  }
}

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  await initPlugins();
  registerExecuteTool(buildPluginSkillAppendix(plugins));

  // Fire update check in background — result stored in pendingUpdate for execute handler
  checkForUpdate().then(info => { pendingUpdate = info; }).catch(() => {});

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
