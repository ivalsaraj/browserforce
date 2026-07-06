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

    // 2. List tools — the compact 4-tool surface, with execute gone.
    console.log('\n--- List Tools ---');
    const toolsResult = await send(proc, 'tools/list', {});
    const toolNames = toolsResult.tools.map((t) => t.name);
    console.log('Tools:', toolNames.join(', '));
    for (const required of ['browserforce', 'exec', 'help', 'reset']) {
      if (!toolNames.includes(required)) throw new Error(`Missing tool "${required}" — got: ${toolNames.join(', ')}`);
    }
    if (toolNames.includes('execute')) throw new Error('Old execute tool must not be advertised (renamed to exec)');

    // 3. Create state.page and navigate (the core workflow)
    console.log('\n--- Execute: create state.page + navigate ---');
    const navResult = await send(proc, 'tools/call', {
      name: 'exec',
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
      name: 'exec',
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
      name: 'exec',
      arguments: { code: 'return await state.page.title()' },
    });
    console.log('Result:', JSON.stringify(titleResult.content));

    // 6. page.evaluate() on state.page
    console.log('\n--- Execute: state.page.evaluate() ---');
    const evalResult = await send(proc, 'tools/call', {
      name: 'exec',
      arguments: { code: 'return await state.page.evaluate(() => document.title)' },
    });
    console.log('Result:', JSON.stringify(evalResult.content));
    if (evalResult.isError) throw new Error('page.evaluate() failed: ' + evalResult.content?.[0]?.text);

    // 7. context.pages() count
    console.log('\n--- Execute: context.pages().length ---');
    const pagesResult = await send(proc, 'tools/call', {
      name: 'exec',
      arguments: { code: 'return context.pages().length' },
    });
    console.log('Result:', JSON.stringify(pagesResult.content));

    // 8. State persistence
    console.log('\n--- Execute: state persistence ---');
    await send(proc, 'tools/call', {
      name: 'exec',
      arguments: { code: 'state.testVal = 42; return state.testVal' },
    });
    const stateResult = await send(proc, 'tools/call', {
      name: 'exec',
      arguments: { code: 'return state.testVal' },
    });
    console.log('State persisted:', JSON.stringify(stateResult.content));

    // 9. Scoped snapshot
    console.log('\n--- Execute: scoped snapshot ---');
    const scopedResult = await send(proc, 'tools/call', {
      name: 'exec',
      arguments: { code: 'return await snapshot({ selector: "body" })' },
    });
    const scopedText = scopedResult.content?.[0]?.text || '';
    console.log('Scoped snapshot length:', scopedText.length, 'chars');
    if (scopedResult.isError) console.log('ERROR:', scopedText);

    // 9a. Same-origin iframe: snapshot includes in-iframe content + locatorForRef round-trip.
    console.log('\n--- Execute: same-origin iframe — content present + locatorForRef check ---');
    const sameOriginCode = [
      "await state.page.setContent('<!doctype html><h1>Host Heading</h1><iframe id=inner srcdoc=\"<label>InnerBox<input type=checkbox id=b></label>\"></iframe>');",
      'await waitForPageLoad();',
      'await state.page.waitForTimeout(400);',
      'const snap = await snapshot({ interactiveOnly: true });',
      "const i = snap.indexOf('InnerBox');",
      "if (i < 0) throw new Error('same-origin iframe content missing from snapshot');",
      'const after = snap.slice(i);',
      "const s = after.indexOf('[ref=');",
      "const e = after.indexOf(']', s);",
      'const ref = after.slice(s + 5, e);',
      'const loc = locatorForRef({ ref });',
      'await loc.check();',
      'const inner = state.page.frames().find((f) => f !== state.page.mainFrame());',
      "const checked = inner ? await inner.evaluate(() => document.getElementById('b').checked) : false;",
      'return JSON.stringify({ ref, checked });',
    ].join('\n');
    const sameOriginResult = await send(proc, 'tools/call', { name: 'exec', arguments: { code: sameOriginCode } });
    const sameOriginText = sameOriginResult.content?.[0]?.text || '';
    console.log('Result:', sameOriginText);
    if (sameOriginResult.isError) throw new Error('same-origin iframe case failed: ' + sameOriginText);
    if (!JSON.parse(sameOriginText).checked) throw new Error('locatorForRef did not check the in-iframe checkbox');

    // 9b. Cross-origin OOPIF: snapshot includes the OOPIF's interactive content + locator
    //     resolves inside it. Self-skips when the cross-origin frame can't load (no network).
    console.log('\n--- Execute: cross-origin OOPIF — content present (skips w/o network) ---');
    const oopifCode = [
      "await state.page.setContent('<!doctype html><h1>OOPIF Host</h1><iframe id=ext src=\"https://example.com\"></iframe>');",
      'await waitForPageLoad();',
      'let oopif = null;',
      'for (let k = 0; k < 25; k++) {',
      '  oopif = state.page.frames().find((f) => { try { return f !== state.page.mainFrame() && /example\\.com/.test(f.url()); } catch { return false; } });',
      '  if (oopif) break;',
      '  await state.page.waitForTimeout(200);',
      '}',
      "if (!oopif) return JSON.stringify({ skipped: true, reason: 'OOPIF did not load (no network?)' });",
      'const snap = await snapshot({ interactiveOnly: true });',
      "const i = snap.indexOf('information');",
      'let acted = false;',
      'if (i >= 0) {',
      '  const after = snap.slice(i);',
      "  const s = after.indexOf('[ref=');",
      '  if (s >= 0) {',
      "    const e = after.indexOf(']', s);",
      '    const ref = after.slice(s + 5, e);',
      '    acted = await locatorForRef({ ref }).first().isVisible().catch(() => false);',
      '  }',
      '}',
      'return JSON.stringify({ skipped: false, hasLink: i >= 0, acted });',
    ].join('\n');
    const oopifResult = await send(proc, 'tools/call', { name: 'exec', arguments: { code: oopifCode } });
    const oopifText = oopifResult.content?.[0]?.text || '';
    console.log('Result:', oopifText);
    if (oopifResult.isError) throw new Error('OOPIF case failed: ' + oopifText);
    {
      const parsed = JSON.parse(oopifText);
      if (parsed.skipped) console.log('SKIP (OOPIF):', parsed.reason);
      else if (!parsed.hasLink) throw new Error('OOPIF interactive content missing from snapshot');
      else if (!parsed.acted) throw new Error('locatorForRef did not resolve inside the OOPIF');
    }

    // 9c. snapshot({ locator }) and snapshot({ frame }) scope to the expected region.
    console.log('\n--- Execute: snapshot({ locator }) and snapshot({ frame }) scoping ---');
    const scopeCode = [
      "await state.page.setContent('<!doctype html><main><button id=keep>KeepBtn</button></main><aside><button id=drop>DropBtn</button></aside><iframe id=f2 srcdoc=\"<button id=ib>FrameBtn</button>\"></iframe>');",
      'await waitForPageLoad();',
      'await state.page.waitForTimeout(400);',
      "const scoped = await snapshot({ locator: state.page.locator('main'), interactiveOnly: true });",
      "const okLocator = scoped.indexOf('KeepBtn') >= 0 && scoped.indexOf('DropBtn') < 0;",
      'const inner = state.page.frames().find((f) => f !== state.page.mainFrame());',
      "const frameSnap = inner ? await snapshot({ frame: inner, interactiveOnly: true }) : '';",
      "const okFrame = frameSnap.indexOf('FrameBtn') >= 0;",
      'return JSON.stringify({ okLocator, okFrame });',
    ].join('\n');
    const scopeResult = await send(proc, 'tools/call', { name: 'exec', arguments: { code: scopeCode } });
    const scopeText = scopeResult.content?.[0]?.text || '';
    console.log('Result:', scopeText);
    if (scopeResult.isError) throw new Error('scoping case failed: ' + scopeText);
    {
      const parsed = JSON.parse(scopeText);
      if (!parsed.okLocator) throw new Error('snapshot({ locator }) did not scope to the expected region');
      if (!parsed.okFrame) throw new Error('snapshot({ frame }) did not return the frame content');
    }

    // 9d. Empty/sparse page → descriptive throw (no silent fallback to a weaker engine).
    console.log('\n--- Execute: empty page → descriptive throw ---');
    const emptyCode = [
      "await state.page.goto('about:blank');",
      'await state.page.waitForTimeout(200);',
      'try {',
      '  await snapshot({ interactiveOnly: true });',
      "  return 'NO_THROW';",
      '} catch (err) {',
      '  return err && err.message ? err.message : String(err);',
      '}',
    ].join('\n');
    const emptyResult = await send(proc, 'tools/call', { name: 'exec', arguments: { code: emptyCode } });
    const emptyText = emptyResult.content?.[0]?.text || '';
    console.log('Result:', emptyText);
    if (emptyResult.isError) throw new Error('empty-page case errored unexpectedly: ' + emptyText);
    if (emptyText === 'NO_THROW') throw new Error('empty page snapshot did not throw (silent fallback?)');
    if (!/empty after retry/.test(emptyText)) console.log('NOTE: empty-page throw message differs:', emptyText);

    // 9e. browserforce command tool — real handler path over stdio, sharing the
    // same runtime/userState as exec (tabs shows the exec-created page).
    console.log('\n--- browserforce: help / tabs / snapshot / click round-trip ---');
    const bfHelp = await send(proc, 'tools/call', { name: 'browserforce', arguments: { command: 'help' } });
    const bfHelpText = bfHelp.content?.[0]?.text || '';
    if (bfHelp.isError || !/click <ref>/.test(bfHelpText)) throw new Error('browserforce help failed: ' + bfHelpText);

    await send(proc, 'tools/call', {
      name: 'exec',
      arguments: { code: "await state.page.goto('https://example.com'); await waitForPageLoad(); return state.page.url();" },
    });

    const bfTabs = await send(proc, 'tools/call', { name: 'browserforce', arguments: { command: 'tabs' } });
    const bfTabsText = bfTabs.content?.[0]?.text || '';
    console.log('tabs:', bfTabsText.split('\n')[0]);
    if (bfTabs.isError || !/t\d+/.test(bfTabsText)) throw new Error('browserforce tabs failed: ' + bfTabsText);

    const bfSnap = await send(proc, 'tools/call', { name: 'browserforce', arguments: { command: 'snapshot' } });
    const bfSnapText = bfSnap.content?.[0]?.text || '';
    if (bfSnap.isError || !/\[ref=e\d+\]/.test(bfSnapText)) throw new Error('browserforce snapshot failed: ' + bfSnapText.slice(0, 300));

    const bfClick = await send(proc, 'tools/call', { name: 'browserforce', arguments: { command: 'click @e1' } });
    const bfClickText = bfClick.content?.[0]?.text || '';
    console.log('click:', bfClickText);
    if (bfClick.isError || !/clicked/.test(bfClickText)) throw new Error('browserforce click failed: ' + bfClickText);

    const bfBad = await send(proc, 'tools/call', { name: 'browserforce', arguments: { command: 'bogus' } });
    const bfBadText = bfBad.content?.[0]?.text || '';
    if (!bfBad.isError || !/Unknown command/.test(bfBadText) || /HINT/.test(bfBadText)) {
      throw new Error('browserforce bad-command shape wrong: ' + bfBadText);
    }

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
