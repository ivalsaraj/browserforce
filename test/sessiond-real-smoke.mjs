#!/usr/bin/env node
// Real-browser E2E smoke for the CLI atomic verbs (sessiond path).
//
// Exercises the DOCUMENTED flow against a real Chrome (every atomic verb):
//   session start --real → eval (create state.page) → get url/title → wait
//   → snapshot --sessiond → session status → fill @ref → click @ref
//   → verify mutation → type @ref → press → verify keys → get text → session stop
//
// Why this exists: the unit suite drives CLI→sessiond→runCode through FAKE
// browser objects, which cannot reproduce real-Chrome conditions — many open
// tabs, relay-discovered targets, lazy CDP attach, and Playwright CRSession
// behaviour (the `newCDPSession`/`_CRSession._onMessage` class of bugs). This
// smoke runs the verbs end-to-end so a regression in either (a) persistent
// `state.page` targeting or (b) the relay's CDP session handshake is caught.
//
// Requires: relay running + extension connected to a real Chrome.
// Self-SKIPS (exit 0) when no extension is connected, so it is safe to wire
// into any runner; it only FAILS on a genuine regression.
//
// Usage:
//   node test/sessiond-real-smoke.mjs
//   RELAY_PORT=19222 node test/sessiond-real-smoke.mjs

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const BIN = join(REPO_ROOT, 'bin.js');
const RELAY_PORT = parseInt(process.env.RELAY_PORT || '19222', 10);

// Isolated lock so this smoke never touches a developer's primary daemon.
const LOCK_PATH = join(tmpdir(), `bf-sessiond-smoke-${process.pid}.json`);

function httpJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: RELAY_PORT, path, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

