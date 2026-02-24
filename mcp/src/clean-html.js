// Clean HTML extraction — runs entirely in the browser via page.evaluate().
// Strips scripts, styles, decorative elements; keeps semantic attributes.

import { createSmartDiff } from './snapshot.js';

const lastHtmlSnapshots = new WeakMap();

/**
 * Extracts cleaned HTML from a Playwright page or locator.
 * All processing happens in-page via DOM manipulation — no server-side parsing deps.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} [selector] - CSS selector to scope extraction (default: document)
 * @param {{ maxAttrLen?: number, maxContentLen?: number, showDiffSinceLastCall?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function getCleanHTML(page, selector, opts = {}) {
  const maxAttrLen = opts.maxAttrLen ?? 200;
  const maxContentLen = opts.maxContentLen ?? 500;
  const showDiffSinceLastCall = opts.showDiffSinceLastCall ?? true;

  const html = await page.evaluate(({ selector, maxAttrLen, maxContentLen }) => {
    const TAGS_TO_REMOVE = new Set([
      'script', 'style', 'link', 'meta', 'noscript',
      'svg', 'head', 'iframe', 'object', 'embed',
    ]);

    const ATTRS_TO_KEEP = new Set([
      'href', 'src', 'alt', 'title', 'name', 'value', 'checked',
      'placeholder', 'type', 'role', 'target', 'label', 'for',
      'aria-label', 'aria-placeholder', 'aria-valuetext',
      'aria-roledescription', 'aria-hidden', 'aria-expanded',
      'aria-checked', 'aria-selected', 'aria-disabled',
      'aria-pressed', 'aria-required', 'aria-current',
      'data-testid', 'data-test', 'data-cy', 'data-qa',
    ]);

    const SEMANTIC_TAGS = new Set([
      'html', 'body', 'main', 'header', 'footer',
      'nav', 'section', 'article', 'aside',
    ]);

    const FORM_TAGS = new Set(['input', 'select', 'textarea', 'button']);

    function truncate(str, max) {
      if (str.length <= max) return str;
      return str.slice(0, max) + '...[' + (str.length - max) + ' more]';
    }

    function shouldKeepAttr(name) {
      if (ATTRS_TO_KEEP.has(name)) return true;
      if (name.startsWith('aria-')) return true;
      if (name.startsWith('data-test') || name.startsWith('data-cy') || name.startsWith('data-qa')) return true;
      return false;
    }

    function hasUsefulContent(el) {
      if (el.nodeType === Node.TEXT_NODE) {
        return el.textContent.trim().length > 0;
      }
      if (el.nodeType !== Node.ELEMENT_NODE) return false;

      const tag = el.tagName.toLowerCase();
      if (FORM_TAGS.has(tag)) return true;
      if (tag === 'img' && el.getAttribute('alt')?.trim()) return true;
      if (tag === 'a' && el.getAttribute('href')) return true;

      for (const child of el.childNodes) {
        if (hasUsefulContent(child)) return true;
      }
      return false;
    }

    function cleanNode(el) {
      if (el.nodeType === Node.COMMENT_NODE) {
        el.remove();
        return;
      }

      if (el.nodeType === Node.TEXT_NODE) {
        if (el.textContent.trim().length === 0) return;
        el.textContent = truncate(el.textContent, maxContentLen);
        return;
      }

      if (el.nodeType !== Node.ELEMENT_NODE) return;

      const tag = el.tagName.toLowerCase();

      if (TAGS_TO_REMOVE.has(tag)) {
        el.remove();
        return;
      }

      if (el.getAttribute('aria-hidden') === 'true') {
        el.remove();
        return;
      }

      // Strip non-semantic attributes
      const attrsToRemove = [];
      for (const attr of el.attributes) {
        if (!shouldKeepAttr(attr.name)) {
          attrsToRemove.push(attr.name);
        }
      }
      for (const name of attrsToRemove) {
        el.removeAttribute(name);
      }

      // Truncate long attribute values
      for (const attr of el.attributes) {
        if (attr.value.length > maxAttrLen) {
          el.setAttribute(attr.name, truncate(attr.value, maxAttrLen));
        }
      }

      // Recurse children (iterate in reverse since we may remove)
      const children = Array.from(el.childNodes);
      for (const child of children) {
        cleanNode(child);
      }

      // After cleaning children: remove decorative elements (no text, no form elements)
      if (!SEMANTIC_TAGS.has(tag) && !FORM_TAGS.has(tag) && !hasUsefulContent(el)) {
        el.remove();
        return;
      }

      // Unwrap unnecessary wrappers: single-child divs/spans with no attributes
      if (el.attributes.length === 0 && el.children.length === 1 && el.childNodes.length === 1) {
        const onlyChild = el.children[0];
        if (onlyChild && onlyChild.nodeType === Node.ELEMENT_NODE) {
          el.replaceWith(onlyChild);
        }
      }
    }

    // Determine root to clean
    let root;
    if (selector) {
      const target = document.querySelector(selector);
      if (!target) return '<empty />';
      root = target.cloneNode(true);
    } else {
      root = document.documentElement.cloneNode(true);
    }

    cleanNode(root);

    // Remove empty elements in multiple passes
    let changed = true;
    while (changed) {
      changed = false;
      for (const el of root.querySelectorAll('*')) {
        if (
          el.attributes.length === 0 &&
          el.childNodes.length === 0 &&
          !FORM_TAGS.has(el.tagName.toLowerCase())
        ) {
          el.remove();
          changed = true;
        }
      }
    }

    return root.outerHTML || root.innerHTML || '';
  }, { selector: selector || null, maxAttrLen, maxContentLen });

  let pageSnapshots = lastHtmlSnapshots.get(page);
  if (!pageSnapshots) {
    pageSnapshots = new Map();
    lastHtmlSnapshots.set(page, pageSnapshots);
  }

  const snapshotKey = selector || '__full_page__';
  const previousSnapshot = pageSnapshots.get(snapshotKey);
  pageSnapshots.set(snapshotKey, html);

  if (showDiffSinceLastCall && previousSnapshot) {
    const diffResult = createSmartDiff(previousSnapshot, html);
    if (diffResult.type === 'no-change') {
      return 'No changes since last call. Use showDiffSinceLastCall: false to see full content.';
    }
    return diffResult.content;
  }

  return html;
}
