// BrowserForce — MCP Server
// Exposes browser control tools for AI agents via Model Context Protocol.
// Connects to the relay via Playwright's CDP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createPatch } from 'diff';

// ─── Configuration ───────────────────────────────────────────────────────────

const BF_DIR = join(homedir(), '.browserforce');
const CDP_URL_FILE = join(BF_DIR, 'cdp-url');

function getCdpUrl() {
  if (process.env.BF_CDP_URL) return process.env.BF_CDP_URL;
  try {
    const url = readFileSync(CDP_URL_FILE, 'utf8').trim();
    if (url) return url;
  } catch { /* fall through */ }
  throw new Error(
    'Cannot find CDP URL. Either:\n' +
    '  1. Start the relay first: pnpm relay\n' +
    '  2. Set BF_CDP_URL environment variable'
  );
}

// ─── Browser Connection ──────────────────────────────────────────────────────

let browser = null;

async function ensureBrowser() {
  if (browser?.isConnected()) return;
  const cdpUrl = getCdpUrl();
  browser = await chromium.connectOverCDP(cdpUrl);
  browser.on('disconnected', () => { browser = null; });
}

function getContext() {
  if (!browser?.isConnected()) throw new Error('Not connected to relay. Is the relay running?');
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error('No browser context available');
  return contexts[0];
}

function getPages() {
  return getContext().pages();
}

function getPage(tabIndex) {
  const pages = getPages();
  const idx = tabIndex ?? 0;
  if (idx < 0 || idx >= pages.length) {
    throw new Error(`Tab index ${idx} out of range. ${pages.length} tab(s) available.`);
  }
  return pages[idx];
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'browserforce',
  version: '1.0.0',
});

// ─── Tab Management Tools ────────────────────────────────────────────────────

server.tool(
  'bf_list_tabs',
  'List all browser tabs controlled by the relay. Returns index, URL, and title for each.',
  {},
  async () => {
    await ensureBrowser();
    const pages = getPages();
    const tabs = [];
    for (let i = 0; i < pages.length; i++) {
      let title = '';
      try { title = await pages[i].title(); } catch {}
      tabs.push({ index: i, url: pages[i].url(), title });
    }
    return { content: [{ type: 'text', text: JSON.stringify(tabs, null, 2) }] };
  }
);

server.tool(
  'bf_navigate',
  'Navigate a browser tab to a URL',
  {
    url: z.string().describe('URL to navigate to'),
    tabIndex: z.number().optional().describe('Tab index (default: 0, use bf_list_tabs to see indices)'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
      .describe('When to consider navigation done (default: domcontentloaded)'),
  },
  async ({ url, tabIndex, waitUntil }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const response = await page.goto(url, {
      waitUntil: waitUntil || 'domcontentloaded',
      timeout: 30000,
    });
    const status = response?.status() || 'unknown';
    const finalUrl = page.url();
    return {
      content: [{ type: 'text', text: `Navigated to ${finalUrl} (status: ${status})` }],
    };
  }
);

server.tool(
  'bf_new_tab',
  'Open a new browser tab (uses your real Chrome profile with all cookies/sessions)',
  {
    url: z.string().optional().describe('URL to open (default: about:blank)'),
  },
  async ({ url }) => {
    await ensureBrowser();
    const context = getContext();
    const page = await context.newPage();
    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    const pages = getPages();
    const idx = pages.indexOf(page);
    return {
      content: [{ type: 'text', text: `Opened new tab at index ${idx}: ${page.url()}` }],
    };
  }
);

server.tool(
  'bf_close_tab',
  'Close a browser tab',
  {
    tabIndex: z.number().describe('Tab index to close (use bf_list_tabs to see indices)'),
  },
  async ({ tabIndex }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const url = page.url();
    await page.close();
    return { content: [{ type: 'text', text: `Closed tab ${tabIndex} (${url})` }] };
  }
);

// ─── Observation Tools ───────────────────────────────────────────────────────

server.tool(
  'bf_screenshot',
  'Take a screenshot of a browser tab. Returns the image directly.',
  {
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    fullPage: z.boolean().optional().describe('Capture full scrollable page (default: false)'),
    selector: z.string().optional().describe('CSS selector to screenshot a specific element'),
  },
  async ({ tabIndex, fullPage, selector }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);

    let buffer;
    if (selector) {
      const element = page.locator(selector);
      buffer = await element.screenshot({ type: 'png' });
    } else {
      buffer = await page.screenshot({ type: 'png', fullPage: fullPage || false });
    }

    return {
      content: [{
        type: 'image',
        data: buffer.toString('base64'),
        mimeType: 'image/png',
      }],
    };
  }
);

