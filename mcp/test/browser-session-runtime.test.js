import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSessionRuntime } from '../src/browser-session-runtime.js';

test('runtime keeps persistent userState until reset', async () => {
  const runtime = createBrowserSessionRuntime({
    connectBrowser: async () => ({ isConnected: () => true, close: async () => {} }),
    getContext: () => ({ pages: () => [] }),
  });

  runtime.userState.answer = 42;
  assert.equal(runtime.userState.answer, 42);
  await runtime.reset();
  assert.equal(runtime.userState.answer, undefined);
});
