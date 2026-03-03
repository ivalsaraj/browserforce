import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSessionRunId,
  classifyRunStepIcon,
  clearSessionRunId,
  formatContextUsage,
  getLatestInFlightStepIndex,
  getSessionRunId,
  renderInlineContent,
  shouldApplySessionSelection,
} from '../../extension/agent-panel-runtime.js';

test('run ids are scoped per session', () => {
  let mapping = {};
  mapping = assignSessionRunId(mapping, 's1', 'r1');
  mapping = assignSessionRunId(mapping, 's2', 'r2');

  assert.equal(getSessionRunId(mapping, 's1'), 'r1');
  assert.equal(getSessionRunId(mapping, 's2'), 'r2');
  assert.equal(getSessionRunId(mapping, 's3'), null);

  mapping = clearSessionRunId(mapping, 's1', 'r1');
  assert.equal(getSessionRunId(mapping, 's1'), null);
  assert.equal(getSessionRunId(mapping, 's2'), 'r2');
});

test('stale selection requests are rejected after async load', () => {
  const stale = shouldApplySessionSelection({
    requestToken: 1,
    latestRequestToken: 2,
    requestedSessionId: 's1',
    activeSessionId: 's2',
  });
  assert.equal(stale, false);

  const current = shouldApplySessionSelection({
    requestToken: 2,
    latestRequestToken: 2,
    requestedSessionId: 's2',
    activeSessionId: 's2',
  });
  assert.equal(current, true);
});

test('classifies step icons from reasoning/tool labels', () => {
  assert.equal(classifyRunStepIcon({ kind: 'reasoning', label: 'Let me create a plan first' }), 'reasoning');
  assert.equal(classifyRunStepIcon({ kind: 'tool', label: 'Extract page text' }), 'view');
  assert.equal(classifyRunStepIcon({ kind: 'tool', label: 'Take screenshot' }), 'camera');
  assert.equal(classifyRunStepIcon({ kind: 'tool', label: 'Created a plan' }), 'plan');
  assert.equal(classifyRunStepIcon({ kind: 'status', status: 'done', label: 'Done' }), 'done');
  assert.equal(classifyRunStepIcon({ kind: 'status', status: 'failed', label: 'Failed' }), 'failed');
});

test('renders safe inline markdown for bold and code spans', () => {
  assert.equal(renderInlineContent('**Inspect active tab**'), '<strong>Inspect active tab</strong>');
  assert.equal(renderInlineContent('Use `snapshot()` now'), 'Use <code>snapshot()</code> now');
  assert.equal(
    renderInlineContent('**<script>alert(1)</script>**'),
    '<strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>',
  );
});

test('tracks latest step index for active runs only', () => {
  assert.equal(getLatestInFlightStepIndex({ done: false, steps: [{}, {}, {}] }), 2);
  assert.equal(getLatestInFlightStepIndex({ done: true, steps: [{}, {}] }), -1);
  assert.equal(getLatestInFlightStepIndex({ done: false, steps: [] }), -1);
});

test('formats context usage with percentage when context window is present', () => {
  assert.equal(
    formatContextUsage({ totalTokens: 12345, modelContextWindow: 258400 }),
    '12,345 / 258,400 (4.8%)',
  );
});

test('returns null for context usage formatting when values are incomplete', () => {
  assert.equal(formatContextUsage({ totalTokens: 12345 }), null);
  assert.equal(formatContextUsage({ modelContextWindow: 258400 }), null);
  assert.equal(formatContextUsage({ totalTokens: 0, modelContextWindow: 258400 }), null);
});
