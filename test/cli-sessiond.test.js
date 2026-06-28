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
      const okTok = await httpFetch('GET', `${base}/status`, null, lock.token);
      assert.equal(noTok.status, 401);
      assert.equal(badTok.status, 401);
      assert.equal(okTok.status, 200);
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
});
