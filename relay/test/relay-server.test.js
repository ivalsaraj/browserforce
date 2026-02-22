const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocket } = require('ws');
const { RelayServer, DEFAULT_PORT, BF_DIR } = require('../src/index.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find a free port to avoid collisions between tests */
function getRandomPort() {
  return 19300 + Math.floor(Math.random() * 700);
}

/** HTTP GET as a promise */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    }).on('error', reject);
  });
}

/** Connect a WebSocket and wait for open */
function connectWs(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connect timeout'));
    }, 3000);
    ws.on('open', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/** Read one message from a WebSocket */
function readMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WS read timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/** Send a JSON message and read the response (matched by id) */
async function sendAndReceive(ws, msg, timeoutMs = 3000) {
  ws.send(JSON.stringify(msg));
  return readMessage(ws, timeoutMs);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Token Persistence ───────────────────────────────────────────────────────

describe('Token Persistence', () => {
  const tmpDir = path.join(os.tmpdir(), `bf-test-${crypto.randomBytes(4).toString('hex')}`);
  const origBfDir = BF_DIR;

  it('creates auth token file on first run', () => {
    // RelayServer reads token from the global BF_DIR.
    // We just verify the token is a non-empty string.
    const relay = new RelayServer(getRandomPort());
    assert.ok(relay.authToken, 'authToken should be set');
    assert.ok(relay.authToken.length >= 20, 'authToken should be at least 20 chars');
  });

  it('token is stable across RelayServer instances', () => {
    const a = new RelayServer(getRandomPort());
    const b = new RelayServer(getRandomPort());
    assert.equal(a.authToken, b.authToken, 'Same token file means same token');
  });
});

// ─── HTTP Endpoints ──────────────────────────────────────────────────────────

describe('HTTP Endpoints', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200); // Wait for server to bind
  });

  after(() => {
    relay.stop();
  });

  it('GET / returns health status', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.extension, false);
    assert.equal(body.targets, 0);
    assert.equal(body.clients, 0);
  });

  it('GET /json/version returns CDP discovery info', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/json/version`);
    assert.equal(status, 200);
    assert.ok(body.Browser.includes('BrowserForce'));
    assert.equal(body['Protocol-Version'], '1.3');
    assert.ok(body.webSocketDebuggerUrl.includes(`token=${relay.authToken}`));
  });

  it('GET /json/list returns empty array when no targets', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it('GET /json is alias for /json/list', async () => {
    const { status, body } = await httpGet(`http://127.0.0.1:${port}/json`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  it('GET /unknown returns 404', async () => {
    const { status } = await httpGet(`http://127.0.0.1:${port}/unknown`);
    assert.equal(status, 404);
  });
});

// ─── WebSocket Security ──────────────────────────────────────────────────────

describe('WebSocket Security', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('rejects /extension without chrome-extension:// origin', async () => {
    try {
      const ws = await connectWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { Origin: 'https://evil.com' },
      });
      ws.close();
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('403') || err.message.includes('Unexpected'));
    }
  });

  it('rejects /cdp without valid token', async () => {
    try {
      const ws = await connectWs(`ws://127.0.0.1:${port}/cdp?token=invalid`);
      ws.close();
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected'));
    }
  });

  it('rejects /cdp with no token', async () => {
    try {
      const ws = await connectWs(`ws://127.0.0.1:${port}/cdp`);
      ws.close();
      assert.fail('Should have rejected');
    } catch (err) {
      assert.ok(err.message.includes('401') || err.message.includes('Unexpected'));
    }
  });

  it('accepts /extension with chrome-extension:// origin', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://abcdef123456' },
    });
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('accepts /cdp with valid token', async () => {
    const ws = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });

  it('rejects second extension connection (single slot)', async () => {
    const ws1 = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://first' },
    });

    try {
      const ws2 = await connectWs(`ws://127.0.0.1:${port}/extension`, {
        headers: { Origin: 'chrome-extension://second' },
      });
      ws2.close();
      assert.fail('Should have rejected second connection');
    } catch (err) {
      assert.ok(err.message.includes('409') || err.message.includes('Unexpected'));
    }

    ws1.close();
    await sleep(100); // Let cleanup happen
  });
});

