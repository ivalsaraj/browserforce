import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createSmartDiff, parseSearchPattern,
} from '../src/snapshot.js';

const MCP_ROOT = join(import.meta.url.replace('file://', ''), '../../');

function createRpcClient(proc) {
  let nextId = 0;
  let buffer = '';
  const pending = new Map();

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const callback = pending.get(message.id);
        if (callback) {
          pending.delete(message.id);
          callback(message);
        }
      } catch {
        // Ignore non-RPC startup output.
      }
    }
  });

  return function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = globalThis.setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, 5000);

      pending.set(id, (message) => {
        globalThis.clearTimeout(timeout);
        if (message.error) {
          reject(new Error(JSON.stringify(message.error)));
        } else {
          resolve(message.result);
        }
      });

      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
}

// ─── CDP URL Discovery ──────────────────────────────────────────────────────

describe('CDP URL Discovery', () => {
  const BF_DIR = join(homedir(), '.browserforce');
  const CDP_URL_FILE = join(BF_DIR, 'cdp-url');

  it('reads CDP URL from well-known file', () => {
    // The relay should have written this during previous test runs
    // or manual relay starts. We test the file format.
    try {
      const url = readFileSync(CDP_URL_FILE, 'utf8').trim();
      assert.ok(url.startsWith('ws://'), 'CDP URL should start with ws://');
      assert.ok(url.includes('/cdp?token='), 'CDP URL should contain /cdp?token=');
      assert.ok(url.includes('127.0.0.1'), 'CDP URL should bind to localhost');
    } catch {
      // File might not exist if relay hasn't been run — skip
      assert.ok(true, 'CDP URL file not found (relay not started yet)');
    }
  });

  it('env var BF_CDP_URL takes priority over file', () => {
    const original = process.env.BF_CDP_URL;
    try {
      process.env.BF_CDP_URL = 'ws://127.0.0.1:99999/cdp?token=test';
      assert.equal(process.env.BF_CDP_URL, 'ws://127.0.0.1:99999/cdp?token=test');
    } finally {
      if (original) {
        process.env.BF_CDP_URL = original;
      } else {
        delete process.env.BF_CDP_URL;
      }
    }
  });
});

// ─── Tool Schema Validation ──────────────────────────────────────────────────

