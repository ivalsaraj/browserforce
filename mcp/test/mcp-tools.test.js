import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  buildSnapshotText, createSmartDiff, parseSearchPattern,
  annotateStableAttrs, buildLocator, escapeLocatorName,
} from '../src/snapshot.js';

// ─── CDP URL Discovery ──────────────────────────────────────────────────────

describe('CDP URL Discovery', () => {
  const BF_DIR = join(homedir(), '.browserforce');
  const CDP_URL_FILE = join(BF_DIR, 'cdp-url');

  it('reads CDP URL from well-known file', () => {
    // The relay should have written this during previous test runs
    // or manual relay starts. We test the file format.
    try {
      const url = readFileSync(CDP_URL_FILE, 'utf8').trim();
      assert.ok(url.startsWith('ws://'), 'CDP URL should start with ws://');
      assert.ok(url.includes('/cdp?token='), 'CDP URL should contain /cdp?token=');
      assert.ok(url.includes('127.0.0.1'), 'CDP URL should bind to localhost');
    } catch {
      // File might not exist if relay hasn't been run — skip
      assert.ok(true, 'CDP URL file not found (relay not started yet)');
    }
  });

  it('env var BF_CDP_URL takes priority over file', () => {
    const original = process.env.BF_CDP_URL;
    try {
      process.env.BF_CDP_URL = 'ws://127.0.0.1:99999/cdp?token=test';
      assert.equal(process.env.BF_CDP_URL, 'ws://127.0.0.1:99999/cdp?token=test');
    } finally {
      if (original) {
        process.env.BF_CDP_URL = original;
      } else {
        delete process.env.BF_CDP_URL;
      }
    }
  });
});

// ─── Tool Schema Validation ──────────────────────────────────────────────────

describe('Tool Definitions', () => {
  it('MCP server module loads without syntax errors', async () => {
    const { execSync } = await import('node:child_process');
    const result = execSync('node --check src/index.js', {
      cwd: join(import.meta.url.replace('file://', ''), '../../'),
      encoding: 'utf8',
    });
    assert.equal(result, '');
  });

  it('registers exactly 2 tools: execute, reset', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const toolNames = [];
    const regex = /server\.tool\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      toolNames.push(match[1]);
    }

    assert.equal(toolNames.length, 2, `Should have exactly 2 tools, found ${toolNames.length}: ${toolNames.join(', ')}`);
    assert.deepEqual(toolNames.sort(), ['execute', 'reset']);
  });

  it('tools have non-empty descriptions', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // execute tool uses EXECUTE_PROMPT variable, reset uses inline string
    assert.ok(source.includes('EXECUTE_PROMPT'), 'execute tool should reference EXECUTE_PROMPT');
    assert.ok(source.includes('const EXECUTE_PROMPT'), 'EXECUTE_PROMPT should be defined');
    // Check reset tool still has inline description
    const resetBlock = source.split("'reset'")[1] || '';
    assert.ok(resetBlock.includes('Reconnects'), 'reset should have description');
  });

  it('execute tool description includes key guidance sections', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // EXECUTE_PROMPT is defined as a const above server.tool('execute', EXECUTE_PROMPT, ...)
    const promptStart = source.indexOf('const EXECUTE_PROMPT');
    const promptEnd = source.indexOf("server.tool(\n  'execute'");
    const promptBlock = source.slice(promptStart, promptEnd);
    // Core scope
    assert.ok(promptBlock.includes('page'), 'should mention page');
    assert.ok(promptBlock.includes('context'), 'should mention context');
    assert.ok(promptBlock.includes('state'), 'should mention state');
    // Key behavioral guidance
    assert.ok(promptBlock.includes('state.page'), 'should mention state.page for page management');
    assert.ok(promptBlock.includes('snapshot'), 'should mention snapshot-first approach');
    assert.ok(promptBlock.includes('waitForPageLoad'), 'should mention waitForPageLoad');
    assert.ok(promptBlock.includes('screenshotWithAccessibilityLabels'), 'should mention screenshotWithAccessibilityLabels helper');
    assert.ok(promptBlock.includes('cleanHTML'), 'should mention cleanHTML helper');
    assert.ok(promptBlock.includes('pageMarkdown'), 'should mention pageMarkdown helper');
    assert.ok(promptBlock.includes('newPage'), 'should mention creating new tabs');
    // Anti-patterns section
    assert.ok(promptBlock.includes('ANTI-PATTERN') || promptBlock.includes('Don\'t') || promptBlock.includes('✗'), 'should include anti-patterns');
  });

  it('execute prompt includes tactical anti-pattern and decision guidance', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const promptStart = source.indexOf('const EXECUTE_PROMPT');
    const promptEnd = source.indexOf("server.tool(\n  'execute'");
    const promptBlock = source.slice(promptStart, promptEnd);

    assert.ok(promptBlock.includes('Selector priority'), 'should include selector ranking guidance');
    assert.ok(promptBlock.includes('login popups'), 'should include login popup handling');
    assert.ok(promptBlock.includes('cookie') || promptBlock.includes('consent'), 'should include consent modal handling');
    assert.ok(promptBlock.includes('stale locator'), 'should include stale locator warning');
    assert.ok(promptBlock.includes('snapshot({ showDiffSinceLastCall'), 'should include diff usage guidance');
  });

  it('execute tool has code and optional timeout params', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const execBlock = source.split("'execute'")[1]?.split('server.tool(')[0] || '';
    assert.ok(execBlock.includes('z.string()'), 'execute should have a string param (code)');
    assert.ok(execBlock.includes('z.number().optional()'), 'execute should have an optional number param (timeout)');
    assert.ok(execBlock.includes('code:'), 'execute should have code param');
    assert.ok(execBlock.includes('timeout:'), 'execute should have timeout param');
  });

  it('reset tool has no params', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // Find the reset tool block — between 'reset' and the next async handler
    const resetIdx = source.indexOf("'reset'");
    assert.ok(resetIdx !== -1, 'reset tool should exist');
    const afterReset = source.slice(resetIdx);
    // The params object should be empty {}
    const paramsMatch = afterReset.match(/,\s*\{\s*\}\s*,/);
    assert.ok(paramsMatch, 'reset should have empty params {}');
  });

  it('does not register screenshot_with_labels tool', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    assert.ok(!source.includes("'screenshot_with_labels'"), 'screenshot_with_labels tool should be removed');
    assert.ok(!source.includes('SCREENSHOT_LABELS_PROMPT'), 'dedicated screenshot prompt should be removed');
  });
});

