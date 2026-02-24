// Page markdown extraction — uses Mozilla Readability (Firefox Reader View algorithm).
// Injects a pre-bundled Readability IIFE into the page, then extracts article content.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let readabilityCode = null;

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
 * @returns {Promise<string>}
 */
export async function getPageMarkdown(page) {
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

  return markdown;
}