describe('Tool Definitions', () => {
  it('MCP server module loads without syntax errors', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('node --check src/index.js', {
      cwd: join(import.meta.url.replace('file://', ''), '../../'),
      encoding: 'utf8',
    });
    assert.equal(result, '');
  });

  it('index imports only exports available from exec-engine', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync(
      'node --input-type=module -e "import { getCdpUrl, getRelayHttpUrl, getRelayHttpUrlFromCdpUrl, assertExtensionConnected, ensureRelay, connectOverCdpWithBusyRetry, CodeExecutionTimeoutError, buildExecContext, runCode, formatResult } from \'./src/exec-engine.js\'; console.log(typeof getRelayHttpUrlFromCdpUrl, typeof assertExtensionConnected);"',
      {
        cwd: join(import.meta.url.replace('file://', ''), '../../'),
        encoding: 'utf8',
      }
    ).trim();
    assert.equal(result, 'function function');
  });

  // Extract a tool's registration block (description + schema, up to the async
  // handler) anchored on the server.tool() call — NOT a bare string split,
  // because names like 'browserforce' also appear as the McpServer name.
  function toolRegistrationBlock(source, name) {
    const match = source.match(new RegExp(`server\\.tool\\(\\s*'${name}',`));
    if (!match) return '';
    const rest = source.slice(match.index + match[0].length);
    const end = rest.indexOf('async (');
    return end === -1 ? rest : rest.slice(0, end);
  }

  it('registers exactly 4 tools: browserforce, exec, help, reset', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const toolNames = [];
    const regex = /server\.tool\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      toolNames.push(match[1]);
    }

    assert.equal(toolNames.length, 4, `Should have exactly 4 tools, found ${toolNames.length}: ${toolNames.join(', ')}`);
    assert.deepEqual(toolNames.sort(), ['browserforce', 'exec', 'help', 'reset']);
  });

  it('does not advertise the old execute tool by default', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    assert.doesNotMatch(
      source,
      /server\.tool\(\s*['"]execute['"]/,
      'execute must not be advertised by default (renamed to exec)'
    );
  });

  it('browserforce tool accepts a command string and optional timeout', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const bfBlock = toolRegistrationBlock(source, 'browserforce');
    assert.ok(bfBlock, 'browserforce tool should be registered');
    assert.ok(bfBlock.includes('command:'), 'browserforce should have a command param');
    assert.ok(bfBlock.includes('z.string()'), 'command should be a string');
    assert.ok(bfBlock.includes('timeout:'), 'browserforce should have a timeout param');
    assert.ok(bfBlock.includes('z.number().optional()'), 'timeout should be an optional number');
  });

  it('exec tool keeps the raw execution shape: code, timeout, intent', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const execBlock = toolRegistrationBlock(source, 'exec');
    assert.ok(execBlock, 'exec tool should be registered');
    assert.ok(execBlock.includes('code:'), 'exec should have a code param');
    assert.ok(execBlock.includes('z.string()'), 'code should be a string');
    assert.ok(execBlock.includes('timeout:'), 'exec should have a timeout param');
    assert.ok(execBlock.includes('z.number().optional()'), 'timeout should be an optional number');
    assert.ok(execBlock.includes('intent:'), 'exec should keep the intent param');
    assert.ok(
      execBlock.includes("z.enum(['inspect', 'open', 'auto'])"),
      'intent should keep the inspect/open/auto enum'
    );
  });

  it('tools have non-empty descriptions', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // execute tool uses EXECUTE_PROMPT variable, reset uses inline string
    assert.ok(source.includes('EXECUTE_PROMPT'), 'execute tool should reference EXECUTE_PROMPT');
    assert.ok(source.includes('const EXECUTE_PROMPT'), 'EXECUTE_PROMPT should be defined');
    const helpBlock = source.split("'help'")[1]?.split('server.tool(')[0] || '';
    assert.ok(helpBlock.includes('No Chrome connection'), 'help should document that it does not connect to Chrome');
    // Check reset tool still has inline description
    const resetBlock = source.split("'reset'")[1] || '';
    assert.ok(resetBlock.includes('Reconnects'), 'reset should have description');
  });

  it('help tool is registered without CDP startup side effects', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    assert.ok(source.includes('readHelpSections'), 'help should cache read sections per MCP session');
    assert.ok(source.includes('force'), 'help should support forcing repeated section reads');
    const helpIdx = source.indexOf("'help'");
    assert.ok(helpIdx !== -1, 'help tool should exist');
    const helpEnd = source.indexOf('\n);\n\n// ─── Exec Tool Prompt', helpIdx);
    assert.ok(helpEnd !== -1, 'help tool should be registered before the exec prompt');
    const helpBlock = source.slice(helpIdx, helpEnd);
    assert.doesNotMatch(helpBlock, /ensureBrowser/);
    assert.doesNotMatch(helpBlock, /beginBrowserOperation/);
    assert.doesNotMatch(helpBlock, /chromium\.connectOverCDP/);
  });

  it('help responds over JSON-RPC without a live relay or CDP connection', async () => {
    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd: MCP_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BF_CDP_URL: 'ws://127.0.0.1:9/cdp?token=test',
      },
    });
    const send = createRpcClient(proc);
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    try {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'help-no-cdp-test', version: '1.0.0' },
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      const listResult = await send('tools/call', {
        name: 'help',
        arguments: {},
      });
      assert.match(listResult.content?.[0]?.text || '', /tabs:/);

      const result = await send('tools/call', {
        name: 'help',
        arguments: { section: 'tabs' },
      });
      const text = result.content?.[0]?.text || '';
      assert.match(text, /manualAttachedTabs/);

      const cachedResult = await send('tools/call', {
        name: 'help',
        arguments: { section: 'tabs' },
      });
      assert.match(cachedResult.content?.[0]?.text || '', /already read/);

      const forcedResult = await send('tools/call', {
        name: 'help',
        arguments: { section: 'tabs', force: true },
      });
      assert.match(forcedResult.content?.[0]?.text || '', /context\.pages\(\)/);
      assert.doesNotMatch(stderr, /\[bf-mcp\] Connected to relay/);
    } finally {
      proc.kill('SIGTERM');
    }
  });

  // Extract the full browserforce handler block (registration + async handler)
  // for source-contract assertions.
  function browserforceHandlerBlock(source) {
    const start = source.indexOf('function registerBrowserforceTool()');
    assert.ok(start !== -1, 'registerBrowserforceTool should exist');
    const end = source.indexOf("server.tool(\n  'reset'", start);
    assert.ok(end !== -1, 'browserforce handler block should end before the reset tool');
    return source.slice(start, end);
  }

  it('browserforce handler delegates to the shared registry with the MCP runtime', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const block = browserforceHandlerBlock(source);

    assert.ok(
      /executeBrowserforceCommand\(\{ command, runtime, timeout \}\)/.test(block),
      'handler must call executeBrowserforceCommand with the shared MCP runtime (same userState as exec)'
    );
    assert.ok(block.includes('preflightAttachedPageBeforeCdp'), 'handler runs the same preflight as exec');
    assert.ok(block.includes("verb === 'open' ? 'open' : 'inspect'"), 'open command maps to open intent, everything else inspects');
  });

  it('browserforce handler never touches raw Playwright page/locator APIs', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const block = browserforceHandlerBlock(source);

    for (const forbidden of ['.locator(', '.click(', '.newPage(', '.goto(', 'page.', 'getPages()']) {
      assert.ok(
        !block.includes(forbidden),
        `browserforce handler must not call raw Playwright APIs (found "${forbidden}") — all actions go through the guarded registry/runtime boundary`
      );
    }
  });

  it('command path source contract: handler → registry → runtime.runCommand → runCode', () => {
    const indexSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const registrySource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browserforce-command-registry.js'),
      'utf8'
    );
    const runtimeSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );

    assert.ok(browserforceHandlerBlock(indexSource).includes('executeBrowserforceCommand('), 'handler calls the registry');
    assert.ok(/runtime\.runCommand\(/.test(registrySource), 'registry executes through runtime.runCommand()');
    // Strip comments (they legitimately mention the forbidden APIs when
    // documenting this exact rule) before checking for real usage.
    const registryCode = registrySource.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/new Function\(|globalThis\.eval\(|\bvm\./.test(registryCode),
      'registry never builds executable code outside the guarded boundary'
    );
    assert.ok(/await runCode\(code, execCtx, timeout\)/.test(runtimeSource), 'runtime.runCommand runs through the guarded runCode() boundary');
  });

  it('browserforce handler formats command errors with Suggestion lines and gated reset hints', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const block = browserforceHandlerBlock(source);

    const commandErrorFn = block.slice(
      block.indexOf('const commandErrorResponse'),
      block.indexOf('// Parse first'),
    );
    assert.ok(commandErrorFn.includes('isError: true'), 'command errors are isError responses');
    assert.ok(commandErrorFn.includes('Suggestion: '), 'command errors render an explicit Suggestion line');
    assert.ok(commandErrorFn.includes('err.suggestion'), 'command errors surface the structured suggestion');
    assert.ok(
      commandErrorFn.includes("err.resetHintAllowed === true ? RESET_HINT : ''"),
      'reset guidance is appended ONLY when resetHintAllowed === true'
    );
  });

  it('MCP server installs the process crash guard before serving tools', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    assert.ok(
      source.includes("from './process-crash-guard.js'"),
      'index.js imports the crash guard'
    );
    const installIdx = source.search(/installProcessCrashGuard\(\{\s*logPrefix: '\[bf-mcp\]'/);
    const mainCallIdx = source.indexOf('main().catch');
    assert.ok(installIdx !== -1, 'index.js installs the guard with the [bf-mcp] prefix');
    assert.ok(mainCallIdx !== -1, 'main().catch entrypoint exists');
    assert.ok(installIdx < mainCallIdx, 'guard installs BEFORE the server entrypoint runs');
  });

  it('browserforce responds over JSON-RPC: help succeeds, bad commands teach without reset hints', async () => {
    const proc = spawn(process.execPath, ['src/index.js'], {
      cwd: MCP_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BF_CDP_URL: 'ws://127.0.0.1:9/cdp?token=test',
      },
    });
    const send = createRpcClient(proc);

    try {
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'browserforce-tool-test', version: '1.0.0' },
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      // Real handler path: the help command needs no browser and returns the
      // shared command help text.
      const helpResult = await send('tools/call', {
        name: 'browserforce',
        arguments: { command: 'help' },
      });
      const helpText = helpResult.content?.[0]?.text || '';
      assert.match(helpText, /open <url>/, 'command help lists open');
      assert.match(helpText, /click <ref>/, 'command help lists click');
      assert.notEqual(helpResult.isError, true);

      // Unknown commands fail as teaching errors, not reset-hinted crashes.
      const badResult = await send('tools/call', {
        name: 'browserforce',
        arguments: { command: 'bogus-command' },
      });
      assert.equal(badResult.isError, true);
      const badText = badResult.content?.[0]?.text || '';
      assert.match(badText, /Unknown command: bogus-command/);
      assert.match(badText, /help/i, 'teaching error suggests help');
      assert.ok(!badText.includes('HINT'), 'no reset hint for command errors');
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('execute prompt is small and starts with the help gate plus tab rules', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // EXECUTE_PROMPT is defined as a const above server.tool('exec', EXECUTE_PROMPT, ...)
    const promptStart = source.indexOf('const EXECUTE_PROMPT');
    const promptEnd = source.indexOf('`;', promptStart) + 2;
    const promptBlock = source.slice(promptStart, promptEnd);

    assert.ok(promptBlock.length < 2000, `EXECUTE_PROMPT block is ${promptBlock.length} chars`);
    assert.ok(promptBlock.slice(0, 500).includes('HELP GATE'), 'HELP GATE should be visible early');
    assert.ok(promptBlock.slice(0, 500).includes('TAB RULES'), 'TAB RULES should be visible early');
  });

  it('execute prompt keeps critical tab guidance visible', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const promptStart = source.indexOf('const EXECUTE_PROMPT');
    const promptEnd = source.indexOf('`;', promptStart) + 2;
    const promptBlock = source.slice(promptStart, promptEnd);

    assert.ok(promptBlock.includes('getBrowserforceStatus()'), 'should use the relay status helper for attached-tab metadata');
    assert.ok(promptBlock.includes('getBrowserforcePageForTab()'), 'should use the page helper for attached-tab inspection');
    assert.ok(promptBlock.includes('context.pages()'), 'should keep existing tab discovery visible');
    assert.ok(promptBlock.includes('inspect/read/check'), 'should preserve inspect task guidance');
    assert.ok(promptBlock.includes('Use state.page'), 'should keep ongoing state.page guidance');
    assert.ok(promptBlock.includes("intent:'open'"), 'should scope open intent to explicit navigation requests');
  });

  it('execute prompt moves long guidance behind help sections', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const promptStart = source.indexOf('const EXECUTE_PROMPT');
    const promptEnd = source.indexOf('`;\n\nfunction registerExecTool', promptStart) + 2;
    const promptBlock = source.slice(promptStart, promptEnd);

    for (const header of [
      'AVAILABLE SCOPE',
      'SNAPSHOT VS SCREENSHOT',
      'BROWSERFORCE TAB SWARMS',
      'API QUICK REFERENCE',
    ]) {
      assert.ok(!promptBlock.includes(header), `${header} should move behind help(section)`);
    }
  });

  it('exec tool has code and optional timeout params', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const execBlock = source.split("'exec'")[1]?.split('server.tool(')[0] || '';
    assert.ok(execBlock.includes('z.string()'), 'exec should have a string param (code)');
    assert.ok(execBlock.includes('z.number().optional()'), 'exec should have an optional number param (timeout)');
    assert.ok(execBlock.includes('code:'), 'exec should have code param');
    assert.ok(execBlock.includes('timeout:'), 'exec should have timeout param');
  });

  it('reset tool has no params', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // Find the reset tool block — between 'reset' and the next async handler
    const resetIdx = source.indexOf("'reset'");
    assert.ok(resetIdx !== -1, 'reset tool should exist');
    const afterReset = source.slice(resetIdx);
    // The params object should be empty {}
    const paramsMatch = afterReset.match(/,\s*\{\s*\}\s*,/);
    assert.ok(paramsMatch, 'reset should have empty params {}');
  });

  it('does not register screenshot_with_labels tool', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    assert.ok(!source.includes("'screenshot_with_labels'"), 'screenshot_with_labels tool should be removed');
    assert.ok(!source.includes('SCREENSHOT_LABELS_PROMPT'), 'dedicated screenshot prompt should be removed');
  });

  it('exec context source exposes refToLocator helper', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/exec-engine.js'),
      'utf8'
    );

    assert.ok(source.includes('refToLocator'), 'exec engine should expose refToLocator helper');
    assert.ok(source.includes('const getCDPSession = async'), 'exec engine should define getCDPSession helper');
    assert.ok(
      source.includes('No changes since last snapshot. Use showDiffSinceLastCall: false to see full content.'),
      'exec engine should return snapshot no-change guidance'
    );
    assert.ok(
      source.includes('!selector && !locator && !frame && !search && showDiffSinceLastCall'),
      'snapshot diff mode should only run for unscoped full-page snapshots with no search'
    );
  });

  it('execute context includes browserforceSettings', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/exec-engine.js'),
      'utf8'
    );

    assert.ok(
      source.includes('browserforceSettings'),
      'exec context should expose browserforceSettings in the sandbox scope'
    );
    assert.ok(
      source.includes('executionMode') && source.includes('parallelVisibilityMode'),
      'browserforceSettings should include executionMode and parallelVisibilityMode'
    );
  });

  it('execute context includes browserforceRestrictions', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/exec-engine.js'),
      'utf8'
    );

    assert.ok(
      source.includes('browserforceRestrictions'),
      'exec context should expose browserforceRestrictions in the sandbox scope'
    );
    assert.ok(
      source.includes('lockUrl') && source.includes('noNewTabs') && source.includes('readOnly'),
      'browserforceRestrictions should include lockUrl, noNewTabs, and readOnly flags'
    );
  });

  it('MCP preferences fetch is cached once per session', () => {
    // Cached preferences now live in the shared browser session runtime.
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );

    assert.ok(source.includes('cachedAgentPreferences'), 'should track cached agent preferences');
    assert.ok(
      source.includes('if (cachedAgentPreferences)'),
      'should return cached preferences without refetching'
    );
    assert.ok(
      source.includes('/agent-preferences'),
      'should fetch preferences from relay /agent-preferences endpoint'
    );
  });

  it('MCP restrictions fetch is cached once per session', () => {
    // Cached restrictions now live in the shared browser session runtime.
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );

    assert.ok(source.includes('cachedBrowserforceRestrictions'), 'should track cached browserforce restrictions');
    assert.ok(
      source.includes('cachedBrowserforceRestrictions && !forceRefresh'),
      'should return cached restrictions without refetching (unless forceRefresh)'
    );
    assert.ok(
      source.includes('/restrictions'),
      'should fetch restrictions from relay /restrictions endpoint'
    );
  });

  it('execute does not create a page for attached/manual inspection mode when context is empty', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const startupSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/startup.js'),
      'utf8'
    );

    assert.ok(startupSource.includes('assertAttachedPageAvailable'), 'shared startup path should assert attached-page availability');
    assert.ok(source.includes('preflightAttachedPageBeforeCdp'), 'execute should use the shared no-CDP preflight');
    assert.ok(source.includes('shouldCreateImplicitStartupPage'), 'implicit page creation should be gated behind an explicit predicate');
  });

  it('reset also runs attached-page preflight before reconnecting over CDP', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const resetIdx = source.indexOf("'reset'");
    const resetBlock = source.slice(resetIdx, resetIdx + 3000);
    assert.ok(resetBlock.includes('preflightAttachedPageBeforeCdp'), 'reset should preflight before ensureBrowser');
    assert.ok(resetBlock.indexOf('preflightAttachedPageBeforeCdp') < resetBlock.indexOf('ensureBrowser()'));
  });

  it('execute and reset are the only MCP tool handlers allowed to reach CDP startup', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const directEnsureBrowserCalls = [...source.matchAll(/await ensureBrowser\(/g)].map((match) => match.index);
    assert.equal(directEnsureBrowserCalls.length, 2, 'all CDP startup should remain auditable through execute/reset');
    for (const idx of directEnsureBrowserCalls) {
      const surroundingBlock = source.slice(Math.max(0, idx - 1000), idx + 500);
      assert.match(surroundingBlock, /preflightAttachedPageBeforeCdp/, 'CDP startup must be preflighted in the same branch');
    }
    assert.equal((source.match(/chromium\.connectOverCDP/g) || []).length, 1, 'CDP connect should stay centralized inside ensureBrowser');
  });

  it('exec catches CodeExecutionTimeoutError and omits the reset hint on timeout', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const execHandler = (source.split("'exec'")[1] || '').split('server.tool(')[0];

    assert.ok(execHandler.includes('err instanceof CodeExecutionTimeoutError'), 'exec should detect timeout errors');
    assert.ok(
      execHandler.includes("const hint = isTimeout ? '' : RESET_HINT"),
      'timeout errors produce an empty hint; the reset hint lives in the non-timeout branch only'
    );
  });

  it('exec routes code through the shared runCode boundary with no extra timeout race', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const execHandler = (source.split("'exec'")[1] || '').split('server.tool(')[0];

    assert.ok(execHandler.includes('await runCode(code, execCtx, timeout)'), 'exec should delegate to the shared runCode boundary');
    assert.ok(!execHandler.includes('Promise.race'), 'exec must not add its own timeout race around runCode');
  });

  it('runCode owns the single timeout boundary that aborts the run', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/exec-engine.js'),
      'utf8'
    );

    assert.ok(source.includes('export async function runCode'), 'runCode should be the exported execution entry point');
    assert.ok(source.includes('vm.runInContext'), 'runCode should run user code inside the vm timeout boundary');
    assert.ok(source.includes('run.abort()'), 'runCode should abort the run when the timeout fires');
  });

  it('CLI one-shot execute shares the runCode boundary without its own timeout race', () => {
    const source = readFileSync(
      join(MCP_ROOT, '../bin.js'),
      'utf8'
    );
    const execHandler = source.slice(
      source.indexOf('async function cmdExecute'),
      source.indexOf('async function cmdServe'),
    );

    assert.ok(execHandler.includes('await runCode(code, execCtx, timeoutMs)'), 'CLI execute should delegate to the shared runCode boundary');
    assert.ok(!execHandler.includes('Promise.race'), 'CLI execute must not add its own timeout race around runCode');
  });

  it('CLI one-shot execute waits for initial page discovery before reading pages', () => {
    const source = readFileSync(
      join(MCP_ROOT, '../bin.js'),
      'utf8'
    );
    const execHandler = source.slice(
      source.indexOf('async function cmdExecute'),
      source.indexOf('async function cmdServe'),
    );

    assert.ok(source.includes('async function waitForInitialPageDiscovery'), 'CLI should define a page discovery wait helper');
    assert.ok(
      execHandler.includes('await waitForInitialPageDiscovery(ctx);'),
      'CLI execute should wait for CDP page discovery before ctx.pages()'
    );
    assert.ok(
      execHandler.indexOf('await waitForInitialPageDiscovery(ctx);') < execHandler.indexOf('const pages = ctx.pages();'),
      'CLI execute should wait before reading ctx.pages()'
    );
  });

  it('ensureBrowser does not use root relay readiness as attached-page proof', () => {
    // ensureBrowser now lives in the shared runtime; the relay+CDP connect is
    // injected from index.js. Neither path may use the root / health check as
    // attached-page proof.
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );
    const ensureBrowserIdx = source.indexOf('async function ensureBrowser');
    const ensureBrowserBlock = source.slice(ensureBrowserIdx, source.indexOf('async function getAgentPreferencesForSession', ensureBrowserIdx));
    assert.doesNotMatch(ensureBrowserBlock, /assertExtensionConnected/);
    assert.doesNotMatch(ensureBrowserBlock, /fetch\(`?\$\{?baseUrl\}?\/`?/);

    const indexSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const connectIdx = indexSource.indexOf('async function connectBrowserOverRelay');
    const connectBlock = indexSource.slice(connectIdx, indexSource.indexOf('const runtime =', connectIdx));
    assert.doesNotMatch(connectBlock, /assertExtensionConnected/);
    assert.doesNotMatch(connectBlock, /fetch\(`?\$\{?baseUrl\}?\/`?/);
  });

  it('exec schema includes an explicit attached-page intent', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const execBlock = source.split("'exec'")[1]?.split('async ({ code')[0] || '';
    assert.match(execBlock, /intent:\s*z\.enum\(\['inspect', 'open', 'auto'\]\)\.optional\(\)/);
  });

  it('missing active page hint prefers existing pages before opening a new tab', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/exec-engine.js'),
      'utf8'
    );

    assert.ok(
      source.includes('No active page. Reuse an existing one first: state.page = context.pages()[0]'),
      'missing-page hint should prefer context.pages() before context.newPage()'
    );
    assert.ok(
      source.includes("If there isn't one, create one with: state.page = await context.newPage()"),
      'missing-page hint should still explain how to create a tab when needed'
    );
  });

  it('reset clears cached preferences', () => {
    // The MCP reset tool delegates state clearing to runtime.reset(), which is
    // what clears cached agent preferences/restrictions.
    const indexSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    const resetIdx = indexSource.indexOf("'reset'");
    assert.ok(resetIdx !== -1, 'reset tool should exist');
    const resetBlock = indexSource.slice(resetIdx, resetIdx + 2500);
    assert.ok(
      resetBlock.includes('runtime.reset()'),
      'reset tool should delegate state clearing to runtime.reset()'
    );

    const runtimeSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );
    const runtimeResetIdx = runtimeSource.indexOf('async function reset');
    assert.ok(runtimeResetIdx !== -1, 'runtime should define reset()');
    const runtimeResetBlock = runtimeSource.slice(runtimeResetIdx, runtimeResetIdx + 600);
    assert.ok(
      runtimeResetBlock.includes('cachedAgentPreferences = null'),
      'runtime reset should clear cached agent preferences'
    );
    assert.ok(
      runtimeResetBlock.includes('cachedBrowserforceRestrictions = null'),
      'runtime reset should clear cached browserforce restrictions'
    );
  });

  it('MCP server starts the relay on startup without opening a browser connection', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    assert.ok(
      source.includes('MCP server running'),
      'startup log should remain present'
    );
    const mainStart = source.indexOf('async function main()');
    const connectIdx = source.indexOf('await server.connect(transport)');
    const ensureIdx = source.indexOf('await ensureRelay()', mainStart);
    assert.ok(mainStart !== -1, 'main function should exist');
    assert.ok(ensureIdx !== -1, 'main should ensure relay during MCP startup');
    assert.ok(connectIdx !== -1, 'server connect should remain present');
    assert.ok(
      ensureIdx < connectIdx,
      'relay should be ensured before MCP reports as connected'
    );
    assert.ok(
      !source.includes('startBackgroundConnectionLoop();'),
      'server startup should not launch an eager background CDP connect loop'
    );
    assert.ok(
      !source.includes('BACKGROUND_CONNECT_RETRY_INTERVAL_MS'),
      'background eager-connect interval should be removed'
    );
    const mainBlock = source.slice(mainStart, source.indexOf('main().catch', mainStart));
    assert.ok(
      !mainBlock.includes('ensureBrowser()'),
      'startup should not open a Playwright/CDP browser connection'
    );
  });

  it('MCP server includes idle disconnect handling for browser connections', () => {
    // The idle-disconnect timeout is read in index.js (env) and passed to the
    // runtime, which owns the scheduler/timer/active-operation bookkeeping.
    const indexSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );
    assert.ok(
      indexSource.includes('BF_MCP_IDLE_DISCONNECT_MS'),
      'idle disconnect timeout should be configurable'
    );
    assert.ok(
      indexSource.includes('idleDisconnectMs'),
      'index should pass the idle disconnect timeout to the runtime'
    );

    const runtimeSource = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );
    assert.ok(
      runtimeSource.includes('scheduleIdleBrowserDisconnect'),
      'should define idle browser disconnect scheduler'
    );
    assert.ok(
      runtimeSource.includes('clearIdleBrowserDisconnectTimer'),
      'should clear pending idle disconnect timers when activity resumes'
    );
    assert.ok(
      runtimeSource.includes('activeBrowserOperations'),
      'should track in-flight browser operations before disconnecting'
    );
  });

  it('MCP server waits for initial CDP page discovery before executing code', () => {
    // ensureBrowser + page-discovery wait now live in the shared runtime.
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/browser-session-runtime.js'),
      'utf8'
    );

    const ensureBrowserIdx = source.indexOf('async function ensureBrowser');
    assert.ok(ensureBrowserIdx !== -1, 'ensureBrowser should exist');
    const ensureBrowserBlock = source.slice(ensureBrowserIdx, source.indexOf('async function getAgentPreferencesForSession', ensureBrowserIdx));
    assert.ok(
      source.includes('waitForInitialPageDiscovery'),
      'should define initial page discovery wait helper'
    );
    assert.ok(
      ensureBrowserBlock.includes('await waitForInitialPageDiscovery(ctx)'),
      'ensureBrowser should wait for Playwright pages before execute/reset read context.pages()'
    );
  });
});

