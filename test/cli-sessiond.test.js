// test/cli-sessiond.test.js — BrowserForce CLI session daemon (sessiond)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeRef, writeSessiondLock } from '../cli/session-client.js';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SESSIOND = join(ROOT, 'cli', 'sessiond.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpFetch(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

function tmpLockPath() {
  return join(tmpdir(), `bf-sessiond-${Math.random().toString(36).slice(2)}.json`);
}

async function readLockFile(lockPath) {
  try { return JSON.parse(await fs.readFile(lockPath, 'utf8')); }
  catch { return null; }
}

async function waitForLock(lockPath, attempts = 50, delayMs = 100) {
  for (let i = 0; i < attempts; i += 1) {
    const lock = await readLockFile(lockPath);
    if (lock && lock.pid && lock.port && lock.token) return lock;
    await sleep(delayMs);
  }
  return null;
}

describe('CLI session daemon', () => {
  it('session status reports not running when no lock exists', async () => {
    const lockPath = tmpLockPath();
    const { stdout } = await exec('node', ['bin.js', 'session', 'status', '--json'], {
      cwd: ROOT,
      env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath },
    });

    const data = JSON.parse(stdout);
    assert.equal(data.running, false);
  });

  describe('with a directly-spawned sessiond', () => {
    let child;
    let lockPath;
    let lock;
    let base;

    before(async () => {
      lockPath = tmpLockPath();
      // Force the managed backend so startup negotiation is hermetic (no
      // dependency on a live relay/extension and no real Chrome launch — the
      // managed connect stays lazy until a command runs).
      child = spawn('node', [SESSIOND], {
        cwd: ROOT,
        env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_BROWSER_BACKEND: 'managed' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should write a lock once listening');
      base = `http://127.0.0.1:${lock.port}`;
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { await fs.unlink(lockPath); } catch { /* already gone */ }
    });

    it('sessiond rejects a command with no/incorrect bearer token (401), accepts the valid token', async () => {
      const noTok = await httpFetch('GET', `${base}/status`, null, '');
      const badTok = await httpFetch('GET', `${base}/status`, null, 'wrong-token');
      // A token longer than the real one (timingSafeEqual must not throw on
      // unequal length — the constant-time compare hashes both sides first).
      const longTok = await httpFetch('GET', `${base}/status`, null, `${lock.token}-extra-suffix`);
      const okTok = await httpFetch('GET', `${base}/status`, null, lock.token);
      assert.equal(noTok.status, 401);
      assert.equal(badTok.status, 401);
      assert.equal(longTok.status, 401);
      assert.equal(okTok.status, 200);
    });

    it('rejects a malformed (non-Bearer) Authorization header (401)', async () => {
      const malformed = await new Promise((resolve, reject) => {
        const u = new URL(`${base}/status`);
        const req = http.request({
          hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET',
          headers: { Authorization: `Basic ${lock.token}` },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end();
      });
      assert.equal(malformed, 401);
    });

    it('sessiond binds 127.0.0.1 only and writes the lock sidecar 0o600', async () => {
      const mode = (await fs.stat(lockPath)).mode & 0o777;
      assert.equal(mode, 0o600);
      // Liveness is reachable on 127.0.0.1 without a token.
      const health = await httpFetch('GET', `${base}/health`, null, '');
      assert.equal(health.status, 200);
      assert.equal(health.body.ok, true);
    });

    it('lock sidecar carries a version field for stale-restart detection', async () => {
      assert.ok(Object.prototype.hasOwnProperty.call(lock, 'version'), 'lock should include a version field');
    });

    it('session status reports running with pid/port when the daemon is up', async () => {
      const { stdout } = await exec('node', ['bin.js', 'session', 'status', '--json'], {
        cwd: ROOT,
        env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath },
      });
      const data = JSON.parse(stdout);
      assert.equal(data.running, true);
      assert.equal(data.pid, lock.pid);
      assert.equal(data.port, lock.port);
    });
  });

  describe('session start/stop lifecycle (via bin.js)', () => {
    let lockPath;

    before(() => { lockPath = tmpLockPath(); });

    after(async () => {
      const lock = await readLockFile(lockPath);
      if (lock?.pid) { try { process.kill(lock.pid, 'SIGKILL'); } catch { /* gone */ } }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
    });

    it('starts the daemon, reports it running, then stops it', async () => {
      const startEnv = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_BROWSER_BACKEND: 'managed' };

      const start = await exec('node', ['bin.js', 'session', 'start', '--json'], { cwd: ROOT, env: startEnv });
      const startData = JSON.parse(start.stdout);
      assert.equal(startData.running, true);
      assert.ok(Number.isInteger(startData.port), 'start should report the bound port');

      const status = await exec('node', ['bin.js', 'session', 'status', '--json'], { cwd: ROOT, env: startEnv });
      assert.equal(JSON.parse(status.stdout).running, true);

      const stop = await exec('node', ['bin.js', 'session', 'stop', '--json'], { cwd: ROOT, env: startEnv });
      assert.equal(JSON.parse(stop.stdout).stopped, true);

      // After stop, status reports not running.
      const statusAfter = await exec('node', ['bin.js', 'session', 'status', '--json'], { cwd: ROOT, env: startEnv });
      assert.equal(JSON.parse(statusAfter.stdout).running, false);
    });
  });

  describe('backend negotiation (/status)', () => {
    const spawned = [];

    function spawnSessiond(extraEnv) {
      const lockPath = tmpLockPath();
      const child = spawn('node', [SESSIOND], {
        cwd: ROOT,
        env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, ...extraEnv },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      const rec = { child, lockPath, getStderr: () => stderr };
      spawned.push(rec);
      return rec;
    }

    // A localhost port with nothing listening (acquire-then-release).
    async function getDeadPort() {
      const srv = http.createServer();
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      await new Promise((r) => srv.close(r));
      return port;
    }

    async function statusOf(lock) {
      return httpFetch('GET', `http://127.0.0.1:${lock.port}/status`, null, lock.token);
    }

    after(async () => {
      for (const { child, lockPath } of spawned) {
        try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
        try { await fs.unlink(lockPath); } catch { /* gone */ }
        try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
      }
    });

    it('explicit managed backend reports backend "managed" with no warning (no bridge needed)', async () => {
      const { lockPath } = spawnSessiond({ BF_BROWSER_BACKEND: 'managed' });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'managed sessiond should start without a relay/extension');
      const res = await statusOf(lock);
      assert.equal(res.status, 200);
      assert.equal(res.body.backend, 'managed');
      assert.equal(res.body.requestedBackend, 'managed');
      assert.equal(res.body.fallbackReason, null);
      assert.equal(res.body.warning, null);
    });

    it('explicit headless backend reports backend "headless"', async () => {
      const { lockPath } = spawnSessiond({ BF_BROWSER_BACKEND: 'headless' });
      const lock = await waitForLock(lockPath);
      assert.ok(lock);
      const res = await statusOf(lock);
      assert.equal(res.body.backend, 'headless');
      assert.equal(res.body.requestedBackend, 'headless');
      assert.equal(res.body.fallbackReason, null);
    });

    it('auto falls back to managed (with a warning) when the real bridge is unavailable', async () => {
      const deadPort = await getDeadPort();
      const { lockPath } = spawnSessiond({
        BF_BROWSER_BACKEND: 'auto',
        BF_CDP_URL: `ws://127.0.0.1:${deadPort}/cdp?token=x`,
      });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'auto should still start by falling back to managed');
      const res = await statusOf(lock);
      assert.equal(res.body.backend, 'managed');
      assert.equal(res.body.requestedBackend, 'auto');
      assert.equal(res.body.fallbackReason, 'real-chrome-bridge-unavailable');
      assert.ok(typeof res.body.warning === 'string' && res.body.warning.length > 0, 'managed fallback must warn');
    });

    it('auto selects "real" when the bridge reports the extension connected', async () => {
      const fake = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/extension/status')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ connected: true, activeTargets: 1 }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      await new Promise((r) => fake.listen(0, '127.0.0.1', r));
      const fakePort = fake.address().port;
      try {
        const { lockPath } = spawnSessiond({
          BF_BROWSER_BACKEND: 'auto',
          BF_CDP_URL: `ws://127.0.0.1:${fakePort}/cdp?token=x`,
        });
        const lock = await waitForLock(lockPath);
        assert.ok(lock);
        const res = await statusOf(lock);
        assert.equal(res.body.backend, 'real');
        assert.equal(res.body.requestedBackend, 'auto');
        assert.equal(res.body.fallbackReason, null);
        assert.equal(res.body.warning, null);
      } finally {
        await new Promise((r) => fake.close(r));
      }
    });

    it('explicit real backend fails loud (non-zero exit, no lock) when the bridge is unavailable', async () => {
      const deadPort = await getDeadPort();
      const { child, lockPath } = spawnSessiond({
        BF_BROWSER_BACKEND: 'real',
        BF_CDP_URL: `ws://127.0.0.1:${deadPort}/cdp?token=x`,
      });
      const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
      assert.notEqual(code, 0, 'real backend without a bridge must exit non-zero');
      const lock = await readLockFile(lockPath);
      assert.equal(lock, null, 'no lock should be written when negotiation fails');
    });
  });

  describe('atomic snapshot verb (real CLI path → sessiond → runCode → snapshotData)', () => {
    const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
    let child;
    let lockPath;
    let env;

    before(async () => {
      lockPath = tmpLockPath();
      // Managed backend (no relay probe) + a fake browser injected BELOW
      // buildExecContext, so the snapshot engine and runCode() boundary run for
      // real without a Chrome/relay. The same env is reused by the CLI so it
      // resolves THIS daemon's lock.
      env = {
        ...process.env,
        BF_SESSIOND_LOCK_PATH: lockPath,
        BF_BROWSER_BACKEND: 'managed',
        BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      };
      child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should start with the fake browser backend');
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
    });

    it('browserforce snapshot --sessiond --json returns the structured envelope', async () => {
      const { stdout } = await exec('node', ['bin.js', 'snapshot', '--sessiond', '--json'], { cwd: ROOT, env });
      const resp = JSON.parse(stdout);
      assert.equal(resp.success, true);
      assert.equal(resp.error, null);
      assert.ok(resp.data, 'envelope carries data');
      assert.equal(resp.data.url, 'https://fake.test/');
      assert.equal(resp.data.title, 'Fake');
      assert.match(resp.data.tree, /button "Submit" \[ref=e1\]/, 'tree keeps the [ref=eN] contract');
      assert.ok(Array.isArray(resp.data.refs) && resp.data.refs.length === 1);
      assert.deepEqual(resp.data.refs[0], {
        ref: 'e1',
        role: 'button',
        name: 'Submit',
        locator: '[data-testid="submit"]',
        frameChain: [],
      });
      assert.deepEqual(resp.data.frameErrors, []);
    });
  });

  describe('atomic interaction verbs (real CLI path → sessiond → runCode → locatorForRef)', () => {
    const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
    let child;
    let lockPath;
    let eventsPath;
    let env;

    const readEvents = async () => {
      try {
        const raw = await fs.readFile(eventsPath, 'utf8');
        return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch { return []; }
    };

    before(async () => {
      lockPath = tmpLockPath();
      eventsPath = join(tmpdir(), `bf-fake-events-${Math.random().toString(36).slice(2)}.jsonl`);
      env = {
        ...process.env,
        BF_SESSIOND_LOCK_PATH: lockPath,
        BF_BROWSER_BACKEND: 'managed',
        BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
        BF_SESSIOND_FAKE_EVENTS: eventsPath,
      };
      child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should start with the fake browser backend');
      // Prime refs: snapshot stores e1 in the daemon's persistent session.
      await exec('node', ['bin.js', 'snapshot', '--sessiond', '--json'], { cwd: ROOT, env });
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
      try { await fs.unlink(eventsPath); } catch { /* gone */ }
    });

    it('click resolves the SAME stored ref via @e1, e1, and ref=e1 aliases', async () => {
      for (const alias of ['@e1', 'e1', 'ref=e1']) {
        const { stdout } = await exec('node', ['bin.js', 'click', alias, '--json'], { cwd: ROOT, env });
        const resp = JSON.parse(stdout);
        assert.equal(resp.success, true, `click ${alias} succeeds`);
        assert.equal(resp.data.clicked, 'e1', `click ${alias} normalizes to e1`);
      }
      const clicks = (await readEvents()).filter((e) => e.action === 'click');
      assert.equal(clicks.length, 3, 'the fake locator recorded three click() calls');
      for (const c of clicks) {
        assert.equal(c.selector, '[data-testid="submit"]', 'stored ref resolved to the CDP-built locator');
      }
    });

    it('fill and type write through the stored ref; press sends a key', async () => {
      const fillRes = JSON.parse((await exec('node', ['bin.js', 'fill', '@e1', 'hello', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(fillRes.success, true);
      assert.equal(fillRes.data.filled, 'e1');

      const typeRes = JSON.parse((await exec('node', ['bin.js', 'type', '@e1', 'world', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(typeRes.success, true);
      assert.equal(typeRes.data.typed, 'e1');

      const pressRes = JSON.parse((await exec('node', ['bin.js', 'press', 'Enter', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(pressRes.success, true);
      assert.equal(pressRes.data.pressed, 'Enter');

      const events = await readEvents();
      const fill = events.find((e) => e.action === 'fill');
      assert.ok(fill && fill.value === 'hello' && fill.selector === '[data-testid="submit"]', 'fill recorded with text + selector');
      const type = events.find((e) => e.action === 'type');
      assert.ok(type && type.value === 'world', 'type recorded with text');
      const keypress = events.find((e) => e.action === 'keypress');
      assert.ok(keypress && keypress.key === 'Enter', 'keyboard press recorded');
    });

    it('click on an unknown ref returns a helpful error (success:false)', async () => {
      let out;
      try {
        out = (await exec('node', ['bin.js', 'click', '@e999', '--json'], { cwd: ROOT, env })).stdout;
      } catch (err) {
        out = err.stdout; // CLI exits non-zero on failure
      }
      const resp = JSON.parse(out);
      assert.equal(resp.success, false);
      assert.match(resp.error, /Unknown ref/);
    });
  });

  describe('sessiond endpoint compatibility (registry-backed /command/* envelope contract)', () => {
    const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
    let child;
    let lockPath;
    let lock;
    let base;

    const post = (path, body) => httpFetch('POST', `${base}${path}`, body, lock.token);

    const assertEnvelopeShape = (body) => {
      assert.deepEqual(
        Object.keys(body).sort(),
        ['data', 'error', 'success', 'warning'],
        'envelope keeps the exact { success, data, error, warning } contract',
      );
    };

    before(async () => {
      lockPath = tmpLockPath();
      child = spawn('node', [SESSIOND], {
        cwd: ROOT,
        env: {
          ...process.env,
          BF_SESSIOND_LOCK_PATH: lockPath,
          BF_BROWSER_BACKEND: 'managed',
          BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should start with the fake browser backend');
      base = `http://127.0.0.1:${lock.port}`;
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
    });

    it('POST /command/snapshot keeps the envelope contract', async () => {
      const { status, body } = await post('/command/snapshot', {});
      assert.equal(status, 200);
      assertEnvelopeShape(body);
      assert.equal(body.success, true);
      assert.equal(body.error, null);
      assert.equal(body.data.url, 'https://fake.test/');
      assert.ok(Array.isArray(body.data.refs));
    });

    it('POST /command/click keeps the envelope contract', async () => {
      const { status, body } = await post('/command/click', { ref: '@e1' });
      assert.equal(status, 200);
      assertEnvelopeShape(body);
      assert.equal(body.success, true);
      assert.equal(body.data.clicked, 'e1');
    });

    it('POST /command/fill keeps the envelope contract', async () => {
      const { status, body } = await post('/command/fill', { ref: '@e1', text: 'hello' });
      assert.equal(status, 200);
      assertEnvelopeShape(body);
      assert.equal(body.success, true);
      assert.equal(body.data.filled, 'e1');
    });

    it('POST /command/hover and get html reach the new registry commands', async () => {
      const hover = await post('/command/hover', { ref: '@e1' });
      assert.equal(hover.status, 200);
      assert.equal(hover.body.success, true);
      assert.equal(hover.body.data.hovered, 'e1');

      const html = await post('/command/get', { what: 'html', ref: '@e1' });
      assert.equal(html.status, 200);
      assert.equal(html.body.success, true);
      assert.equal(html.body.data.html, '<span>Submit</span>');
    });

    it('command failures stay HTTP 200 with success:false (envelope, not status)', async () => {
      const unknownRef = await post('/command/click', { ref: '@e404' });
      assert.equal(unknownRef.status, 200);
      assertEnvelopeShape(unknownRef.body);
      assert.equal(unknownRef.body.success, false);
      assert.match(unknownRef.body.error, /Unknown ref/);

      const badPress = await post('/command/press', {});
      assert.equal(badPress.status, 200);
      assert.equal(badPress.body.success, false);
      assert.match(badPress.body.error, /press requires a key/);
    });

    it('unknown verbs still return HTTP 501', async () => {
      const { status, body } = await post('/command/bogus', {});
      assert.equal(status, 501);
      assert.equal(body.success, false);
      assert.match(body.error, /command not implemented: bogus/);
    });
  });

  describe('wait/get/eval verbs (real CLI path → sessiond → runCode)', () => {
    const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
    let child;
    let lockPath;
    let env;

    // eval --stdin needs piped stdin, which execFile can't supply.
    function evalViaStdin(input, args = ['eval', '--stdin', '--json']) {
      return new Promise((resolve, reject) => {
        const proc = spawn('node', ['bin.js', ...args], { cwd: ROOT, env });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d; });
        proc.stderr.on('data', (d) => { stderr += d; });
        proc.on('error', reject);
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
        proc.stdin.end(input);
      });
    }

    before(async () => {
      lockPath = tmpLockPath();
      env = {
        ...process.env,
        BF_SESSIOND_LOCK_PATH: lockPath,
        BF_BROWSER_BACKEND: 'managed',
        BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      };
      child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should start with the fake browser backend');
      await exec('node', ['bin.js', 'snapshot', '--sessiond', '--json'], { cwd: ROOT, env });
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
    });

    it('wait --text / --url / --load resolve through the session', async () => {
      const textRes = JSON.parse((await exec('node', ['bin.js', 'wait', '--text', 'saved', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(textRes.success, true);
      assert.equal(textRes.data.waited, 'text');
      assert.equal(textRes.data.text, 'saved');

      const urlRes = JSON.parse((await exec('node', ['bin.js', 'wait', '--url', '**/dashboard', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(urlRes.success, true);
      assert.equal(urlRes.data.waited, 'url');

      const loadRes = JSON.parse((await exec('node', ['bin.js', 'wait', '--load', 'domcontentloaded', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(loadRes.success, true);
      assert.equal(loadRes.data.waited, 'load');
      assert.equal(loadRes.data.state, 'domcontentloaded');
    });

    it('get url / title / text @ref read from the session', async () => {
      const urlRes = JSON.parse((await exec('node', ['bin.js', 'get', 'url', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(urlRes.data.url, 'https://fake.test/');

      const titleRes = JSON.parse((await exec('node', ['bin.js', 'get', 'title', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(titleRes.data.title, 'Fake');

      const textRes = JSON.parse((await exec('node', ['bin.js', 'get', 'text', '@e1', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(textRes.success, true);
      assert.equal(textRes.data.text, 'Submit');
    });

    it('eval --stdin runs piped code through the guarded runCode boundary and round-trips a value', async () => {
      const { stdout, code } = await evalViaStdin('return 6 * 7;');
      assert.equal(code, 0);
      const resp = JSON.parse(stdout);
      assert.equal(resp.success, true);
      assert.equal(resp.data, 42);
    });

    it('eval --stdin shares persistent session state across calls', async () => {
      const first = JSON.parse((await evalViaStdin('state.counter = (state.counter || 0) + 1; return state.counter;')).stdout);
      const second = JSON.parse((await evalViaStdin('state.counter = (state.counter || 0) + 1; return state.counter;')).stdout);
      assert.equal(first.data, 1, 'first eval initializes shared state');
      assert.equal(second.data, 2, 'second eval sees state persisted by the daemon session');
    });
  });

  describe('direct verbs + run "<command>" share the registry parser (Task 9)', () => {
    const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
    let child;
    let lockPath;
    let env;

    // exec() rejects on non-zero exit; capture the failure instead.
    async function execFail(args) {
      try {
        const { stdout, stderr } = await exec('node', ['bin.js', ...args], { cwd: ROOT, env });
        return { code: 0, stdout, stderr };
      } catch (err) {
        return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
      }
    }

    before(async () => {
      lockPath = tmpLockPath();
      env = {
        ...process.env,
        BF_SESSIOND_LOCK_PATH: lockPath,
        BF_BROWSER_BACKEND: 'managed',
        BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      };
      child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should start with the fake browser backend');
      // Prime refs so ref commands resolve e1.
      await exec('node', ['bin.js', 'snapshot', '--json'], { cwd: ROOT, env });
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
    });

    it('run "tabs" reaches the registry and matches the direct verb output exactly', async () => {
      const direct = (await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env })).stdout;
      const viaRun = (await exec('node', ['bin.js', 'run', 'tabs', '--json'], { cwd: ROOT, env })).stdout;
      assert.equal(viaRun, direct, 'run and direct verbs share output formatting');

      const rows = JSON.parse(direct);
      assert.ok(Array.isArray(rows), 'tabs --json keeps the pre-registry top-level array shape');
      const row = rows[0];
      // Superset contract: old fields kept, registry fields added.
      assert.equal(row.index, 0);
      assert.equal(row.title, 'Fake');
      assert.equal(row.url, 'https://fake.test/');
      assert.equal(row.handle, 't1');
      assert.equal(row.active, true);
      assert.equal(row.name, null);
    });

    it('human tabs output shows the stable handle + active marker on both paths', async () => {
      const direct = (await exec('node', ['bin.js', 'tabs'], { cwd: ROOT, env })).stdout;
      const viaRun = (await exec('node', ['bin.js', 'run', 'tabs'], { cwd: ROOT, env })).stdout;
      assert.equal(viaRun, direct);
      assert.match(direct, /\* t1 Fake/);
    });

    it('run "click @e1" executes through the daemon session', async () => {
      const resp = JSON.parse((await exec('node', ['bin.js', 'run', 'click @e1', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(resp.success, true);
      assert.equal(resp.data.clicked, 'e1');
    });

    it('new registry verbs are reachable directly: hover, get html, use', async () => {
      const hover = JSON.parse((await exec('node', ['bin.js', 'hover', '@e1', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(hover.success, true);
      assert.equal(hover.data.hovered, 'e1');

      const html = JSON.parse((await exec('node', ['bin.js', 'get', 'html', '@e1', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(html.success, true);
      assert.equal(html.data.html, '<span>Submit</span>');

      const use = JSON.parse((await exec('node', ['bin.js', 'use', 't1', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(use.success, true);
      assert.equal(use.data.active.handle, 't1');
    });

    it('eval accepts positional code (not just --stdin)', async () => {
      const resp = JSON.parse((await exec('node', ['bin.js', 'eval', 'return 6 * 7;', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(resp.success, true);
      assert.equal(resp.data, 42);
    });

    it('wait accepts the positional kind form alongside the legacy flag form', async () => {
      const positional = JSON.parse((await exec('node', ['bin.js', 'wait', 'text', 'saved', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(positional.success, true);
      assert.equal(positional.data.waited, 'text');
      assert.equal(positional.data.text, 'saved');
    });

    it('unknown flags fail loudly on BOTH paths (exit non-zero, no silent swallow)', async () => {
      const direct = await execFail(['click', '@e1', '--bogus', '--json']);
      assert.notEqual(direct.code, 0, 'direct verb exits non-zero');
      const directResp = JSON.parse(direct.stdout);
      assert.equal(directResp.success, false);
      assert.match(directResp.error, /Unknown flag --bogus/);

      const viaRun = await execFail(['run', 'click @e1 --bogus', '--json']);
      assert.notEqual(viaRun.code, 0, 'run path exits non-zero');
      const runResp = JSON.parse(viaRun.stdout);
      assert.equal(runResp.success, false);
      assert.match(runResp.error, /Unknown flag --bogus/);
    });

    it('missing flag values fail loudly on BOTH paths', async () => {
      const direct = await execFail(['snapshot', '--tab']);
      assert.notEqual(direct.code, 0);
      assert.match(direct.stderr, /Flag --tab requires a value/);

      const viaRun = await execFail(['run', 'snapshot --tab']);
      assert.notEqual(viaRun.code, 0);
      assert.match(viaRun.stderr, /Flag --tab requires a value/);
    });

    it('global CLI flags are never forwarded to the registry parser', async () => {
      // --timeout (value flag) and --json/--sessiond (booleans) are bin.js-owned:
      // the registry would reject them as unknown flags if they leaked through.
      const resp = JSON.parse(
        (await exec('node', ['bin.js', 'get', 'url', '--timeout', '5000', '--sessiond', '--json'], { cwd: ROOT, env })).stdout
      );
      assert.equal(resp.success, true);
      assert.equal(resp.data.url, 'https://fake.test/');
    });

    it('quoted multi-word text survives the direct-verb rebuild (fill)', async () => {
      const resp = JSON.parse(
        (await exec('node', ['bin.js', 'fill', '@e1', 'hello "quoted" world', '--json'], { cwd: ROOT, env })).stdout
      );
      assert.equal(resp.success, true);
      assert.equal(resp.data.filled, 'e1');
    });

    it('run requires exactly one command-string argument', async () => {
      const missing = await execFail(['run']);
      assert.notEqual(missing.code, 0);
      assert.match(missing.stderr, /Usage: browserforce run/);

      const extra = await execFail(['run', 'tabs', 'extra']);
      assert.notEqual(extra.code, 0);
      assert.match(extra.stderr, /Usage: browserforce run/);
    });

    it('run "help" prints the command help without needing the daemon', async () => {
      const { stdout } = await exec('node', ['bin.js', 'run', 'help'], { cwd: ROOT, env });
      assert.match(stdout, /BrowserForce commands:/);
      assert.match(stdout, /click <ref> \[--tab name\]/);
    });

    it('snapshot rejects the old positional tab index with a teaching error', async () => {
      const res = await execFail(['snapshot', '1', '--json']);
      assert.notEqual(res.code, 0);
      const resp = JSON.parse(res.stdout);
      assert.match(resp.error, /snapshot takes no positional arguments/);
      assert.match(resp.error, /--tab/);
    });
  });

  // ─── Stress: many named tabs + parallel --tab reads over the real wire ─────
  // (Task 12) One daemon, many tabs opened via the CLI, then concurrent CLI
  // processes reading different named tabs. Proves handles/names stay stable
  // and per-run pinning holds across separate CLI invocations.
  describe('stress: CLI many named tabs + parallel --tab reads (Task 12)', () => {
    const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
    const TAB_COUNT = 12;
    let child;
    let lockPath;
    let env;

    async function execFail(args) {
      try {
        const { stdout, stderr } = await exec('node', ['bin.js', ...args], { cwd: ROOT, env });
        return { code: 0, stdout, stderr };
      } catch (err) {
        return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
      }
    }

    before(async () => {
      lockPath = tmpLockPath();
      env = {
        ...process.env,
        BF_SESSIOND_LOCK_PATH: lockPath,
        BF_BROWSER_BACKEND: 'managed',
        BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      };
      child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, 'sessiond should start with the fake browser backend');
      // Open TAB_COUNT named tabs through the real CLI `open` path.
      for (let i = 0; i < TAB_COUNT; i += 1) {
        await exec('node', ['bin.js', 'open', `https://job-${i}.test/`, '--as', `job-${i}`, '--json'], { cwd: ROOT, env });
      }
    });

    after(async () => {
      try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
    });

    it('tabs lists every opened tab with unique stable handles and its name', async () => {
      const rows = JSON.parse((await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(rows.length, TAB_COUNT + 1, 'the original fixture tab plus every opened tab');

      const handles = rows.map((row) => row.handle);
      assert.ok(handles.every((h) => /^t\d+$/.test(h)));
      assert.equal(new Set(handles).size, rows.length, 'handles are unique');

      for (let i = 0; i < TAB_COUNT; i += 1) {
        const row = rows.find((r) => r.name === `job-${i}`);
        assert.ok(row, `job-${i} is named in tabs output`);
        assert.equal(row.url, `https://job-${i}.test/`);
      }
      const active = rows.filter((row) => row.active);
      assert.equal(active.length, 1);
      assert.equal(active[0].name, `job-${TAB_COUNT - 1}`, 'the last open is the active tab');
    });

    it('concurrent CLI processes reading different --tab targets each hit their own page', async () => {
      const targets = [2, 5, 8, 11];
      const results = await Promise.all(targets.map((i) =>
        exec('node', ['bin.js', 'get', 'url', '--tab', `job-${i}`, '--json'], { cwd: ROOT, env })
      ));
      results.forEach(({ stdout }, idx) => {
        const resp = JSON.parse(stdout);
        assert.equal(resp.success, true);
        assert.equal(resp.data.url, `https://job-${targets[idx]}.test/`, 'each concurrent read landed on its own tab');
      });

      // Parallel --tab reads never moved the active tab.
      const rows = JSON.parse((await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(rows.find((row) => row.active)?.name, `job-${TAB_COUNT - 1}`);
    });

    it('re-using a taken name fails over the wire until --replace is given', async () => {
      const conflict = await execFail(['open', 'https://newer.test/', '--as', 'job-3', '--json']);
      assert.notEqual(conflict.code, 0);
      const resp = JSON.parse(conflict.stdout);
      assert.equal(resp.success, false);
      assert.match(resp.error, /job-3/);
      assert.match(resp.error, /--replace/);

      const replaced = JSON.parse(
        (await exec('node', ['bin.js', 'open', 'https://newer.test/', '--as', 'job-3', '--replace', '--json'], { cwd: ROOT, env })).stdout
      );
      assert.equal(replaced.success, true);
      assert.equal(replaced.data.tab.name, 'job-3');
      assert.equal(replaced.data.tab.url, 'https://newer.test/');

      const rows = JSON.parse((await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env })).stdout);
      const named = rows.filter((row) => row.name === 'job-3');
      assert.equal(named.length, 1, 'exactly one tab holds the name after --replace');
      assert.equal(named[0].url, 'https://newer.test/');
    });

    it('invalid tab names are rejected over the wire with the teaching suggestion', async () => {
      const before = JSON.parse((await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env })).stdout);

      for (const bad of ['my tab', 't2']) {
        const fail = await execFail(['open', 'https://invalid-name.test/', '--as', bad, '--json']);
        assert.notEqual(fail.code, 0);
        const resp = JSON.parse(fail.stdout);
        assert.equal(resp.success, false);
        assert.match(resp.error, /identifier-like|reserved/);
        assert.match(resp.error, /api-docs|docs/, 'the wire error keeps the teaching suggestion');
      }

      const after = JSON.parse((await exec('node', ['bin.js', 'tabs', '--json'], { cwd: ROOT, env })).stdout);
      assert.equal(after.length, before.length, 'rejected names never created a tab');
    });
  });
});

describe('sessiond lifecycle hardening (stop / restart / warning / backend flags)', () => {
  const FAKE_BROWSER = fileURLToPath(new URL('./fixtures/fake-snapshot-browser.mjs', import.meta.url));
  const cleanups = [];

  async function getDeadPort() {
    const srv = http.createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));
    return port;
  }

  function trackLock(lockPath) {
    cleanups.push(async () => {
      const lock = await readLockFile(lockPath);
      if (lock?.pid) { try { process.kill(lock.pid, 'SIGKILL'); } catch { /* gone */ } }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
      try { await fs.unlink(`${lockPath.replace(/\.json$/, '')}-url.json`); } catch { /* gone */ }
    });
  }

  after(async () => { for (const fn of cleanups) await fn(); });

  it('session stop on a stale lock (live PID, dead port) clears sidecars WITHOUT killing the unrelated PID', async () => {
    // Simulate PID reuse: the daemon died and its PID was handed to an unrelated
    // long-lived process. The lock still points at that PID.
    const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
    await sleep(100);
    const deadPort = await getDeadPort();
    const lockPath = tmpLockPath();
    await writeSessiondLock({ pid: victim.pid, port: deadPort, token: 'stale-token', version: '0.0.0', lockPath });
    try {
      const { stdout } = await exec('node', ['bin.js', 'session', 'stop', '--json'], {
        cwd: ROOT, env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath },
      });
      const data = JSON.parse(stdout);
      assert.equal(data.stopped, true);
      assert.equal(data.running, false);
      assert.equal(data.stale, true, 'a stale lock is reported as stale');
      // The unrelated process MUST still be alive — stop must never kill an
      // unverified PID from the lock.
      assert.doesNotThrow(() => process.kill(victim.pid, 0), 'stop must not kill the reused PID');
      assert.equal(await readLockFile(lockPath), null, 'stale lock sidecar is cleared');
    } finally {
      try { process.kill(victim.pid, 'SIGKILL'); } catch { /* gone */ }
      try { await fs.unlink(lockPath); } catch { /* gone */ }
    }
  });

  it('the managed-fallback warning is attached to NON-snapshot verb envelopes (not just snapshot)', async () => {
    const deadPort = await getDeadPort();
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    // auto + a dead bridge → managed fallback (shouldWarn), with the fake browser
    // injected below buildExecContext so the verb still runs.
    const env = {
      ...process.env,
      BF_SESSIOND_LOCK_PATH: lockPath,
      BF_BROWSER_BACKEND: 'auto',
      BF_CDP_URL: `ws://127.0.0.1:${deadPort}/cdp?token=x`,
      BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
    };
    const child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    cleanups.push(async () => { try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
    const lock = await waitForLock(lockPath);
    assert.ok(lock, 'auto should fall back to managed and start');

    const resp = JSON.parse((await exec('node', ['bin.js', 'get', 'url', '--sessiond', '--json'], { cwd: ROOT, env })).stdout);
    assert.equal(resp.success, true);
    assert.equal(resp.data.url, 'https://fake.test/');
    assert.ok(
      typeof resp.warning === 'string' && /Real Chrome bridge unavailable/.test(resp.warning),
      'a non-snapshot verb envelope must carry the managed-fallback warning',
    );
  });

  it('session start surfaces the managed-fallback warning on stderr', async () => {
    const deadPort = await getDeadPort();
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    const env = {
      ...process.env,
      BF_SESSIOND_LOCK_PATH: lockPath,
      BF_BROWSER_BACKEND: 'auto',
      BF_CDP_URL: `ws://127.0.0.1:${deadPort}/cdp?token=x`,
      BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
    };
    // Non-JSON start: the warning goes to stderr.
    const { stderr } = await exec('node', ['bin.js', 'session', 'start'], { cwd: ROOT, env });
    assert.match(stderr, /Real Chrome bridge unavailable/, 'session start must warn about the managed fallback');
  });

  it('CLI backend flags flow to the daemon: --managed / --headless set requestedBackend', async () => {
    for (const [flag, mode] of [['--managed', 'managed'], ['--headless', 'headless']]) {
      const lockPath = tmpLockPath();
      trackLock(lockPath);
      const env = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER };
      // Deliberately no BF_BROWSER_BACKEND: if the flag were ignored, the daemon
      // would default to 'auto' — so requestedBackend === mode proves it flowed.
      await exec('node', ['bin.js', 'session', 'start', flag, '--json'], { cwd: ROOT, env });
      const lock = await waitForLock(lockPath);
      assert.ok(lock, `session start ${flag} should start`);
      const res = await httpFetch('GET', `http://127.0.0.1:${lock.port}/status`, null, lock.token);
      assert.equal(res.body.requestedBackend, mode, `${flag} → requestedBackend "${mode}"`);
      assert.equal(res.body.backend, mode);
    }
  });

  it('conflicting backend flags (--real --managed) fail loud', async () => {
    const lockPath = tmpLockPath();
    await assert.rejects(
      exec('node', ['bin.js', 'session', 'start', '--real', '--managed', '--json'], {
        cwd: ROOT, env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath },
      }),
      /mutually exclusive|conflicting/i,
      'mutually-exclusive backend flags must fail loud',
    );
  });

  it('a verb auto-restarts a daemon left running by an older install (version mismatch)', async () => {
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    // Pre-start a daemon pinned to a stale version via the test seam.
    const staleEnv = {
      ...process.env,
      BF_SESSIOND_LOCK_PATH: lockPath,
      BF_BROWSER_BACKEND: 'managed',
      BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      BF_SESSIOND_VERSION: '0.0.0-stale',
    };
    const stale = spawn('node', [SESSIOND], { cwd: ROOT, env: staleEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    cleanups.push(async () => { try { if (stale?.pid) process.kill(stale.pid, 'SIGKILL'); } catch { /* gone */ } });
    const lock1 = await waitForLock(lockPath);
    assert.ok(lock1, 'stale-version daemon should start');
    assert.equal(lock1.version, '0.0.0-stale');

    // Run a verb WITHOUT the version override → ensureSessiondRunning sees the
    // running daemon's version != this install's version → restart.
    const verbEnv = {
      ...process.env,
      BF_SESSIOND_LOCK_PATH: lockPath,
      BF_BROWSER_BACKEND: 'managed',
      BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
    };
    const resp = JSON.parse((await exec('node', ['bin.js', 'get', 'url', '--sessiond', '--json'], { cwd: ROOT, env: verbEnv })).stdout);
    assert.equal(resp.success, true, 'the verb runs against the restarted daemon');

    const lock2 = await readLockFile(lockPath);
    assert.ok(lock2, 'a fresh lock exists after restart');
    assert.notEqual(lock2.pid, lock1.pid, 'stale-version daemon was restarted with a new PID');
    assert.notEqual(lock2.version, '0.0.0-stale', 'the restarted daemon reports the current version');
  });

  // Start a managed daemon (fake browser) and return its first lock.
  async function startManagedDaemon(lockPath) {
    const env = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_BROWSER_BACKEND: 'managed', BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER };
    const child = spawn('node', [SESSIOND], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    cleanups.push(async () => { try { if (child?.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
    const lock = await waitForLock(lockPath);
    assert.ok(lock, 'managed daemon should start');
    return lock;
  }

  it('an explicit --real verb against a running MANAGED daemon never silently uses managed (fails loud)', async () => {
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    await startManagedDaemon(lockPath);
    const deadPort = await getDeadPort();
    // --real with no bridge: ensureSessiondRunning must restart into real (not
    // reuse the managed daemon); the real negotiation then fails loud before any
    // new lock is written.
    const realEnv = {
      ...process.env,
      BF_SESSIOND_LOCK_PATH: lockPath,
      BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      BF_CDP_URL: `ws://127.0.0.1:${deadPort}/cdp?token=x`,
    };
    let failed = false; let detail = '';
    try {
      await exec('node', ['bin.js', 'get', 'url', '--real', '--json'], { cwd: ROOT, env: realEnv });
    } catch (err) {
      failed = true;
      detail = `${err.stderr || ''}${err.message || ''}`;
    }
    assert.ok(failed, '--real must fail (non-zero exit), never silently reuse the managed daemon');
    assert.match(detail, /failed to start|real Chrome bridge|extension not connected/i);
    // The reused-managed result ("https://fake.test/") must NOT have been returned.
    assert.doesNotMatch(detail, /fake\.test/);
  });

  it('an explicit --headless verb restarts a running managed daemon into headless', async () => {
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    const lock1 = await startManagedDaemon(lockPath);
    const verbEnv = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER };
    const resp = JSON.parse((await exec('node', ['bin.js', 'get', 'url', '--headless', '--json'], { cwd: ROOT, env: verbEnv })).stdout);
    assert.equal(resp.success, true);
    const lock2 = await readLockFile(lockPath);
    assert.ok(lock2);
    assert.notEqual(lock2.pid, lock1.pid, 'managed daemon was restarted into headless with a new PID');
    const res = await httpFetch('GET', `http://127.0.0.1:${lock2.port}/status`, null, lock2.token);
    assert.equal(res.body.backend, 'headless', 'restarted daemon runs the explicitly requested backend');
  });

  it('an explicit --managed verb REUSES an already-managed daemon (no needless restart)', async () => {
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    const lock1 = await startManagedDaemon(lockPath);
    const verbEnv = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER };
    const resp = JSON.parse((await exec('node', ['bin.js', 'get', 'url', '--managed', '--json'], { cwd: ROOT, env: verbEnv })).stdout);
    assert.equal(resp.success, true);
    const lock2 = await readLockFile(lockPath);
    assert.equal(lock2.pid, lock1.pid, 'matching effective backend is reused — no churn');
  });

  // `session start` shares the SAME backend predicate as the verb path: an
  // explicit flag against a different-backend daemon must restart, never report
  // the wrong-backend daemon as "running". (Guard-pair consistency.)
  it('session start --real against a running MANAGED daemon never reports it running (fails loud)', async () => {
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    await startManagedDaemon(lockPath);
    const deadPort = await getDeadPort();
    const realEnv = {
      ...process.env,
      BF_SESSIOND_LOCK_PATH: lockPath,
      BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER,
      BF_CDP_URL: `ws://127.0.0.1:${deadPort}/cdp?token=x`,
    };
    let failed = false; let detail = '';
    try {
      await exec('node', ['bin.js', 'session', 'start', '--real', '--json'], { cwd: ROOT, env: realEnv });
    } catch (err) {
      failed = true;
      detail = `${err.stderr || ''}${err.stdout || ''}${err.message || ''}`;
    }
    assert.ok(failed, 'session start --real must fail loud, not reuse the managed daemon');
    assert.match(detail, /failed to start|real Chrome bridge|extension not connected/i);
    assert.doesNotMatch(detail, /"started":\s*false/);
  });

  it('session start --headless restarts a running managed daemon into headless (started:true, new pid)', async () => {
    const lockPath = tmpLockPath();
    trackLock(lockPath);
    const lock1 = await startManagedDaemon(lockPath);
    const env = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath, BF_SESSIOND_CONNECT_MODULE: FAKE_BROWSER };
    const resp = JSON.parse((await exec('node', ['bin.js', 'session', 'start', '--headless', '--json'], { cwd: ROOT, env })).stdout);
    assert.equal(resp.started, true, 'mismatched backend forces a fresh start');
    assert.equal(resp.backend, 'headless');
    assert.notEqual(resp.pid, lock1.pid, 'a new daemon PID confirms the restart');
  });
});

describe('ref normalization (CLI input aliases)', () => {
  it('normalizes @e1, e1, and ref=e1 to the same canonical ref', () => {
    assert.equal(normalizeRef('@e1'), 'e1');
    assert.equal(normalizeRef('e1'), 'e1');
    assert.equal(normalizeRef('ref=e1'), 'e1');
    assert.equal(normalizeRef('REF=e2'), 'e2');
    assert.equal(normalizeRef('  @e3  '), 'e3');
    assert.equal(normalizeRef(''), '');
  });
});