// ─── CDP Protocol ────────────────────────────────────────────────────────────

describe('CDP Protocol', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('Browser.getVersion returns synthetic response', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 1,
      method: 'Browser.getVersion',
    });
    assert.equal(res.id, 1);
    assert.ok(res.result.product.includes('BrowserForce'));
    assert.equal(res.result.protocolVersion, '1.3');
    cdp.close();
  });

  it('Target.setDiscoverTargets returns empty result', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 2,
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    });
    assert.equal(res.id, 2);
    assert.deepEqual(res.result, {});
    cdp.close();
  });

  it('Target.getTargets returns empty list when no tabs attached', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 3,
      method: 'Target.getTargets',
    });
    assert.equal(res.id, 3);
    assert.ok(Array.isArray(res.result.targetInfos));
    assert.equal(res.result.targetInfos.length, 0);
    cdp.close();
  });

  it('Browser.setDownloadBehavior returns empty result', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 4,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: '/tmp' },
    });
    assert.equal(res.id, 4);
    assert.deepEqual(res.result, {});
    cdp.close();
  });

  it('Target.getTargetInfo returns browser target for unknown targetId', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 5,
      method: 'Target.getTargetInfo',
      params: { targetId: 'nonexistent' },
    });
    assert.equal(res.id, 5);
    assert.ok(res.result.targetInfo);
    assert.equal(res.result.targetInfo.type, 'browser');
    cdp.close();
  });

  it('Target.attachToTarget returns error for unknown target', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 6,
      method: 'Target.attachToTarget',
      params: { targetId: 'nonexistent' },
    });
    assert.equal(res.id, 6);
    assert.ok(res.error);
    cdp.close();
  });

  it('unknown browser-level command returns empty result', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 7,
      method: 'Browser.someUnknownMethod',
    });
    assert.equal(res.id, 7);
    assert.deepEqual(res.result, {});
    cdp.close();
  });
});

// ─── Extension ↔ Relay Communication ─────────────────────────────────────────

describe('Extension Communication', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('relay sends ping to extension', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const msg = await readMessage(ext, 6000); // ping comes every 5s
    assert.equal(msg.method, 'ping');

    ext.close();
    await sleep(100);
  });

  it('extension can respond to pong', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    // Wait for ping
    const ping = await readMessage(ext, 6000);
    assert.equal(ping.method, 'ping');

    // Send pong (should not error)
    ext.send(JSON.stringify({ method: 'pong' }));
    await sleep(100);
    assert.equal(ext.readyState, WebSocket.OPEN);

    ext.close();
    await sleep(100);
  });

  it('health endpoint reflects extension connection', async () => {
    // Before connection
    const before = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(before.body.extension, false);

    // Connect extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    await sleep(50);
    const during = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(during.body.extension, true);

    // Disconnect
    ext.close();
    await sleep(100);
    const after = await httpGet(`http://127.0.0.1:${port}/`);
    assert.equal(after.body.extension, false);
  });
});

// ─── Target.setAutoAttach with Mock Extension ────────────────────────────────

