// BrowserForce — MCP Server
// 2-tool architecture: execute (run Playwright code) + reset (reconnect)
// Connects to the relay via Playwright's CDP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import {
  getCdpUrl, getRelayHttpUrl, getRelayHttpUrlFromCdpUrl, assertExtensionConnected,
  ensureRelay, connectOverCdpWithBusyRetry,
  CodeExecutionTimeoutError, buildExecContext, runCode, formatResult,
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
const CONNECT_RETRY_TIMEOUT_MS = 30000;
const BACKGROUND_CONNECT_RETRY_INTERVAL_MS = 1500;
let browserConnectPromise = null;
let backgroundConnectLoopStarted = false;
let lastBackgroundConnectError = null;

function sleep(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function withClientLabel(cdpUrl) {
  try {
    const url = new URL(cdpUrl);
    if (!url.searchParams.get('label')) {
      url.searchParams.set(
        'label',
        process.env.BROWSERFORCE_CDP_CLIENT_LABEL || 'browserforce-mcp',
      );
    }
    return url.toString();
  } catch {
    return cdpUrl;
  }
}

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  if (browserConnectPromise) {
    await browserConnectPromise;
    return;
  }

  browserConnectPromise = (async () => {
    await ensureRelay();
    const cdpUrl = withClientLabel(await getCdpUrl());
    const baseUrl = getRelayHttpUrlFromCdpUrl(cdpUrl);
    await assertExtensionConnected({ baseUrl });
    const nextBrowser = await connectOverCdpWithBusyRetry({
      connect: (url) => chromium.connectOverCDP(url),
      cdpUrl,
      baseUrl,
      timeoutMs: CONNECT_RETRY_TIMEOUT_MS,
    });
    browser = nextBrowser;
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
  })();

  try {
    await browserConnectPromise;
  } finally {
    browserConnectPromise = null;
  }
}

function startBackgroundConnectionLoop() {
  if (backgroundConnectLoopStarted) return;
  backgroundConnectLoopStarted = true;

  (async () => {
    while (true) {
      if (browser?.isConnected()) {
        lastBackgroundConnectError = null;
        await sleep(BACKGROUND_CONNECT_RETRY_INTERVAL_MS);
        continue;
      }

      try {
        await ensureBrowser();
        if (lastBackgroundConnectError !== null) {
          process.stderr.write('[bf-mcp] Relay slot available; connected\n');
          lastBackgroundConnectError = null;
        } else {
          process.stderr.write('[bf-mcp] Connected to relay\n');
        }
      } catch (err) {
        const message = err?.message || String(err);
        if (message !== lastBackgroundConnectError) {
          process.stderr.write(`[bf-mcp] Waiting for relay/browser: ${message}\n`);
          process.stderr.write('[bf-mcp] MCP is running; tools will connect when slot is available\n');
          lastBackgroundConnectError = message;
        }
      }

      await sleep(BACKGROUND_CONNECT_RETRY_INTERVAL_MS);
    }
  })().catch((err) => {
    process.stderr.write(`[bf-mcp] Background connect loop error: ${err?.message || String(err)}\n`);
  });
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
const DEFAULT_AGENT_PREFERENCES = Object.freeze({
  executionMode: 'parallel',
  parallelVisibilityMode: 'foreground-tab',
});
const DEFAULT_BROWSERFORCE_RESTRICTIONS = Object.freeze({
  mode: 'auto',
  lockUrl: false,
  noNewTabs: false,
  readOnly: false,
  instructions: '',
});
let cachedAgentPreferences = null;
let cachedBrowserforceRestrictions = null;

function normalizeAgentPreferences(raw) {
  const executionMode = raw?.executionMode === 'sequential' ? 'sequential' : 'parallel';
  // Keep behavior locked to visible tabs in the current window.
  const parallelVisibilityMode = 'foreground-tab';
  return { executionMode, parallelVisibilityMode };
}

async function getAgentPreferencesForSession() {
  if (cachedAgentPreferences) {
    return cachedAgentPreferences;
  }

  try {
    const response = await fetch(`${getRelayHttpUrl()}/agent-preferences`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = await response.json();
    cachedAgentPreferences = normalizeAgentPreferences(raw);
    return cachedAgentPreferences;
  } catch {
    cachedAgentPreferences = { ...DEFAULT_AGENT_PREFERENCES };
    return cachedAgentPreferences;
  }
}

function normalizeRestrictions(raw) {
  return {
    mode: raw?.mode === 'manual' ? 'manual' : 'auto',
    lockUrl: !!raw?.lockUrl,
    noNewTabs: !!raw?.noNewTabs,
    readOnly: !!raw?.readOnly,
    instructions: typeof raw?.instructions === 'string' ? raw.instructions : '',
  };
}

async function getBrowserforceRestrictionsForSession() {
  if (cachedBrowserforceRestrictions) {
    return cachedBrowserforceRestrictions;
  }

  try {
    const response = await fetch(`${getRelayHttpUrl()}/restrictions`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const raw = await response.json();
    cachedBrowserforceRestrictions = normalizeRestrictions(raw);
    return cachedBrowserforceRestrictions;
  } catch {
    cachedBrowserforceRestrictions = { ...DEFAULT_BROWSERFORCE_RESTRICTIONS };
    return cachedBrowserforceRestrictions;
  }
}

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
  browserforceSettings Session defaults loaded once per MCP session (refresh on reset).
                      Keys: executionMode, parallelVisibilityMode.
  browserforceRestrictions Session restrictions from extension/relay.
                      Keys: mode, lockUrl, noNewTabs, readOnly, instructions.

Helpers:
  snapshot({ selector?, search?, showDiffSinceLastCall? })   Accessibility tree as text. 10-100x cheaper than screenshots.
  refToLocator({ ref })              Resolve a snapshot ref (e.g., e3) to a Playwright locator string.
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
  getCDPSession({ page })            Create a relay-safe raw CDP session for a page.
                                     Use this instead of page.context().newCDPSession(page).

Globals: fetch, URL, URLSearchParams, Buffer, setTimeout, clearTimeout, TextEncoder, TextDecoder

═══ FIRST CALL — PAGE SETUP ═══

IMPORTANT: Do NOT navigate the user's existing tabs. Always create or reuse a dedicated tab.

On your first call:
  state.page = context.pages().find(p => p.url() === 'about:blank') || await context.newPage();
  await state.page.goto('https://example.com');
  await waitForPageLoad();
  return await snapshot();

After setup, use state.page for all subsequent operations.
If state.page was closed:
  if (!state.page || state.page.isClosed()) {
    state.page = context.pages().find(p => p.url() === 'about:blank') || await context.newPage();
  }

═══ URL DISCOVERY (NO GUESSING) ═══

Do NOT guess deep links when the site already exposes navigation links.
When discovering a section/page:
  1) Snapshot first and inspect visible refs.
  2) Prefer clicking discovered links/buttons or reading hrefs from those elements.
  3) Only construct a URL manually if there is no discoverable navigation path.
  4) If a guessed URL fails (404/wrong content), back up and derive it from on-page links.

