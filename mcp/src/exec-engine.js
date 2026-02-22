// BrowserForce — Shared Execution Engine
// Used by both MCP server and CLI.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  TEST_ID_ATTRS,
  buildSnapshotText, parseSearchPattern, annotateStableAttrs,
} from './snapshot.js';

// ─── Configuration ───────────────────────────────────────────────────────────

export const BF_DIR = join(homedir(), '.browserforce');
export const CDP_URL_FILE = join(BF_DIR, 'cdp-url');

export function getCdpUrl() {
  if (process.env.BF_CDP_URL) return process.env.BF_CDP_URL;
  try {
    const url = readFileSync(CDP_URL_FILE, 'utf8').trim();
    if (url) return url;
  } catch { /* fall through */ }
  throw new Error(
    'Cannot find CDP URL. Either:\n' +
    '  1. Start the relay first: browserforce serve\n' +
    '  2. Set BF_CDP_URL environment variable'
  );
}

/** Derive the relay HTTP base URL from the CDP WebSocket URL. */
export function getRelayHttpUrl() {
  const cdpUrl = getCdpUrl();
  try {
    const parsed = new URL(cdpUrl);
    return `http://${parsed.hostname}:${parsed.port}`;
  } catch {
    return 'http://127.0.0.1:19222';
  }
}

// ─── Smart Page Load Detection ───────────────────────────────────────────────
// Filters analytics/ad requests that never finish, polls document.readyState +
// pending resource count.

const FILTERED_DOMAINS = [
  'doubleclick', 'googlesyndication', 'googleadservices', 'google-analytics',
  'googletagmanager', 'facebook.net', 'fbcdn.net', 'twitter.com', 'linkedin.com',
  'hotjar', 'mixpanel', 'segment.io', 'segment.com', 'newrelic', 'datadoghq',
  'sentry.io', 'fullstory', 'amplitude', 'intercom', 'crisp.chat', 'zdassets.com',
  'zendesk', 'tawk.to', 'hubspot', 'marketo', 'pardot', 'optimizely', 'crazyegg',
  'mouseflow', 'clarity.ms', 'bing.com/bat', 'ads.', 'analytics.', 'tracking.',
  'pixel.',
];

const FILTERED_EXTENSIONS = ['.gif', '.ico', '.cur', '.woff', '.woff2', '.ttf', '.otf', '.eot'];

const STUCK_THRESHOLD_MS = 10000;
const SLOW_RESOURCE_THRESHOLD_MS = 3000;

export async function smartWaitForPageLoad(page, timeout, pollInterval = 100, minWait = 500) {
  const startTime = Date.now();
  let lastReadyState = '';
  let lastPendingRequests = [];

  const checkArgs = {
    filteredDomains: FILTERED_DOMAINS,
    filteredExtensions: FILTERED_EXTENSIONS,
    stuckThreshold: STUCK_THRESHOLD_MS,
    slowResourceThreshold: SLOW_RESOURCE_THRESHOLD_MS,
  };

  const checkPageReady = () => page.evaluate((args) => {
    const readyState = document.readyState;
    if (readyState !== 'complete') {
      return { ready: false, readyState, pendingRequests: [`document.readyState: ${readyState}`] };
    }

    const resources = performance.getEntriesByType('resource');
    const now = performance.now();

    const pendingRequests = resources
      .filter((r) => {
        if (r.responseEnd > 0) return false;
        const elapsed = now - r.startTime;
        const url = r.name.toLowerCase();
        if (url.startsWith('data:')) return false;
        if (args.filteredDomains.some((d) => url.includes(d))) return false;
        if (elapsed > args.stuckThreshold) return false;
        if (elapsed > args.slowResourceThreshold &&
            args.filteredExtensions.some((ext) => url.includes(ext))) return false;
        return true;
      })
      .map((r) => r.name);

    return { ready: pendingRequests.length === 0, readyState, pendingRequests };
  }, checkArgs);

  try {
    const first = await checkPageReady();
    if (first.ready) {
      return {
        success: true, readyState: first.readyState,
        pendingRequests: 0, waitTimeMs: Date.now() - startTime, timedOut: false,
      };
    }
    lastReadyState = first.readyState;
    lastPendingRequests = first.pendingRequests;
  } catch {
    // page may not be ready for evaluate yet
  }

  await new Promise((r) => globalThis.setTimeout(r, minWait));

  while (Date.now() - startTime < timeout) {
    try {
      const { ready, readyState, pendingRequests } = await checkPageReady();
      lastReadyState = readyState;
      lastPendingRequests = pendingRequests;
      if (ready) {
        return {
          success: true, readyState,
          pendingRequests: 0, waitTimeMs: Date.now() - startTime, timedOut: false,
        };
      }
    } catch {
      return {
        success: false, readyState: 'error',
        pendingRequests: ['page.evaluate failed — page may have closed or navigated'],
        waitTimeMs: Date.now() - startTime, timedOut: false,
      };
    }
    await new Promise((r) => globalThis.setTimeout(r, pollInterval));
  }

  return {
    success: false, readyState: lastReadyState,
    pendingRequests: lastPendingRequests.slice(0, 10),
    waitTimeMs: Date.now() - startTime, timedOut: true,
  };
}

