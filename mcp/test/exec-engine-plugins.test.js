import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecContext,
  runCode,
  formatResult,
  getRelayHttpUrl,
  getCdpUrl,
  assertExtensionConnected,
} from '../src/exec-engine.js';

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

function createLabeledScreenshotPage() {
  const screenshotCalls = [];
  const screenshotBuffer = Buffer.from('jpeg-image-data');
  const locatorCalls = [];
  let a11yInjected = false;
  return {
    isClosed: () => false,
    url: () => 'https://example.test',
    title: async () => 'Snapshot Test',
    screenshot: async (opts) => {
      screenshotCalls.push(opts);
      return screenshotBuffer;
    },
    locator: (selector) => {
      locatorCalls.push(selector);
      return {
        first: () => ({
          boundingBox: async () => ({ x: 20, y: 30, width: 160, height: 40 }),
        }),
      };
    },
    evaluate: async (_fn, arg) => {
      if (typeof _fn === 'string') {
        a11yInjected = true;
        return undefined;
      }
      const source = String(_fn);
      if (source.includes('typeof globalThis.__bf_a11y')) {
        return a11yInjected;
      }
      if (source.includes('renderA11yLabels(entries)')) {
        return Array.isArray(arg) ? arg.length : 0;
      }
      if (source.includes('__bf_labels__')) {
        return undefined;
      }
      if (arg && typeof arg === 'object' && Array.isArray(arg.testIdAttrs)) {
        return {};
      }
      if (typeof arg === 'number') {
        return { width: 1200, height: 700 };
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
    getScreenshotCalls: () => screenshotCalls,
    getScreenshotBuffer: () => screenshotBuffer,
    getLocatorCalls: () => locatorCalls,
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

function createGoogleSheetsMockPage(cellValues = {}, options = {}) {
  let activeRef = String(options.activeRef || 'A1').toUpperCase();
  let editorReadCount = 0;
  let selection;
  if (Object.prototype.hasOwnProperty.call(options, 'selection')) {
    selection = options.selection
      ? {
          anchorCell: String(options.selection.anchorCell || activeRef).toUpperCase(),
          rangeRef: String(options.selection.rangeRef || options.selection.anchorCell || activeRef).toUpperCase(),
          multiCell: options.selection.multiCell === true,
          activeSheetTitle: options.selection.activeSheetTitle || 'Mock Sheet',
        }
      : null;
  } else {
    selection = {
      anchorCell: activeRef,
      rangeRef: activeRef,
      multiCell: false,
      activeSheetTitle: 'Mock Sheet',
    };
  }
  const boldRangesByCell = options.boldRangesByCell || {};
  const failWriteRefs = new Set((options.failWriteRefs || []).map((ref) => String(ref).toUpperCase()));
  const pageUrl = options.pageUrl || 'https://docs.google.com/spreadsheets/d/test-sheet-id/edit#gid=1';
  let currentUrl = pageUrl;

  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    title: async () => 'Mock Sheet',
    goto: async (url) => {
      currentUrl = url;
    },
    locator: (selector) => {
      assert.equal(selector, '#t-name-box');
      return {
        click: async () => {},
        fill: async (value) => {
          activeRef = String(value || '').toUpperCase();
        },
      };
    },
    keyboard: {
      press: async (key) => {
        if (key === 'Enter') {
          selection = {
            anchorCell: activeRef,
            rangeRef: activeRef,
            multiCell: false,
            activeSheetTitle: selection?.activeSheetTitle || 'Mock Sheet',
          };
        }
      },
    },
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      const source = String(fn);
      if (arg && typeof arg === 'object' && typeof arg.textValue === 'string') {
        if (failWriteRefs.has(activeRef)) {
          return { after: `${arg.textValue} [mismatch]`, lineCount: arg.textValue.split('\n').length };
        }
        cellValues[activeRef] = arg.textValue;
        return { after: arg.textValue, lineCount: arg.textValue.split('\n').length };
      }
      if (source.includes('#t-name-box') && source.includes('activeSheetTitle')) {
        return selection ? { ...selection } : null;
      }
      if (source.includes('createTreeWalker(editor, NodeFilter.SHOW_TEXT)')) {
        const text = Object.prototype.hasOwnProperty.call(cellValues, activeRef)
          ? String(cellValues[activeRef])
          : '';
        return {
          text,
          baseStyle: '',
          boldRanges: Array.isArray(boldRangesByCell[activeRef]) ? boldRangesByCell[activeRef] : [],
          lineCount: text.split('\n').length,
        };
      }
      if (source.includes('#waffle-rich-text-editor')) {
        editorReadCount += 1;
        return Object.prototype.hasOwnProperty.call(cellValues, activeRef)
          ? String(cellValues[activeRef])
          : '';
      }
      throw new Error('Unexpected evaluate call in google-sheets mock');
    },
  };

  return {
    page,
    getEditorReadCount: () => editorReadCount,
    getSelection: () => selection,
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

test('pluginCatalog and pluginHelp built-ins are available in execute scope', async () => {
  const pluginSkillRuntime = {
    catalog: [{
      name: 'tagger',
      description: 'Tags elements quickly',
      helpers: ['tagger'],
      sections: ['examples'],
    }],
    byName: {
      tagger: {
        text: 'Use tagger() to tag.',
        sections: { examples: '- tagger("hero")' },
      },
    },
  };

  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, {}, {}, {}, pluginSkillRuntime);
  const catalog = await runCode('return pluginCatalog()', ctx, 5000);
  assert.deepEqual(catalog, pluginSkillRuntime.catalog);

  const defaultHelp = await runCode('return pluginHelp("tagger")', ctx, 5000);
  assert.equal(defaultHelp, 'Use tagger() to tag.');

  const sectionHelp = await runCode('return pluginHelp("tagger", "examples")', ctx, 5000);
  assert.equal(sectionHelp, '- tagger("hero")');
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

test('plugin helpers cannot override pluginCatalog/pluginHelp built-ins', async () => {
  const pluginHelpers = {
    pluginCatalog: async () => ['evil'],
    pluginHelp: async () => 'evil-help',
  };
  const pluginSkillRuntime = {
    catalog: [{ name: 'safe', helpers: [], sections: [] }],
    byName: { safe: { text: 'safe-help', sections: {} } },
  };

  const ctx = buildExecContext(
    mockPage,
    mockCtx,
    {},
    {},
    pluginHelpers,
    {},
    {},
    pluginSkillRuntime,
  );

  const catalog = await runCode('return pluginCatalog()', ctx, 5000);
  assert.deepEqual(catalog, pluginSkillRuntime.catalog);

  const help = await runCode('return pluginHelp("safe")', ctx, 5000);
  assert.equal(help, 'safe-help');
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

test('official plugin canonical helper names remain available alongside aliases', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const { default: highlightPlugin } = await import('../../plugins/official/highlight/index.js');

  assert.equal(typeof googleSheetsPlugin.helpers.gs__getSelection, 'function');
  assert.equal(typeof googleSheetsPlugin.helpers.gsGetSelection, 'function');
  assert.equal(googleSheetsPlugin.helpers.gs__getSelection, googleSheetsPlugin.helpers.gsGetSelection);

  assert.equal(typeof googleSheetsPlugin.helpers.gs__suggestBoldPhrases, 'function');
  assert.equal(typeof googleSheetsPlugin.helpers.gsSuggestBoldPhrases, 'function');
  assert.equal(googleSheetsPlugin.helpers.gs__suggestBoldPhrases, googleSheetsPlugin.helpers.gsSuggestBoldPhrases);

  assert.equal(typeof googleSheetsPlugin.helpers.gs__formatCurrentSelection, 'function');
  assert.equal(typeof googleSheetsPlugin.helpers.gsFormatCurrentSelection, 'function');
  assert.equal(googleSheetsPlugin.helpers.gs__formatCurrentSelection, googleSheetsPlugin.helpers.gsFormatCurrentSelection);

  assert.equal(typeof googleSheetsPlugin.helpers.gs__summarizeSheet, 'function');
  assert.equal(typeof googleSheetsPlugin.helpers.gsSummarizeSheet, 'function');
  assert.equal(googleSheetsPlugin.helpers.gs__summarizeSheet, googleSheetsPlugin.helpers.gsSummarizeSheet);

  assert.equal(typeof highlightPlugin.helpers.hl__highlight, 'function');
  assert.equal(typeof highlightPlugin.helpers.highlight, 'function');
  assert.equal(highlightPlugin.helpers.hl__highlight, highlightPlugin.helpers.highlight);
});

test('gsGetSelection returns current single-cell selection from the Sheets name box', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const getSelection = googleSheetsPlugin.helpers.gsGetSelection;
  const { page } = createGoogleSheetsMockPage({}, {
    selection: {
      anchorCell: 'D4',
      rangeRef: 'D4',
      multiCell: false,
      activeSheetTitle: 'Mock Sheet',
    },
  });

  const result = await getSelection(page, null, {});

  assert.deepEqual(result, {
    anchorCell: 'D4',
    rangeRef: 'D4',
    multiCell: false,
    activeSheetTitle: 'Mock Sheet',
    spreadsheetId: 'test-sheet-id',
    gid: '1',
  });
});

test('gsGetSelection returns current multi-cell selection from the Sheets name box', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const getSelection = googleSheetsPlugin.helpers.gsGetSelection;
  const { page } = createGoogleSheetsMockPage({}, {
    selection: {
      anchorCell: 'F2',
      rangeRef: 'F2:L11',
      multiCell: true,
      activeSheetTitle: 'Mock Sheet',
    },
  });

  const result = await getSelection(page, null, {});

  assert.equal(result.anchorCell, 'F2');
  assert.equal(result.rangeRef, 'F2:L11');
  assert.equal(result.multiCell, true);
});

test('gsGetSelection fails clearly when the selection cannot be resolved', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const getSelection = googleSheetsPlugin.helpers.gsGetSelection;
  const { page } = createGoogleSheetsMockPage({}, { selection: null });

  await assert.rejects(
    () => getSelection(page, null, {}),
    /could not resolve the current Google Sheets selection/i,
  );
});

test('gsSuggestBoldPhrases suggests short signal phrases without mutating cells', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const suggestBoldPhrases = googleSheetsPlugin.helpers.gsSuggestBoldPhrases;
  const cells = {
    D2: '- Owns delivery milestones - Closes QA with evidence',
    D3: '- Gives clear status updates',
  };
  const { page } = createGoogleSheetsMockPage(cells);

  const result = await suggestBoldPhrases(page, null, {}, 'D2:D3', {
    maxPhrasesPerLine: 1,
    maxWordsPerPhrase: 4,
  });

  assert.equal(result.rangeRef, 'D2:D3');
  assert.deepEqual(result.suggestionsByCell.D2, ['Owns delivery milestones']);
  assert.deepEqual(result.suggestionsByCell.D3, ['Gives clear status updates']);
  assert.equal(cells.D2, '- Owns delivery milestones - Closes QA with evidence');
  assert.equal(cells.D3, '- Gives clear status updates');
});

test('gsSuggestBoldPhrases can prefer existing bold ranges first', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const suggestBoldPhrases = googleSheetsPlugin.helpers.gsSuggestBoldPhrases;
  const { page } = createGoogleSheetsMockPage({
    D2: 'Owns delivery milestones',
  }, {
    boldRangesByCell: {
      D2: [{ start: 0, end: 5 }],
    },
  });

  const result = await suggestBoldPhrases(page, null, {}, 'D2:D2', {
    strategy: 'existing-bold-first',
  });

  assert.deepEqual(result.suggestionsByCell.D2, ['Owns']);
});

test('gsFormatCurrentSelection delegates to gsFormatBulletsInRange using the resolved range', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const formatCurrentSelection = googleSheetsPlugin.helpers.gsFormatCurrentSelection;
  const { page } = createGoogleSheetsMockPage({
    D2: 'Alpha - Beta',
    E2: 'Gamma - Delta',
  }, {
    selection: {
      anchorCell: 'D2',
      rangeRef: 'D2:E2',
      multiCell: true,
      activeSheetTitle: 'Mock Sheet',
    },
  });

  const result = await formatCurrentSelection(page, { pages: () => [page] }, {}, {
    verifyMode: 'none',
  });

  assert.equal(result.selection.rangeRef, 'D2:E2');
  assert.equal(result.rangeRef, 'D2:E2');
  assert.equal(result.executionModeRequested, 'safe');
  assert.equal(result.executionModeUsed, 'safe');
});

