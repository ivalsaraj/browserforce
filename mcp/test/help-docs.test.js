import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getHelpSection,
  listHelpSections,
} from '../src/help-docs.js';

describe('MCP help docs', () => {
  it('lists section metadata', () => {
    const sections = listHelpSections();

    assert.ok(sections.length > 0);
    for (const section of sections) {
      assert.equal(typeof section.name, 'string');
      assert.equal(typeof section.title, 'string');
      assert.equal(typeof section.summary, 'string');
    }
  });

  it('puts the browserforce-first command workflow at the top of the section list', () => {
    const sections = listHelpSections();
    assert.equal(sections[0].name, 'commands', 'commands is the first help section');

    const commands = getHelpSection('commands');
    assert.match(commands, /Use browserforce first/);
    assert.match(commands, /browserforce "tabs"/);
    assert.match(commands, /browserforce "use t1"/);
    assert.match(commands, /browserforce "snapshot"/);
    assert.match(commands, /browserforce "click @e2"/);
    assert.match(commands, /Use exec only when the command layer cannot express the task/);
    assert.match(commands, /Use reset only for real connection\/session corruption/);
  });

  it('documents multi-tab named work and name-conflict rules', () => {
    const commands = getHelpSection('commands');

    assert.match(commands, /open https:\/\/example\.com --as docs/);
    assert.match(commands, /snapshot --tab app/);
    assert.match(commands, /Name conflicts fail by default/);
    assert.match(commands, /--replace only when you intentionally want to move a name/);
    assert.match(commands, /never by list position/);
  });

  it('never teaches brittle patterns (state.ensure, last-page indexing, reset-after-failure)', () => {
    for (const section of listHelpSections()) {
      const text = getHelpSection(section.name);
      assert.ok(!text.includes('state.ensure'), `${section.name} must not teach state.ensure`);
      assert.ok(!/pages\(\)\[.*length - 1\]/.test(text), `${section.name} must not teach last-page indexing`);
    }
    const errors = getHelpSection('errors');
    assert.match(errors, /never reset|do not reset|Do not call reset/i, 'errors section scopes reset away from normal failures');
  });

  it('documents tab discovery and manual attached-tab metadata', () => {
    const tabs = getHelpSection('tabs');

    assert.match(tabs, /getBrowserforceStatus/);
    assert.match(tabs, /getBrowserforcePageForTab/);
    assert.match(tabs, /manualAttachedTabs/);
    assert.match(tabs, /activeManualTargets/);
    assert.match(tabs, /context\.pages\(\)/);
    assert.match(tabs, /browserforce "tabs"/, 'exec-scope tab help points at the command surface first');
  });

  it('cli-session documents the unified session commands and run form', () => {
    const cli = getHelpSection('cli-session');

    assert.match(cli, /open.*tabs.*use.*snapshot/s);
    assert.match(cli, /browserforce run "<command>"/);
    assert.match(cli, /same language as the MCP browserforce tool/);
    assert.ok(!cli.includes('--sessiond'), 'the legacy --sessiond spelling is no longer taught');
  });

  it('documents relay-safe CDP session usage', () => {
    const cdp = getHelpSection('cdp');

    assert.match(cdp, /getCDPSession/);
  });

  it('throws for an unknown section', () => {
    assert.throws(
      () => getHelpSection('unknown'),
      /Unknown help section "unknown"/,
    );
  });

  it('keeps each section short enough for on-demand tool reads', () => {
    for (const section of listHelpSections()) {
      const text = getHelpSection(section.name);

      assert.ok(
        text.length < 4000,
        `${section.name} help section is ${text.length} chars`,
      );
    }
  });
});