// ─── Accessibility Tree via DOM ──────────────────────────────────────────────
// Replaces page.accessibility.snapshot() which was removed in Playwright 1.58.
// Walks the DOM and builds an AX tree using ARIA roles, HTML semantics, and
// computed accessible names. Supports Shadow DOM (open roots).

export async function getAccessibilityTree(page, rootSelector) {
  return page.evaluate((sel) => {
    function getRole(el) {
      if (el.nodeType !== 1) return null;
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      switch (el.tagName) {
        case 'A': return el.hasAttribute('href') ? 'link' : null;
        case 'BUTTON': case 'SUMMARY': return 'button';
        case 'INPUT': {
          const t = (el.type || 'text').toLowerCase();
          if (t === 'hidden') return null;
          return { text: 'textbox', search: 'searchbox', email: 'textbox', url: 'textbox',
            tel: 'textbox', password: 'textbox', number: 'spinbutton',
            checkbox: 'checkbox', radio: 'radio', range: 'slider',
            button: 'button', submit: 'button', reset: 'button', image: 'button',
          }[t] || 'textbox';
        }
        case 'SELECT': return 'combobox';
        case 'TEXTAREA': return 'textbox';
        case 'IMG': return 'img';
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
        case 'NAV': return 'navigation';
        case 'MAIN': return 'main';
        case 'HEADER': return el.closest('article, aside, main, nav, section') ? null : 'banner';
        case 'FOOTER': return el.closest('article, aside, main, nav, section') ? null : 'contentinfo';
        case 'ASIDE': return 'complementary';
        case 'FORM': return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('name')) ? 'form' : null;
        case 'TABLE': return 'table';
        case 'THEAD': case 'TBODY': case 'TFOOT': return 'rowgroup';
        case 'TR': return 'row';
        case 'TH': return 'columnheader';
        case 'TD': return 'cell';
        case 'UL': case 'OL': return 'list';
        case 'LI': return 'listitem';
        case 'DIALOG': return 'dialog';
        case 'DETAILS': case 'FIELDSET': return 'group';
        case 'PROGRESS': return 'progressbar';
        case 'METER': return 'meter';
        case 'OPTION': return 'option';
        case 'SECTION': return (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : null;
        case 'ARTICLE': return 'article';
        case 'SEARCH': return 'search';
        default: return null;
      }
    }

    function getName(el) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim();
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy.split(/\s+/)
          .map(id => document.getElementById(id)?.textContent?.trim())
          .filter(Boolean).join(' ');
        if (t) return t;
      }
      if (el.tagName === 'IMG') return (el.alt || '').trim();
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
        if (el.id) {
          const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lab) return lab.textContent?.trim() || '';
        }
        const parentLabel = el.closest('label');
        if (parentLabel) {
          const clone = parentLabel.cloneNode(true);
          clone.querySelectorAll('input,select,textarea').forEach(i => i.remove());
          const t = clone.textContent?.trim();
          if (t) return t;
        }
        if (el.placeholder) return el.placeholder.trim();
      }
      if (el.title && !['A', 'BUTTON'].includes(el.tagName)) return el.title.trim();
      const textTags = ['BUTTON', 'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SUMMARY', 'OPTION', 'LEGEND', 'CAPTION'];
      if (textTags.includes(el.tagName)) {
        return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
      }
      return '';
    }

    function isHidden(el) {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.hidden) return true;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD'].includes(el.tagName)) return true;
      try {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return true;
      } catch { /* ignore */ }
      return false;
    }

    function getChildren(el) {
      const kids = [];
      // Regular DOM children
      for (const child of el.children) {
        kids.push(child);
      }
      // Open Shadow DOM
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          kids.push(child);
        }
      }
      return kids;
    }

    let nodeCount = 0;
    const MAX_NODES = 2000;

    function buildTree(el, depth) {
      if (!el || el.nodeType !== 1) return null;
      if (isHidden(el)) return null;
      if (depth > 30) return null; // prevent runaway recursion
      if (nodeCount >= MAX_NODES) return null; // cap total nodes

      const role = getRole(el);
      const children = [];
      for (const child of getChildren(el)) {
        if (nodeCount >= MAX_NODES) break;
        const r = buildTree(child, depth + 1);
        if (r) {
          if (Array.isArray(r)) children.push(...r);
          else children.push(r);
        }
      }

      if (role) {
        nodeCount++;
        const node = { role, name: getName(el) };
        if (/^H[1-6]$/.test(el.tagName)) node.level = parseInt(el.tagName[1]);
        if (['checkbox', 'radio', 'switch'].includes(role)) {
          node.checked = el.checked ?? el.getAttribute('aria-checked') === 'true';
        }
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
        const exp = el.getAttribute('aria-expanded');
        if (exp !== null) node.expanded = exp === 'true';
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) {
          node.value = el.value.slice(0, 500);
        }
        if (el.tagName === 'SELECT' && el.selectedOptions?.length) {
          node.value = el.selectedOptions[0]?.text || '';
        }
        if (children.length > 0) node.children = children;
        return node;
      }

      // No role: pass through children
      if (children.length === 0) return null;
      if (children.length === 1) return children[0];
      return children; // flatten
    }

    const scope = sel ? document.querySelector(sel) : document.body;
    if (!scope) return null;

    const result = buildTree(scope, 0);
    if (!result) return { role: 'WebArea', name: document.title, children: [] };
    const kids = Array.isArray(result) ? result : (result.children || [result]);
    return { role: 'WebArea', name: document.title, children: kids };
  }, rootSelector || null);
}