test('gsFormatBulletsInRange defaults to safe execution and full verification', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const formatBullets = googleSheetsPlugin.helpers.gsFormatBulletsInRange;
  const { page } = createGoogleSheetsMockPage({
    D2: 'Alpha - Beta',
  });

  const result = await formatBullets(page, { pages: () => [page] }, {}, 'D2:D2');

  assert.equal(result.executionModeRequested, 'safe');
  assert.equal(result.executionModeUsed, 'safe');
  assert.equal(result.verifyMode, 'full');
});

test('gsFormatBulletsInRange rejects invalid executionMode and verifyMode values', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const formatBullets = googleSheetsPlugin.helpers.gsFormatBulletsInRange;
  const { page } = createGoogleSheetsMockPage({
    D2: 'Alpha - Beta',
  });

  await assert.rejects(
    () => formatBullets(page, { pages: () => [page] }, {}, 'D2:D2', { executionMode: 'fastest' }),
    /executionMode must be one of: safe, parallel/i,
  );

  await assert.rejects(
    () => formatBullets(page, { pages: () => [page] }, {}, 'D2:D2', { verifyMode: 'smart' }),
    /verifyMode must be one of: full, sample, none/i,
  );
});

test('gsFormatBulletsInRange parallel mode uses separate worker pages when explicitly requested', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const formatBullets = googleSheetsPlugin.helpers.gsFormatBulletsInRange;
  const sharedCells = {
    D2: 'Alpha - Beta',
    D3: 'Gamma - Delta',
  };
  const base = createGoogleSheetsMockPage(sharedCells);
  let newPageCalls = 0;
  const ctx = {
    pages: () => [base.page],
    newPage: async () => {
      newPageCalls += 1;
      return createGoogleSheetsMockPage(sharedCells).page;
    },
  };

  const result = await formatBullets(base.page, ctx, {}, 'D2:D3', {
    executionMode: 'parallel',
    verifyMode: 'none',
    maxConcurrentWorkers: 2,
  });

  assert.equal(result.executionModeRequested, 'parallel');
  assert.equal(result.executionModeUsed, 'parallel');
  assert.ok(newPageCalls >= 2);
  assert.ok(result.peakConcurrentWorkers >= 2);
});