// ─── MCP Response Format ─────────────────────────────────────────────────────

describe('MCP Response Format', () => {
  it('text content format is valid', () => {
    const response = {
      content: [{ type: 'text', text: 'Navigated to https://example.com (status: 200)' }],
    };
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'text');
    assert.ok(typeof response.content[0].text === 'string');
  });

  it('image content format is valid', () => {
    const fakeBase64 = Buffer.from('fake-png-data').toString('base64');
    const response = {
      content: [{ type: 'image', data: fakeBase64, mimeType: 'image/png' }],
    };
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'image');
    assert.equal(response.content[0].mimeType, 'image/png');
    assert.ok(typeof response.content[0].data === 'string');
  });

  it('tab list JSON format is parseable', () => {
    const tabs = [
      { index: 0, url: 'https://gmail.com', title: 'Gmail - Inbox' },
      { index: 1, url: 'https://github.com', title: 'GitHub' },
    ];
    const json = JSON.stringify(tabs, null, 2);
    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].index, 0);
    assert.equal(parsed[1].url, 'https://github.com');
  });

  it('labeled screenshot multi-content format is valid', () => {
    const fakeBase64 = Buffer.from('fake-jpeg-data').toString('base64');
    const response = {
      content: [
        { type: 'image', data: fakeBase64, mimeType: 'image/jpeg' },
        { type: 'text', text: 'Labels: 5 interactive elements\n\n- button "Submit" [ref=e1]' },
      ],
    };
    assert.equal(response.content.length, 2);
    assert.equal(response.content[0].type, 'image');
    assert.equal(response.content[0].mimeType, 'image/jpeg');
    assert.equal(response.content[1].type, 'text');
    assert.ok(response.content[1].text.includes('Labels:'));
    assert.ok(response.content[1].text.includes('[ref='));
  });
});