Example href discovery:
  const hrefs = await state.page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent?.trim(), href: a.getAttribute('href') }))
  );

═══ SETTINGS & STRATEGY PRECHECK ═══

Read browserforceSettings + browserforceRestrictions before planning execution.
- executionMode=sequential: do one task at a time; do not run tab swarms.
- executionMode=parallel: parallelize only independent read-only tasks.
- parallelVisibilityMode=foreground-tab: new tabs are visible in the current window; avoid disruptive tab choreography.
- mode=manual or noNewTabs=true: do not create tabs, only operate on user-attached tabs.
- lockUrl=true: do not navigate away from current URL (reload is allowed).
- readOnly=true: no click/type/submit actions; observe with snapshot/screenshot/evaluate only.
- instructions: treat as mandatory policy text for this session.

Empty tabs/targets handling:
- If tabs/targets are empty, treat it as normal startup state and create/reuse a dedicated tab with context.newPage().
- Do not ask the user to click Attach/Share by default.
- Ask for manual Attach/Share only when mode=manual or noNewTabs=true, or when the user explicitly asks to use their current tab.

═══ CORE LOOP — OBSERVE → ACT → OBSERVE ═══

After every action, verify the result before proceeding.
Each execute call should usually do one meaningful action and return verification.
Multi-step is allowed for read-only bulk extraction when actions are independent.

Recommended cycle:
  1) OBSERVE: console.log('URL:', state.page.url()); return await snapshot();
  2) ACT: one action (click, type, navigate, submit)
  3) OBSERVE: snapshot() again; verify the expected change happened

If nothing changed, wait for load and observe again before retrying.

═══ INTERACTION RULES ═══

Selector priority:
  1) Use fresh [ref=...] locators from snapshot output
  2) Use role/name locators from snapshot
  3) Use stable test IDs (data-testid)
  4) Avoid brittle nth()/deep CSS selectors unless no stable option exists

If snapshot shows [ref=e3]:
  const locator = refToLocator({ ref: 'e3' });
  if (locator) await state.page.locator(locator).click();

Before interacting, dismiss blockers:
  await snapshot({ search: /cookie|consent|accept|reject|allow|age|verify|login|sign.in/i });

Handle login popups by preferring controllable tabs over blocked popup windows.

For multiline text, prefer fill() with \\n:
  await state.page.locator('role=textbox[name="Message"]').fill('Line 1\\nLine 2');

═══ SNAPSHOT DIFF CONTROL ═══

Use snapshot({ showDiffSinceLastCall: true }) to get concise diffs when repeatedly observing the same page.
Use snapshot({ showDiffSinceLastCall: false }) when you need full output.

═══ SNAPSHOT VS SCREENSHOT ═══

Prefer snapshot() for text/content/verification.
Use screenshotWithAccessibilityLabels() only when visual layout or spatial relationships matter.

