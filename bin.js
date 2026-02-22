#!/usr/bin/env node
// BrowserForce CLI

import { parseArgs } from 'node:util';
import http from 'node:http';

const { values, positionals } = parseArgs({
  options: {
    eval: { type: 'string', short: 'e' },
    timeout: { type: 'string', default: '30000' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] || (values.eval ? 'execute' : 'help');

// ─── Helpers ────────────────────────────────────────────────────────────────

function output(data, json) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === 'string') {
    console.log(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    }).on('error', reject);
  });
}

async function connectBrowser() {
  const { getCdpUrl } = await import('./mcp/src/exec-engine.js');
  // playwright-core lives in mcp/node_modules (pnpm workspace sub-package).
  // Use createRequire from the mcp package context to locate it, then dynamic-import.
  const { createRequire } = await import('node:module');
  const mReq = createRequire(new URL('./mcp/src/exec-engine.js', import.meta.url).pathname);
  const pwPath = mReq.resolve('playwright-core');
  const { default: pw } = await import(pwPath);
  const { chromium } = pw;
  const cdpUrl = getCdpUrl();
  return chromium.connectOverCDP(cdpUrl);
}

function getFirstContext(browser) {
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser context available. Is the extension connected?');
  }
  return contexts[0];
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdStatus() {
  const { getRelayHttpUrl } = await import('./mcp/src/exec-engine.js');
  let baseUrl;
  try {
    baseUrl = getRelayHttpUrl();
  } catch {
    baseUrl = 'http://127.0.0.1:19222';
  }
  try {
    const data = await httpGet(`${baseUrl}/`);
    output({
      relay: 'running',
      extension: data.extension ? 'connected' : 'disconnected',
      targets: data.targets || 0,
      clients: data.clients || 0,
    }, values.json);
  } catch {
    output({ relay: 'not running' }, values.json);
    process.exit(1);
  }
}

async function cmdTabs() {
  const browser = await connectBrowser();
  try {
    const ctx = getFirstContext(browser);
    const pages = ctx.pages();
    const tabs = pages.map((p, i) => ({ index: i, title: '', url: p.url() }));
    await Promise.all(tabs.map(async (t, i) => {
      try { t.title = await pages[i].title(); } catch { t.title = '(untitled)'; }
    }));
    if (values.json) {
      output(tabs, true);
    } else if (tabs.length === 0) {
      console.log('No tabs available');
    } else {
      for (const t of tabs) {
        console.log(`  [${t.index}] ${t.title}`);
        console.log(`      ${t.url}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdScreenshot() {
  const index = parseInt(positionals[1] || '0', 10);
  const browser = await connectBrowser();
  try {
    const pages = getFirstContext(browser).pages();
    if (index >= pages.length) {
      console.error(`Tab ${index} not found. ${pages.length} tab(s) available.`);
      process.exit(1);
    }
    const buf = await pages[index].screenshot();
    if (values.json) {
      output({ type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }, true);
    } else {
      process.stdout.write(buf);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdSnapshot() {
  const index = parseInt(positionals[1] || '0', 10);
  const { getAccessibilityTree, getStableIds } = await import('./mcp/src/exec-engine.js');
  const { buildSnapshotText, annotateStableAttrs } = await import('./mcp/src/snapshot.js');
  const browser = await connectBrowser();
  try {
    const pages = getFirstContext(browser).pages();
    if (index >= pages.length) {
      console.error(`Tab ${index} not found. ${pages.length} tab(s) available.`);
      process.exit(1);
    }
    const page = pages[index];
    const axRoot = await getAccessibilityTree(page);
    if (!axRoot) { console.log('No accessibility tree available.'); return; }
    const stableIds = await getStableIds(page);
    annotateStableAttrs(axRoot, stableIds);
    const { text, refs } = buildSnapshotText(axRoot);
    const refTable = refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + refs.map(r => `${r.ref}: ${r.locator}`).join('\n')
      : '';
    const title = await page.title().catch(() => '');
    output(`Page: ${title} (${page.url()})\nRefs: ${refs.length} interactive elements\n\n${text}${refTable}`, values.json);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdNavigate() {
  const url = positionals[1];
  if (!url) { console.error('Usage: browserforce navigate <url>'); process.exit(1); }
  const { smartWaitForPageLoad } = await import('./mcp/src/exec-engine.js');
  const browser = await connectBrowser();
  try {
    const ctx = getFirstContext(browser);
    const page = await ctx.newPage();
    await page.goto(url);
    await smartWaitForPageLoad(page, 30000);
    const title = await page.title().catch(() => '');
    output({ url: page.url(), title }, values.json);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdExecute() {
  const code = values.eval;
  if (!code) { console.error('Usage: browserforce -e "<playwright code>"'); process.exit(1); }
  const timeoutMs = parseInt(values.timeout, 10);
  const { buildExecContext, runCode, formatResult } = await import('./mcp/src/exec-engine.js');
  const browser = await connectBrowser();
  try {
    const ctx = getFirstContext(browser);
    const pages = ctx.pages();
    const page = pages[0] || null;
    // One-shot state: fresh per invocation, not persistent across CLI calls
    const userState = {};
    const execCtx = buildExecContext(page, ctx, userState);
    const result = await runCode(code, execCtx, timeoutMs);
    const formatted = formatResult(result);
    if (formatted.type === 'image') {
      if (values.json) { output(formatted, true); }
      else { process.stdout.write(Buffer.from(formatted.data, 'base64')); }
    } else {
      output(formatted.text, values.json);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cmdServe() {
  const { RelayServer } = await import('./relay/src/index.js');
  const port = parseInt(process.env.RELAY_PORT || positionals[1] || '19222', 10);
  const relay = new RelayServer(port);
  relay.start({ writeCdpUrl: true });
  process.on('SIGINT', () => { relay.stop(); process.exit(0); });
  process.on('SIGTERM', () => { relay.stop(); process.exit(0); });
}

async function cmdMcp() {
  await import('./mcp/src/index.js');
}

function cmdHelp() {
  console.log(`
  BrowserForce — Give AI agents your real Chrome browser

  Usage:
    browserforce serve              Start the relay server
    browserforce mcp                Start the MCP server (stdio)
    browserforce status             Check relay and extension status
    browserforce tabs               List open browser tabs
    browserforce screenshot [n]     Screenshot tab n (default: 0)
    browserforce snapshot [n]       Accessibility tree of tab n (default: 0)
    browserforce navigate <url>     Open URL in a new tab
    browserforce -e "<code>"        Execute Playwright JavaScript (one-shot)

  Options:
    --timeout <ms>    Execution timeout (default: 30000)
    --json            JSON output
    -h, --help        Show this help

  Examples:
    browserforce serve
    browserforce tabs
    browserforce -e "return await snapshot()"
    browserforce -e "await page.goto('https://github.com'); return await snapshot()"
    browserforce screenshot 0 > page.png
    browserforce navigate https://gmail.com

  Note: -e commands are one-shot. State does not persist between calls.
  For persistent state, use the MCP server (browserforce mcp).
`);
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const commands = {
  serve: cmdServe, mcp: cmdMcp, status: cmdStatus, tabs: cmdTabs,
  screenshot: cmdScreenshot, snapshot: cmdSnapshot, navigate: cmdNavigate,
  execute: cmdExecute, help: cmdHelp,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  cmdHelp();
  process.exit(1);
}

try {
  await handler();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