test('gsFormatBulletsInRange parallel mode falls back to safe mode after a worker mismatch', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const formatBullets = googleSheetsPlugin.helpers.gsFormatBulletsInRange;
  const sharedCells = {
    D2: 'Alpha - Beta',
    D3: 'Gamma - Delta',
    D4: 'Epsilon - Zeta',
  };
  const base = createGoogleSheetsMockPage(sharedCells);
  let newPageCalls = 0;
  const ctx = {
    pages: () => [base.page],
    newPage: async () => {
      newPageCalls += 1;
      return createGoogleSheetsMockPage(sharedCells, {
        failWriteRefs: ['D2'],
      }).page;
    },
  };

  const result = await formatBullets(base.page, ctx, {}, 'D2:D4', {
    executionMode: 'parallel',
    verifyMode: 'none',
    maxConcurrentWorkers: 2,
  });

  assert.equal(result.executionModeRequested, 'parallel');
  assert.equal(result.executionModeUsed, 'safe');
  assert.equal(result.fallbackTriggered, true);
  assert.match(result.fallbackReason, /text_mismatch_after_write/i);
  assert.ok(newPageCalls >= 2);
});

test('runCode uses execute-scope console shim instead of global console', async () => {
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, {});
  const originalLog = globalThis.console.log;
  const originalError = globalThis.console.error;
  let globalCalls = 0;

  globalThis.console.log = () => {
    globalCalls += 1;
    throw new Error('global console.log should not be called');
  };
  globalThis.console.error = () => {
    globalCalls += 1;
    throw new Error('global console.error should not be called');
  };

  try {
    const result = await runCode(
      'console.log("hello", { ok: true }); console.error("warn"); return getExecConsoleLogs({ count: 10 });',
      ctx,
      5000,
    );
    assert.equal(globalCalls, 0);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 2);
    assert.equal(result[0].level, 'log');
    assert.equal(result[1].level, 'error');
    assert.ok(result[0].text.includes('hello'));
    assert.ok(result[0].text.includes('"ok":true'));
    assert.ok(result[1].text.includes('warn'));
  } finally {
    globalThis.console.log = originalLog;
    globalThis.console.error = originalError;
  }
});

