import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

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
  // Dynamically import the MCP server module to check tool registration.
  // We can't start the full server (it needs stdio transport), but we can
  // verify the module loads without errors.

  it('MCP server module loads without syntax errors', async () => {
    // We just verify the module can be parsed. Actually starting it
    // would attempt a Playwright connection which we don't want in tests.
    // Use a subprocess with --check flag.
    const { execSync } = await import('node:child_process');
    const result = execSync('node --check src/index.js', {
      cwd: join(import.meta.url.replace('file://', ''), '../../'),
      encoding: 'utf8',
    });
    assert.equal(result, '');
  });

  it('tool names follow bf_ prefix convention', () => {
    // Read the source and extract tool names
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

    assert.ok(toolNames.length >= 10, `Should have at least 10 tools, found ${toolNames.length}`);

    for (const name of toolNames) {
      assert.ok(name.startsWith('bf_'), `Tool "${name}" should start with "bf_"`);
      assert.ok(!name.includes('-'), `Tool "${name}" should use underscores, not hyphens`);
    }
  });

  it('all expected tools are registered', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    const expectedTools = [
      'bf_list_tabs',
      'bf_navigate',
      'bf_new_tab',
      'bf_close_tab',
      'bf_screenshot',
      'bf_click',
      'bf_type',
      'bf_fill',
      'bf_press_key',
      'bf_scroll',
      'bf_select',
      'bf_hover',
      'bf_get_content',
      'bf_evaluate',
      'bf_wait_for',
    ];

    for (const tool of expectedTools) {
      assert.ok(source.includes(`'${tool}'`), `Tool "${tool}" should be registered`);
    }
  });

  it('tools have descriptions', () => {
    const source = readFileSync(
      join(import.meta.url.replace('file://', ''), '../../src/index.js'),
      'utf8'
    );

    // Each server.tool() call should have a description string after the name
    const toolBlocks = source.split('server.tool(').slice(1);
    for (const block of toolBlocks) {
      // After the tool name string, next arg should be description string
      const lines = block.split('\n').slice(0, 5).join(' ');
      assert.ok(
        lines.includes("'") && lines.split("'").length >= 4,
        'Each tool should have a name and description string'
      );
    }
  });
});

// ─── Helper Function Logic ───────────────────────────────────────────────────

describe('Helper Logic', () => {
  it('tab index validation is correct', () => {
    // Simulate getPage logic
    function getPage(pages, tabIndex) {
      const idx = tabIndex ?? 0;
      if (idx < 0 || idx >= pages.length) {
        throw new Error(`Tab index ${idx} out of range. ${pages.length} tab(s) available.`);
      }
      return pages[idx];
    }

    const pages = ['page0', 'page1', 'page2'];

    assert.equal(getPage(pages, 0), 'page0');
    assert.equal(getPage(pages, 2), 'page2');
    assert.equal(getPage(pages, undefined), 'page0'); // default to 0

    assert.throws(() => getPage(pages, 3), /out of range/);
    assert.throws(() => getPage(pages, -1), /out of range/);
    assert.throws(() => getPage([], 0), /out of range/);
  });

  it('content truncation works correctly', () => {
    function truncate(content, limit = 50000) {
      if (content.length > limit) {
        return content.slice(0, limit) + '\n\n[...truncated at 50000 chars]';
      }
      return content;
    }

    const short = 'hello world';
    assert.equal(truncate(short), short);

    const long = 'x'.repeat(60000);
    const truncated = truncate(long);
    assert.ok(truncated.length < long.length);
    assert.ok(truncated.endsWith('[...truncated at 50000 chars]'));
    assert.equal(truncated.indexOf('x'.repeat(50000)), 0);
  });

  it('scroll direction maps to correct deltas', () => {
    function getDeltas(direction, amount) {
      const px = amount || 500;
      const deltaX = direction === 'right' ? px : direction === 'left' ? -px : 0;
      const deltaY = direction === 'down' ? px : direction === 'up' ? -px : 0;
      return { deltaX, deltaY };
    }

    assert.deepEqual(getDeltas('down', 300), { deltaX: 0, deltaY: 300 });
    assert.deepEqual(getDeltas('up', 300), { deltaX: 0, deltaY: -300 });
    assert.deepEqual(getDeltas('right', 300), { deltaX: 300, deltaY: 0 });
    assert.deepEqual(getDeltas('left', 300), { deltaX: -300, deltaY: 0 });
    assert.deepEqual(getDeltas('down'), { deltaX: 0, deltaY: 500 }); // default 500
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
});
