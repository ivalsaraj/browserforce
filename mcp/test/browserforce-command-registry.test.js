// Tests for the shared BrowserForce command registry (parser + execution).
// The registry is the single command surface behind the MCP `browserforce`
// tool, the CLI direct verbs, and the sessiond HTTP verbs.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  parseBrowserforceCommand,
  BrowserforceCommandError,
} from '../src/browserforce-command-registry.js';

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