test('gsSummarizeSheet reuses cached rows on repeated calls with same options', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const summarize = googleSheetsPlugin.helpers.gsSummarizeSheet;
  const { page, getEditorReadCount } = createGoogleSheetsMockPage({
    A1: 'Level',
    B1: 'Expectation',
    A2: 'Junior',
    B2: 'Owns scoped tasks',
    A3: '',
    B3: '',
  });
  const state = {};
  const options = {
    columns: ['A', 'B'],
    startRow: 1,
    maxRows: 6,
    emptyStreakStop: 1,
    previewRows: 2,
  };

  const first = await summarize(page, null, state, options);
  const readsAfterFirst = getEditorReadCount();
  assert.equal(first.scan.usedRowCount, 2);
  assert.ok(readsAfterFirst > 0);

  const second = await summarize(page, null, state, options);
  const readsAfterSecond = getEditorReadCount();
  assert.equal(second.scan.usedRowCount, 2);
  assert.equal(readsAfterSecond, readsAfterFirst);
});

test('gsSummarizeSheet forceRefresh bypasses cache', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const summarize = googleSheetsPlugin.helpers.gsSummarizeSheet;
  const { page, getEditorReadCount } = createGoogleSheetsMockPage({
    A1: 'Level',
    B1: 'Expectation',
    A2: 'Junior',
    B2: 'Owns scoped tasks',
    A3: '',
    B3: '',
  });
  const state = {};
  const options = {
    columns: ['A', 'B'],
    startRow: 1,
    maxRows: 6,
    emptyStreakStop: 1,
    previewRows: 2,
  };

  await summarize(page, null, state, options);
  const readsAfterFirst = getEditorReadCount();
  await summarize(page, null, state, { ...options, forceRefresh: true });
  const readsAfterForceRefresh = getEditorReadCount();
  assert.ok(readsAfterForceRefresh > readsAfterFirst);
});