snapshot vs cleanHTML vs pageMarkdown:
  - snapshot(): interactive structure, refs, quick verification
  - cleanHTML(): structured DOM extraction/parsing
  - pageMarkdown(): article-like content extraction

Authenticated fetch:
  Use state.page.evaluate(() => fetch(...)) when authenticated browser session context matters.

Downloads:
  Prefer browser-driven download flows for large outputs instead of printing huge payloads.

═══ BROWSERFORCE TAB SWARMS // PARALLEL TABS PROCESSING ═══

Read browserforceSettings.executionMode before choosing strategy.
For independent read-only extraction tasks, use Promise.all with a concurrency cap (usually 3-8, start at 5).
Never run Promise.all actions against the same Page object.
Parallel task rule: one tab/page per task, then aggregate results.
On 429/challenges/timeouts: retry with lower concurrency, then sequential if needed.
If visibility mode requires showing work (for example, rotating/foreground demos), bringing your own working tab to front is allowed.

Return telemetry for swarm runs:
  {
    peakConcurrentTasks,
    wallClockMs,
    sumTaskDurationsMs,
    failures,
    retries
  }

═══ DEBUGGING QUICK LOOP ═══

1) snapshot({ search: /button|dialog|error|target/i })
2) getLogs({ count: 30 })
3) state.page.evaluate(...) for visibility/disabled/overlay checks

Combine snapshot + logs to debug JS-heavy failures.
For JS-heavy or authenticated sites, stay in browser automation.
Do not switch to raw HTTP/curl expecting fully rendered DOM state.

═══ HARD RULES ═══

✗ Don't navigate the user's existing tabs
✗ Don't screenshot to read text; use snapshot
✗ Don't chain actions blindly without verification
✗ Don't use page.waitForTimeout() when a deterministic wait is available
✗ Don't use stale refs after DOM/navigation updates (stale locator refs cause false actions)
✗ Don't call page.context().newCDPSession(page); use getCDPSession({ page })
✗ Don't call browser.close() or context.close()
✗ Don't call page.bringToFront() by default; only use it when user asks or when visibility mode needs visible tab progression
✗ Don't use the default page variable for ongoing work after setup; use state.page

═══ ERROR RECOVERY ═══

If page closed:      recreate state.page with context.newPage() (or reuse about:blank)
If navigation fails: check current URL, then snapshot() to re-ground state
If element missing:  use snapshot({ search: /.../ }) with tighter patterns
If connection lost:  call reset, then reinitialize state.page
If timeout:          increase timeout or break work into smaller execute calls
If Chrome/extension unavailable: ask user to open Chrome, keep at least one normal web tab open, and ensure BrowserForce extension is connected

═══ API QUICK REFERENCE ═══

snapshot(options?) -> text accessibility tree with interactive refs; options.showDiffSinceLastCall toggles diff/full output
waitForPageLoad(options?) -> { success, readyState, pendingRequests, waitTimeMs, timedOut }
getLogs(options?) -> browser console log entries
clearLogs() -> clears captured logs for current page
state -> persistent across execute calls; cleared on reset`;

function registerExecuteTool(skillAppendix = '') {
  server.tool(
    'execute',
    EXECUTE_PROMPT + skillAppendix,
    {
      code: z.string().describe('JavaScript to run — page/context/state/snapshot/refToLocator/getCDPSession/waitForPageLoad/getLogs/cleanHTML/pageMarkdown in scope'),
      timeout: z.number().optional().describe('Max execution time in ms (default: 30000)'),
    },
    async ({ code, timeout = 30000 }) => {
      await ensureBrowser();
      ensureAllPagesCapture();
      const [agentPreferences, browserforceRestrictions] = await Promise.all([
        getAgentPreferencesForSession(),
        getBrowserforceRestrictionsForSession(),
      ]);
      const ctx = getContext();
      const pages = ctx.pages();
      const page = pages[0] || null;

      if (page) setupConsoleCapture(page);
      const execCtx = buildExecContext(page, ctx, userState, {
        consoleLogs, setupConsoleCapture,
      }, pluginHelpers, agentPreferences, browserforceRestrictions);
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
        const hint = isTimeout ? '' : '\n\n[HINT: Call reset only for connection/internal failures (relay disconnect, page/context closed, Playwright internal/assertion issues). For normal selector/logic errors, fix and retry without reset.]';
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
  'Reconnects CDP and reinitializes browser/page bindings. Use when MCP stops responding, connection errors occur, pages/context were closed, or state is inconsistent. Reset clears persistent state; reinitialize state.page after calling it.',
  {},
  async () => {
    if (browser) {
      try { await browser.close(); } catch { /* connection may already be dead */ }
    }
    browser = null;
    userState = {};
    cachedAgentPreferences = null;
    cachedBrowserforceRestrictions = null;
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[bf-mcp] MCP server running\n');
  startBackgroundConnectionLoop();
}

main().catch((err) => {
  process.stderr.write(`[bf-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
