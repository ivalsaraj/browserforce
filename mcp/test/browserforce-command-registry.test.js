// Tests for the shared BrowserForce command registry (parser + execution).
// The registry is the single command surface behind the MCP `browserforce`
// tool, the CLI direct verbs, and the sessiond HTTP verbs.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  parseBrowserforceCommand,
  executeBrowserforceCommand,
  executeBrowserforceVerb,
  normalizeRef,
  BrowserforceCommandError,
} from '../src/browserforce-command-registry.js';

// Fake runtime that records runCommand() calls — proves every action routes
// through the guarded runtime boundary with the expected generated snippet.
function fakeRuntime(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    async runCommand(opts) {
      calls.push(opts);
      return result;
    },
  };
}

describe('parseBrowserforceCommand', () => {
  it('parses bare verbs', () => {
    assert.deepEqual(parseBrowserforceCommand('tabs'), {
      verb: 'tabs',
      args: [],
      flags: {},
      command: 'tabs',
    });
    assert.deepEqual(parseBrowserforceCommand('snapshot'), {
      verb: 'snapshot',
      args: [],
      flags: {},
      command: 'snapshot',
    });
  });

  it('parses ref commands', () => {
    assert.deepEqual(parseBrowserforceCommand('click @e2'), {
      verb: 'click',
      args: ['@e2'],
      flags: {},
      command: 'click @e2',
    });
    assert.deepEqual(parseBrowserforceCommand('hover @e2'), {
      verb: 'hover',
      args: ['@e2'],
      flags: {},
      command: 'hover @e2',
    });
  });

  it('keeps unquoted multiword text as positional args', () => {
    assert.deepEqual(parseBrowserforceCommand('fill @e3 hello world'), {
      verb: 'fill',
      args: ['@e3', 'hello', 'world'],
      flags: {},
      command: 'fill @e3 hello world',
    });
  });

  it('groups quoted strings into single args', () => {
    assert.deepEqual(parseBrowserforceCommand('fill @e3 "hello world"').args, ['@e3', 'hello world']);
    assert.deepEqual(parseBrowserforceCommand("fill @e3 'hello world'").args, ['@e3', 'hello world']);
    assert.deepEqual(parseBrowserforceCommand('wait text "Saved"').args, ['text', 'Saved']);
    assert.deepEqual(parseBrowserforceCommand('eval "return page.url()"').args, ['return page.url()']);
  });

  it('parses get with sub-targets', () => {
    assert.deepEqual(parseBrowserforceCommand('get html @e5'), {
      verb: 'get',
      args: ['html', '@e5'],
      flags: {},
      command: 'get html @e5',
    });
    assert.deepEqual(parseBrowserforceCommand('get url').args, ['url']);
  });

  it('parses open with --as and --replace', () => {
    assert.deepEqual(parseBrowserforceCommand('open https://example.com --as docs'), {
      verb: 'open',
      args: ['https://example.com'],
      flags: { as: 'docs' },
      command: 'open https://example.com --as docs',
    });
    assert.deepEqual(
      parseBrowserforceCommand('open https://example.com/app --as docs --replace').flags,
      { as: 'docs', replace: true },
    );
  });

  it('parses --flag=value form', () => {
    assert.deepEqual(parseBrowserforceCommand('snapshot --tab=docs').flags, { tab: 'docs' });
  });

  it('parses --tab routing flags', () => {
    assert.deepEqual(parseBrowserforceCommand('snapshot --tab docs'), {
      verb: 'snapshot',
      args: [],
      flags: { tab: 'docs' },
      command: 'snapshot --tab docs',
    });
    assert.deepEqual(parseBrowserforceCommand('click @e2 --tab app').flags, { tab: 'app' });
  });

  it('parses use with handles and soft-match text', () => {
    assert.deepEqual(parseBrowserforceCommand('use t3'), {
      verb: 'use',
      args: ['t3'],
      flags: {},
      command: 'use t3',
    });
    assert.deepEqual(parseBrowserforceCommand('use Mantle MRR').args, ['Mantle', 'MRR']);
  });

  it('parses rename and forget', () => {
    assert.deepEqual(parseBrowserforceCommand('rename docs api-docs'), {
      verb: 'rename',
      args: ['docs', 'api-docs'],
      flags: {},
      command: 'rename docs api-docs',
    });
    assert.deepEqual(parseBrowserforceCommand('forget docs').args, ['docs']);
  });

  it('parses help', () => {
    assert.deepEqual(parseBrowserforceCommand('help').verb, 'help');
  });

  it('trims surrounding whitespace but preserves the original command text', () => {
    const parsed = parseBrowserforceCommand('  tabs  ');
    assert.equal(parsed.verb, 'tabs');
    assert.equal(parsed.command, 'tabs');
  });

  it('rejects unknown commands with a structured teaching error', () => {
    let err = null;
    try {
      parseBrowserforceCommand('frobnicate @e2');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof BrowserforceCommandError, 'should throw BrowserforceCommandError');
    assert.equal(err.code, 'UNKNOWN_COMMAND');
    assert.ok(err.message.length < 200, 'message should be short');
    assert.match(err.suggestion, /browserforce "help"/);
    assert.equal(err.resetHintAllowed, false);
  });

  it('rejects empty commands', () => {
    assert.throws(
      () => parseBrowserforceCommand('   '),
      (err) => err instanceof BrowserforceCommandError && err.code === 'EMPTY_COMMAND',
    );
    assert.throws(
      () => parseBrowserforceCommand(null),
      (err) => err instanceof BrowserforceCommandError && err.code === 'EMPTY_COMMAND',
    );
  });

  it('rejects unknown flags loudly with a help suggestion and no reset hint', () => {
    let err = null;
    try {
      parseBrowserforceCommand('click @e2 --bogus');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof BrowserforceCommandError);
    assert.equal(err.code, 'UNKNOWN_FLAG');
    assert.match(err.message, /--bogus/);
    assert.match(err.suggestion, /browserforce "help"/);
    assert.equal(err.resetHintAllowed, false);
  });

  it('rejects flags that are missing a required value', () => {
    let err = null;
    try {
      parseBrowserforceCommand('snapshot --tab');
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof BrowserforceCommandError);
    assert.equal(err.code, 'MISSING_FLAG_VALUE');
    assert.match(err.message, /--tab/);
    assert.equal(err.resetHintAllowed, false);
  });

  it('rejects a value-flag immediately followed by another flag', () => {
    assert.throws(
      () => parseBrowserforceCommand('open https://example.com --as --replace'),
      (err) => err instanceof BrowserforceCommandError && err.code === 'MISSING_FLAG_VALUE',
    );
  });

  it('rejects unterminated quotes', () => {
    assert.throws(
      () => parseBrowserforceCommand('fill @e3 "hello'),
      (err) => err instanceof BrowserforceCommandError && err.code === 'BAD_QUOTING',
    );
  });
});

