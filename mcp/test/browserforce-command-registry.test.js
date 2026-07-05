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
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';

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

// ─── Real runtime over a fake browser (for tab-management commands) ──────────
// Tab commands (tabs/use/open/rename/forget) act through the runtime's tab
// APIs rather than generated snippets, so they are tested against the REAL
// createBrowserSessionRuntime with a fake Playwright browser underneath.

function fakePage({ url = 'about:blank', title = '' } = {}) {
  let closed = false;
  const page = {
    isClosed: () => closed,
    closeNow: () => { closed = true; },
    url: () => page._url,
    title: async () => page._title,
    goto: async (next) => { page._url = next; },
    close: async () => { closed = true; },
    on() {},
    mainFrame() { return 'main-frame'; },
  };
  page._url = url;
  page._title = title;
  return page;
}

function tabRuntimeEnv({ pages = [], restrictions = null } = {}) {
  const list = [...pages];
  const context = {
    on() {},
    pages: () => list,
    newPage: async () => {
      const page = fakePage({ title: 'New Tab' });
      list.push(page);
      return page;
    },
  };
  const browser = {
    isConnected: () => true,
    contexts: () => [context],
    on() {},
    close: async () => {},
  };
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => browser,
    getRelayHttpUrl: () => 'http://relay.test',
    // Restrictions default to none unless the test injects some.
    fetch: async (url) => {
      if (restrictions && url.endsWith('/restrictions')) {
        return { ok: true, json: async () => restrictions };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const run = (command, timeout) => executeBrowserforceCommand({ command, runtime, timeout });
  return { runtime, run, pages: list };
}

describe('tab commands: tabs / use / open / rename / forget', () => {
  it('tabs returns structured rows with stable handles, active marker, and names', async () => {
    const docs = fakePage({ url: 'https://docs.test/', title: 'Docs' });
    const app = fakePage({ url: 'https://app.test/', title: 'App' });
    const { runtime, run } = tabRuntimeEnv({ pages: [docs, app] });
    runtime.setNamedPage('docs', docs);
    runtime.setActivePage(app);

    const { data } = await run('tabs');
    assert.deepEqual(data.tabs, [
      { handle: 't1', index: 0, title: 'Docs', url: 'https://docs.test/', active: false, name: 'docs' },
      { handle: 't2', index: 1, title: 'App', url: 'https://app.test/', active: true, name: null },
    ]);
  });

  it('the sessiond verb path returns the exact same tab rows as the command path', async () => {
    const docs = fakePage({ url: 'https://docs.test/', title: 'Docs' });
    const { runtime, run } = tabRuntimeEnv({ pages: [docs] });

    const { data: commandData } = await run('tabs');
    const verbData = await executeBrowserforceVerb({ verb: 'tabs', body: {}, runtime });
    assert.deepEqual(verbData, commandData, 'both surfaces render from the same structured rows');
  });

  it('use selects by stable handle, name, and soft URL match', async () => {
    const docs = fakePage({ url: 'https://docs.test/', title: 'Docs' });
    const mrr = fakePage({ url: 'https://app.heymantle.com/reports/mrr', title: 'MRR' });
    const { runtime, run } = tabRuntimeEnv({ pages: [docs, mrr] });

    const byHandle = await run('use t2');
    assert.equal(byHandle.data.active.handle, 't2');
    assert.equal(byHandle.data.matchedBy, 'handle');
    assert.equal(runtime.getActivePage(), mrr);

    runtime.setNamedPage('docs', docs);
    const byName = await run('use docs');
    assert.equal(byName.data.matchedBy, 'name');
    assert.equal(runtime.getActivePage(), docs);

    const byUrl = await run('use app.heymantle.com/reports/mrr');
    assert.equal(byUrl.data.matchedBy, 'url-substring');
    assert.equal(runtime.getActivePage(), mrr);
  });

  it('use <position> works but warns to use the stable handle next time', async () => {
    const a = fakePage({ title: 'A' });
    const b = fakePage({ title: 'B' });
    const { runtime, run } = tabRuntimeEnv({ pages: [a, b] });

    const { data } = await run('use 2');
    assert.equal(runtime.getActivePage(), b);
    assert.equal(data.matchedBy, 'index');
    assert.match(data.warning, /t2/, 'index selection warns with the stable handle');
  });

  it('ambiguous use fails listing candidates and never silently picks one', async () => {
    const a = fakePage({ url: 'https://one.test/', title: 'Dashboard' });
    const b = fakePage({ url: 'https://two.test/', title: 'Dashboard' });
    const { runtime, run } = tabRuntimeEnv({ pages: [a, b] });
    runtime.setActivePage(a);

    await assert.rejects(
      () => run('use Dashboard'),
      (err) => err instanceof BrowserforceCommandError
        && err.code === 'TAB_AMBIGUOUS'
        && /t1/.test(err.message) && /t2/.test(err.message)
        && err.resetHintAllowed === false,
    );
    assert.equal(runtime.getActivePage(), a, 'ambiguity leaves the active tab unchanged');
  });

  it('use with no match fails with a tabs suggestion and no reset hint', async () => {
    const { run } = tabRuntimeEnv({ pages: [fakePage({ title: 'A' })] });
    await assert.rejects(
      () => run('use nothing-matches-this'),
      (err) => err instanceof BrowserforceCommandError
        && err.code === 'TAB_NOT_FOUND'
        && /tabs/.test(err.suggestion)
        && err.resetHintAllowed === false,
    );
  });

  it('open creates a new active page and defaults bare domains to https', async () => {
    const { runtime, run, pages } = tabRuntimeEnv({ pages: [fakePage({ title: 'Existing' })] });

    const { data } = await run('open example.com');
    assert.equal(pages.length, 2, 'open created a page');
    assert.equal(pages[1]._url, 'https://example.com');
    assert.equal(runtime.getActivePage(), pages[1], 'open activates the new page');
    assert.equal(data.opened, 'https://example.com');
    assert.equal(data.tab.active, true);
  });

  it('open --as names the new page; duplicate names need --replace', async () => {
    const { runtime, run, pages } = tabRuntimeEnv({ pages: [] });

    await run('open https://docs.test --as docs');
    assert.equal(runtime.getNamedPage('docs'), pages[0]);

    await assert.rejects(
      () => run('open https://other.test --as docs'),
      (err) => err instanceof BrowserforceCommandError
        && err.code === 'TAB_NAME_IN_USE'
        && /--replace/.test(err.suggestion),
    );
    assert.equal(pages.length, 1, 'the losing open never created an orphan tab');

    await run('open https://other.test --as docs --replace');
    assert.equal(pages.length, 2);
    assert.equal(runtime.getNamedPage('docs'), pages[1], '--replace moves the name to the new tab');
    assert.equal(pages[0].isClosed(), false, 'the previously named tab stays open');
  });

  it('open respects noNewTabs/manual restrictions without creating a page', async () => {
    for (const restrictions of [{ noNewTabs: true }, { mode: 'manual' }]) {
      const { run, pages } = tabRuntimeEnv({ pages: [fakePage()], restrictions });
      await assert.rejects(
        () => run('open https://example.com'),
        (err) => err instanceof BrowserforceCommandError && err.code === 'NEW_TABS_DISABLED',
      );
      assert.equal(pages.length, 1, 'no tab is created when new tabs are disabled');
    }
  });

  it('rename moves a name and forget removes it', async () => {
    const docs = fakePage({ title: 'Docs' });
    const app = fakePage({ title: 'App' });
    const { runtime, run } = tabRuntimeEnv({ pages: [docs, app] });
    runtime.setNamedPage('docs', docs);

    const renamed = await run('rename docs api-docs');
    assert.deepEqual(renamed.data.renamed, { from: 'docs', to: 'api-docs', replaced: false });
    assert.equal(runtime.getNamedPage('api-docs'), docs);

    runtime.setNamedPage('app', app);
    await assert.rejects(
      () => run('rename app api-docs'),
      (err) => err.code === 'TAB_NAME_IN_USE' && /--replace/.test(err.suggestion),
    );
    const replaced = await run('rename app api-docs --replace');
    assert.equal(replaced.data.renamed.replaced, true);
    assert.equal(runtime.getNamedPage('api-docs'), app);

    const forgot = await run('forget api-docs');
    assert.deepEqual(forgot.data, { forgot: 'api-docs' });
    await assert.rejects(
      () => run('forget api-docs'),
      (err) => err.code === 'TAB_NAME_NOT_FOUND' && /tabs/.test(err.suggestion),
    );
  });
});

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