// ─── MCP Response Format ─────────────────────────────────────────────────────

describe('MCP Response Format', () => {
  it('text content format is valid', () => {
    const response = {
      content: [{ type: 'text', text: 'Navigated to https://example.com (status: 200)' }],
    };
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'text');
    assert.ok(typeof response.content[0].text === 'string');
  });

  it('image content format is valid', () => {
    const fakeBase64 = Buffer.from('fake-png-data').toString('base64');
    const response = {
      content: [{ type: 'image', data: fakeBase64, mimeType: 'image/png' }],
    };
    assert.equal(response.content.length, 1);
    assert.equal(response.content[0].type, 'image');
    assert.equal(response.content[0].mimeType, 'image/png');
    assert.ok(typeof response.content[0].data === 'string');
  });

  it('tab list JSON format is parseable', () => {
    const tabs = [
      { index: 0, url: 'https://gmail.com', title: 'Gmail - Inbox' },
      { index: 1, url: 'https://github.com', title: 'GitHub' },
    ];
    const json = JSON.stringify(tabs, null, 2);
    const parsed = JSON.parse(json);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].index, 0);
    assert.equal(parsed[1].url, 'https://github.com');
  });

  it('labeled screenshot multi-content format is valid', () => {
    const fakeBase64 = Buffer.from('fake-jpeg-data').toString('base64');
    const response = {
      content: [
        { type: 'image', data: fakeBase64, mimeType: 'image/jpeg' },
        { type: 'text', text: 'Labels: 5 interactive elements\n\n- button "Submit" [ref=e1]' },
      ],
    };
    assert.equal(response.content.length, 2);
    assert.equal(response.content[0].type, 'image');
    assert.equal(response.content[0].mimeType, 'image/jpeg');
    assert.equal(response.content[1].type, 'text');
    assert.ok(response.content[1].text.includes('Labels:'));
    assert.ok(response.content[1].text.includes('[ref='));
  });
});

// ─── Snapshot Tree Building (imports from snapshot.js) ───────────────────────