describe('executeBrowserforceCommand → runtime.runCommand snippets', () => {
  it('snapshot routes through snapshotData()', async () => {
    const runtime = fakeRuntime();
    const { data } = await executeBrowserforceCommand({ command: 'snapshot', runtime });
    assert.deepEqual(data, { ok: true });
    assert.equal(runtime.calls.length, 1);
    assert.match(runtime.calls[0].code, /return await snapshotData\(/);
    assert.match(runtime.calls[0].code, /"interactiveOnly":false/);
    assert.equal(runtime.calls[0].timeout, 30000);
  });

  it('snapshot forwards --selector/--search/--interactive', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'snapshot --selector "#main" --search save --interactive', runtime });
    assert.match(runtime.calls[0].code, /"selector":"#main"/);
    assert.match(runtime.calls[0].code, /"search":"save"/);
    assert.match(runtime.calls[0].code, /"interactiveOnly":true/);
  });

  it('click @e2 resolves the ref via locatorForRef and clicks', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'click @e2', runtime });
    const { code } = runtime.calls[0];
    assert.match(code, /locatorForRef\(\{ ref: "e2" \}\)/);
    assert.match(code, /await locator\.click\(\);/);
    assert.match(code, /clicked/);
  });

  it('hover @e2 hovers through the same guarded path', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'hover @e2', runtime });
    const { code } = runtime.calls[0];
    assert.match(code, /locatorForRef\(\{ ref: "e2" \}\)/);
    assert.match(code, /await locator\.hover\(\);/);
    assert.match(code, /hovered/);
  });

  it('fill @e3 "hello" fills JSON-encoded text', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'fill @e3 "hello"', runtime });
    const { code } = runtime.calls[0];
    assert.match(code, /locatorForRef\(\{ ref: "e3" \}\)/);
    assert.match(code, /await locator\.fill\("hello"\);/);
  });

  it('fill joins unquoted multiword text', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'fill @e3 hello world', runtime });
    assert.match(runtime.calls[0].code, /await locator\.fill\("hello world"\);/);
  });

  it('type @e4 "abc" types sequentially', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'type @e4 "abc"', runtime });
    assert.match(runtime.calls[0].code, /await locator\.pressSequentially\("abc"\);/);
  });

  it('press Enter presses the key on the page', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'press Enter', runtime });
    assert.match(runtime.calls[0].code, /await page\.keyboard\.press\("Enter"\);/);
  });

  it('wait text "Saved" polls case-insensitively and gets runCode headroom', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'wait text "Saved"', runtime, timeout: 10000 });
    const call = runtime.calls[0];
    assert.match(call.code, /waitForFunction/);
    assert.match(call.code, /"Saved"/);
    assert.match(call.code, /toLocaleLowerCase/);
    assert.equal(call.timeout, 15000, 'wait gets +5000ms headroom beyond the inner waiter');
  });

  it('wait url / load / selector build the right waiters', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'wait url "**/done"', runtime });
    assert.match(runtime.calls[0].code, /waitForURL\("\*\*\/done"/);
    await executeBrowserforceCommand({ command: 'wait load networkidle', runtime });
    assert.match(runtime.calls[1].code, /waitForLoadState\("networkidle"/);
    await executeBrowserforceCommand({ command: 'wait load', runtime });
    assert.match(runtime.calls[2].code, /waitForLoadState\("load"/);
    await executeBrowserforceCommand({ command: 'wait selector "#done"', runtime });
    assert.match(runtime.calls[3].code, /waitForSelector\("#done"/);
  });

  it('get url / title read from the page', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'get url', runtime });
    assert.match(runtime.calls[0].code, /return \{ url: page\.url\(\) \};/);
    await executeBrowserforceCommand({ command: 'get title', runtime });
    assert.match(runtime.calls[1].code, /return \{ title: await page\.title\(\) \};/);
  });

  it('get text @e2 and get html @e5 read through stored refs', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'get text @e2', runtime });
    assert.match(runtime.calls[0].code, /locatorForRef\(\{ ref: "e2" \}\)/);
    assert.match(runtime.calls[0].code, /await locator\.textContent\(\)/);
    await executeBrowserforceCommand({ command: 'get html @e5', runtime });
    assert.match(runtime.calls[1].code, /locatorForRef\(\{ ref: "e5" \}\)/);
    assert.match(runtime.calls[1].code, /await locator\.innerHTML\(\)/);
  });

  it('eval passes the user code straight into the guarded boundary', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceCommand({ command: 'eval "return page.url()"', runtime });
    assert.equal(runtime.calls[0].code, 'return page.url()');
  });

  it('help returns the command reference without touching the runtime', async () => {
    const runtime = fakeRuntime();
    const { data } = await executeBrowserforceCommand({ command: 'help', runtime });
    assert.match(data, /snapshot/);
    assert.match(data, /click <ref>/);
    assert.equal(runtime.calls.length, 0);
  });

  it('validation failures throw structured errors without reset hints', async () => {
    const runtime = fakeRuntime();
    for (const command of ['click', 'fill @e3', 'press', 'wait bogus x', 'get bogus', 'eval ""']) {
      let err = null;
      try {
        await executeBrowserforceCommand({ command, runtime });
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof BrowserforceCommandError, `${command} should throw structured error`);
      assert.equal(err.resetHintAllowed, false, `${command} must not allow reset hints`);
    }
    assert.equal(runtime.calls.length, 0, 'validation failures never reach the runtime');
  });
});

