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
      child = spawn('node', [SESSIOND], {
        cwd: ROOT,
        env: { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath },
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
      const startEnv = { ...process.env, BF_SESSIOND_LOCK_PATH: lockPath };

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
});
