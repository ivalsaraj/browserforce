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
    // Atomic session-backed verbs (route through the sessiond daemon).
    sessiond: { type: 'boolean', default: false },
    // Backend selection (parsed by the canonical resolveRequestedBackend()).
    real: { type: 'boolean', default: false },
    managed: { type: 'boolean', default: false },
    headless: { type: 'boolean', default: false },
    backend: { type: 'string' },
    selector: { type: 'string' },
    search: { type: 'string' },
    'interactive-only': { type: 'boolean', default: false },
    // wait <kind> selectors and eval input source.
    text: { type: 'string' },
    url: { type: 'string' },
    load: { type: 'string' },
    fn: { type: 'string' },
    stdin: { type: 'boolean', default: false },
    // skills get flags.
    full: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    // doctor: remove stale sidecars (never secrets).
    fix: { type: 'boolean', default: false },
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
  const {
    getCdpUrl,
    ensureRelay,
    assertExtensionConnected,
    getRelayHttpUrlFromCdpUrl,
  } = await import('./mcp/src/exec-engine.js');
  await ensureRelay();
  // playwright-core lives in mcp/node_modules (pnpm workspace sub-package).
  // Use createRequire from the mcp package context to locate it, then dynamic-import.
  const { createRequire } = await import('node:module');
  const mReq = createRequire(fileURLToPath(new URL('./mcp/src/exec-engine.js', import.meta.url)));
  const pwPath = mReq.resolve('playwright-core');
  const { default: pw } = await import(pwPath);
  const { chromium } = pw;
  const cdpUrl = await getCdpUrl();
  const baseUrl = getRelayHttpUrlFromCdpUrl(cdpUrl);
  await assertExtensionConnected({ baseUrl });
  return chromium.connectOverCDP(cdpUrl);
}