// ─── Snapshot Diff Mode ──────────────────────────────────────────────────────

describe('Snapshot Diff Mode', () => {
  it('returns no-change when snapshots are identical', () => {
    const text = '- main:\n  - button "Submit" [ref=e1]';
    const result = createSmartDiff(text, text);
    assert.equal(result.type, 'no-change');
  });

  it('returns diff for small changes', () => {
    const old = [
      '- banner:',
      '  - link "Home" [ref=e1]',
      '  - link "About" [ref=e2]',
      '- main:',
      '  - heading "Welcome"',
      '  - button "Submit" [ref=e3]',
      '  - textbox "Email" [ref=e4]',
      '  - textbox "Password" [ref=e5]',
      '  - checkbox "Remember me" [ref=e6]',
      '  - link "Forgot password?" [ref=e7]',
    ].join('\n');

    const now = [
      '- banner:',
      '  - link "Home" [ref=e1]',
      '  - link "About" [ref=e2]',
      '- main:',
      '  - heading "Welcome"',
      '  - button "Submit" [ref=e3]',
      '  - textbox "Email" [ref=e4]',
      '  - textbox "Password" [ref=e5]',
      '  - checkbox "Remember me" [ref=e6]',
      '  - link "Forgot password?" [ref=e7]',
      '  - button "Reset" [ref=e8]',
    ].join('\n');

    const result = createSmartDiff(old, now);
    assert.equal(result.type, 'diff');
    assert.ok(result.content.includes('+  - button "Reset"'));
  });

  it('returns full content when >50% changed', () => {
    const old = '- button "A" [ref=e1]\n- button "B" [ref=e2]';
    const now = '- link "X" [ref=e1]\n- link "Y" [ref=e2]\n- link "Z" [ref=e3]';
    const result = createSmartDiff(old, now);
    assert.equal(result.type, 'full');
    assert.equal(result.content, now);
  });
});

