#!/usr/bin/env node
// Quick E2E smoke test: spawns MCP server, sends JSON-RPC tool calls, checks responses.
// Requires: relay running + extension connected.
// Usage: node mcp/test/e2e-smoke.mjs

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(__dirname, '..', 'src', 'index.js');

let msgId = 0;
let pendingCallbacks = new Map();
let buffer = '';

function startMcp() {
  const proc = spawn('node', [MCP_SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[mcp-stderr] ${chunk}`);
  });

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    // JSON-RPC messages are newline-delimited
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pendingCallbacks.has(msg.id)) {
          pendingCallbacks.get(msg.id)(msg);
          pendingCallbacks.delete(msg.id);
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  });

  return proc;
}

function send(proc, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const timeout = globalThis.setTimeout(() => {
      pendingCallbacks.delete(id);
      reject(new Error(`Timeout waiting for response to ${method} (id=${id})`));
    }, 30000);

    pendingCallbacks.set(id, (msg) => {
      clearTimeout(timeout);
      if (msg.error) reject(new Error(`RPC error: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });

    const rpc = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    proc.stdin.write(rpc);
  });
}

async function run() {
  console.log('Starting MCP server...');
  const proc = startMcp();

  // Wait for server to boot
  await new Promise((r) => globalThis.setTimeout(r, 2000));

  try {
    // 1. Initialize
    console.log('\n--- Initialize ---');
    const initResult = await send(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-smoke', version: '1.0.0' },
    });
    console.log('Protocol:', initResult.protocolVersion);
    console.log('Server:', initResult.serverInfo?.name);

    // Send initialized notification (no response expected)
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    await new Promise((r) => globalThis.setTimeout(r, 500));

    // 2. List tools
    console.log('\n--- List Tools ---');
    const toolsResult = await send(proc, 'tools/list', {});
    const toolNames = toolsResult.tools.map((t) => t.name);
    console.log('Tools:', toolNames.join(', '));

    // 3. Create state.page and navigate (the core workflow)
    console.log('\n--- Execute: create state.page + navigate ---');
    const navResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: {
        code: `state.page = await context.newPage();
await state.page.goto('https://example.com');
await waitForPageLoad();
return state.page.url();`,
        timeout: 30000,
      },
    });
    console.log('Result:', JSON.stringify(navResult.content));
    if (navResult.isError) throw new Error('Navigation failed: ' + navResult.content?.[0]?.text);

    // 4. Snapshot (DOM-based accessibility tree)
    console.log('\n--- Execute: snapshot() ---');
    const snapResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'return await snapshot()' },
    });
    const snapText = snapResult.content?.[0]?.text || '';
    console.log('Snapshot length:', snapText.length, 'chars');
    console.log('First 500 chars:', snapText.slice(0, 500));
    if (snapResult.isError) throw new Error('Snapshot failed: ' + snapText);
    if (snapText.length < 50) throw new Error('Snapshot too short — likely broken');

    // 5. page.title() on state.page
    console.log('\n--- Execute: state.page.title() ---');
    const titleResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'return await state.page.title()' },
    });
    console.log('Result:', JSON.stringify(titleResult.content));

    // 6. page.evaluate() on state.page
    console.log('\n--- Execute: state.page.evaluate() ---');
    const evalResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'return await state.page.evaluate(() => document.title)' },
    });
    console.log('Result:', JSON.stringify(evalResult.content));
    if (evalResult.isError) throw new Error('page.evaluate() failed: ' + evalResult.content?.[0]?.text);

    // 7. context.pages() count
    console.log('\n--- Execute: context.pages().length ---');
    const pagesResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'return context.pages().length' },
    });
    console.log('Result:', JSON.stringify(pagesResult.content));

    // 8. State persistence
    console.log('\n--- Execute: state persistence ---');
    await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'state.testVal = 42; return state.testVal' },
    });
    const stateResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'return state.testVal' },
    });
    console.log('State persisted:', JSON.stringify(stateResult.content));

    // 9. Scoped snapshot
    console.log('\n--- Execute: scoped snapshot ---');
    const scopedResult = await send(proc, 'tools/call', {
      name: 'execute',
      arguments: { code: 'return await snapshot({ selector: "body" })' },
    });
    const scopedText = scopedResult.content?.[0]?.text || '';
    console.log('Scoped snapshot length:', scopedText.length, 'chars');
    if (scopedResult.isError) console.log('ERROR:', scopedText);

    // 10. Reset
    console.log('\n--- Reset ---');
    const resetResult = await send(proc, 'tools/call', {
      name: 'reset',
      arguments: {},
    });
    console.log('Reset:', JSON.stringify(resetResult.content));

    console.log('\n=== ALL SMOKE TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exitCode = 1;
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => globalThis.setTimeout(r, 500));
  }
}

run();
