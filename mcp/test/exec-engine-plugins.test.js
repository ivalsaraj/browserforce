import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecContext, runCode, formatResult } from '../src/exec-engine.js';

const mockPage = { isClosed: () => false, url: () => 'about:blank', title: async () => 'Test' };
const mockCtx = { pages: () => [mockPage] };

function createSnapshotPage() {
  return {
    isClosed: () => false,
    url: () => 'https://example.test',
    title: async () => 'Snapshot Test',
    evaluate: async (_fn, arg) => {
      if (arg && typeof arg === 'object' && Array.isArray(arg.testIdAttrs)) {
        return {};
      }
      return {
        role: 'WebArea',
        name: '',
        children: [
          {
            role: 'main',
            name: '',
            children: [{ role: 'button', name: 'Submit', children: [] }],
          },
        ],
      };
    },
  };
}

function createCleanHtmlPage() {
  return {
    isClosed: () => false,
    evaluate: async (_fn, arg) => {
      if (arg && typeof arg === 'object' && Object.hasOwn(arg, 'maxAttrLen')) {
        return '<html><body><main>clean body</main></body></html>';
      }
      throw new Error('Unexpected evaluate call in cleanHTML test');
    },
  };
}

function createPageMarkdownPage(content = 'Markdown content line', options = {}) {
  const title = options.title === undefined ? 'Markdown Title' : options.title;
  return {
    isClosed: () => false,
    evaluate: async (arg) => {
      if (typeof arg === 'function') {
        const fnSource = arg.toString();
        if (fnSource.includes('!!globalThis.__readability')) {
          return true;
        }
        if (fnSource.includes('isProbablyReaderable')) {
          return {
            content,
            title,
            author: null,
            excerpt: null,
            siteName: null,
            lang: 'en',
            publishedTime: null,
            wordCount: 3,
            readable: true,
          };
        }
      }
      if (typeof arg === 'string') {
        return undefined;
      }
      throw new Error('Unexpected evaluate call in pageMarkdown test');
    },
  };
}

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

test('snapshot diff wiring returns full, then no-change guidance, then full when disabled', async () => {
  const page = createSnapshotPage();
  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});

  const first = await ctx.snapshot({ showDiffSinceLastCall: true });
  assert.ok(first.includes('Page: Snapshot Test (https://example.test)'));
  assert.ok(first.includes('- button "Submit" [ref=e1]'));

  const second = await ctx.snapshot({ showDiffSinceLastCall: true });
  assert.ok(second.includes('No changes since last snapshot'));
  assert.ok(second.includes('showDiffSinceLastCall: false'));

  const full = await ctx.snapshot({ showDiffSinceLastCall: false });
  assert.ok(full.includes('Page: Snapshot Test (https://example.test)'));
});

test('cleanHTML diff wiring returns no-change guidance on identical repeated calls', async () => {
  const page = createCleanHtmlPage();
  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});

  const first = await ctx.cleanHTML('body', { showDiffSinceLastCall: true });
  assert.ok(first.includes('<main>clean body</main>'));

  const second = await ctx.cleanHTML('body', { showDiffSinceLastCall: true });
  assert.ok(second.includes('No changes since last call'));
  assert.ok(second.includes('showDiffSinceLastCall: false'));

  const full = await ctx.cleanHTML('body', { showDiffSinceLastCall: false });
  assert.ok(full.includes('<main>clean body</main>'));
});

test('pageMarkdown option forwarding and diff wiring returns no-change guidance on repeated calls', async () => {
  const page = createPageMarkdownPage();
  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});

  const first = await ctx.pageMarkdown({ showDiffSinceLastCall: true });
  assert.ok(first.includes('# Markdown Title'));
  assert.ok(first.includes('Markdown content line'));

  const second = await ctx.pageMarkdown({ showDiffSinceLastCall: true });
  assert.ok(second.includes('No changes since last call'));
  assert.ok(second.includes('showDiffSinceLastCall: false'));

  const full = await ctx.pageMarkdown({ showDiffSinceLastCall: false });
  assert.ok(full.includes('# Markdown Title'));
});

test('pageMarkdown search takes precedence over diff mode on repeated calls', async () => {
  const page = createPageMarkdownPage('alpha line\nfind me here\nomega line');
  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});

  await ctx.pageMarkdown({ showDiffSinceLastCall: true });
  const searched = await ctx.pageMarkdown({ search: 'find me' });

  assert.ok(searched.includes('find me here'));
  assert.ok(!searched.includes('No changes since last call'));
});

test('pageMarkdown search resets regex state for g/y regex flags', async () => {
  const page = createPageMarkdownPage('target on only line', { title: null });
  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});
  const search = /target/g;
  search.lastIndex = 1;

  const result = await ctx.pageMarkdown({ search, showDiffSinceLastCall: false });
  assert.ok(result.includes('target on only line'));
  assert.ok(!result.includes('No matches found'));
});