server.tool(
  'bf_get_content',
  'Get text content or HTML from a page or element',
  {
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    selector: z.string().optional().describe('CSS selector (default: body)'),
    format: z.enum(['text', 'html']).optional().describe('Output format (default: text)'),
  },
  async ({ tabIndex, selector, format }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const sel = selector || 'body';
    const fmt = format || 'text';

    let content;
    if (fmt === 'html') {
      content = await page.locator(sel).innerHTML();
    } else {
      content = await page.locator(sel).innerText();
    }

    // Truncate very large content
    if (content.length > 50000) {
      content = content.slice(0, 50000) + '\n\n[...truncated at 50000 chars]';
    }

    return { content: [{ type: 'text', text: content }] };
  }
);

server.tool(
  'bf_evaluate',
  'Execute JavaScript in the page context and return the result',
  {
    expression: z.string().describe('JavaScript expression to evaluate'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
  },
  async ({ expression, tabIndex }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const result = await page.evaluate(expression);
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text: text ?? 'undefined' }] };
  }
);

// ─── Interaction Tools ───────────────────────────────────────────────────────

server.tool(
  'bf_click',
  'Click an element on the page',
  {
    selector: z.string().describe('CSS selector, text selector ("text=Login"), or role selector ("role=button[name=Submit]")'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default: left)'),
    clickCount: z.number().optional().describe('Number of clicks (default: 1, use 2 for double-click)'),
  },
  async ({ selector, tabIndex, button, clickCount }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    await page.locator(selector).click({
      button: button || 'left',
      clickCount: clickCount || 1,
      timeout: 10000,
    });
    return { content: [{ type: 'text', text: `Clicked: ${selector}` }] };
  }
);