test('gsSummarizeSheet useCache false bypasses cache reads and writes', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const summarize = googleSheetsPlugin.helpers.gsSummarizeSheet;
  const { page, getEditorReadCount } = createGoogleSheetsMockPage({
    A1: 'Level',
    B1: 'Expectation',
    A2: 'Junior',
    B2: 'Owns scoped tasks',
    A3: '',
    B3: '',
  });
  const state = {};
  const options = {
    columns: ['A', 'B'],
    startRow: 1,
    maxRows: 6,
    emptyStreakStop: 1,
    previewRows: 2,
    useCache: false,
  };

  await summarize(page, null, state, options);
  const readsAfterFirst = getEditorReadCount();
  await summarize(page, null, state, options);
  const readsAfterSecond = getEditorReadCount();
  assert.ok(readsAfterSecond > readsAfterFirst);
});

test('gsSplitBulletsInRange invalidates gsSummarizeSheet cache after real write', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const summarize = googleSheetsPlugin.helpers.gsSummarizeSheet;
  const splitBullets = googleSheetsPlugin.helpers.gsSplitBulletsInRange;
  const { page, getEditorReadCount } = createGoogleSheetsMockPage({
    A1: 'Level',
    B1: 'Expectation',
    A2: 'Junior',
    B2: 'Owns scoped tasks',
    A3: '',
    B3: '',
    D2: 'Alpha - Beta',
  });
  const state = {};
  const summarizeOptions = {
    columns: ['A', 'B'],
    startRow: 1,
    maxRows: 6,
    emptyStreakStop: 1,
    previewRows: 2,
  };

  await summarize(page, null, state, summarizeOptions);
  const readsAfterFirst = getEditorReadCount();
  await summarize(page, null, state, summarizeOptions);
  const readsAfterSecond = getEditorReadCount();
  assert.equal(readsAfterSecond, readsAfterFirst);

  const splitResult = await splitBullets(page, null, state, 'D2:D2', {
    verify: false,
    dryRun: false,
  });
  assert.equal(splitResult.changed, 1);

  const readsAfterWrite = getEditorReadCount();
  await summarize(page, null, state, summarizeOptions);
  const readsAfterThird = getEditorReadCount();
  assert.ok(readsAfterThird > readsAfterWrite);
});

