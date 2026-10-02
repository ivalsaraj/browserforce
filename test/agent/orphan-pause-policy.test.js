import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrphanedPause, isNonEmptyString } from '../../extension/orphan-pause-policy.js';

test('a child target waiting for the debugger is resumed on its own session', () => {
  assert.deepEqual(
    resolveOrphanedPause('Target.attachedToTarget', { sessionId: 'CHILD', waitingForDebugger: true }),
    { method: 'Runtime.runIfWaitingForDebugger', params: {}, sessionId: 'CHILD' },
  );
});

test('a child target that is not waiting needs no resolution', () => {
  assert.equal(resolveOrphanedPause('Target.attachedToTarget', { sessionId: 'CHILD', waitingForDebugger: false }), null);
});

test('a paused request is continued on the source session', () => {
  assert.deepEqual(
    resolveOrphanedPause('Fetch.requestPaused', { requestId: 'interception-1' }),
    { method: 'Fetch.continueRequest', params: { requestId: 'interception-1' } },
  );
});

test('an auth challenge is handed back to the browser default', () => {
  assert.deepEqual(
    resolveOrphanedPause('Fetch.authRequired', { requestId: 'interception-2' }),
    {
      method: 'Fetch.continueWithAuth',
      params: { requestId: 'interception-2', authChallengeResponse: { response: 'Default' } },
    },
  );
});

test('events that do not pause anything return null', () => {
  assert.equal(resolveOrphanedPause('Page.loadEventFired', { timestamp: 1 }), null);
});

test('null or non-object params return null', () => {
  assert.equal(resolveOrphanedPause('Fetch.requestPaused', null), null);
  assert.equal(resolveOrphanedPause('Target.attachedToTarget', 'x'), null);
});

test('a missing, empty or numeric requestId returns null', () => {
  for (const requestId of [undefined, '', 7]) {
    assert.equal(resolveOrphanedPause('Fetch.requestPaused', { requestId }), null);
    assert.equal(resolveOrphanedPause('Fetch.authRequired', { requestId }), null);
  }
});

test('a missing, empty or numeric child sessionId returns null instead of a top-level resume', () => {
  for (const sessionId of [undefined, '', 7]) {
    assert.equal(resolveOrphanedPause('Target.attachedToTarget', { sessionId, waitingForDebugger: true }), null);
  }
});

test('isNonEmptyString accepts only non-empty strings', () => {
  assert.equal(isNonEmptyString('CHILD'), true);
  for (const value of ['', 7, null, undefined, true, {}]) assert.equal(isNonEmptyString(value), false);
});
