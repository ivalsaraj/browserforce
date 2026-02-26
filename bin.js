#!/usr/bin/env node
// BrowserForce CLI

import { parseArgs } from 'node:util';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { checkForUpdate } from './mcp/src/update-check.js';

const { values, positionals } = parseArgs({
  options: {
    eval: { type: 'string', short: 'e' },
    timeout: { type: 'string', default: '30000' },
    'dry-run': { type: 'boolean', default: false },
    'no-autostart': { type: 'boolean', default: false },
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

function httpFetch(method, url, body, authToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: parsed.hostname, port: parsed.port,
      path: parsed.pathname, method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function connectBrowser() {
  const { getCdpUrl, ensureRelay } = await import('./mcp/src/exec-engine.js');
  await ensureRelay();
  // playwright-core lives in mcp/node_modules (pnpm workspace sub-package).
  // Use createRequire from the mcp package context to locate it, then dynamic-import.
  const { createRequire } = await import('node:module');
  const mReq = createRequire(fileURLToPath(new URL('./mcp/src/exec-engine.js', import.meta.url)));
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
  // Warn if installed extension is outdated vs current package
  try {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { homedir } = await import('node:os');
    const pkgDir = dirname(fileURLToPath(import.meta.url));
    const pkgVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
    const extDir = process.env.BF_EXT_DIR || join(homedir(), '.browserforce', 'extension');
    const installedVersion = readFileSync(join(extDir, 'VERSION'), 'utf8').trim();
    if (installedVersion !== pkgVersion) {
      process.stderr.write(`⚠  Extension is outdated (installed: ${installedVersion}, current: ${pkgVersion}).\n`);
      process.stderr.write(`   Run: browserforce install-extension\n`);
      process.stderr.write(`❗ Then reload the extension in chrome://extensions/ (click the ↺ icon).\n\n`);
    }
  } catch { /* no VERSION file — git clone or first install; skip */ }

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

async function cmdPlugin() {
  const sub = positionals[1];
  if (!sub) {
    console.error('Usage: browserforce plugin <list|install|remove> [name]');
    process.exit(1);
  }

  const { getRelayHttpUrl } = await import('./mcp/src/exec-engine.js');
  let baseUrl;
  try { baseUrl = getRelayHttpUrl(); } catch { baseUrl = 'http://127.0.0.1:19222'; }

  // Auth token for write endpoints — read from token file
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const pluginsDir = process.env.BF_PLUGINS_DIR || join(homedir(), '.browserforce', 'plugins');
  const tokenFile = join(homedir(), '.browserforce', 'auth-token');
  let authToken = '';
  try { authToken = readFileSync(tokenFile, 'utf8').trim(); } catch { /* no token file */ }

  if (sub === 'list') {
    const data = await httpGet(`${baseUrl}/plugins`);
    if (values.json) {
      output(data, true);
    } else {
      const list = (data && data.plugins) ? data.plugins : [];
      if (list.length === 0) {
        console.log('No plugins installed');
      } else {
        for (const name of list) console.log(` \u2022 ${name}`);
      }
    }
    return;
  }

  if (sub === 'install') {
    const name = positionals[2];
    if (!name) { console.error('Usage: browserforce plugin install <name>'); process.exit(1); }
    const { status, body } = await httpFetch('POST', `${baseUrl}/plugins/install`, { name }, authToken);
    if (status >= 400) {
      console.error(`Error: ${body.error || JSON.stringify(body)}`);
      process.exit(1);
    }
    output(body, values.json);
    return;
  }

  if (sub === 'remove') {
    const name = positionals[2];
    if (!name) { console.error('Usage: browserforce plugin remove <name>'); process.exit(1); }
    const { status, body } = await httpFetch('DELETE', `${baseUrl}/plugins/${encodeURIComponent(name)}`, null, authToken);
    if (status >= 400) {
      console.error(`Error: ${body.error || JSON.stringify(body)}`);
      process.exit(1);
    }
    output(body, values.json);
    return;
  }

  console.error(`Unknown plugin subcommand: ${sub}`);
  process.exit(1);
}

async function cmdUpdate() {
  const { spawnSync } = await import('node:child_process');
  console.log('Checking for updates...');
  let update;
  try {
    update = await checkForUpdate();
  } catch (err) {
    console.error(`Update check failed: ${err.message}`);
    return;
  }
  if (!update) {
    console.log('Already up to date.');
    return;
  }
  console.log(`Updating ${update.current} → ${update.latest}...`);
  const result = spawnSync('npm', ['install', '-g', 'browserforce'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('Update failed. Run manually: npm install -g browserforce');
    process.exit(1);
  }
  console.log(`Updated to ${update.latest}.`);

  // Auto-sync extension if user has previously run install-extension
  const { readFileSync: readFs } = await import('node:fs');
  const { join: pathJoin } = await import('node:path');
  const { homedir: osHomedir } = await import('node:os');
  const extDir = process.env.BF_EXT_DIR || pathJoin(osHomedir(), '.browserforce', 'extension');
  let hasVersion = false;
  try { readFs(pathJoin(extDir, 'VERSION'), 'utf8'); hasVersion = true; } catch { /* not installed */ }
  if (hasVersion) {
    const { dest, reloaded } = await doInstallExtension(true);
    console.log(`Extension updated in ${dest}`);
    if (reloaded) {
      console.log('  Reloading extension... ✓');
    } else {
      console.log('❗ Reload the extension in chrome://extensions/ (click the ↺ icon).');
    }
  } else {
    console.log('Tip: run browserforce install-extension to set up the Chrome extension.');
  }
}

async function attemptExtensionReload() {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const tokenFile = join(homedir(), '.browserforce', 'auth-token');
  let authToken = '';
  try { authToken = readFileSync(tokenFile, 'utf8').trim(); } catch { return false; }
  if (!authToken) return false;

  const { getRelayHttpUrl } = await import('./mcp/src/exec-engine.js');
  let baseUrl;
  try { baseUrl = getRelayHttpUrl(); } catch { baseUrl = 'http://127.0.0.1:19222'; }

  try {
    const { status, body } = await httpFetch('POST', `${baseUrl}/extension/reload`, {}, authToken);
    return status === 200 && body?.reloaded === true;
  } catch {
    return false; // relay not running
  }
}

async function doInstallExtension(quiet) {
  const { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { homedir } = await import('node:os');

  const pkgDir = dirname(fileURLToPath(import.meta.url));
  const src = join(pkgDir, 'extension');
  const dest = process.env.BF_EXT_DIR || join(homedir(), '.browserforce', 'extension');

  if (!existsSync(src)) {
    throw new Error(`Extension source not found at ${src}.\nIs browserforce installed via npm? Try: npm install -g browserforce`);
  }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });

  // VERSION sentinel — tracks npm package version, NOT manifest.json version (those are separate tracks)
  const pkgVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  writeFileSync(join(dest, 'VERSION'), pkgVersion);

  const reloaded = await attemptExtensionReload();

  if (!quiet) {
    console.log(`Extension installed to: ${dest}`);
    console.log('');
    console.log('To load in Chrome:');
    console.log('  1. Open chrome://extensions/');
    console.log('  2. Enable Developer mode (toggle, top-right)');
    console.log('  3. Click "Load unpacked" → select:');
    console.log(`     ${dest}`);
    console.log('');
    if (reloaded) {
      console.log('  Reloading extension... ✓');
    } else {
      console.log('❗ After any BrowserForce update, re-run: browserforce install-extension');
      console.log('   Then reload the extension in chrome://extensions/ (click the ↺ icon).');
    }
  }

  return { dest, pkgVersion, reloaded };
}

async function cmdInstallExtension() {
  await doInstallExtension(false);
}

async function cmdSetup() {
  const target = positionals[1];
  if (!target) {
    console.error('Usage: browserforce setup openclaw [--dry-run] [--json] [--no-autostart]');
    process.exit(1);
  }

  if (target !== 'openclaw') {
    console.error(`Unknown setup target: ${target}`);
    process.exit(1);
  }

  const { homedir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const fs = await import('node:fs/promises');
  const {
    mergeOpenClawConfig,
    formatJsonStable,
    buildAutostartSpec,
    applyAutostart,
  } = await import('./mcp/src/openclaw-setup.js');

  const dryRun = values['dry-run'] === true;
  const noAutostart = values['no-autostart'] === true;
  const homeDir = homedir();
  const openclawConfigPath = join(homeDir, '.openclaw', 'openclaw.json');
  const openclawDir = dirname(openclawConfigPath);

  let existingConfig = {};
  let configExisted = false;
  try {
    const raw = await fs.readFile(openclawConfigPath, 'utf8');
    configExisted = true;
    existingConfig = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`Failed to read OpenClaw config at ${openclawConfigPath}: ${err.message}`);
    }
  }

  const mergedConfig = mergeOpenClawConfig(existingConfig);
  const mergedJson = formatJsonStable(mergedConfig);
  if (!dryRun) {
    await fs.mkdir(openclawDir, { recursive: true });
    await fs.writeFile(openclawConfigPath, mergedJson, 'utf8');
  }

  let autostart = null;
  if (!noAutostart) {
    let autostartExecFn;
    if (values.json) {
      const { spawnSync } = await import('node:child_process');
      autostartExecFn = (command) => {
        const result = spawnSync(command, {
          shell: true,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (result.error) {
          throw result.error;
        }

        if (typeof result.status === 'number' && result.status !== 0) {
          const commandOutput = [result.stderr, result.stdout]
            .filter((chunk) => typeof chunk === 'string' && chunk.trim().length > 0)
            .join('\n')
            .trim();
          throw new Error(
            commandOutput
              ? `Command failed with exit code ${result.status}: ${command}\n${commandOutput}`
              : `Command failed with exit code ${result.status}: ${command}`,
          );
        }

        if (result.status === null) {
          throw new Error(`Command terminated unexpectedly: ${command}`);
        }
      };
    }

    const autostartSpec = buildAutostartSpec({
      platform: process.platform,
      homeDir,
      nodePath: process.execPath,
      binScriptPath: fileURLToPath(import.meta.url),
    });
    const autostartReport = await applyAutostart(autostartSpec, {
      dryRun,
      ...(autostartExecFn ? { execFn: autostartExecFn } : {}),
    });
    autostart = {
      platform: autostartSpec.platform,
      summary: autostartSpec.summary,
      wroteFiles: autostartReport.wroteFiles,
      ranCommands: autostartReport.ranCommands,
      skippedCommands: autostartReport.skippedCommands,
    };
  }

  const result = {
    target: 'openclaw',
    dryRun,
    openclawConfigPath,
    mcpAdapterConfigured: mergedConfig?.plugins?.entries?.['mcp-adapter']?.enabled === true,
    configExisted,
    configWritten: !dryRun,
    autostart,
  };

  if (values.json) {
    process.stdout.write(formatJsonStable(result));
    return;
  }

  console.log('OpenClaw setup complete');
  console.log(`  target: ${result.target}`);
  console.log(`  openclawConfigPath: ${result.openclawConfigPath}`);
  console.log(`  mcpAdapterConfigured: ${result.mcpAdapterConfigured}`);
  console.log(`  config: ${dryRun ? 'dry-run (not written)' : 'written'}`);
  if (noAutostart) {
    console.log('  autostart: skipped (--no-autostart)');
  } else {
    console.log(`  autostart.platform: ${autostart.platform}`);
    console.log(`  autostart: ${dryRun ? 'dry-run (not applied)' : 'applied'}`);
  }
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
    browserforce plugin list        List installed plugins
    browserforce plugin install <n> Install a plugin from the registry
    browserforce plugin remove <n>  Remove an installed plugin
    browserforce setup openclaw     Configure OpenClaw + optional autostart
    browserforce update             Update to the latest version
    browserforce install-extension  Copy extension to ~/.browserforce/extension/
    browserforce -e "<code>"        Execute Playwright JavaScript (one-shot)

  Options:
    --timeout <ms>    Execution timeout (default: 30000)
    --dry-run         Preview setup changes without writing files
    --no-autostart    Skip autostart setup for setup openclaw
    --json            JSON output
    -h, --help        Show this help

  Examples:
    browserforce serve
    browserforce tabs
    browserforce plugin list
    browserforce plugin install highlight
    browserforce setup openclaw --dry-run --json
    browserforce update
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
  execute: cmdExecute, plugin: cmdPlugin, update: cmdUpdate,
  'install-extension': cmdInstallExtension, setup: cmdSetup, help: cmdHelp,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: ${command}`);
  cmdHelp();
  process.exit(1);
}

// Start update check in background — skipped for long-running or self-update commands
const updatePromise = (command !== 'serve' && command !== 'mcp' && command !== 'update')
  ? checkForUpdate().catch(() => null)
  : null;

try {
  await handler();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// Show update notice after command finishes (wait at most 500 ms)
if (updatePromise) {
  const update = await Promise.race([updatePromise, new Promise(r => setTimeout(r, 500, null))]);
  if (update) {
    process.stderr.write(`\n  Update available: ${update.current} → ${update.latest}\n  Run: npm install -g browserforce\n\n`);
  }
}
