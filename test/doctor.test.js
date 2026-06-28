// test/doctor.test.js — ESM (root package is "type": "module")
//
// runDoctor() is a pure orchestrator over injectable probes so every diagnosis
// path (relay down, extension disconnected, stale cdp-url, loose secret perms,
// active/stale backend) is testable without a real relay, browser, or fs.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { runDoctor, OK, WARN, FAIL } from '../mcp/src/doctor.js';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PATHS = {
  tokenFile: '/tmp/bf-doctor/auth-token',
  cdpUrlFile: '/tmp/bf-doctor/cdp-url',
  sessiondLockFile: '/tmp/bf-doctor/sessiond-lock.json',
  sessiondUrlFile: '/tmp/bf-doctor/sessiond-lock-url.json',
};

// A fully-healthy baseline; individual tests override one probe to fault-inject.
function healthyDeps(overrides = {}) {
  return {
    paths: PATHS,
    probeExtensionStatus: async () => ({ connected: true }),
    readText: () => null, // no cdp-url sidecar on disk
    fileStat: () => ({ exists: false, mode: null }),
    readRawLock: () => null, // no session daemon
    lockAlive: async () => false,
    probeSessiondStatus: async () => ({ backend: 'real' }),
    removeFile: () => {},
    ...overrides,
  };
}

const find = (report, id) => report.checks.find((c) => c.id === id);

describe('doctor: runDoctor', () => {
  it('reports all green for a healthy environment (ok:true, no mutations)', async () => {
    const removed = [];
    const report = await runDoctor(healthyDeps({ removeFile: (p) => removed.push(p) }));
    assert.equal(report.ok, true);
    assert.equal(find(report, 'relay').status, OK);
    assert.equal(find(report, 'extension').status, OK);
    assert.equal(removed.length, 0, 'doctor without --fix must not mutate state');
  });

  it('flags the relay as FAIL when it is not running', async () => {
    const report = await runDoctor(healthyDeps({
      probeExtensionStatus: async () => { throw new Error('ECONNREFUSED'); },
    }));
    assert.equal(find(report, 'relay').status, FAIL);
    assert.equal(report.ok, false);
  });

  it('flags the extension as FAIL when the relay is up but the extension is disconnected', async () => {
    const report = await runDoctor(healthyDeps({
      probeExtensionStatus: async () => ({ connected: false }),
    }));
    assert.equal(find(report, 'relay').status, OK);
    assert.equal(find(report, 'extension').status, FAIL);
    assert.equal(report.ok, false);
  });

  it('warns about a stale cdp-url sidecar when the relay is unreachable', async () => {
    const report = await runDoctor(healthyDeps({
      probeExtensionStatus: async () => { throw new Error('down'); },
      readText: (p) => (p === PATHS.cdpUrlFile ? 'ws://127.0.0.1:19222/cdp?token=x' : null),
    }));
    const c = find(report, 'cdp-url');
    assert.equal(c.status, WARN);
    assert.equal(c.fixable, true);
  });

  it('--fix removes ONLY the stale cdp-url sidecar (never the auth token)', async () => {
    const removed = [];
    const report = await runDoctor(healthyDeps({
      fix: true,
      probeExtensionStatus: async () => { throw new Error('down'); },
      readText: (p) => (p === PATHS.cdpUrlFile ? 'ws://127.0.0.1:19222/cdp?token=x' : null),
      removeFile: (p) => removed.push(p),
    }));
    assert.ok(removed.includes(PATHS.cdpUrlFile));
    assert.ok(!removed.includes(PATHS.tokenFile), 'must never remove the auth token');
    assert.ok(report.fixes.includes(PATHS.cdpUrlFile));
    assert.equal(find(report, 'cdp-url').fixed, true);
  });

  it('warns when a secret file has permissions looser than 0600', async () => {
    const report = await runDoctor(healthyDeps({
      fileStat: (p) => (p === PATHS.tokenFile ? { exists: true, mode: 0o644 } : { exists: false, mode: null }),
    }));
    const c = find(report, 'permissions');
    assert.equal(c.status, WARN);
    assert.match(c.detail, /auth-token/);
    assert.match(c.detail, /644/);
  });

  it('passes the permission check when secrets are 0600 (or absent)', async () => {
    const report = await runDoctor(healthyDeps({
      fileStat: (p) => (p === PATHS.tokenFile ? { exists: true, mode: 0o600 } : { exists: false, mode: null }),
    }));
    assert.equal(find(report, 'permissions').status, OK);
  });

  it('reports the active backend from a live session daemon', async () => {
    const report = await runDoctor(healthyDeps({
      readRawLock: () => ({ pid: 4321, port: 19350, token: 't' }),
      lockAlive: async () => true,
      probeSessiondStatus: async () => ({ backend: 'real', requestedBackend: 'auto', warning: null }),
    }));
    const c = find(report, 'backend');
    assert.equal(c.status, OK);
    assert.match(c.detail, /real/);
  });

  it('surfaces the daemon fallback warning as a WARN backend check', async () => {
    const report = await runDoctor(healthyDeps({
      readRawLock: () => ({ pid: 4321, port: 19350, token: 't' }),
      lockAlive: async () => true,
      probeSessiondStatus: async () => ({ backend: 'managed', requestedBackend: 'auto', warning: 'Real Chrome bridge unavailable; using managed Chrome.' }),
    }));
    const c = find(report, 'backend');
    assert.equal(c.status, WARN);
    assert.match(c.detail, /managed/);
  });

  it('flags a stale session daemon lock (dead pid) as fixable, and --fix clears the lock + url sidecars', async () => {
    const removed = [];
    const report = await runDoctor(healthyDeps({
      fix: true,
      readRawLock: () => ({ pid: 999999, port: 19350, token: 't' }),
      lockAlive: async () => false,
      removeFile: (p) => removed.push(p),
    }));
    assert.ok(removed.includes(PATHS.sessiondLockFile));
    assert.ok(removed.includes(PATHS.sessiondUrlFile));
    assert.equal(find(report, 'backend').fixed, true);
  });
});

describe('doctor: real CLI path (browserforce doctor)', () => {
  // Point at a dead relay port so the relay check deterministically FAILs
  // regardless of whether a real relay happens to be running locally.
  const env = { ...process.env, BF_CDP_URL: 'ws://127.0.0.1:1/cdp?token=x' };

  it('doctor --json reports success:false and exits 1 when the relay is unreachable', async () => {
    let out;
    let code = 0;
    try {
      out = (await exec('node', ['bin.js', 'doctor', '--json'], { cwd: ROOT, env })).stdout;
    } catch (err) {
      out = err.stdout;
      code = err.code;
    }
    assert.equal(code, 1);
    const res = JSON.parse(out);
    assert.equal(res.success, false);
    assert.ok(Array.isArray(res.data.checks));
    assert.equal(res.data.checks.find((c) => c.id === 'relay').status, FAIL);
  });

  it('doctor is listed in help', async () => {
    const { stdout } = await exec('node', ['bin.js', 'help'], { cwd: ROOT });
    assert.match(stdout, /browserforce doctor/);
  });
});
