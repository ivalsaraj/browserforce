import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReportTabUpdate, shouldReportTabRemoval } from '../../extension/tab-update-policy.js';

test('reports url and title changes for tabs that are not attached', () => {
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { url: 'https://a.test/' } }), true);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { title: 'A' } }), true);
});

test('still reports for attached tabs', () => {
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { url: 'https://a.test/' } }), true);
});

test('ignores changes that carry neither url nor title', () => {
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { status: 'loading' } }), false);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: {} }), false);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: null }), false);
});

test('closing an unattached tab is still reported', () => {
  // Otherwise the relay keeps serving a target for a tab that is gone, and
  // rows, handles and names built from it point at nothing.
  assert.equal(shouldReportTabRemoval({ isAttached: false }), true);
  assert.equal(shouldReportTabRemoval({ isAttached: true }), true);
});

test('an emptied title or url is still reported', () => {
  // Truthiness checks drop these and the relay keeps serving stale metadata.
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { title: '' } }), true);
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { url: '' } }), true);
});

test('group-only changes are reported for attached tabs only', () => {
  // Group reconciliation is meaningful only where the relay tracks the tab.
  assert.equal(shouldReportTabUpdate({ isAttached: true, changeInfo: { groupId: 3 } }), true);
  assert.equal(shouldReportTabUpdate({ isAttached: false, changeInfo: { groupId: 3 } }), false);
});
