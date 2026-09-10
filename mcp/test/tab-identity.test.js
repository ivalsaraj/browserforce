import test from 'node:test';
import assert from 'node:assert/strict';
import { matchPagesToTargets } from '../src/tab-identity.js';

test('pairs unique URLs to their target id and title', () => {
  const out = matchPagesToTargets(
    ['https://a.test/', 'https://b.test/'],
    [{ id: 'T2', url: 'https://b.test/', title: 'B' }, { id: 'T1', url: 'https://a.test/', title: 'A' }],
  );
  assert.deepEqual(out, [{ targetId: 'T1', title: 'A' }, { targetId: 'T2', title: 'B' }]);
});

test('duplicate URLs match nothing, even when the counts line up', () => {
  // Fail closed: 2 pages and 2 targets at one URL could be paired positionally,
  // but only if both lists share an order, which is unproven. A swap here is a
  // silent wrong-tab action; renumbering is merely visible.
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank'],
    [{ id: 'T1', url: 'about:blank', title: 'first' }, { id: 'T2', url: 'about:blank', title: 'second' }],
  );
  assert.deepEqual(out, [{ targetId: null, title: '' }, { targetId: null, title: '' }]);
});

test('a page with no matching target yields a null targetId rather than a guess', () => {
  const out = matchPagesToTargets(['https://a.test/'], [{ id: 'T1', url: 'https://other.test/', title: 'X' }]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('an incomplete duplicate group also matches nothing', () => {
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank'],
    [{ id: 'T1', url: 'about:blank', title: 'only' }],
  );
  assert.deepEqual(out, [{ targetId: null, title: '' }, { targetId: null, title: '' }]);
});

test('a unique URL still matches even when another URL is duplicated', () => {
  const out = matchPagesToTargets(
    ['about:blank', 'about:blank', 'https://a.test/'],
    [{ id: 'T1', url: 'about:blank', title: 'x' }, { id: 'T9', url: 'https://a.test/', title: 'A' }],
  );
  assert.deepEqual(out, [
    { targetId: null, title: '' },
    { targetId: null, title: '' },
    { targetId: 'T9', title: 'A' },
  ]);
});

test('ignores targets with no id and tolerates a missing title', () => {
  assert.deepEqual(matchPagesToTargets(['u'], [{ url: 'u', title: 'no id' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 'T1', url: 'u' }]), [{ targetId: 'T1', title: '' }]);
});

test('duplicate target ids make the whole listing ambiguous', () => {
  // Two distinct URLs sharing an id would both resolve to one t<N>, so the
  // handle would select the wrong tab.
  const out = matchPagesToTargets(['https://a.test/', 'https://b.test/'], [
    { id: 'T1', url: 'https://a.test/', title: 'A' },
    { id: 'T1', url: 'https://b.test/', title: 'B' },
  ]);
  assert.deepEqual(out, [{ targetId: null, title: '' }, { targetId: null, title: '' }]);
});

test('a malformed target with no URL makes the whole listing ambiguous', () => {
  const out = matchPagesToTargets(['https://a.test/'], [
    { id: 'T1', url: 'https://a.test/', title: 'good' },
    { id: 'T2', title: 'no url' },
  ]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('a malformed target makes its whole URL group ambiguous', () => {
  const out = matchPagesToTargets(['https://a.test/'], [
    { id: 'T1', url: 'https://a.test/', title: 'good' },
    { url: 'https://a.test/', title: 'no id' },
  ]);
  assert.deepEqual(out, [{ targetId: null, title: '' }]);
});

test('malformed targets and unreadable page URLs never match', () => {
  // A page whose url() threw is recorded as ''. Coercing a target's missing URL
  // to '' too would pair them and hand a real handle to an unrelated target.
  assert.deepEqual(matchPagesToTargets([''], [{ id: 'T1', title: 'x' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets([''], [{ id: 'T1', url: '', title: 'x' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 42, url: 'u', title: 'x' }]), [{ targetId: null, title: '' }]);
  assert.deepEqual(matchPagesToTargets(['u'], [{ id: 'T1', url: 99, title: 'x' }]), [{ targetId: null, title: '' }]);
});

test('empty and non-array inputs return an empty array', () => {
  assert.deepEqual(matchPagesToTargets([], [{ id: 'T1', url: 'u', title: 't' }]), []);
  assert.deepEqual(matchPagesToTargets(undefined, undefined), []);
});

// The safety invariant. This asserts the blast radius: a page can only ever be
// paired with a target that has its EXACT URL, so a mis-pair is confined to
// tabs already showing the same page and can never hand out a handle pointing
// at a different site.
test('a page is never paired with a target of a different URL', () => {
  const pageUrls = ['about:blank', 'https://console.test/prod', 'about:blank', 'https://a.test/'];
  const targets = [
    { id: 'T1', url: 'about:blank', title: 'x' },
    { id: 'T2', url: 'https://console.test/prod', title: 'console' },
    { id: 'T3', url: 'about:blank', title: 'y' },
    { id: 'T4', url: 'https://a.test/', title: 'a' },
  ];
  const byId = new Map(targets.map((t) => [t.id, t.url]));
  matchPagesToTargets(pageUrls, targets).forEach(({ targetId }, i) => {
    if (targetId) assert.equal(byId.get(targetId), pageUrls[i]);
  });
});