async function waitForInitialPageDiscovery(ctx, { timeoutMs = 5000, pollMs = 100 } = {}) {
  const started = Date.now();
  while (ctx.pages().length === 0 && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
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

async function cmdScreenshot() {
  const index = parseInt(positionals[1] || '0', 10);
  const browser = await connectBrowser();
  try {
    const ctx = getFirstContext(browser);
    await waitForInitialPageDiscovery(ctx);
    const pages = ctx.pages();
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
  const { loadPluginRuntime } = await import('./mcp/src/plugin-runtime.js');
  const pluginRuntime = await loadPluginRuntime({ logPrefix: '[bf-cli]' });
  const browser = await connectBrowser();
  try {
    const ctx = getFirstContext(browser);
    await waitForInitialPageDiscovery(ctx);
    const pages = ctx.pages();
    const page = pages[0] || null;
    // One-shot state: fresh per invocation, not persistent across CLI calls
    const userState = {};
    const execCtx = buildExecContext(
      page,
      ctx,
      userState,
      {},
      pluginRuntime.helpers,
      {},
      {},
      pluginRuntime.skillRuntime,
    );
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
    const data = await httpGet(`${baseUrl}/v1/plugins`);
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
    const { status, body } = await httpFetch('POST', `${baseUrl}/v1/plugins/install`, { name }, authToken);
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
    const { status, body } = await httpFetch('DELETE', `${baseUrl}/v1/plugins/${encodeURIComponent(name)}`, null, authToken);
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

  // VERSION sentinel tracks the same package version shown by the extension manifest.
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
  const pluginsDir = process.env.BF_PLUGINS_DIR || join(homeDir, '.browserforce', 'plugins');

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

  // OpenClaw-specific guidance should only affect OpenClaw users.
  // Install the openclaw plugin after setup (best effort).
  let openclawPlugin = null;
  if (!dryRun) {
    try {
      const { installPlugin } = await import('./mcp/src/plugin-installer.js');
      await installPlugin('openclaw', pluginsDir);
      openclawPlugin = { name: 'openclaw', installed: true };
    } catch (err) {
      openclawPlugin = {
        name: 'openclaw',
        installed: false,
        error: err?.message || String(err),
      };
    }
  }

  const result = {
    target: 'openclaw',
    dryRun,
    openclawConfigPath,
    mcpAdapterConfigured: mergedConfig?.plugins?.entries?.['mcp-adapter']?.enabled === true,
    configExisted,
    configWritten: !dryRun,
    autostart,
    ...(openclawPlugin ? { openclawPlugin } : {}),
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
  if (openclawPlugin) {
    if (openclawPlugin.installed) {
      console.log('  openclawPlugin: installed');
    } else {
      console.log(`  openclawPlugin: install failed (${openclawPlugin.error})`);
    }
  }
}

async function fetchChatdHealth(port, attempts = 20, delayMs = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const health = await httpGet(`http://127.0.0.1:${port}/health`);
      if (health && health.ok) return health;
    } catch {
      // Keep polling until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

async function cmdAgent() {
  const sub = positionals[1];
  const { pickChatdPort } = await import('./agent/src/port-resolver.js');
  const { writeLock, readLock, clearLock, isLockAlive } = await import('./agent/src/lockfile.js');
  const { randomBytes } = await import('node:crypto');
  const { spawn } = await import('node:child_process');
  const { promises: fsp } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');

  const lockPath = process.env.BF_CHATD_LOCK_PATH || join(homedir(), '.browserforce', 'chatd-lock.json');
  const chatdUrlPath = process.env.BF_CHATD_URL_PATH || join(homedir(), '.browserforce', 'chatd-url.json');
  const AGENT_INSTRUCTIONS_TEMPLATE_PATH = fileURLToPath(new URL('./agent/instructions/AGENTS.md', import.meta.url));
  const MANAGED_AGENTS_HEADER = '<!-- BrowserForce managed AGENTS.md (remove this header to opt out of auto-sync) -->';

  const syncManagedAgentInstructions = async (codexCwd) => {
    const targetPath = join(codexCwd, 'AGENTS.md');
    const template = await fsp.readFile(AGENT_INSTRUCTIONS_TEMPLATE_PATH, 'utf8');
    const nextBody = `${MANAGED_AGENTS_HEADER}\n\n${String(template || '').trimEnd()}\n`;

    let currentBody = null;
    try {
      currentBody = await fsp.readFile(targetPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (currentBody == null) {
      await fsp.writeFile(targetPath, nextBody, 'utf8');
      return;
    }

    if (currentBody.startsWith(MANAGED_AGENTS_HEADER) && currentBody !== nextBody) {
      await fsp.writeFile(targetPath, nextBody, 'utf8');
    }
  };

  if (sub === 'start') {
    const current = await readLock({ lockPath });
    if (current && await isLockAlive({ lock: current })) {
      output({ started: false, running: true, pid: current.pid, port: current.port }, values.json);
      return;
    }

    const envPort = Number(process.env.BF_CHATD_PORT || 0);
    const port = await pickChatdPort({ envPort });
    const token = randomBytes(32).toString('base64url');
    const codexCwd = String(process.env.BF_CHATD_CODEX_CWD || '').trim()
      || join(homedir(), '.browserforce', 'agent-cwd');
    await fsp.mkdir(codexCwd, { recursive: true });
    await syncManagedAgentInstructions(codexCwd);

    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./agent/src/chatd.js', import.meta.url))],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          BF_CHATD_PORT: String(port),
          BF_CHATD_TOKEN: token,
          BF_CHATD_CODEX_CWD: codexCwd,
        },
      },
    );
    child.unref();

    await writeLock({ pid: child.pid, port, token, lockPath });
    const health = await fetchChatdHealth(port, 30, 100);
    output({ started: true, pid: child.pid, port, ready: !!health }, values.json);
    return;
  }

  if (sub === 'status') {
    const lock = await readLock({ lockPath });
    if (!lock) {
      output({ running: false }, values.json);
      return;
    }

    const alive = await isLockAlive({ lock });
    if (!alive) {
      await clearLock({ lockPath });
      output({ running: false, stale: true }, values.json);
      return;
    }

    const health = await fetchChatdHealth(lock.port, 10, 100);
    output({
      running: !!health,
      pid: lock.pid,
      port: lock.port,
      health,
    }, values.json);
    return;
  }

  if (sub === 'stop') {
    const clearChatdUrlFile = async () => {
      try { await fsp.unlink(chatdUrlPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    };
    const lock = await readLock({ lockPath });
    if (!lock) {
      await clearLock({ lockPath });
      await clearChatdUrlFile();
      output({ stopped: true, running: false }, values.json);
      return;
    }

    const alive = await isLockAlive({ lock });
    if (alive) {
      try {
        process.kill(lock.pid, 'SIGTERM');
      } catch {
        // ignore kill race
      }
    }
    await clearLock({ lockPath });
    await clearChatdUrlFile();
    output({ stopped: true, pid: lock.pid, port: lock.port }, values.json);
    return;
  }

  console.error('Usage: browserforce agent start|status|stop');
  process.exit(1);
}

// Read this CLI package's version (the version a freshly-spawned daemon will
// report). Used to restart a daemon left running by a previous, older install.
async function getCliPkgVersion() {
  try {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const pkgDir = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

// Spawn the sessiond daemon detached and wait for it to publish its lock.
// The daemon self-picks its port/token; the parent resolves the requested
// backend from CLI flags/env via the canonical resolveRequestedBackend() and
// forwards it as BF_BROWSER_BACKEND so `--real`/`--managed`/`--headless`/
// `--backend` actually drive negotiation (and `--real` fails loud at startup).
// Throws on fast-fail or conflicting/unknown backend flags.
async function startSessiondDaemon() {
  const { readSessiondLock } = await import('./cli/session-client.js');
  const { resolveRequestedBackend } = await import('./mcp/src/backend-selection.js');
  const { spawn } = await import('node:child_process');
  const sessiondPath = fileURLToPath(new URL('./cli/sessiond.js', import.meta.url));

  // Throws on conflicting flags (`--real --managed`) or an unknown `--backend`
  // value — surfaced by the top-level dispatch as a clean `Error:` + exit 1.
  const backend = resolveRequestedBackend({ argv: values, env: process.env });

  const child = spawn(process.execPath, [sessiondPath], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, BF_BROWSER_BACKEND: backend },
  });

  // Capture early stderr so a fast-fail startup error is surfaced (agent-browser lesson).
  let startupStderr = '';
  const onStderr = (chunk) => { startupStderr += chunk.toString(); };
  child.stderr?.on('data', onStderr);

  let lock = null;
  for (let i = 0; i < 50 && !lock; i += 1) {
    lock = await readSessiondLock();
    if (!lock) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.stderr?.off('data', onStderr);
  // Release the child's stderr pipe so this CLI process can exit (an open pipe
  // fd would otherwise keep the event loop alive); the daemon swallows EPIPE.
  child.stderr?.destroy();
  if (!lock) {
    try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    const detail = startupStderr.trim();
    throw new Error(`session daemon failed to start${detail ? `:\n${detail}` : '.'}`);
  }
  child.unref();
  return lock;
}

// Should an already-live daemon be restarted to honor THIS invocation? Two
// triggers: (1) the live daemon is an older install (version mismatch), so verbs
// would run on stale code; or (2) an EXPLICIT backend flag (--real/--managed/
// --headless) whose effective backend differs from what's live — `--real` must
// never silently reuse a managed daemon (a silent fallback). `auto` (no flag)
// reuses whatever is live. The comparison is against the daemon's EFFECTIVE
// backend (`/status.backend`), so an auto→managed daemon is still reused by an
// explicit `--managed` without needless churn. Both the verb auto-start path
// (ensureSessiondRunning) and `session start` route through this ONE predicate
// so the backend guarantee can't drift between them.
async function sessiondMustRestart({ status, requested, sessiondCommand }) {
  const expected = await getCliPkgVersion();
  if (expected && status.version && status.version !== expected) return true;
  if (requested === 'real' || requested === 'managed' || requested === 'headless') {
    let live = null;
    try { live = (await sessiondCommand({ method: 'GET', path: '/status' })).body; }
    catch { /* unknown → restart to be safe */ }
    if (!live || live.backend !== requested) return true;
  }
  return false;
}

// Gracefully stop a live daemon and clear its sidecars before a fresh spawn.
// Uses the authenticated /stop self-shutdown (never a raw PID kill) so a reused
// PID can't be signalled; the daemon may close the socket mid-response, so a
// failed request is non-fatal.
async function stopAndClearSessiond({ sessiondCommand, clearSessiondLock, clearSessiondUrl }) {
  try { await sessiondCommand({ method: 'POST', path: '/stop' }); } catch { /* may close mid-response */ }
  await clearSessiondLock();
  await clearSessiondUrl();
}

// Return a live sessiond lock, auto-starting the daemon if none is running.
// Liveness is daemon-aware (probes /health, not just the lock PID) so a stale
// lock left by a crashed daemon — or a PID since reused by an unrelated process
// — is cleared and replaced rather than trusted. A live daemon predating a
// package upgrade (version mismatch) or running a different backend than an
// explicit flag requests is gracefully stopped and restarted so verbs always
// run on the current code and the requested backend.
async function ensureSessiondRunning() {
  const {
    getLiveSessiondStatus,
    clearSessiondLock,
    clearSessiondUrl,
    sessiondCommand,
  } = await import('./cli/session-client.js');
  const { resolveRequestedBackend } = await import('./mcp/src/backend-selection.js');

  // Resolve the requested backend up front (throws loud on conflicting flags).
  const requested = resolveRequestedBackend({ argv: values, env: process.env });
  const status = await getLiveSessiondStatus();
  if (status.running) {
    if (await sessiondMustRestart({ status, requested, sessiondCommand })) {
      await stopAndClearSessiond({ sessiondCommand, clearSessiondLock, clearSessiondUrl });
      return startSessiondDaemon();
    }
    return status.lock;
  }
  if (status.stale) {
    await clearSessiondLock();
    await clearSessiondUrl();
  }
  return startSessiondDaemon();
}

async function cmdSession() {
  const sub = positionals[1] || 'status';
  const {
    getLiveSessiondStatus,
    clearSessiondLock,
    clearSessiondUrl,
    sessiondCommand,
  } = await import('./cli/session-client.js');

  // Best-effort authenticated /status read (backend + fallback warning). Never
  // throws — observability must not break start/status/stop.
  const readBackendStatus = async () => {
    try { return (await sessiondCommand({ method: 'GET', path: '/status' })).body; }
    catch { return null; }
  };
  const surfaceWarning = (st) => {
    if (st?.warning && !values.json) process.stderr.write(`⚠  ${st.warning}\n`);
  };

  if (sub === 'start') {
    const { resolveRequestedBackend } = await import('./mcp/src/backend-selection.js');
    // Throws loud on conflicting flags (`--real --managed`) / unknown `--backend`.
    const requested = resolveRequestedBackend({ argv: values, env: process.env });
    const status = await getLiveSessiondStatus();
    // Reuse a live daemon ONLY when it honors this invocation. An explicit
    // `--real`/`--headless` against a different-backend daemon must restart, not
    // silently report the wrong-backend daemon as "running" (same no-silent-
    // fallback guarantee the verb path enforces — one shared predicate).
    if (status.running && !(await sessiondMustRestart({ status, requested, sessiondCommand }))) {
      const st = await readBackendStatus();
      surfaceWarning(st);
      output({ running: true, started: false, pid: status.lock.pid, port: status.lock.port, backend: st?.backend ?? null }, values.json);
      return;
    }
    // No live daemon, a stale lock, or a version/backend mismatch that must
    // restart to honor this invocation. Stop a live (mismatched) daemon via the
    // authenticated /stop; otherwise just clear a stale lock before spawning.
    if (status.running) {
      await stopAndClearSessiond({ sessiondCommand, clearSessiondLock, clearSessiondUrl });
    } else if (status.stale) {
      await clearSessiondLock();
      await clearSessiondUrl();
    }
    const lock = await startSessiondDaemon();
    const st = await readBackendStatus();
    surfaceWarning(st);
    output({ running: true, started: true, pid: lock.pid, port: lock.port, backend: st?.backend ?? null }, values.json);
    return;
  }

  if (sub === 'status') {
    const status = await getLiveSessiondStatus();
    if (!status.running) {
      output({ running: false }, values.json);
      return;
    }
    const st = await readBackendStatus();
    surfaceWarning(st);
    output({
      running: true,
      pid: status.lock.pid,
      port: status.lock.port,
      version: status.lock.version ?? null,
      backend: st?.backend ?? null,
      warning: st?.warning ?? null,
    }, values.json);
    return;
  }

  if (sub === 'stop') {
    const status = await getLiveSessiondStatus();
    if (!status.running) {
      // No live daemon. NEVER `process.kill` the lock's PID — under PID reuse it
      // may belong to an unrelated process. Just clear the (possibly stale)
      // sidecars and report.
      await clearSessiondLock();
      await clearSessiondUrl();
      output({ stopped: true, running: false, ...(status.stale ? { stale: true, reason: status.reason } : {}) }, values.json);
      return;
    }
    // Verified our daemon is live → graceful, authenticated self-shutdown.
    try { await sessiondCommand({ method: 'POST', path: '/stop' }); } catch { /* may close the socket mid-response */ }
    await clearSessiondLock();
    await clearSessiondUrl();
    output({ stopped: true, pid: status.lock.pid, port: status.lock.port }, values.json);
    return;
  }

  console.error('Usage: browserforce session start|status|stop');
  process.exit(1);
}

// ─── Registry-backed command verbs ──────────────────────────────────────────
// Direct verbs (`browserforce click @e2 --tab app`) and the quoted form
// (`browserforce run "click @e2 --tab app"`) share one path: rebuild the
// command string from the RAW post-verb argv, hand it to the shared registry
// parser (the single authority for command flags/args — parseArgs strict:false
// must never pre-consume or swallow them), then send the normalized JSON body
// to the sessiond per-verb endpoint.

const REGISTRY_COMMAND_VERBS = new Set([
  'open', 'tabs', 'use', 'snapshot', 'click', 'hover', 'fill', 'type',
  'press', 'wait', 'get', 'eval', 'rename', 'forget', 'run',
]);

// Global flags owned by bin.js — extracted from the raw argv and never
// forwarded to the registry parser. Everything else (known command flags AND
// unknown typos) flows through so the registry can accept or reject it.
const GLOBAL_CLI_BOOLEAN_FLAGS = new Set([
  '--json', '--sessiond', '--stdin', '--real', '--managed', '--headless',
  '--no-autostart', '--dry-run', '--help', '-h',
]);
const GLOBAL_CLI_VALUE_FLAGS = new Set(['--timeout', '--backend']);

// Raw argv tokens after the verb, minus global CLI flags (wherever they
// appear). The first non-flag token is the verb itself and is skipped.
function extractRawCommandTokens() {
  const raw = process.argv.slice(2);
  const tokens = [];
  let verbSeen = false;
  for (let i = 0; i < raw.length; i += 1) {
    const token = raw[i];
    const isFlag = token.startsWith('-');
    const eqIdx = token.indexOf('=');
    const flagName = isFlag ? (eqIdx === -1 ? token : token.slice(0, eqIdx)) : null;
    if (flagName && GLOBAL_CLI_BOOLEAN_FLAGS.has(flagName)) continue;
    if (flagName && GLOBAL_CLI_VALUE_FLAGS.has(flagName)) {
      if (eqIdx === -1) i += 1; // consume the flag's value token too
      continue;
    }
    if (!verbSeen && !isFlag) { verbSeen = true; continue; }
    tokens.push(token);
  }
  return tokens;
}

// Re-quote an argv token for the registry tokenizer: double-quote when it
// contains whitespace/quotes/backslashes (escaping only `\` and `"`, so real
// newlines from --stdin survive verbatim).
function quoteCommandToken(token) {
  if (token !== '' && !/[\s"'\\]/.test(token)) return token;
  return `"${token.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

async function cmdBrowserforceCommand() {
  const {
    parseBrowserforceCommand,
    commandToBody,
    renderBrowserforceCommandText,
    BrowserforceCommandError,
    COMMAND_HELP_TEXT,
  } = await import('./mcp/src/browserforce-command-registry.js');

  const failLocal = (message) => {
    if (values.json) output({ success: false, data: null, error: message, warning: null }, true);
    else console.error(`Error: ${message}`);
    process.exit(1);
  };

  let commandString;
  if (command === 'run') {
    const rawTokens = extractRawCommandTokens();
    if (rawTokens.length !== 1 || rawTokens[0].startsWith('--')) {
      failLocal('Usage: browserforce run "<command>"   (e.g. browserforce run "click @e2")');
    }
    commandString = rawTokens[0];
  } else {
    let tokens = extractRawCommandTokens();
    // CLI compat alias: the pre-registry snapshot flag spelling.
    if (command === 'snapshot') {
      tokens = tokens.map((t) => (t === '--interactive-only' ? '--interactive' : t));
    }
    // eval --stdin: piped code becomes the (single, quoted) code argument.
    if (command === 'eval' && values.stdin) {
      tokens = [await readStdin(), ...tokens];
    }
    commandString = [command, ...tokens.map(quoteCommandToken)].join(' ');
  }

  let parsed;
  let body;
  try {
    parsed = parseBrowserforceCommand(commandString);
    body = commandToBody(parsed);
  } catch (err) {
    const suggestion = err instanceof BrowserforceCommandError && err.suggestion ? ` ${err.suggestion}` : '';
    failLocal(`${err.message}${suggestion}`);
  }

  // help never needs the daemon.
  if (parsed.verb === 'help') {
    if (values.json) output({ success: true, data: COMMAND_HELP_TEXT, error: null, warning: null }, true);
    else console.log(COMMAND_HELP_TEXT);
    return;
  }

  const { sessiondCommand } = await import('./cli/session-client.js');
  await ensureSessiondRunning();
  const { body: resp } = await sessiondCommand({
    method: 'POST',
    path: `/command/${parsed.verb}`,
    body: { ...body, timeout: parseInt(values.timeout, 10) },
  });

  if (values.json) {
    // Compat: `tabs --json` keeps the pre-registry top-level array shape; each
    // row keeps index/title/url and adds handle/active/name (a superset).
    if (parsed.verb === 'tabs' && resp && resp.success !== false) {
      output(resp.data?.tabs ?? [], true);
      return;
    }
    output(resp, true);
    if (resp && resp.success === false) process.exit(1);
    return;
  }
  if (!resp || resp.success === false) {
    console.error(`Error: ${resp?.error || 'command failed'}`);
    process.exit(1);
  }
  if (resp.warning) process.stderr.write(`⚠  ${resp.warning}\n`);
  output(renderBrowserforceCommandText(parsed.verb, resp.data), false);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

// Serve the BrowserForce skills bundled with the package (mirrors agent-browser
// `skills list|get|path`). Pure discovery/parse logic lives in skills-cmd.js;
// this function only resolves the search dirs and renders text/JSON output.
async function cmdSkills() {
  const { findSkillsDirs, skillsList, skillsGet, skillsPath, truncateDescription } =
    await import('./mcp/src/skills-cmd.js');

  const dirs = findSkillsDirs();
  if (dirs.length === 0) {
    const error = 'Skills directory not found. Reinstall via npm or set BF_SKILLS_DIR.';
    if (values.json) output({ success: false, error }, true);
    else console.error(`✗ ${error}`);
    process.exit(1);
  }

  const sub = positionals[1] || 'list';

  if (sub === 'list') {
    const result = skillsList(dirs);
    if (values.json) { output(result, true); return; }
    if (result.data.length === 0) { console.log('No skills found'); return; }
    const maxName = Math.max(...result.data.map((s) => s.name.length));
    for (const s of result.data) {
      console.log(`  ${s.name.padEnd(maxName)}  ${truncateDescription(s.description, 70)}`);
    }
    return;
  }

  if (sub === 'get') {
    const names = positionals.slice(2);
    const result = skillsGet(dirs, names, { all: values.all, full: values.full });
    if (values.json) { output(result, true); if (!result.success) process.exit(1); return; }
    if (!result.success) { console.error(`✗ ${result.error}`); process.exit(1); }
    result.data.forEach((s, i) => {
      if (i > 0) console.log('\n---\n');
      process.stdout.write(s.content.endsWith('\n') ? s.content : `${s.content}\n`);
      for (const f of s.files || []) {
        console.log(`\n--- ${f.path} ---\n`);
        process.stdout.write(f.content.endsWith('\n') ? f.content : `${f.content}\n`);
      }
    });
    return;
  }

  if (sub === 'path') {
    const result = skillsPath(dirs, positionals[2]);
    if (values.json) { output(result, true); if (!result.success) process.exit(1); return; }
    if (!result.success) { console.error(`✗ ${result.error}`); process.exit(1); }
    if (result.data.paths) for (const p of result.data.paths) console.log(p);
    else console.log(result.data.path);
    return;
  }

  const error = `Unknown skills subcommand: ${sub}`;
  if (values.json) output({ success: false, error }, true);
  else console.error(`✗ ${error}`);
  process.exit(1);
}

// Read-only diagnostics (relay, extension, stale cdp-url, secret perms, active
// backend). `--fix` removes only stale sidecars — never secrets. Exits 1 when
// any check fails (warnings are allowed).
async function cmdDoctor() {
  const { runDoctor } = await import('./mcp/src/doctor.js');
  const report = await runDoctor({ fix: values.fix });

  if (values.json) {
    output({ success: report.ok, data: report }, true);
    if (!report.ok) process.exit(1);
    return;
  }

  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  console.log('\n  BrowserForce doctor\n');
  for (const c of report.checks) {
    console.log(`  ${icon[c.status] || '?'} ${c.label}: ${c.detail}`);
  }
  if (report.fixes.length > 0) {
    console.log(`\n  Removed ${report.fixes.length} stale sidecar(s).`);
  }
  console.log(`\n  ${report.ok ? '✓ All critical checks passed.' : '✗ One or more checks failed.'}\n`);
  if (!report.ok) process.exit(1);
}

function cmdHelp() {
  console.log(`
  BrowserForce — Give AI agents your real Chrome browser

  Usage:
    browserforce serve              Start the relay server
    browserforce mcp                Start the MCP server (stdio)
    browserforce status             Check relay and extension status

  Session commands (shared command language with the MCP browserforce tool):
    browserforce open <url> [--as name] [--replace]   Open a URL in a new tab
    browserforce tabs               List tabs with stable handles (t1, t2, ...)
    browserforce use <t1|name|text> Switch the active tab (soft match)
    browserforce snapshot [--tab name] [--selector css] [--search re] [--interactive]
    browserforce click <@ref>       Click a ref from the last session snapshot
    browserforce hover <@ref>       Hover a ref
    browserforce fill <@ref> <text> Fill a ref with text (clears first)
    browserforce type <@ref> <text> Type text into a ref (key by key)
    browserforce press <key>        Press a keyboard key (e.g. Enter)
    browserforce wait <text|url|load|fn> <value>  Wait (flag form --text <s> also works)
    browserforce get <url|title>    Read url/title, or: get <text|html> <@ref>
    browserforce eval --stdin       Run piped Playwright JS in the session (or: eval "<code>")
    browserforce rename <old> <new> Rename a tab name
    browserforce forget <name>      Remove a tab name
    browserforce run "<command>"    Run any command string (e.g. run "click @e2 --tab app")
    Ref/read commands accept --tab <handle|name|text> to target a specific tab.

  Other:
    browserforce screenshot [n]     Screenshot tab n (default: 0)
    browserforce navigate <url>     Open URL in a new tab (one-shot, no session)
    browserforce plugin list        List installed plugins
    browserforce plugin install <n> Install a plugin from the registry
    browserforce plugin remove <n>  Remove an installed plugin
    browserforce agent <subcmd>     Start/status/stop local BrowserForce Agent daemon
    browserforce session <subcmd>   Start/status/stop the CLI session daemon
    browserforce skills <subcmd>    list / get <name> [--full] / path [name]
    browserforce doctor [--fix]     Diagnose relay/extension/sidecars/backend
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
    browserforce open https://example.com --as docs
    browserforce tabs
    browserforce snapshot --tab docs
    browserforce click @e2
    browserforce run "fill @e3 'hello world' --tab docs"
    browserforce plugin list
    browserforce setup openclaw --dry-run --json
    browserforce -e "return await snapshot()"
    browserforce screenshot 0 > page.png

  Note: session commands share one persistent browser session (and snapshot
  refs) via the CLI session daemon — the same command language as the MCP
  browserforce tool. -e is one-shot (state does not persist between calls).
`);
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const commands = {
  serve: cmdServe, mcp: cmdMcp, status: cmdStatus,
  screenshot: cmdScreenshot, navigate: cmdNavigate,
  execute: cmdExecute, plugin: cmdPlugin, update: cmdUpdate,
  'install-extension': cmdInstallExtension, setup: cmdSetup, agent: cmdAgent,
  session: cmdSession, skills: cmdSkills, doctor: cmdDoctor,
  help: cmdHelp,
};
// Session-backed command verbs all share the registry path (direct and `run`).
for (const verb of REGISTRY_COMMAND_VERBS) commands[verb] = cmdBrowserforceCommand;

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
