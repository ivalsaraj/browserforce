import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBrowserBackend, resolveRequestedBackend } from '../src/backend-selection.js';

test('auto uses real when extension is connected', () => {
  assert.deepEqual(selectBrowserBackend({ requested: 'auto', extensionConnected: true }), {
    backend: 'real',
    shouldWarn: false,
    reason: 'real-chrome-bridge-available',
  });
});

test('auto falls back to managed headed when extension is unavailable', () => {
  assert.deepEqual(selectBrowserBackend({ requested: 'auto', extensionConnected: false }), {
    backend: 'managed',
    shouldWarn: true,
    reason: 'real-chrome-bridge-unavailable',
  });
});

test('real uses the real bridge when the extension is connected', () => {
  assert.deepEqual(selectBrowserBackend({ requested: 'real', extensionConnected: true }), {
    backend: 'real',
    shouldWarn: false,
    reason: 'real-chrome-bridge-available',
  });
});

test('real never falls back', () => {
  assert.throws(
    () => selectBrowserBackend({ requested: 'real', extensionConnected: false }),
    /real Chrome bridge is unavailable/,
  );
});

test('managed is selected explicitly without a warning', () => {
  assert.deepEqual(selectBrowserBackend({ requested: 'managed', extensionConnected: true }), {
    backend: 'managed',
    shouldWarn: false,
    reason: 'managed-explicit',
  });
});

test('headless is selected explicitly without a warning', () => {
  assert.deepEqual(selectBrowserBackend({ requested: 'headless', extensionConnected: false }), {
    backend: 'headless',
    shouldWarn: false,
    reason: 'headless-explicit',
  });
});

test('selectBrowserBackend rejects an unknown requested backend', () => {
  assert.throws(() => selectBrowserBackend({ requested: 'bogus', extensionConnected: true }), /unknown backend/i);
});

// ─── Canonical request parser ────────────────────────────────────────────────

test('defaults to auto when nothing is set', () => {
  assert.equal(resolveRequestedBackend({ argv: {}, env: {} }), 'auto');
});

test('--real / --managed / --headless map to their backend', () => {
  assert.equal(resolveRequestedBackend({ argv: { real: true }, env: {} }), 'real');
  assert.equal(resolveRequestedBackend({ argv: { managed: true }, env: {} }), 'managed');
  assert.equal(resolveRequestedBackend({ argv: { headless: true }, env: {} }), 'headless');
});

test('explicit boolean flag beats --backend beats env beats default', () => {
  assert.equal(resolveRequestedBackend({ argv: { real: true, backend: 'managed' }, env: { BF_BROWSER_BACKEND: 'headless' } }), 'real');
  assert.equal(resolveRequestedBackend({ argv: { backend: 'managed' }, env: { BF_BROWSER_BACKEND: 'headless' } }), 'managed');
  assert.equal(resolveRequestedBackend({ argv: {}, env: { BF_BROWSER_BACKEND: 'headless' } }), 'headless');
});

test('rejects an unknown backend value', () => {
  assert.throws(() => resolveRequestedBackend({ argv: { backend: 'bogus' }, env: {} }), /unknown backend/i);
});

test('throws on conflicting explicit backend flags', () => {
  assert.throws(() => resolveRequestedBackend({ argv: { real: true, managed: true }, env: {} }), /conflicting|mutually exclusive/i);
});