test('gsRebalanceBoldInRange invalidates gsSummarizeSheet cache after real write', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const summarize = googleSheetsPlugin.helpers.gsSummarizeSheet;
  const rebalanceBold = googleSheetsPlugin.helpers.gsRebalanceBoldInRange;
  const { page, getEditorReadCount } = createGoogleSheetsMockPage({
    A1: 'Level',
    B1: 'Expectation',
    A2: 'Junior',
    B2: 'Owns scoped tasks',
    A3: '',
    B3: '',
    D2: 'Alpha Beta',
  });
  const state = {};
  const summarizeOptions = {
    columns: ['A', 'B'],
    startRow: 1,
    maxRows: 6,
    emptyStreakStop: 1,
    previewRows: 2,
  };

  await summarize(page, null, state, summarizeOptions);
  const readsAfterFirst = getEditorReadCount();
  await summarize(page, null, state, summarizeOptions);
  const readsAfterSecond = getEditorReadCount();
  assert.equal(readsAfterSecond, readsAfterFirst);

  const rebalanceResult = await rebalanceBold(page, null, state, 'D2:D2', {
    verify: false,
    dryRun: false,
    preferredPhrases: ['Alpha'],
  });
  assert.equal(rebalanceResult.changed, 1);

  const readsAfterWrite = getEditorReadCount();
  await summarize(page, null, state, summarizeOptions);
  const readsAfterThird = getEditorReadCount();
  assert.ok(readsAfterThird > readsAfterWrite);
});

test('gsFormatBulletsInRange invalidates gsSummarizeSheet cache after real write', async () => {
  const { default: googleSheetsPlugin } = await import('../../plugins/official/google-sheets/index.js');
  const summarize = googleSheetsPlugin.helpers.gsSummarizeSheet;
  const formatBullets = googleSheetsPlugin.helpers.gsFormatBulletsInRange;
  const { page, getEditorReadCount } = createGoogleSheetsMockPage({
    A1: 'Level',
    B1: 'Expectation',
    A2: 'Junior',
    B2: 'Owns scoped tasks',
    A3: '',
    B3: '',
    D2: 'Alpha - Beta',
  });
  const state = {};
  const summarizeOptions = {
    columns: ['A', 'B'],
    startRow: 1,
    maxRows: 6,
    emptyStreakStop: 1,
    previewRows: 2,
  };

  await summarize(page, null, state, summarizeOptions);
  const readsAfterFirst = getEditorReadCount();
  await summarize(page, null, state, summarizeOptions);
  const readsAfterSecond = getEditorReadCount();
  assert.equal(readsAfterSecond, readsAfterFirst);

  const formatResult = await formatBullets(page, null, state, 'D2:D2', {
    verify: false,
    dryRun: false,
  });
  assert.equal(formatResult.changed, 1);

  const readsAfterWrite = getEditorReadCount();
  await summarize(page, null, state, summarizeOptions);
  const readsAfterThird = getEditorReadCount();
  assert.ok(readsAfterThird > readsAfterWrite);
});

test('buildExecContext exposes screenshot and content helpers in execute scope', () => {
  const ctx = buildExecContext(mockPage, mockCtx, {}, {}, {});
  assert.equal(typeof ctx.console, 'object');
  assert.equal(typeof ctx.console.log, 'function');
  assert.equal(typeof ctx.getExecConsoleLogs, 'function');
  assert.equal(typeof ctx.clearExecConsoleLogs, 'function');
  assert.equal(typeof ctx.screenshotWithAccessibilityLabels, 'function');
  assert.equal(typeof ctx.cleanHTML, 'function');
  assert.equal(typeof ctx.pageMarkdown, 'function');
});