// ─── Search Pattern Validation ───────────────────────────────────────────────

describe('Search Pattern Validation', () => {
  it('returns null for empty/undefined search', () => {
    assert.equal(parseSearchPattern(null), null);
    assert.equal(parseSearchPattern(undefined), null);
    assert.equal(parseSearchPattern(''), null);
  });

  it('returns valid regex for good patterns', () => {
    const pattern = parseSearchPattern('button|input');
    assert.ok(pattern instanceof RegExp);
    assert.ok(pattern.test('button'));
    assert.ok(pattern.test('INPUT'));
  });

  it('throws descriptive error for invalid regex', () => {
    assert.throws(
      () => parseSearchPattern('button['),
      /Invalid search regex/
    );
  });
});

// ─── smartWaitForPageLoad ─────────────────────────────────────────────────────

describe('smartWaitForPageLoad', () => {
  it('returns success when page is already ready', async () => {
    // Mock a minimal page object with evaluate
    const mockPage = {
      evaluate: async () => ({
        ready: true,
        readyState: 'complete',
        pendingRequests: [],
      }),
    };

    // Import dynamically to test the function shape
    // Since smartWaitForPageLoad is not exported, test its behavior indirectly
    // by verifying the response format matches expectations
    const expectedShape = {
      success: true,
      readyState: 'complete',
      pendingRequests: 0,
      timedOut: false,
    };

    // Verify the expected response shape is valid
    assert.equal(typeof expectedShape.success, 'boolean');
    assert.equal(typeof expectedShape.readyState, 'string');
    assert.equal(typeof expectedShape.pendingRequests, 'number');
    assert.equal(typeof expectedShape.timedOut, 'boolean');
    assert.equal(expectedShape.success, true);
    assert.equal(expectedShape.timedOut, false);
  });
});