server.tool(
  'bf_type',
  'Type text character by character (works on contenteditable, React inputs, etc.)',
  {
    text: z.string().describe('Text to type'),
    selector: z.string().optional().describe('CSS selector to focus first (types into currently focused element if omitted)'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    delay: z.number().optional().describe('Delay between keystrokes in ms (default: 0)'),
  },
  async ({ text, selector, tabIndex, delay }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    if (selector) {
      await page.locator(selector).click({ timeout: 10000 });
    }
    await page.keyboard.type(text, { delay: delay || 0 });
    return { content: [{ type: 'text', text: `Typed ${text.length} character(s)` }] };
  }
);

server.tool(
  'bf_fill',
  'Fill an input or textarea (clears existing value first). For standard form fields.',
  {
    selector: z.string().describe('CSS selector for the input/textarea'),
    value: z.string().describe('Value to fill'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
  },
  async ({ selector, value, tabIndex }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    await page.locator(selector).fill(value, { timeout: 10000 });
    return { content: [{ type: 'text', text: `Filled ${selector} with "${value}"` }] };
  }
);

server.tool(
  'bf_press_key',
  'Press a keyboard key or key combination',
  {
    key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "Control+a", "Meta+c")'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
  },
  async ({ key, tabIndex }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    await page.keyboard.press(key);
    return { content: [{ type: 'text', text: `Pressed: ${key}` }] };
  }
);

server.tool(
  'bf_scroll',
  'Scroll the page or an element',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.number().optional().describe('Scroll amount in pixels (default: 500)'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    selector: z.string().optional().describe('CSS selector to scroll within (default: page)'),
  },
  async ({ direction, amount, tabIndex, selector }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const px = amount || 500;

    const deltaX = direction === 'right' ? px : direction === 'left' ? -px : 0;
    const deltaY = direction === 'down' ? px : direction === 'up' ? -px : 0;

    if (selector) {
      await page.locator(selector).evaluate(
        (el, { dx, dy }) => el.scrollBy(dx, dy),
        { dx: deltaX, dy: deltaY }
      );
    } else {
      await page.mouse.wheel(deltaX, deltaY);
    }

    return { content: [{ type: 'text', text: `Scrolled ${direction} ${px}px` }] };
  }
);

server.tool(
  'bf_select',
  'Select an option from a <select> dropdown',
  {
    selector: z.string().describe('CSS selector for the <select> element'),
    value: z.string().describe('Option value or label to select'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
  },
  async ({ selector, value, tabIndex }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const selected = await page.locator(selector).selectOption(value, { timeout: 10000 });
    return { content: [{ type: 'text', text: `Selected: ${JSON.stringify(selected)}` }] };
  }
);

// ─── Wait Tool ───────────────────────────────────────────────────────────────

server.tool(
  'bf_wait_for',
  'Wait for an element to appear, a URL pattern, or a load state',
  {
    selector: z.string().optional().describe('CSS selector to wait for'),
    url: z.string().optional().describe('URL pattern to wait for (substring match)'),
    state: z.enum(['load', 'domcontentloaded', 'networkidle']).optional()
      .describe('Load state to wait for'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    timeout: z.number().optional().describe('Max wait time in ms (default: 10000)'),
  },
  async ({ selector, url, state, tabIndex, timeout }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const ms = timeout || 10000;

    if (selector) {
      await page.locator(selector).waitFor({ state: 'visible', timeout: ms });
      return { content: [{ type: 'text', text: `Element appeared: ${selector}` }] };
    }

    if (url) {
      await page.waitForURL(`**${url}**`, { timeout: ms });
      return { content: [{ type: 'text', text: `URL matched: ${page.url()}` }] };
    }

    if (state) {
      await page.waitForLoadState(state, { timeout: ms });
      return { content: [{ type: 'text', text: `Load state reached: ${state}` }] };
    }

    throw new Error('Provide at least one of: selector, url, or state');
  }
);

// ─── Hover Tool ──────────────────────────────────────────────────────────────

server.tool(
  'bf_hover',
  'Hover over an element (triggers CSS :hover and JS mouseover events)',
  {
    selector: z.string().describe('CSS selector to hover'),
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
  },
  async ({ selector, tabIndex }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    await page.locator(selector).hover({ timeout: 10000 });
    return { content: [{ type: 'text', text: `Hovered: ${selector}` }] };
  }
);

// ─── Accessibility Snapshot ─────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'searchbox',
  'checkbox', 'radio', 'slider', 'spinbutton', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'tab', 'treeitem',
]);

const CONTEXT_ROLES = new Set([
  'navigation', 'main', 'contentinfo', 'banner', 'form',
  'section', 'region', 'complementary', 'search',
  'list', 'listitem', 'table', 'rowgroup', 'row', 'cell',
  'heading', 'img',
]);

const SKIP_ROLES = new Set([
  'generic', 'none', 'presentation',
]);

const TEST_ID_ATTRS = [
  'data-testid', 'data-test-id', 'data-test',
  'data-cy', 'data-pw', 'data-qa', 'data-e2e',
];

const previousSnapshots = new Map();

function escapeLocatorName(name) {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildLocator(role, name, stableAttr) {
  if (stableAttr) {
    return `[${stableAttr.attr}="${escapeLocatorName(stableAttr.value)}"]`;
  }
  const trimmed = name?.trim();
  if (trimmed) {
    return `role=${role}[name="${escapeLocatorName(trimmed)}"]`;
  }
  return `role=${role}`;
}

function walkAxTree(node, visitor, depth = 0, parentNames = []) {
  if (!node) return;
  visitor(node, depth, parentNames);
  const nextNames = node.name ? [...parentNames, node.name] : parentNames;
  if (node.children) {
    for (const child of node.children) {
      walkAxTree(child, visitor, depth + 1, nextNames);
    }
  }
}

function hasInteractiveDescendant(node) {
  if (!node.children) return false;
  for (const child of node.children) {
    if (INTERACTIVE_ROLES.has(child.role)) return true;
    if (hasInteractiveDescendant(child)) return true;
  }
  return false;
}

function buildSnapshotText(axTree, stableIdMap, searchPattern) {
  const lines = [];
  const refs = [];
  let refCounter = 0;

  walkAxTree(axTree, (node, depth, parentNames) => {
    const role = node.role;
    if (SKIP_ROLES.has(role) || role === 'RootWebArea' || role === 'WebArea') {
      return;
    }

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContext = CONTEXT_ROLES.has(role);
    const name = node.name || '';

    if (!isInteractive && !isContext) {
      if (!hasInteractiveDescendant(node)) return;
    }

    if (searchPattern) {
      const text = `${role} ${name}`;
      if (!searchPattern.test(text) && !hasMatchingDescendant(node, searchPattern)) {
        return;
      }
    }

    const indent = '  '.repeat(depth);
    let lineText = `${indent}- ${role}`;
    if (name) {
      lineText += ` "${escapeLocatorName(name)}"`;
    }

    if (isInteractive) {
      refCounter++;
      const stableId = stableIdMap?.get(name);
      const ref = stableId ? stableId.value : `e${refCounter}`;
      const locator = buildLocator(role, name, stableId);

      lineText += ` [ref=${ref}]`;
      refs.push({ ref, role, name, locator });
    }

    if (node.children?.length > 0) {
      const hasRelevantChildren = node.children.some(c =>
        INTERACTIVE_ROLES.has(c.role) || CONTEXT_ROLES.has(c.role) || hasInteractiveDescendant(c)
      );
      if (hasRelevantChildren) {
        lineText += ':';
      }
    }

    lines.push(lineText);
  });

  return { text: lines.join('\n'), refs };
}

function hasMatchingDescendant(node, pattern) {
  if (!node.children) return false;
  for (const child of node.children) {
    const text = `${child.role} ${child.name || ''}`;
    if (pattern.test(text)) return true;
    if (hasMatchingDescendant(child, pattern)) return true;
  }
  return false;
}

async function getStableIds(page) {
  return page.evaluate((testIdAttrs) => {
    const result = {};
    const selectors = testIdAttrs.map(a => `[${a}]`).join(',');
    const elements = document.querySelectorAll(selectors + ',[id]');
    for (const el of elements) {
      const name = el.getAttribute('aria-label') ||
                   el.textContent?.trim().slice(0, 100) || '';
      for (const attr of testIdAttrs) {
        const value = el.getAttribute(attr);
        if (value) {
          result[name] = { attr, value };
          break;
        }
      }
      if (!result[name]) {
        const id = el.getAttribute('id');
        if (id && !/^[:\d]/.test(id) && !id.includes('__')) {
          result[name] = { attr: 'id', value: id };
        }
      }
    }
    return result;
  }, TEST_ID_ATTRS);
}

function createDiff(oldText, newText) {
  if (oldText === newText) return { type: 'no-change', content: newText };

  const patch = createPatch('snapshot', oldText, newText, 'previous', 'current', { context: 3 });
  const patchLines = patch.split('\n');
  const diffBody = patchLines.slice(4).join('\n');

  const oldLineCount = oldText.split('\n').length;
  const newLineCount = newText.split('\n').length;
  const addedLines = (diffBody.match(/^\+[^+]/gm) || []).length;
  const removedLines = (diffBody.match(/^-[^-]/gm) || []).length;
  const changeRatio = Math.max(addedLines, removedLines) / Math.max(oldLineCount, newLineCount, 1);

  if (changeRatio >= 0.5 || diffBody.length >= newText.length) {
    return { type: 'full', content: newText };
  }
  return { type: 'diff', content: diffBody };
}

server.tool(
  'bf_snapshot',
  'Get an accessibility snapshot of the page as a text tree. Returns interactive elements with refs you can use as locators in bf_click/bf_fill. Much cheaper than screenshots (~5-20KB text vs 100KB+ image). Supports search filtering and diff mode.',
  {
    tabIndex: z.number().optional().describe('Tab index (default: 0)'),
    search: z.string().optional().describe('Regex pattern to filter elements (e.g., "button|input" to show only buttons and inputs)'),
    diff: z.boolean().optional().describe('Return only changes since last snapshot of this tab (default: false)'),
    selector: z.string().optional().describe('CSS selector to scope snapshot to a subtree'),
  },
  async ({ tabIndex, search, diff, selector }) => {
    await ensureBrowser();
    const page = getPage(tabIndex);
    const pageUrl = page.url();

    const axRoot = selector
      ? await page.locator(selector).ariaSnapshot()
      : await page.accessibility.snapshot({ interestingOnly: false });

    if (!axRoot) {
      return { content: [{ type: 'text', text: 'No accessibility tree available for this page.' }] };
    }

    const stableIdRaw = await getStableIds(page);
    const stableIdMap = new Map();
    for (const [name, info] of Object.entries(stableIdRaw)) {
      stableIdMap.set(name, info);
    }

    const searchPattern = search ? new RegExp(search, 'i') : null;
    const { text: snapshotText, refs } = buildSnapshotText(axRoot, stableIdMap, searchPattern);

    let output;
    const cacheKey = `${tabIndex ?? 0}::${pageUrl}`;

    if (diff && previousSnapshots.has(cacheKey)) {
      const prevText = previousSnapshots.get(cacheKey);
      const result = createDiff(prevText, snapshotText);

      if (result.type === 'no-change') {
        output = '[no changes since last snapshot]';
      } else if (result.type === 'diff') {
        output = `[diff from previous snapshot]\n${result.content}`;
      } else {
        output = snapshotText;
      }
    } else {
      output = snapshotText;
    }

    previousSnapshots.set(cacheKey, snapshotText);

    const refTable = refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + refs.map(r => `${r.ref}: ${r.locator}`).join('\n')
      : '';

    const title = await page.title().catch(() => '');
    const header = `Page: ${title} (${pageUrl})\nRefs: ${refs.length} interactive elements\n\n`;

    return {
      content: [{ type: 'text', text: header + output + refTable }],
    };
  }
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  // Connect to relay on startup
  try {
    await ensureBrowser();
    process.stderr.write('[bf-mcp] Connected to relay\n');
  } catch (err) {
    process.stderr.write(`[bf-mcp] Warning: ${err.message}\n`);
    process.stderr.write('[bf-mcp] Tools will attempt to connect on first use\n');
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[bf-mcp] MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`[bf-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
