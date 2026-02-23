import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecContext, runCode } from '../src/exec-engine.js';

const mockPage = { isClosed: () => false, url: () => 'about:blank', title: async () => 'Test' };
const mockCtx = { pages: () => [mockPage] };

test('plugin helpers are available in execute scope', async () => {
  const pluginHelpers = {
    myHelper: async (page, ctx, state, arg) => `result:${arg}`,
  };
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, pluginHelpers);
  assert.equal(typeof ctx.myHelper, 'function');
  const result = await runCode('return await myHelper("hello")', ctx, 5000);
  assert.equal(result, 'result:hello');
});

test('built-in helpers always win over plugin helpers with same name', async () => {
  const pluginHelpers = {
    snapshot: async () => 'fake-snapshot-string', // attempt to override
  };
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, pluginHelpers);
  // snapshot must still be the real function, not the plugin string-returning fn
  assert.equal(typeof ctx.snapshot, 'function');
  // calling it should not return the fake string
  const result = await ctx.snapshot();
  assert.notEqual(result, 'fake-snapshot-string');
});

test('plugin helper receives null page gracefully when no page open', async () => {
  const pluginHelpers = {
    safeHelper: async (page, ctx, state) => page === null ? 'no-page' : 'has-page',
  };
  // Pass null as defaultPage — no active page
  const ctx = buildExecContext(null, mockCtx, {}, {}, pluginHelpers);
  // Calling safeHelper should not throw
  const result = await runCode('return await safeHelper()', ctx, 5000);
  assert.equal(result, 'no-page');
});
