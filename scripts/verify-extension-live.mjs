// Live end-to-end verification of the extension-side half against a REAL Chrome.
//
// Uses Chrome for Testing, not the branded build: Chrome 136+ gates
// --load-extension behind DisableLoadExtensionCommandLineSwitch and 152 drops it
// entirely, while CfT keeps it working — that is what CfT is for.
// Install with: npx -y @puppeteer/browsers install chrome@stable
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const EXT = new URL('../extension', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
const CHROME = process.env.BF_VERIFY_CHROME
  || '/private/tmp/chrome/mac_arm-153.0.8010.36/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const RELAY = 'http://127.0.0.1:19222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await fetch(`${RELAY}/extension/status`)).json();
const list = async () => (await fetch(`${RELAY}/json/list`)).json();

let ctx;
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failed = true; };

try {
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bf-verify-')), {
    executablePath: CHROME,
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  // MV3 service workers start lazily: give the extension an event to wake on.
  const warmup = await ctx.newPage();
  await warmup.goto('data:text/html,<title>warmup</title>');
  let connected = false;
  for (let i = 0; i < 60; i += 1) {
    if ((await status().catch(() => ({}))).connected) { connected = true; break; }
    await sleep(1000);
  }
  check(connected, 'the extension connects to the relay');
  if (!connected) throw new Error('extension never connected');

  // Tabs first, while NO CDP client exists: that is the lazily-attached state
  // the title fix is about.
  const pages = [warmup];
  for (const t of ['Alpha', 'Beta', 'Gamma']) {
    const p = await ctx.newPage();
    await p.goto(`data:text/html,<title>${t} Page</title><h1>${t}</h1>`);
    pages.push(p);
  }
  await sleep(2000);
  const lazy = await status();
  console.log(`  before any CDP client: attachedTabs=${lazy.attachedTabs.length} clients=${lazy.clients}`);
  check(lazy.attachedTabs.length === 0, 'no tab is attached while no agent is connected (lazy attach)');

  // The relay populates `targets` only once a client sends Target.setAutoAttach
  // (measured on a healthy 72-tab browser: activeTargets 0, attachedTabs []),
  // so /json/list is empty until an agent connects. Attach one and keep it.
  const cdpUrl = readFileSync(join(homedir(), '.browserforce', 'cdp-url'), 'utf8').trim();
  const agent = await chromium.connectOverCDP(cdpUrl);
  await sleep(2500);

  // 1. Titles come from the relay for EVERY tab — the (untitled) fix.
  let targets = await list();
  console.log(`  /json/list -> ${targets.length} targets, ${targets.filter((t) => t.title).length} titled`);
  check(targets.length >= 4, `every tab is listed (${targets.length})`);
  check(targets.filter((t) => t.title).length === targets.length, 'every listed tab has a real title');
  check(targets.some((t) => t.title === 'Alpha Page'), 'titles are the real page titles');

  // 2. Navigating an UNATTACHED tab refreshes the cache — the onTabUpdated fix.
  await pages[2].goto('data:text/html,<title>Beta Renamed</title><h1>beta2</h1>');
  await sleep(2000);
  targets = await list();
  check(targets.some((t) => t.title === 'Beta Renamed'), 'navigating an unattached tab refreshes the relay cache');
  check(!targets.some((t) => t.title === 'Beta Page'), 'and the stale title is gone');

  // 3. Closing an UNATTACHED tab is reported — the onTabRemoved fix.
  const before = (await list()).length;
  await pages[3].close();
  await sleep(2000);
  targets = await list();
  check(targets.length === before - 1, `closing an unattached tab is reported (${before} -> ${targets.length})`);
  check(!targets.some((t) => t.title === 'Gamma Page'), 'and its target is gone from /json/list');

  // 4. Synthetic target ids are unique — the Codex R1 fix.
  const ids = (await list()).map((t) => t.id);
  check(new Set(ids).size === ids.length, `target ids are unique (${ids.join(', ')})`);

  // 5. THE defect this whole arc exists for: handles and titles survive the
  //    browser idle disconnect. Run the repro harness against this live session.
  console.log('=== handle durability across the idle reconnect ===');
  try {
    const { stdout } = await exec('node', ['scripts/repro-tab-handles.mjs'], { cwd: ROOT });
    console.log(stdout.trim().split('\n').map((l) => `  ${l}`).join('\n'));
    check(true, 'handles and titles survive the idle reconnect');
  } catch (err) {
    console.log((err.stdout || '').trim().split('\n').map((l) => `  ${l}`).join('\n'));
    console.log((err.stderr || '').trim().slice(0, 400));
    check(false, 'handles and titles survive the idle reconnect');
  }
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  failed = true;
} finally {
  try { await ctx?.close(); } catch { /* already gone */ }
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
