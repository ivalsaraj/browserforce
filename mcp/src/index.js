// BrowserForce — MCP Server
// 3-tool architecture: execute (run Playwright code) + help (docs) + reset (reconnect)
// Connects to the relay via Playwright's CDP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import {
  getCdpUrl, getRelayHttpUrl, getRelayHttpUrlFromCdpUrl,
  ensureRelay, connectOverCdpWithBusyRetry,
  CodeExecutionTimeoutError, buildExecContext, runCode, formatResult,
  BrowserForceMcpError, shouldCreateImplicitStartupPage,
} from './exec-engine.js';
import { createBrowserSessionRuntime } from './browser-session-runtime.js';
import {
  preflightAttachedPageBeforeCdp,
  formatBrowserForceMcpError,
} from './startup.js';
import {
  loadPlugins,
  buildPluginHelpers,
  buildPluginSkillAppendix,
  buildPluginSkillRuntime,
} from './plugin-loader.js';
import { checkForUpdate } from './update-check.js';
import {
  getHelpSection,
  listHelpSections,
  HELP_SECTION_NAMES,
} from './help-docs.js';

// ─── Browser Session Runtime ─────────────────────────────────────────────────
// Browser connection, persistent userState, idle-disconnect lifecycle, console
// capture, and cached agent preferences/restrictions are owned by the shared
// runtime (./browser-session-runtime.js), which the CLI session daemon also
// reuses. MCP injects the relay+CDP connect path; the runtime owns the
// lifecycle (connect coalescing, idle disconnect, console capture) around it.

const CONNECT_RETRY_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_BROWSER_DISCONNECT_MS = 15000;

function resolveNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

const IDLE_BROWSER_DISCONNECT_MS = resolveNonNegativeInt(
  process.env.BF_MCP_IDLE_DISCONNECT_MS,
  DEFAULT_IDLE_BROWSER_DISCONNECT_MS,
);

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

// Injected connect path. Note: extension readiness is asserted by
// preflightAttachedPageBeforeCdp() (via /extension/status) before this point is
// reached. This connect must NOT prove readiness via the root / health check —
// that is not proof an attached page exists.
async function connectBrowserOverRelay() {
  await ensureRelay();
  const cdpUrl = withClientLabel(await getCdpUrl());
  const baseUrl = getRelayHttpUrlFromCdpUrl(cdpUrl);
  return connectOverCdpWithBusyRetry({
    connect: (url) => chromium.connectOverCDP(url),
    cdpUrl,
    baseUrl,
    timeoutMs: CONNECT_RETRY_TIMEOUT_MS,
  });
}

const runtime = createBrowserSessionRuntime({
  connectBrowser: connectBrowserOverRelay,
  getRelayHttpUrl,
  idleDisconnectMs: IDLE_BROWSER_DISCONNECT_MS,
  onConnected: () => process.stderr.write('[bf-mcp] Connected to relay\n'),
});

const {
  ensureBrowser,
  getContext,
  getPages,
  setupConsoleCapture,
  ensureAllPagesCapture,
  beginOperation: beginBrowserOperation,
  endOperation: endBrowserOperation,
  getAgentPreferencesForSession,
  getBrowserforceRestrictionsForSession,
} = runtime;

// ─── Plugin State ────────────────────────────────────────────────────────────

let plugins = [];
let pluginHelpers = {};
let pluginSkillRuntime = { catalog: [], byName: {} };

// ─── Update State ────────────────────────────────────────────────────────────
// Checked once at startup; notice injected into first execute response only.

let pendingUpdate = null;    // { current, latest } or null
let updateNoticeSent = false;

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'browserforce',
  version: '1.0.0',
});
const readHelpSections = new Set();

function formatHelpSectionList() {
  const sections = listHelpSections()
    .map((section) => `- ${section.name}: ${section.summary}`)
    .join('\n');

  return `BrowserForce help sections:
${sections}

Call help({ section: 'tabs' }) for a section. Repeated section reads return a receipt unless force:true.`;
}

server.tool(
  'help',
  'Read BrowserForce docs by section. No Chrome connection. First read returns docs; repeats return a receipt unless force:true.',
  {
    section: z.enum([...HELP_SECTION_NAMES, 'all']).optional(),
    force: z.boolean().optional(),
  },
  async ({ section, force = false }) => {
    if (!section || section === 'all') {
      return { content: [{ type: 'text', text: formatHelpSectionList() }] };
    }

    if (readHelpSections.has(section) && !force) {
      return {
        content: [{
          type: 'text',
          text: `Help section "${section}" was already read this MCP session. Use force:true to read it again.`,
        }],
      };
    }

    readHelpSections.add(section);
    return { content: [{ type: 'text', text: getHelpSection(section) }] };
  },
);

// ─── Execute Tool Prompt ───────────────────────────────────────────────────

