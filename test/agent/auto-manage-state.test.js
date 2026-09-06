import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrateAgentTabs, hydrateActivity, canCloseTab } from '../../extension/auto-manage-state.js';

test('hydrates legacy state written before ownership existed', () => {
  const out = hydrateAgentTabs({ agentCreatedTabs: [1, 2] }, new Set([1, 2]));
  assert.deepEqual([...out], [[1, null], [2, null]]);
});

test('hydrates membership plus owners from the two-field format', () => {
  const out = hydrateAgentTabs(
    { agentCreatedTabs: [1, 2], agentTabOwners: [[1, 'label:a'], [2, 'label:b']] },
    new Set([1, 2]),
  );
  assert.deepEqual([...out], [[1, 'label:a'], [2, 'label:b']]);
});

test('prunes tabs that closed while the service worker was dead', () => {
  const out = hydrateAgentTabs({ agentCreatedTabs: [1, 2], agentTabOwners: [[2, 'label:b']] }, new Set([2]));
  assert.deepEqual([...out], [[2, 'label:b']]);
});

test('malformed owner data never costs membership', () => {
  for (const agentTabOwners of ['nope', [null], [[1]], [[1, 2, 3]], undefined]) {
    const out = hydrateAgentTabs({ agentCreatedTabs: [1], agentTabOwners }, new Set([1]));
    assert.deepEqual([...out], [[1, null]], `agentTabOwners=${JSON.stringify(agentTabOwners)}`);
  }
});

test('a non-string owner key degrades to unowned rather than throwing', () => {
  const out = hydrateAgentTabs({ agentCreatedTabs: [1], agentTabOwners: [[1, 42]] }, new Set([1]));
  assert.deepEqual([...out], [[1, null]]);
});

test('a malformed activity entry never aborts hydration of the good ones', () => {
  const saved = { tabLastActivity: [[1, 1000], null, [2], [3, 'nope'], [4, 4000]] };
  const out = hydrateActivity(saved, new Set([1, 2, 3, 4]));
  assert.deepEqual([...out], [[1, 1000], [4, 4000]]);
});

test('activity hydration prunes tabs that are no longer open', () => {
  const out = hydrateActivity({ tabLastActivity: [[1, 1000], [2, 2000]] }, new Set([2]));
  assert.deepEqual([...out], [[2, 2000]]);
});

test('activity hydration tolerates a missing or non-array field', () => {
  for (const tabLastActivity of [undefined, null, 'nope', {}]) {
    assert.deepEqual([...hydrateActivity({ tabLastActivity }, new Set([1]))], []);
  }
});

test('an owner may close its own tab', () => {
  assert.equal(canCloseTab({ owner: 'label:a', requester: 'label:a' }), true);
});

test('a different agent may not close it', () => {
  assert.equal(canCloseTab({ owner: 'label:a', requester: 'label:b' }), false);
});

test('auto-close has no identity and is never fenced', () => {
  assert.equal(canCloseTab({ owner: 'label:a', requester: null }), true);
});

test('unowned tabs stay closable by anyone', () => {
  assert.equal(canCloseTab({ owner: null, requester: 'label:b' }), true);
});
