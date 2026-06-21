import test from 'node:test';
import assert from 'node:assert/strict';

import { commentaryHeadingFromDelta, normalizeToolLabel } from '../../extension/agent-timeline-labels.js';

test('commentaryHeadingFromDelta normalizes conversational commentary into a stable title', () => {
  const heading = commentaryHeadingFromDelta('I’m checking the same BUCKS Settings tab again now.');

  assert.equal(heading, 'Checking the same BUCKS Settings tab again now');
});

test('commentaryHeadingFromDelta clips long commentary at clause boundaries', () => {
  const heading = commentaryHeadingFromDelta('I found BUCKS settings, and checking the open tab so I can continue.');

  assert.equal(heading, 'I found BUCKS settings, and checking the open tab');
});

test('commentaryHeadingFromDelta ignores command-like and recovery headings', () => {
  assert.equal(commentaryHeadingFromDelta('/bin/zsh -lc pnpm test'), '');
  assert.equal(commentaryHeadingFromDelta('BrowserForce recovered from an error'), '');
});

test('normalizeToolLabel preserves BrowserForce execute and reset labels', () => {
  assert.equal(normalizeToolLabel('execute', { name: 'execute', args: { code: 'return 1;' } }), 'BrowserForce:execute');
  assert.equal(normalizeToolLabel('reset', { name: 'reset', arguments: '{}' }), 'BrowserForce:reset');
  assert.equal(normalizeToolLabel('execute', { name: 'execute', arguments: '{"query":"status"}' }), 'execute');
});
