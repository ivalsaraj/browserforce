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

test('normalizeToolLabel preserves BrowserForce exec, command, and reset labels', () => {
  assert.equal(normalizeToolLabel('exec', { name: 'exec', args: { code: 'return 1;' } }), 'BrowserForce:exec');
  assert.equal(normalizeToolLabel('browserforce', { name: 'browserforce', args: { command: 'snapshot' } }), 'BrowserForce:command');
  assert.equal(
    normalizeToolLabel('mcp__browserforce__browserforce', { name: 'mcp__browserforce__browserforce', arguments: '{"command":"tabs"}' }),
    'BrowserForce:command',
  );
  assert.equal(normalizeToolLabel('reset', { name: 'reset', arguments: '{}' }), 'BrowserForce:reset');
  assert.equal(normalizeToolLabel('exec', { name: 'exec', arguments: '{"query":"status"}' }), 'exec');
});

test('normalizeToolLabel keeps branding legacy execute events recorded before the rename', () => {
  assert.equal(normalizeToolLabel('execute', { name: 'execute', args: { code: 'return 1;' } }), 'BrowserForce:execute');
  assert.equal(normalizeToolLabel('execute', { name: 'execute', arguments: '{"query":"status"}' }), 'execute');
});
