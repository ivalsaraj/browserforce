import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecContext, runCode, formatResult } from '../src/exec-engine.js';

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

test('buildExecContext exposes screenshot and content helpers in execute scope', () => {
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, {});
  assert.equal(typeof ctx.screenshotWithAccessibilityLabels, 'function');
  assert.equal(typeof ctx.cleanHTML, 'function');
  assert.equal(typeof ctx.pageMarkdown, 'function');
});

test('buildExecContext exposes callable ref and CDP helpers', async () => {
  const fakeSession = { send: async () => ({}) };
  const page = {
    isClosed: () => false,
    context: () => ({
      newCDPSession: async (targetPage) => {
        assert.equal(targetPage, page);
        return fakeSession;
      },
    }),
  };

  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});
  assert.equal(typeof ctx.refToLocator, 'function');
  assert.equal(typeof ctx.getCDPSession, 'function');

  const session = await ctx.getCDPSession({ page });
  assert.equal(session, fakeSession);

  await assert.rejects(
    () => ctx.getCDPSession({ page: { isClosed: () => true } }),
    /Cannot create CDP session for closed page/
  );
});

test('formatResult returns multi-content for labeled screenshot sentinel', () => {
  const fakeBuffer = Buffer.from('fake-jpeg-data');
  const formatted = formatResult({
    _bf_type: 'labeled_screenshot',
    screenshot: fakeBuffer,
    snapshot: '- button "Submit" [ref=e1]',
    labelCount: 1,
  });

  assert.ok(Array.isArray(formatted));
  assert.equal(formatted.length, 2);
  assert.deepEqual(formatted[0], {
    type: 'image',
    data: fakeBuffer.toString('base64'),
    mimeType: 'image/jpeg',
  });
  assert.equal(formatted[1].type, 'text');
  assert.ok(formatted[1].text.includes('Labels: 1 interactive elements'));
});