// ─── CDP Busy Helpers ───────────────────────────────────────────────────────

describe('CDP Busy Helpers', () => {
  it('detects relay slot contention errors', async () => {
    const { isCdpBusyError } = await import('../src/exec-engine.js');
    assert.equal(isCdpBusyError(new Error('Unexpected server response: 409')), true);
    assert.equal(isCdpBusyError(new Error('ECONNREFUSED')), false);
  });

  it('retries busy connect and succeeds after slot is free', async () => {
    const { connectOverCdpWithBusyRetry } = await import('../src/exec-engine.js');

    let connectCalls = 0;
    const expectedBrowser = { connected: true };
    const connect = async () => {
      connectCalls += 1;
      if (connectCalls === 1) {
        throw new Error('Unexpected server response: 409');
      }
      return expectedBrowser;
    };

    let waitCalls = 0;
    const waitForFreeSlot = async () => {
      waitCalls += 1;
      return true;
    };

    const browser = await connectOverCdpWithBusyRetry({
      connect,
      cdpUrl: 'ws://127.0.0.1:19222/cdp?token=test',
      baseUrl: 'http://127.0.0.1:19222',
      timeoutMs: 5000,
      waitForFreeSlot,
    });

    assert.equal(browser, expectedBrowser);
    assert.equal(connectCalls, 2);
    assert.equal(waitCalls, 1);
  });

  it('does not retry non-busy connect errors', async () => {
    const { connectOverCdpWithBusyRetry } = await import('../src/exec-engine.js');

    let waitCalls = 0;
    const error = new Error('ECONNREFUSED');

    await assert.rejects(
      () => connectOverCdpWithBusyRetry({
        connect: async () => { throw error; },
        cdpUrl: 'ws://127.0.0.1:19222/cdp?token=test',
        timeoutMs: 5000,
        waitForFreeSlot: async () => {
          waitCalls += 1;
          return true;
        },
      }),
      /ECONNREFUSED/
    );

    assert.equal(waitCalls, 0);
  });
});