describe('executeBrowserforceVerb (sessiond JSON body path)', () => {
  it('runs the same executor as the command path', async () => {
    const runtime = fakeRuntime();
    const data = await executeBrowserforceVerb({
      verb: 'click',
      body: { ref: '@e1' },
      runtime,
    });
    assert.deepEqual(data, { ok: true });
    assert.match(runtime.calls[0].code, /locatorForRef\(\{ ref: "e1" \}\)/);
  });

  it('honors body.timeout like sessiond did', async () => {
    const runtime = fakeRuntime();
    await executeBrowserforceVerb({ verb: 'press', body: { key: 'Enter', timeout: 12000 }, runtime });
    assert.equal(runtime.calls[0].timeout, 12000);
  });

  it('throws UNKNOWN_VERB for unimplemented verbs (sessiond maps to 501)', async () => {
    await assert.rejects(
      executeBrowserforceVerb({ verb: 'bogus', body: {}, runtime: fakeRuntime() }),
      (err) => err instanceof BrowserforceCommandError && err.code === 'UNKNOWN_VERB'
        && /command not implemented: bogus/.test(err.message),
    );
  });
});

describe('normalizeRef (registry copy)', () => {
  it('normalizes @e1, e1, and ref=e1 to the same canonical ref', () => {
    assert.equal(normalizeRef('@e1'), 'e1');
    assert.equal(normalizeRef('e1'), 'e1');
    assert.equal(normalizeRef('ref=e1'), 'e1');
    assert.equal(normalizeRef(' REF=e2 '), 'e2');
    assert.equal(normalizeRef(null), '');
  });
});

describe('BrowserforceCommandError', () => {
  it('carries code, message, suggestion, and resetHintAllowed', () => {
    const err = new BrowserforceCommandError('nope', {
      code: 'TEST',
      suggestion: 'do the thing',
      resetHintAllowed: true,
    });
    assert.equal(err.message, 'nope');
    assert.equal(err.code, 'TEST');
    assert.equal(err.suggestion, 'do the thing');
    assert.equal(err.resetHintAllowed, true);
    assert.ok(err instanceof Error);
  });

  it('defaults resetHintAllowed to false', () => {
    const err = new BrowserforceCommandError('nope', { code: 'TEST' });
    assert.equal(err.resetHintAllowed, false);
    assert.equal(err.suggestion, null);
  });
});