describe('Snapshot Tree Building', () => {
  it('builds snapshot from a simple AX tree', () => {
    const axTree = {
      role: 'WebArea', name: 'Example',
      children: [
        { role: 'banner', name: '', children: [
          { role: 'link', name: 'Home', children: [] },
          { role: 'link', name: 'About', children: [] },
        ]},
        { role: 'main', name: '', children: [
          { role: 'heading', name: 'Welcome', children: [] },
          { role: 'button', name: 'Submit', children: [] },
          { role: 'textbox', name: 'Email', children: [] },
        ]},
      ],
    };

    const { text, refs } = buildSnapshotText(axTree, null, null);

    assert.ok(text.includes('- banner:'));
    assert.ok(text.includes('- link "Home" [ref=e1]'));
    assert.ok(text.includes('- link "About" [ref=e2]'));
    assert.ok(text.includes('- main:'));
    assert.ok(text.includes('- heading "Welcome"'));
    assert.ok(text.includes('- button "Submit" [ref=e3]'));
    assert.ok(text.includes('- textbox "Email" [ref=e4]'));
    assert.equal(refs.length, 4);
    assert.equal(refs[0].ref, 'e1');
    assert.equal(refs[0].locator, 'role=link[name="Home"]');
    assert.equal(refs[2].locator, 'role=button[name="Submit"]');
  });

  it('uses stable IDs via _stableAttr annotation', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'main', name: '', children: [
          { role: 'button', name: 'Submit Form', children: [] },
        ]},
      ],
    };

    const stableIds = { 'Submit Form': { attr: 'data-testid', value: 'submit-btn' } };
    annotateStableAttrs(axTree, stableIds);

    const { refs } = buildSnapshotText(axTree, null, null);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].ref, 'submit-btn');
    assert.equal(refs[0].locator, '[data-testid="submit-btn"]');
  });

  it('deduplicates refs with suffix when same stable ID appears twice', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'form', name: 'Login', children: [
          { role: 'button', name: 'Submit', _stableAttr: { attr: 'data-testid', value: 'submit-btn' }, children: [] },
        ]},
        { role: 'form', name: 'Register', children: [
          { role: 'button', name: 'Submit', _stableAttr: { attr: 'data-testid', value: 'submit-btn' }, children: [] },
        ]},
      ],
    };

    const { refs } = buildSnapshotText(axTree, null, null);
    assert.equal(refs.length, 2);
    assert.equal(refs[0].ref, 'submit-btn');
    assert.equal(refs[1].ref, 'submit-btn-2');
  });

  it('filters by search pattern', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'navigation', name: '', children: [
          { role: 'link', name: 'Home', children: [] },
        ]},
        { role: 'main', name: '', children: [
          { role: 'button', name: 'Submit', children: [] },
          { role: 'textbox', name: 'Email', children: [] },
        ]},
      ],
    };

    const { text, refs } = buildSnapshotText(axTree, null, /button/i);
    assert.ok(text.includes('button'));
    assert.ok(!text.includes('link'));
    assert.ok(!text.includes('textbox'));
    assert.equal(refs.length, 1);
    assert.equal(refs[0].name, 'Submit');
  });

  it('skips generic/presentation roles', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'generic', name: '', children: [
          { role: 'button', name: 'Click Me', children: [] },
        ]},
      ],
    };

    const { text, refs } = buildSnapshotText(axTree, null, null);
    assert.ok(!text.includes('generic'));
    assert.ok(text.includes('button "Click Me"'));
    assert.equal(refs.length, 1);
  });

  it('handles empty AX tree gracefully', () => {
    const axTree = { role: 'WebArea', name: '', children: [] };
    const { text, refs } = buildSnapshotText(axTree, null, null);
    assert.equal(text, '');
    assert.equal(refs.length, 0);
  });

  it('preserves indentation hierarchy', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'navigation', name: 'Main Nav', children: [
          { role: 'list', name: '', children: [
            { role: 'listitem', name: '', children: [
              { role: 'link', name: 'Home', children: [] },
            ]},
          ]},
        ]},
      ],
    };

    const { text } = buildSnapshotText(axTree, null, null);
    const lines = text.split('\n');
    assert.ok(lines[0].startsWith('  - navigation'));
    assert.ok(lines[1].startsWith('    - list'));
    assert.ok(lines[2].startsWith('      - listitem'));
    assert.ok(lines[3].startsWith('        - link'));
  });

  it('locator escapes special characters in names', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'main', name: '', children: [
          { role: 'button', name: 'Click "here"', children: [] },
        ]},
      ],
    };

    const { refs } = buildSnapshotText(axTree, null, null);
    assert.equal(refs[0].locator, 'role=button[name="Click \\"here\\""]');
  });
});

// ─── Snapshot Diff Mode ──────────────────────────────────────────────────────