test('screenshotWithAccessibilityLabels runs snapshot and direct screenshot sequentially', async () => {
  const page = createLabeledScreenshotPage();
  const ctx = buildExecContext(page, { pages: () => [page] }, {}, {}, {});

  const result = await ctx.screenshotWithAccessibilityLabels({ interactiveOnly: false });
  const calls = page.getScreenshotCalls();
  const locatorCalls = page.getLocatorCalls();

  assert.equal(calls.length, 1);
  assert.equal(locatorCalls.length, 2);
  assert.deepEqual(calls[0], {
    type: 'jpeg',
    quality: 80,
    scale: 'css',
    clip: { x: 0, y: 0, width: 1200, height: 700 },
  });
  assert.equal(result._bf_type, 'labeled_screenshot');
  assert.equal(result.screenshot.toString('base64'), page.getScreenshotBuffer().toString('base64'));
  assert.ok(result.snapshot.includes('Page: Snapshot Test (https://example.test)'));
  assert.ok(result.snapshot.includes('- button "Submit" [ref=e2]'));
  assert.equal(result.labelCount, 2);
  assert.ok(result.snapshot.includes('- main [ref=e1]'));
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

test('getRelayHttpUrl defaults to localhost:19222', () => {
  const originalPort = process.env.RELAY_PORT;
  const originalCdp = process.env.BF_CDP_URL;
  try {
    delete process.env.RELAY_PORT;
    delete process.env.BF_CDP_URL;
    assert.equal(getRelayHttpUrl(), 'http://127.0.0.1:19222');
  } finally {
    if (originalPort === undefined) delete process.env.RELAY_PORT;
    else process.env.RELAY_PORT = originalPort;
    if (originalCdp === undefined) delete process.env.BF_CDP_URL;
    else process.env.BF_CDP_URL = originalCdp;
  }
});

test('getRelayHttpUrl respects BF_CDP_URL override host/port', () => {
  const originalCdp = process.env.BF_CDP_URL;
  try {
    process.env.BF_CDP_URL = 'ws://127.0.0.1:19457/cdp?token=test-token';
    assert.equal(getRelayHttpUrl(), 'http://127.0.0.1:19457');
  } finally {
    if (originalCdp === undefined) delete process.env.BF_CDP_URL;
    else process.env.BF_CDP_URL = originalCdp;
  }
});

test('getCdpUrl resolves from /json/version when BF_CDP_URL is not set', async () => {
  const originalCdp = process.env.BF_CDP_URL;
  const originalPort = process.env.RELAY_PORT;
  const originalFetch = globalThis.fetch;

  try {
    delete process.env.BF_CDP_URL;
    process.env.RELAY_PORT = '19222';
    globalThis.fetch = async (url) => {
      assert.equal(url, 'http://127.0.0.1:19222/json/version');
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl: 'ws://127.0.0.1:19222/cdp?token=from-json-version',
        }),
      };
    };

    const cdpUrl = await getCdpUrl();
    assert.equal(cdpUrl, 'ws://127.0.0.1:19222/cdp?token=from-json-version');
  } finally {
    if (originalCdp === undefined) delete process.env.BF_CDP_URL;
    else process.env.BF_CDP_URL = originalCdp;
    if (originalPort === undefined) delete process.env.RELAY_PORT;
    else process.env.RELAY_PORT = originalPort;
    globalThis.fetch = originalFetch;
  }
});

test('assertExtensionConnected throws a clear error when extension is disconnected', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok', extension: false }),
    });
    await assert.rejects(
      () => assertExtensionConnected({ baseUrl: 'http://127.0.0.1:19222' }),
      /extension is not connected/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('assertExtensionConnected succeeds when extension is connected', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok', extension: true }),
    });
    await assert.doesNotReject(
      () => assertExtensionConnected({ baseUrl: 'http://127.0.0.1:19222' })
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
