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

  it('documents tab discovery and manual attached-tab metadata', () => {
    const tabs = getHelpSection('tabs');

    assert.match(tabs, /getBrowserforceStatus/);
    assert.match(tabs, /getBrowserforcePageForTab/);
    assert.match(tabs, /manualAttachedTabs/);
    assert.match(tabs, /activeManualTargets/);
    assert.match(tabs, /context\.pages\(\)/);
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