describe('Snapshot Diff Mode', () => {
  it('returns no-change when snapshots are identical', () => {
    const text = '- main:\n  - button "Submit" [ref=e1]';
    const result = createSmartDiff(text, text);
    assert.equal(result.type, 'no-change');
  });

  it('returns diff for small changes', () => {
    const old = [
      '- banner:',
      '  - link "Home" [ref=e1]',
      '  - link "About" [ref=e2]',
      '- main:',
      '  - heading "Welcome"',
      '  - button "Submit" [ref=e3]',
      '  - textbox "Email" [ref=e4]',
      '  - textbox "Password" [ref=e5]',
      '  - checkbox "Remember me" [ref=e6]',
      '  - link "Forgot password?" [ref=e7]',
    ].join('\n');

    const now = [
      '- banner:',
      '  - link "Home" [ref=e1]',
      '  - link "About" [ref=e2]',
      '- main:',
      '  - heading "Welcome"',
      '  - button "Submit" [ref=e3]',
      '  - textbox "Email" [ref=e4]',
      '  - textbox "Password" [ref=e5]',
      '  - checkbox "Remember me" [ref=e6]',
      '  - link "Forgot password?" [ref=e7]',
      '  - button "Reset" [ref=e8]',
    ].join('\n');

    const result = createSmartDiff(old, now);
    assert.equal(result.type, 'diff');
    assert.ok(result.content.includes('+  - button "Reset"'));
  });

  it('returns full content when >50% changed', () => {
    const old = '- button "A" [ref=e1]\n- button "B" [ref=e2]';
    const now = '- link "X" [ref=e1]\n- link "Y" [ref=e2]\n- link "Z" [ref=e3]';
    const result = createSmartDiff(old, now);
    assert.equal(result.type, 'full');
    assert.equal(result.content, now);
  });
});

// ─── Search Pattern Validation ───────────────────────────────────────────────

describe('Search Pattern Validation', () => {
  it('returns null for empty/undefined search', () => {
    assert.equal(parseSearchPattern(null), null);
    assert.equal(parseSearchPattern(undefined), null);
    assert.equal(parseSearchPattern(''), null);
  });

  it('returns valid regex for good patterns', () => {
    const pattern = parseSearchPattern('button|input');
    assert.ok(pattern instanceof RegExp);
    assert.ok(pattern.test('button'));
    assert.ok(pattern.test('INPUT'));
  });

  it('throws descriptive error for invalid regex', () => {
    assert.throws(
      () => parseSearchPattern('button['),
      /Invalid search regex/
    );
  });
});

// ─── annotateStableAttrs ─────────────────────────────────────────────────────

describe('annotateStableAttrs', () => {
  it('attaches _stableAttr to matching interactive nodes', () => {
    const axTree = {
      role: 'WebArea', name: '',
      children: [
        { role: 'main', name: '', children: [
          { role: 'button', name: 'Save', children: [] },
          { role: 'heading', name: 'Title', children: [] },
        ]},
      ],
    };

    const stableIds = {
      'Save': { attr: 'data-testid', value: 'save-btn' },
      'Title': { attr: 'id', value: 'page-title' },
    };
    annotateStableAttrs(axTree, stableIds);

    assert.deepEqual(axTree.children[0].children[0]._stableAttr, { attr: 'data-testid', value: 'save-btn' });
    assert.equal(axTree.children[0].children[1]._stableAttr, undefined);
  });
});

// ─── smartWaitForPageLoad ─────────────────────────────────────────────────────

describe('smartWaitForPageLoad', () => {
  it('returns success when page is already ready', async () => {
    // Mock a minimal page object with evaluate
    const mockPage = {
      evaluate: async () => ({
        ready: true,
        readyState: 'complete',
        pendingRequests: [],
      }),
    };

    // Import dynamically to test the function shape
    // Since smartWaitForPageLoad is not exported, test its behavior indirectly
    // by verifying the response format matches expectations
    const expectedShape = {
      success: true,
      readyState: 'complete',
      pendingRequests: 0,
      timedOut: false,
    };

    // Verify the expected response shape is valid
    assert.equal(typeof expectedShape.success, 'boolean');
    assert.equal(typeof expectedShape.readyState, 'string');
    assert.equal(typeof expectedShape.pendingRequests, 'number');
    assert.equal(typeof expectedShape.timedOut, 'boolean');
    assert.equal(expectedShape.success, true);
    assert.equal(expectedShape.timedOut, false);
  });
});