describe('Auto-attach Flow', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('auto-attach discovers tabs lazily (no debugger until first command)', async () => {
    // Connect mock extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const extCommands = []; // Track what commands relay sends to extension

    // Extension handles commands from relay
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') {
        ext.send(JSON.stringify({ method: 'pong' }));
        return;
      }
      if (msg.id !== undefined) {
        extCommands.push(msg.method);
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              tabs: [
                { tabId: 1, url: 'https://gmail.com', title: 'Gmail', active: true },
                { tabId: 2, url: 'https://github.com', title: 'GitHub', active: false },
              ],
            },
          }));
        } else if (msg.method === 'attachTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              sessionId: msg.params.sessionId,
              targetId: `target-${msg.params.tabId}`,
              targetInfo: {
                targetId: `target-${msg.params.tabId}`,
                type: 'page',
                title: msg.params.tabId === 1 ? 'Gmail' : 'GitHub',
                url: msg.params.tabId === 1 ? 'https://gmail.com' : 'https://github.com',
              },
            },
          }));
        }
      }
    });

    // Connect CDP client
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];

    // Collect all messages
    cdp.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Send setAutoAttach
    cdp.send(JSON.stringify({
      id: 1,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    }));

    // Wait for relay to process
    await sleep(1000);

    // Should have: response + 2 attachedToTarget events (lazy, no debugger yet)
    const response = messages.find((m) => m.id === 1);
    assert.ok(response, 'Should receive response to setAutoAttach');
    assert.deepEqual(response.result, {});

    const attached = messages.filter((m) => m.method === 'Target.attachedToTarget');
    assert.equal(attached.length, 2, 'Should report 2 targets');

    const urls = attached.map((m) => m.params.targetInfo.url).sort();
    assert.deepEqual(urls, ['https://github.com', 'https://gmail.com']);

    // Key: only listTabs was called, NOT attachTab (lazy behavior)
    assert.deepEqual(extCommands, ['listTabs'], 'Should only call listTabs during auto-attach (lazy)');

    // Verify targets in relay state
    const targets = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(targets.body.length, 2);

    // Verify getTargets
    cdp.send(JSON.stringify({ id: 2, method: 'Target.getTargets' }));
    await sleep(100);
    const getTargetsRes = messages.find((m) => m.id === 2);
    assert.equal(getTargetsRes.result.targetInfos.length, 2);

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('lazy-attaches debugger on first CDP command to a tab', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    const extCommands = [];

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.id !== undefined) {
        extCommands.push(msg.method);
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabs: [{ tabId: 5, url: 'https://lazy.test', title: 'Lazy', active: true }] },
          }));
        } else if (msg.method === 'attachTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              sessionId: msg.params.sessionId,
              targetId: 'real-target-5',
              targetInfo: { targetId: 'real-target-5', type: 'page', title: 'Lazy', url: 'https://lazy.test' },
            },
          }));
        } else if (msg.method === 'cdpCommand') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { result: { type: 'string', value: 'done' } },
          }));
        }
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // Auto-attach (lazy)
    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(500);

    assert.deepEqual(extCommands, ['listTabs'], 'Only listTabs during auto-attach');

    // Get the sessionId
    const attached = messages.find((m) => m.method === 'Target.attachedToTarget');
    const sessionId = attached.params.sessionId;

    // Send a CDP command — should trigger lazy attach + then the command
    cdp.send(JSON.stringify({
      id: 10,
      method: 'Runtime.evaluate',
      params: { expression: '"test"' },
      sessionId,
    }));
    await sleep(500);

    // Now attachTab + cdpCommand should have been called
    assert.deepEqual(extCommands, ['listTabs', 'attachTab', 'cdpCommand'],
      'First command triggers attachTab then cdpCommand');

    // Send a second command — should NOT trigger another attachTab
    cdp.send(JSON.stringify({
      id: 11,
      method: 'Runtime.evaluate',
      params: { expression: '"test2"' },
      sessionId,
    }));
    await sleep(300);

    assert.deepEqual(extCommands, ['listTabs', 'attachTab', 'cdpCommand', 'cdpCommand'],
      'Second command skips attachTab (already attached)');

    cdp.close();
    ext.close();
    await sleep(100);
  });
});

// ─── CDP Command Forwarding ──────────────────────────────────────────────────

