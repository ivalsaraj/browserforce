// test/cli.test.js — ESM (root package is "type": "module")
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Relay is CJS — use createRequire to import it
const require = createRequire(import.meta.url);
const { RelayServer } = require('../relay/src/index.js');

// ws lives in relay/node_modules — use a require anchored at relay/src to find it
const requireFromRelay = createRequire(new URL('../relay/src/index.js', import.meta.url).pathname);
const { WebSocket } = requireFromRelay('ws');

const exec = promisify(execFile);

function getRandomPort() {
  return 19300 + Math.floor(Math.random() * 700);
}

function connectMockExtension(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    }).on('error', reject);
  });
}

describe('CLI', () => {
  let relay, port, ext, cdpUrl;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    await relay.start({ writeCdpUrl: false });
    ext = await connectMockExtension(port);
    cdpUrl = `ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`;
    ext.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.method === 'ping') {
        ext.send(JSON.stringify({ method: 'pong' }));
        return;
      }
      if (msg.id === undefined) return;
      // Respond to all relay commands so browser.close() does not hang
      if (msg.method === 'listTabs') {
        ext.send(JSON.stringify({ id: msg.id, result: { tabs: [] } }));
      } else {
        ext.send(JSON.stringify({ id: msg.id, result: {} }));
      }
    });
  });

  after(async () => {
    ext?.close();
    relay?.stop();
  });

  it('help prints usage text', async () => {
    const { stdout } = await exec('node', ['bin.js', 'help']);
    assert.ok(stdout.includes('BrowserForce'));
    assert.ok(stdout.includes('browserforce serve'));
    assert.ok(stdout.includes('browserforce -e'));
    assert.ok(stdout.includes('one-shot'));
  });

  it('relay HTTP health check returns expected shape', async () => {
    // Direct HTTP check — validates the relay endpoint the CLI status command hits
    const res = await httpGetJson(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 'ok');
    assert.equal(res.extension, true);
  });

  it('status via CLI with BF_CDP_URL', async () => {
    // This tests that the CLI derives the HTTP URL from CDP URL
    const { stdout } = await exec('node', ['bin.js', 'status', '--json'], {
      env: { ...process.env, BF_CDP_URL: cdpUrl },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.relay, 'running');
  });

  it('unknown command prints help and exits 1', async () => {
    try {
      await exec('node', ['bin.js', 'nonsense']);
      assert.fail('should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('Unknown command'));
    }
  });

  it('-e executes code and returns result', async () => {
    // One-shot execution: pure JS that doesn't need page/context.
    // Use spawn to capture stdout as it streams — the CLI outputs the result
    // immediately then may hang in browser.close() teardown. We kill it once
    // we have the output rather than waiting for a clean exit.
    const output = await new Promise((resolve, reject) => {
      const child = spawn('node', ['bin.js', '-e', 'return 2 + 2'], {
        env: { ...process.env, BF_CDP_URL: cdpUrl },
      });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI timed out after 15s without producing output`));
      }, 15000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        // Result is on the first line — resolve as soon as we have it
        if (stdout.includes('\n')) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve(stdout.trim());
        }
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    // Without --json, output() prints the string directly
    assert.equal(output, '4');
  });

  it('-e teardown completes without hanging', async () => {
    // Verify that the CLI exits cleanly after -e execution
    const start = Date.now();
    try {
      await exec('node', ['bin.js', '-e', 'return "done"', '--timeout', '5000'], {
        env: { ...process.env, BF_CDP_URL: cdpUrl },
        timeout: 10000,
      });
    } catch { /* may error on no context, that's ok */ }
    const elapsed = Date.now() - start;
    // Should complete well under 10s — if teardown leaks, it would hang
    assert.ok(elapsed < 10000, `CLI took ${elapsed}ms — possible teardown leak`);
  });
});

describe('CLI plugin commands', () => {
  let relay, port, pluginsDir;

  before(async () => {
    port = getRandomPort();
    pluginsDir = join(tmpdir(), `bf-cli-plugins-${Math.random().toString(36).slice(2)}`);
    mkdirSync(pluginsDir, { recursive: true });
    relay = new RelayServer(port, pluginsDir);
    await relay.start({ writeCdpUrl: false });
  });

  after(() => {
    relay?.stop();
    rmSync(pluginsDir, { recursive: true, force: true });
  });

  it('plugin list prints "No plugins installed" when empty', async () => {
    const cdpUrl = `ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`;
    const { stdout } = await exec('node', ['bin.js', 'plugin', 'list'], {
      env: { ...process.env, BF_CDP_URL: cdpUrl },
    });
    assert.ok(stdout.includes('No plugins installed'));
  });

  it('plugin list --json returns plugins array', async () => {
    const cdpUrl = `ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`;
    const { stdout } = await exec('node', ['bin.js', 'plugin', 'list', '--json'], {
      env: { ...process.env, BF_CDP_URL: cdpUrl },
    });
    const result = JSON.parse(stdout);
    assert.ok(Array.isArray(result.plugins));
  });

  it('plugin remove nonexistent exits 1 with error', async () => {
    const cdpUrl = `ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`;
    try {
      await exec('node', ['bin.js', 'plugin', 'remove', 'ghost-plugin'], {
        env: { ...process.env, BF_CDP_URL: cdpUrl },
      });
      assert.fail('should have exited with error');
    } catch (err) {
      assert.ok(err.stderr.includes('Error') || err.code !== 0);
    }
  });
});

describe('CLI install-extension', () => {
  let tmpExt;

  before(() => {
    tmpExt = join(tmpdir(), `bf-ext-${Math.random().toString(36).slice(2)}`);
  });

  after(() => {
    rmSync(tmpExt, { recursive: true, force: true });
  });

  it('install-extension copies extension files and writes VERSION', async () => {
    const { stdout } = await exec('node', ['bin.js', 'install-extension'], {
      env: { ...process.env, BF_EXT_DIR: tmpExt },
    });
    // Check output
    assert.ok(stdout.includes('Extension installed to:'));
    assert.ok(stdout.includes(tmpExt));
    assert.ok(stdout.includes('Load unpacked'));
    assert.ok(stdout.includes('❗'));
    assert.ok(stdout.includes('↺'));

    // Check files were copied
    const { existsSync, readFileSync } = await import('node:fs');
    assert.ok(existsSync(join(tmpExt, 'manifest.json')));
    assert.ok(existsSync(join(tmpExt, 'background.js')));

    // Check VERSION sentinel
    const version = readFileSync(join(tmpExt, 'VERSION'), 'utf8').trim();
    const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
    assert.equal(version, pkgVersion);
  });

  it('install-extension is listed in help', async () => {
    const { stdout } = await exec('node', ['bin.js', 'help']);
    assert.ok(stdout.includes('install-extension'));
  });

  it('install-extension replaces stale VERSION with current package version', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
    // Simulate a previously-installed-but-stale extension
    mkdirSync(tmpExt, { recursive: true });
    writeFileSync(join(tmpExt, 'VERSION'), '0.0.1');

    // Re-running install-extension should overwrite VERSION with current version
    await exec('node', ['bin.js', 'install-extension'], {
      env: { ...process.env, BF_EXT_DIR: tmpExt },
    });
    const version = readFileSync(join(tmpExt, 'VERSION'), 'utf8').trim();
    const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
    assert.equal(version, pkgVersion);
  });

  it('serve warns when extension VERSION is outdated', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const staleDir = join(tmpdir(), `bf-ext-stale-${Math.random().toString(36).slice(2)}`);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'VERSION'), '0.0.1'); // intentionally stale

    const warning = await new Promise((resolve, reject) => {
      const child = spawn('node', ['bin.js', 'serve'], {
        env: { ...process.env, BF_EXT_DIR: staleDir, RELAY_PORT: String(getRandomPort()) },
      });
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('serve timed out without producing stderr'));
      }, 5000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes('❗')) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve(stderr);
        }
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    assert.ok(warning.includes('outdated'));
    assert.ok(warning.includes('install-extension'));
    assert.ok(warning.includes('❗'));

    rmSync(staleDir, { recursive: true, force: true });
  });

  it('serve does NOT warn when VERSION matches current package', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs');
    const freshDir = join(tmpdir(), `bf-ext-fresh-${Math.random().toString(36).slice(2)}`);
    mkdirSync(freshDir, { recursive: true });
    const currentVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
    writeFileSync(join(freshDir, 'VERSION'), currentVersion);

    const result = await new Promise((resolve) => {
      const child = spawn('node', ['bin.js', 'serve'], {
        env: { ...process.env, BF_EXT_DIR: freshDir, RELAY_PORT: String(getRandomPort()) },
      });
      let stderr = '';
      // Give it 1.5s to produce any warning, then declare "no warning"
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve(stderr);
      }, 1500);
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    });

    assert.ok(!result.includes('outdated'), `Unexpected warning: ${result}`);

    rmSync(freshDir, { recursive: true, force: true });
  });
});
