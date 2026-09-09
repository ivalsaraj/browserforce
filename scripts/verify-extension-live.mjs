// Live end-to-end verification of the extension-side half against a REAL Chrome.
//
// Uses Chrome for Testing, not the branded build: Chrome 136+ gates
// --load-extension behind DisableLoadExtensionCommandLineSwitch and 152 drops it
// entirely, while CfT keeps it working — that is what CfT is for.
// Install with: npx -y @puppeteer/browsers install chrome@stable
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const EXT = new URL('../extension', import.meta.url).pathname;
const ROOT = new URL('..', import.meta.url).pathname;
// Resolved, never a pinned developer-local path: the documented install writes
// a version-stamped directory, so a hardcoded one only works on the machine
// that produced it.
function resolveChrome() {
  if (process.env.BF_VERIFY_CHROME) return process.env.BF_VERIFY_CHROME;
  // Plain traversal, not fs.globSync: that landed in Node 22 and package.json
  // declares engines >= 18.3.0.
  const leaves = [
    ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome'], // linux
  ];
  for (const root of [join(process.cwd(), 'chrome'), '/private/tmp/chrome', join(tmpdir(), 'chrome')]) {
    let builds;
    try { builds = readdirSync(root).sort().reverse(); } catch { continue; }
    for (const build of builds) {
      let platforms;
      try { platforms = readdirSync(join(root, build)); } catch { continue; }
      for (const platform of platforms) {
        for (const leaf of leaves) {
          const candidate = join(root, build, platform, ...leaf);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  throw new Error('Chrome for Testing not found. Install it with '
    + '`npx -y @puppeteer/browsers install chrome@stable`, then set BF_VERIFY_CHROME to the binary it prints.');
}
const CHROME = resolveChrome();
const RELAY = 'http://127.0.0.1:19222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Non-2xx must THROW, never parse: the ownership check treats a thrown error as
// "unknown" and fails closed, but a parsed error body carrying connected:false
// would read as "slot free" and launch Chrome under unknown ownership.
async function getJson(path) {
  const response = await fetch(`${RELAY}${path}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`);
  return response.json();
}
const status = () => getJson('/extension/status');
const list = () => getJson('/json/list');

let ctx;
let failed = false;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) failed = true; };

try {
  // The relay has a SINGLE extension slot. If one is already connected, the
  // extension this harness launches gets a 409 and every assertion below would
  // silently describe the OTHER browser — verifying the wrong thing, which is
  // worse than not verifying at all.
  // Fail CLOSED: only an explicit `connected: false` from a well-formed status
  // means the slot is free. A failed fetch or a malformed body means ownership
  // is unknown, and starting then risks describing another browser entirely.
  const slot = await status().catch(() => null);
  if (!slot || typeof slot !== 'object' || slot.connected !== false) {
    throw new Error('cannot confirm the relay extension slot is free '
      + `(status: ${JSON.stringify(slot)}) — the relay has a single slot, so starting now risks `
      + 'verifying a different browser. Disconnect the other extension, or point at an isolated relay.');
  }
  ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'bf-verify-')), {
    executablePath: CHROME,
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });

  // MV3 service workers start lazily: give the extension an event to wake on.
  // Per-run sentinel. The slot check above is TOCTOU and "an extension is
  // connected" cannot tell WHICH one, so identity is proved from the data: this
  // exact title must appear in /json/list, or we are inspecting another browser.
  const sentinel = `bf-verify-${randomUUID()}`;
  const warmup = await ctx.newPage();
  await warmup.goto(`data:text/html,<title>${sentinel}</title>`);
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

  // Identity proof, BEFORE any other assertion: without it every check below
  // could be describing a browser this harness did not launch.
  let targets = await list();
  check(targets.some((t) => t.title === sentinel),
    'the relay is serving the browser this harness launched (per-run sentinel)');
  if (!targets.some((t) => t.title === sentinel)) {
    throw new Error('sentinel tab absent from /json/list — another extension owns the relay slot');
  }

  // 1. Titles come from the relay for EVERY tab — the (untitled) fix.
  targets = await list();
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
  // Release the slot first: under BF_CLIENT_MODE=single-active a second /cdp
  // client is refused with 409 indefinitely, so the repro could never run.
  await agent.close();
  await sleep(500);
  let reproOut = '';
  try {
    const { stdout } = await exec('node', ['scripts/repro-tab-handles.mjs'], { cwd: ROOT });
    reproOut = stdout;
  } catch (err) {
    reproOut = `${err.stdout || ''}${err.stderr || ''}`;
    failed = true;
  }
  console.log(reproOut.trim().split('\n').map((l) => `  ${l}`).join('\n'));
  // The repro exits 0 on SKIP. A SKIP is not a pass — treating a zero exit as
  // success would report ALL PASSED having verified nothing.
  check(!/\bSKIP\b/.test(reproOut) && /titled=/.test(reproOut),
    'the reconnect proof actually ran (not skipped)');
  check(!failed, 'handles and titles survive the idle reconnect');
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  failed = true;
} finally {
  try { await ctx?.close(); } catch { /* already gone */ }
}
console.log(failed ? 'RESULT: FAILED' : 'RESULT: ALL PASSED');
process.exit(failed ? 1 : 0);