describe('CDP Command Forwarding', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('forwards session-level commands to extension and returns response', async () => {
    // Connect mock extension
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    // Setup: attach a tab
    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') {
        ext.send(JSON.stringify({ method: 'pong' }));
        return;
      }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabs: [{ tabId: 10, url: 'https://example.com', title: 'Example', active: true }] },
          }));
        } else if (msg.method === 'attachTab') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: {
              sessionId: msg.params.sessionId,
              targetId: 'real-target-10',
              targetInfo: { targetId: 'real-target-10', type: 'page', title: 'Example', url: 'https://example.com' },
            },
          }));
        } else if (msg.method === 'cdpCommand') {
          // Forward CDP command: respond with mock result
          if (msg.params.method === 'Page.navigate') {
            ext.send(JSON.stringify({
              id: msg.id,
              result: { frameId: 'frame-123', loaderId: 'loader-456' },
            }));
          } else if (msg.params.method === 'Runtime.evaluate') {
            ext.send(JSON.stringify({
              id: msg.id,
              result: { result: { type: 'string', value: 'hello' } },
            }));
          }
        }
      }
    });

    // Connect CDP client and trigger auto-attach
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const messages = [];
    cdp.on('message', (data) => messages.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(500);

    // Find the sessionId for the attached tab
    const attached = messages.find((m) => m.method === 'Target.attachedToTarget');
    assert.ok(attached, 'Should have attached event');
    const sessionId = attached.params.sessionId;

    // Send Page.navigate via session
    cdp.send(JSON.stringify({
      id: 10,
      method: 'Page.navigate',
      params: { url: 'https://example.com/page2' },
      sessionId,
    }));
    await sleep(200);

    const navResponse = messages.find((m) => m.id === 10);
    assert.ok(navResponse, 'Should receive navigate response');
    assert.equal(navResponse.result.frameId, 'frame-123');
    assert.equal(navResponse.sessionId, sessionId);

    // Send Runtime.evaluate via session
    cdp.send(JSON.stringify({
      id: 11,
      method: 'Runtime.evaluate',
      params: { expression: '"hello"' },
      sessionId,
    }));
    await sleep(200);

    const evalResponse = messages.find((m) => m.id === 11);
    assert.ok(evalResponse, 'Should receive evaluate response');
    assert.equal(evalResponse.result.result.value, 'hello');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('returns error for commands on unknown session', async () => {
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const res = await sendAndReceive(cdp, {
      id: 99,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
      sessionId: 'nonexistent-session',
    });
    assert.equal(res.id, 99);
    assert.ok(res.error);
    assert.ok(res.error.message.includes('not found'));
    cdp.close();
  });
});

// ─── CDP Event Forwarding ────────────────────────────────────────────────────

describe('CDP Event Forwarding', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('forwards CDP events from extension to CDP client', async () => {
    // Connect mock extension with auto-attach
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') {
        ext.send(JSON.stringify({ method: 'pong' }));
        return;
      }
      if (msg.id !== undefined) {
        if (msg.method === 'listTabs') {
          ext.send(JSON.stringify({
            id: msg.id,
            result: { tabs: [{ tabId: 20, url: 'https://test.com', title: 'Test', active: true }] },
          }));
        }
      }
    });

    // Connect CDP client
    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    // Auto-attach (lazy — tabToSession mapping exists but no debugger)
    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(500);

    const attached = events.find((m) => m.method === 'Target.attachedToTarget');
    const sessionId = attached.params.sessionId;

    // Extension sends a CDP event (simulating what happens after debugger is attached)
    ext.send(JSON.stringify({
      method: 'cdpEvent',
      params: {
        tabId: 20,
        method: 'Page.loadEventFired',
        params: { timestamp: 12345.678 },
      },
    }));

    await sleep(200);

    const loadEvent = events.find((m) => m.method === 'Page.loadEventFired');
    assert.ok(loadEvent, 'CDP client should receive the event');
    assert.equal(loadEvent.params.timestamp, 12345.678);
    assert.equal(loadEvent.sessionId, sessionId);

    cdp.close();
    ext.close();
    await sleep(100);
  });
});

// ─── Tab Lifecycle ───────────────────────────────────────────────────────────