// Spawn the CLI for one verb and return its parsed --json envelope.
function cli(args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [BIN, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, BF_SESSIOND_LOCK_PATH: LOCK_PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stderr.on('data', (c) => (err += c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      let json = null;
      const trimmed = out.trim();
      if (trimmed) { try { json = JSON.parse(trimmed); } catch { /* non-JSON output */ } }
      resolve({ code, json, stdout: out, stderr: err });
    });
    if (stdin !== undefined) { proc.stdin.write(stdin); }
    proc.stdin.end();
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// eval snippet that builds a deterministic controlled page and PINS it as
// state.page — the persistent active page every later verb must target.
const SETUP_EVAL = `
const page = await context.newPage();
await page.setContent('<title>BF Verb Test</title><h1>Ready</h1><label>Name <input id="name"></label><button id="go">Submit</button><div id="out"></div><div id="lastkey"></div>');
await page.evaluate(() => {
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').textContent = 'clicked:' + document.getElementById('name').value;
  });
  // Document-level keydown capture lets the press verb be verified regardless of focus.
  document.addEventListener('keydown', (e) => { document.getElementById('lastkey').textContent = e.key; });
});
state.page = page;
return { url: page.url(), title: await page.title(), h1: await page.locator('h1').textContent() };
`;

const VERIFY_EVAL = `
return { out: await state.page.locator('#out').textContent(), inputValue: await state.page.locator('#name').inputValue() };
`;

const KEY_VERIFY_EVAL = `
return { inputValue: await state.page.locator('#name').inputValue(), lastkey: await state.page.locator('#lastkey').textContent() };
`;

async function run() {
  // Preflight: is a real Chrome connected through the relay?
  let status;
  try {
    status = await httpJson('/extension/status');
  } catch (e) {
    console.log(`SKIP: relay not reachable on 127.0.0.1:${RELAY_PORT} (${e.message}).`);
    console.log('      Start it with `pnpm relay` and connect the extension to run this smoke.');
    return;
  }
  if (!status || !status.connected) {
    console.log('SKIP: extension is not connected to a real Chrome. Nothing to smoke-test.');
    return;
  }
  console.log(`Real Chrome connected (activeTargets=${status.activeTargets}). Running atomic-verb smoke...`);

  try {
    // Clean slate, then start the daemon bound to the REAL browser.
    await cli(['session', 'stop', '--json']);
    console.log('\n--- session start --real ---');
    const start = await cli(['session', 'start', '--real', '--json']);
    assert(start.code === 0, `session start exit ${start.code}: ${start.stderr}`);
    assert(start.json && start.json.running === true, `daemon not running: ${start.stdout}`);
    assert(start.json.backend === 'real', `expected real backend, got ${start.json?.backend}`);
    console.log(`daemon pid=${start.json.pid} port=${start.json.port} backend=${start.json.backend}`);

    // eval: create the controlled page and pin state.page.
    console.log('\n--- eval: create state.page ---');
    const setup = await cli(['eval', '--stdin', '--real', '--json'], { stdin: SETUP_EVAL });
    assert(setup.code === 0 && setup.json?.success, `eval setup failed: ${setup.stdout}${setup.stderr}`);
    assert(setup.json.data.title === 'BF Verb Test', `setup title: ${setup.json.data.title}`);
    assert(setup.json.data.h1 === 'Ready', `setup h1: ${setup.json.data.h1}`);
    console.log('state.page pinned:', JSON.stringify(setup.json.data));

    // get url/title MUST reflect the pinned page, not an arbitrary open tab.
    console.log('\n--- get url / get title (must target state.page) ---');
    const url = await cli(['get', 'url', '--real', '--json']);
    assert(url.json?.success && url.json.data.url === 'about:blank', `get url targeted wrong tab: ${url.stdout}`);
    const title = await cli(['get', 'title', '--real', '--json']);
    assert(title.json?.success && title.json.data.title === 'BF Verb Test', `get title targeted wrong tab: ${title.stdout}`);
    console.log('get url:', url.json.data.url, '| get title:', title.json.data.title);

    // wait for known text on the pinned page.
    console.log('\n--- wait --text Ready ---');
    const wait = await cli(['wait', '--text', 'Ready', '--real', '--json']);
    assert(wait.json?.success, `wait failed: ${wait.stdout}${wait.stderr}`);
    console.log('wait ok:', JSON.stringify(wait.json.data));

    // snapshot --sessiond: the verb that previously crashed real Chrome with a
    // `_CRSession._onMessage` assertion (socket hang up). Must return refs.
    console.log('\n--- snapshot --sessiond (regression guard) ---');
    const snap = await cli(['snapshot', '--sessiond', '--real', '--json']);
    assert(snap.code === 0 && snap.json?.success, `snapshot failed (CDP crash regression?): ${snap.stdout}${snap.stderr}`);
    const refs = snap.json.data.refs || [];
    assert(refs.length >= 2, `expected >=2 refs, got ${refs.length}: ${snap.stdout}`);
    const textbox = refs.find((r) => r.role === 'textbox');
    const button = refs.find((r) => r.role === 'button');
    assert(textbox && button, `expected textbox+button refs: ${JSON.stringify(refs)}`);
    console.log(`snapshot ok: ${refs.length} refs (textbox=${textbox.ref}, button=${button.ref})`);

    // session status reflects the live daemon + bound backend.
    console.log('\n--- session status ---');
    const status2 = await cli(['session', 'status', '--json']);
    assert(status2.json?.running === true, `session status not running: ${status2.stdout}`);
    assert(status2.json.backend === 'real', `session status backend: ${status2.json?.backend}`);
    console.log(`status ok: running=${status2.json.running} backend=${status2.json.backend}`);

    // fill + click via refs from the snapshot (the documented snapshot→act loop).
    console.log('\n--- fill @ref + click @ref ---');
    const fill = await cli(['fill', textbox.ref, 'Helixo', '--real', '--json']);
    assert(fill.json?.success, `fill failed: ${fill.stdout}${fill.stderr}`);
    const click = await cli(['click', button.ref, '--real', '--json']);
    assert(click.json?.success, `click failed: ${click.stdout}${click.stderr}`);
    console.log(`fill=${fill.json.data.filled} click=${click.json.data.clicked}`);

    // Verify the click handler actually fired against the SAME pinned page.
    console.log('\n--- verify click mutated the page ---');
    const verify = await cli(['eval', '--stdin', '--real', '--json'], { stdin: VERIFY_EVAL });
    assert(verify.json?.success, `verify eval failed: ${verify.stdout}${verify.stderr}`);
    assert(verify.json.data.inputValue === 'Helixo', `input not filled: ${verify.json.data.inputValue}`);
    assert(verify.json.data.out === 'clicked:Helixo', `click did not fire: ${verify.json.data.out}`);
    console.log('mutation verified:', JSON.stringify(verify.json.data));

    // type @ref appends keystrokes to the textbox; press sends a key to the page.
    console.log('\n--- type @ref + press ---');
    const type = await cli(['type', textbox.ref, '_typed', '--real', '--json']);
    assert(type.json?.success, `type failed: ${type.stdout}${type.stderr}`);
    const press = await cli(['press', 'Enter', '--real', '--json']);
    assert(press.json?.success, `press failed: ${press.stdout}${press.stderr}`);
    const keyVerify = await cli(['eval', '--stdin', '--real', '--json'], { stdin: KEY_VERIFY_EVAL });
    assert(keyVerify.json?.success, `key verify eval failed: ${keyVerify.stdout}${keyVerify.stderr}`);
    assert(keyVerify.json.data.inputValue.includes('_typed'), `type did not enter text: ${keyVerify.json.data.inputValue}`);
    assert(keyVerify.json.data.lastkey === 'Enter', `press Enter not captured: ${keyVerify.json.data.lastkey}`);
    console.log('type+press verified:', JSON.stringify(keyVerify.json.data));

    // get text @ref reads the button label.
    console.log('\n--- get text @ref ---');
    const text = await cli(['get', 'text', button.ref, '--real', '--json']);
    assert(text.json?.success && text.json.data.text === 'Submit', `get text failed: ${text.stdout}`);
    console.log('get text:', text.json.data.text);

    console.log('\n=== ALL SESSIOND REAL-BROWSER SMOKE TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await cli(['session', 'stop', '--json']).catch(() => {});
  }
}

run();
