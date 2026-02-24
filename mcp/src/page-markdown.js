// Page markdown extraction — uses Mozilla Readability (Firefox Reader View algorithm).
// Injects a pre-bundled Readability IIFE into the page, then extracts article content.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmartDiff } from './snapshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let readabilityCode = null;
const lastMarkdownSnapshots = new WeakMap();

function isRegExp(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.test === 'function' &&
    typeof value.exec === 'function'
  );
}

function lineMatchesSearch(search, line) {
  if (!isRegExp(search)) {
    return line.toLowerCase().includes(String(search).toLowerCase());
  }
  if (search.global || search.sticky) {
    search.lastIndex = 0;
  }
  return search.test(line);
}

function getReadabilityCode() {
  if (readabilityCode) return readabilityCode;
  const bundlePath = join(__dirname, 'vendor', 'readability.bundle.js');
  readabilityCode = readFileSync(bundlePath, 'utf-8');
  return readabilityCode;
}

/**
 * Extracts page content as structured markdown using Mozilla Readability.
 * Strips nav, ads, sidebars — returns article body with metadata.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ search?: string | RegExp, showDiffSinceLastCall?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export async function getPageMarkdown(page, opts = {}) {
  const search = opts.search;
  const showDiffSinceLastCall = opts.showDiffSinceLastCall ?? true;

  // Inject Readability if not already present
  const hasReadability = await page.evaluate(() => !!globalThis.__readability);
  if (!hasReadability) {
    await page.evaluate(getReadabilityCode());
  }

  const result = await page.evaluate(() => {
    const { Readability, isProbablyReaderable } = globalThis.__readability;

    const documentClone = document.cloneNode(true);

    if (!isProbablyReaderable(documentClone)) {
      return {
        content: document.body?.innerText || '',
        title: document.title || null,
        author: null,
        excerpt: null,
        siteName: null,
        lang: document.documentElement?.lang || null,
        publishedTime: null,
        wordCount: (document.body?.innerText || '').split(/\s+/).filter(Boolean).length,
        readable: false,
      };
    }

    const article = new Readability(documentClone).parse();

    if (!article) {
      return {
        content: document.body?.innerText || '',
        title: document.title || null,
        author: null,
        excerpt: null,
        siteName: null,
        lang: document.documentElement?.lang || null,
        publishedTime: null,
        wordCount: (document.body?.innerText || '').split(/\s+/).filter(Boolean).length,
        readable: false,
      };
    }

    return {
      content: article.textContent || '',
      title: article.title || null,
      author: article.byline || null,
      excerpt: article.excerpt || null,
      siteName: article.siteName || null,
      lang: article.lang || null,
      publishedTime: article.publishedTime || null,
      wordCount: (article.textContent || '').split(/\s+/).filter(Boolean).length,
      readable: true,
    };
  });

  // Format output as structured markdown
  const lines = [];

  if (result.title) {
    lines.push(`# ${result.title}`, '');
  }

  const metadata = [];
  if (result.author) metadata.push(`Author: ${result.author}`);
  if (result.siteName) metadata.push(`Site: ${result.siteName}`);
  if (result.publishedTime) metadata.push(`Published: ${result.publishedTime}`);
  if (metadata.length > 0) {
    lines.push(metadata.join(' | '), '');
  }

  if (result.excerpt && result.content && result.excerpt !== result.content.slice(0, result.excerpt.length)) {
    lines.push(`> ${result.excerpt}`, '');
  }

  lines.push(result.content);

  if (!result.readable) {
    lines.push('', '---', '_Note: Page was not recognized as an article. Returned raw body text._');
  }

  let markdown = lines.join('\n').trim();

  // Sanitize unpaired surrogates that break JSON encoding
  if (typeof markdown.toWellFormed === 'function') {
    markdown = markdown.toWellFormed();
  }

  const previousSnapshot = lastMarkdownSnapshots.get(page);
  lastMarkdownSnapshots.set(page, markdown);

  if (search) {
    const lines = markdown.split('\n');
    const matchIndices = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (lineMatchesSearch(search, line)) {
        matchIndices.push(i);
        if (matchIndices.length >= 10) break;
      }
    }

    if (matchIndices.length === 0) {
      return 'No matches found';
    }

    const CONTEXT_LINES = 5;
    const includedLines = new Set();
    for (const idx of matchIndices) {
      const start = Math.max(0, idx - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, idx + CONTEXT_LINES);
      for (let i = start; i <= end; i++) {
        includedLines.add(i);
      }
    }

    const sortedIndices = [...includedLines].sort((a, b) => a - b);
    const resultLines = [];
    for (let i = 0; i < sortedIndices.length; i++) {
      const lineIdx = sortedIndices[i];
      if (i > 0 && sortedIndices[i - 1] !== lineIdx - 1) {
        resultLines.push('---');
      }
      resultLines.push(lines[lineIdx]);
    }

    return resultLines.join('\n');
  }

  if (showDiffSinceLastCall && previousSnapshot) {
    const diffResult = createSmartDiff(previousSnapshot, markdown);
    if (diffResult.type === 'no-change') {
      return 'No changes since last call. Use showDiffSinceLastCall: false to see full content.';
    }
    return diffResult.content;
  }

  return markdown;
}