// ─── Snapshot Helper ─────────────────────────────────────────────────────────

export async function getStableIds(page, rootSelector) {
  return page.evaluate(({ testIdAttrs, root }) => {
    const scope = root ? document.querySelector(root) : document;
    if (!scope) return {};
    const result = {};
    const selectors = testIdAttrs.map(a => `[${a}]`).join(',');
    const elements = scope.querySelectorAll(selectors + ',[id]');
    for (const el of elements) {
      const name = el.getAttribute('aria-label') ||
                   el.textContent?.trim().slice(0, 100) || '';
      if (!name) continue;
      for (const attr of testIdAttrs) {
        const value = el.getAttribute(attr);
        if (value) {
          if (!result[name]) {
            result[name] = { attr, value };
          }
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
  }, { testIdAttrs: TEST_ID_ATTRS, root: rootSelector || null });
}

// ─── Execution Engine ────────────────────────────────────────────────────────

export class CodeExecutionTimeoutError extends Error {
  constructor(ms) {
    super(`Code execution timed out after ${ms}ms`);
    this.name = 'CodeExecutionTimeoutError';
  }
}

// buildExecContext takes userState and optional console helpers as params
// instead of referencing module-level singletons.
export function buildExecContext(defaultPage, ctx, userState, consoleHelpers = {}) {
  const { consoleLogs, setupConsoleCapture } = consoleHelpers;

  const activePage = () => {
    if (userState.page && !userState.page.isClosed()) return userState.page;
    if (defaultPage && !defaultPage.isClosed()) return defaultPage;
    throw new Error('No active page. Create one first: state.page = await context.newPage()');
  };

  const snapshot = async ({ selector, search } = {}) => {
    const page = activePage();
    const axRoot = await getAccessibilityTree(page, selector);
    if (!axRoot) return 'No accessibility tree available for this page.';
    const stableIds = await getStableIds(page, selector);
    annotateStableAttrs(axRoot, stableIds);
    const searchPattern = parseSearchPattern(search);
    const { text: snapshotText, refs } = buildSnapshotText(axRoot, null, searchPattern);
    const refTable = refs.length > 0
      ? '\n\n--- Ref → Locator ---\n' + refs.map(r => `${r.ref}: ${r.locator}`).join('\n')
      : '';
    const title = await page.title().catch(() => '');
    const pageUrl = page.url();
    return `Page: ${title} (${pageUrl})\nRefs: ${refs.length} interactive elements\n\n${snapshotText}${refTable}`;
  };

  const waitForPageLoad = (opts = {}) =>
    smartWaitForPageLoad(activePage(), opts.timeout ?? 30000);

  const getLogs = ({ count } = {}) => {
    if (!consoleLogs || !setupConsoleCapture) return [];
    const page = activePage();
    setupConsoleCapture(page);
    const logs = consoleLogs.get(page) || [];
    return count ? logs.slice(-count) : [...logs];
  };

  const clearLogs = () => {
    if (consoleLogs) consoleLogs.set(activePage(), []);
  };

  return {
    page: defaultPage, context: ctx, state: userState,
    snapshot, waitForPageLoad, getLogs, clearLogs,
    fetch, URL, URLSearchParams, Buffer, setTimeout, clearTimeout,
    TextEncoder, TextDecoder,
  };
}

export async function runCode(code, execCtx, timeoutMs) {
  const keys = Object.keys(execCtx);
  const vals = Object.values(execCtx);
  const fn = new Function(...keys, `return (async function() {\n${code}\n})()`);
  let result;
  const nativeSetTimeout = globalThis.setTimeout;
  await Promise.race([
    (async () => { result = await fn(...vals); })(),
    new Promise((_, reject) =>
      nativeSetTimeout(() => reject(new CodeExecutionTimeoutError(timeoutMs)), timeoutMs)),
  ]);
  return result;
}

export function formatResult(result) {
  if (result === undefined || result === null) {
    return { type: 'text', text: String(result) };
  }
  if (Buffer.isBuffer(result)) {
    return { type: 'image', data: result.toString('base64'), mimeType: 'image/png' };
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return { type: 'text', text: text ?? 'undefined' };
}