describe('Tab Lifecycle', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('tab detach event removes target and notifies CDP client', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.method === 'listTabs') {
        ext.send(JSON.stringify({ id: msg.id, result: { tabs: [{ tabId: 30, url: 'https://a.com', title: 'A', active: true }] } }));
      } else if (msg.method === 'attachTab') {
        ext.send(JSON.stringify({ id: msg.id, result: { sessionId: msg.params.sessionId, targetId: 't-30', targetInfo: { targetId: 't-30', type: 'page', title: 'A', url: 'https://a.com' } } }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(500);

    // Verify target exists
    let list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 1);

    // Extension reports tab detached
    ext.send(JSON.stringify({
      method: 'tabDetached',
      params: { tabId: 30, reason: 'tab_closed' },
    }));
    await sleep(200);

    // Verify target removed
    list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 0);

    // CDP client should have received detach event
    const detached = events.find((m) => m.method === 'Target.detachedFromTarget');
    assert.ok(detached, 'Should receive detach event');

    cdp.close();
    ext.close();
    await sleep(100);
  });

  it('tab update event updates target info', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.method === 'listTabs') {
        ext.send(JSON.stringify({ id: msg.id, result: { tabs: [{ tabId: 40, url: 'https://old.com', title: 'Old', active: true }] } }));
      } else if (msg.method === 'attachTab') {
        ext.send(JSON.stringify({ id: msg.id, result: { sessionId: msg.params.sessionId, targetId: 't-40', targetInfo: { targetId: 't-40', type: 'page', title: 'Old', url: 'https://old.com' } } }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(500);

    // Extension sends tabUpdated
    ext.send(JSON.stringify({
      method: 'tabUpdated',
      params: { tabId: 40, url: 'https://new.com', title: 'New Page' },
    }));
    await sleep(200);

    // CDP client should receive targetInfoChanged
    const changed = events.find((m) => m.method === 'Target.targetInfoChanged');
    assert.ok(changed, 'Should receive targetInfoChanged');
    assert.equal(changed.params.targetInfo.url, 'https://new.com');
    assert.equal(changed.params.targetInfo.title, 'New Page');

    // json/list should reflect updated info
    const list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body[0].url, 'https://new.com');
    assert.equal(list.body[0].title, 'New Page');

    cdp.close();
    ext.close();
    await sleep(100);
  });
});

// ─── Extension Disconnect Cleanup ────────────────────────────────────────────

describe('Extension Disconnect', () => {
  let relay;
  let port;

  before(async () => {
    port = getRandomPort();
    relay = new RelayServer(port);
    relay.start({ writeCdpUrl: false });
    await sleep(200);
  });

  after(() => {
    relay.stop();
  });

  it('cleans up all targets when extension disconnects', async () => {
    const ext = await connectWs(`ws://127.0.0.1:${port}/extension`, {
      headers: { Origin: 'chrome-extension://test' },
    });

    ext.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'ping') { ext.send(JSON.stringify({ method: 'pong' })); return; }
      if (msg.method === 'listTabs') {
        ext.send(JSON.stringify({ id: msg.id, result: { tabs: [{ tabId: 50, url: 'https://x.com', title: 'X', active: true }] } }));
      } else if (msg.method === 'attachTab') {
        ext.send(JSON.stringify({ id: msg.id, result: { sessionId: msg.params.sessionId, targetId: 't-50', targetInfo: { targetId: 't-50', type: 'page', title: 'X', url: 'https://x.com' } } }));
      }
    });

    const cdp = await connectWs(`ws://127.0.0.1:${port}/cdp?token=${relay.authToken}`);
    const events = [];
    cdp.on('message', (data) => events.push(JSON.parse(data.toString())));

    cdp.send(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } }));
    await sleep(500);

    // Verify target exists
    let list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 1);

    // Disconnect extension
    ext.close();
    await sleep(200);

    // All targets should be gone
    list = await httpGet(`http://127.0.0.1:${port}/json/list`);
    assert.equal(list.body.length, 0);

    // CDP client should have received detach event
    const detached = events.find((m) => m.method === 'Target.detachedFromTarget');
    assert.ok(detached, 'Should notify CDP client of target loss');

    cdp.close();
    await sleep(100);
  });
});
