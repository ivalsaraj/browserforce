import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignSessionRunId,
  classifyRunStepIcon,
  clearSessionRunId,
  getSessionRunId,
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
