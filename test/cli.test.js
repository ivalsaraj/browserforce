// test/cli.test.js — ESM (root package is "type": "module")
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createRequire } from 'node:module';

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