const EXECUTE_PROMPT = `Run Playwright JS in the user's real Chrome.

HELP GATE:
Read each needed help section once per MCP session.
Call help(section) before navigation, mutation, multi-step work, raw CDP, plugins, snapshots/log debugging, or recovery.
Skip help only for simple read-only tab discovery.

TAB RULES:
- attached/manual/current tab -> list with getBrowserforceStatus(); inspect with state.page = await getBrowserforcePageForTab().
- all open tabs -> context.pages(); filter/cap unless full list asked.
- inspect/read/check -> reuse existing tabs; do not create/navigate to find them.

Use state.page for ongoing work. Use intent:'open' only when the user asked to open/navigate.
For details call help(section).`;

function registerExecuteTool(skillAppendix = '') {
  server.tool(
    'execute',
    EXECUTE_PROMPT + skillAppendix,
    {
      code: z.string().describe('JavaScript to run in BrowserForce execute scope. Use getBrowserforceStatus() for tab metadata; getBrowserforcePageForTab() to inspect an attached tab.'),
      timeout: z.number().optional().describe('Max execution time in ms (default: 30000)'),
      intent: z.enum(['inspect', 'open', 'auto']).optional()
        .describe('Use inspect for current/attached-tab work; use open only when the user explicitly asked to open/navigate. Defaults to inspect.'),
    },
    async ({ code, intent = 'inspect', timeout = 30000 }) => {
      try {
        beginBrowserOperation();
        // Preflight BEFORE the CDP connect. This throws BF_NO_ATTACHED_PAGE /
        // BF_NEW_TABS_DISABLED for attached-only flows with no manual tab, so
        // CDP startup is never reached for those cases.
        const browserforceRestrictions = await preflightAttachedPageBeforeCdp({
          intent,
          fetchBrowserforceRestrictions: getBrowserforceRestrictionsForSession,
        });
        await ensureBrowser();
        ensureAllPagesCapture();
        const agentPreferences = await getAgentPreferencesForSession();
        const ctx = getContext();
        const pages = ctx.pages();
        let page = pages[0] || null;

        if (!page && shouldCreateImplicitStartupPage(browserforceRestrictions)) {
          page = await ctx.newPage();
          runtime.userState.page = page;
        }

        if (page) setupConsoleCapture(page);
        const execCtx = buildExecContext(page, ctx, runtime.userState, {
          consoleLogs: runtime.consoleLogs, setupConsoleCapture,
        }, pluginHelpers, agentPreferences, browserforceRestrictions, pluginSkillRuntime);
        try {
          const result = await runCode(code, execCtx, timeout);
          const formatted = formatResult(result);
          const content = Array.isArray(formatted) ? [...formatted] : [formatted];
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
      } catch (err) {
        // Structured crash-safe errors from the preflight/startup gate.
        if (err instanceof BrowserForceMcpError) {
          return formatBrowserForceMcpError(err);
        }
        throw err;
      } finally {
        endBrowserOperation();
      }
    }
  );
}

server.tool(
  'reset',
  'Reconnects CDP and reinitializes browser/page bindings. Use when MCP stops responding, connection errors occur, pages/context were closed, or state is inconsistent. Reset clears persistent state; reinitialize state.page after calling it.',
  {},
  async () => {
    try {
      beginBrowserOperation();
      // Preflight BEFORE the CDP reconnect: reset reconnects to the attached
      // page, so it must fail with BF_NO_ATTACHED_PAGE rather than opening or
      // connecting to CDP when no manual tab is attached.
      await preflightAttachedPageBeforeCdp({
        intent: 'inspect',
        fetchBrowserforceRestrictions: getBrowserforceRestrictionsForSession,
      });
      // runtime.reset() closes the browser and clears userState, cached
      // preferences/restrictions, and console capture.
      await runtime.reset();
      await ensureBrowser();
      ensureAllPagesCapture();
      const pages = getPages();
      return {
        content: [{ type: 'text', text: `Reset complete. ${pages.length} page(s) available. Current URL: ${pages[0]?.url() ?? 'none'}` }],
      };
    } catch (err) {
      if (err instanceof BrowserForceMcpError) {
        return formatBrowserForceMcpError(err);
      }
      return {
        content: [{ type: 'text', text: `Reset failed: ${err.message}` }],
        isError: true,
      };
    } finally {
      endBrowserOperation();
    }
  }
);

// ─── Plugin Init ─────────────────────────────────────────────────────────────

async function initPlugins() {
  try {
    plugins = await loadPlugins();
    pluginHelpers = buildPluginHelpers(plugins);
    pluginSkillRuntime = buildPluginSkillRuntime(plugins);
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
  await ensureRelay();

  // Fire update check in background — result stored in pendingUpdate for execute handler
  checkForUpdate().then(info => { pendingUpdate = info; }).catch(() => {});

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[bf-mcp] MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`[bf-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
