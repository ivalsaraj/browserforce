// BrowserForce — Shared Accessibility Constants + Snapshot Diff/Search Helpers
// Role sets and locator/name escaping shared by the CDP snapshot engine and the
// screenshot label path; plus createSmartDiff/parseSearchPattern used by snapshot
// diffing and clean-html/page-markdown.

import { createPatch } from 'diff';

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'searchbox',
  'checkbox', 'radio', 'slider', 'spinbutton', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'tab', 'treeitem',
]);

export const CONTEXT_ROLES = new Set([
  'navigation', 'main', 'contentinfo', 'banner', 'form',
  'section', 'region', 'complementary', 'search',
  'list', 'listitem', 'table', 'rowgroup', 'row', 'cell',
  'heading', 'img',
]);

export const SKIP_ROLES = new Set([
  'generic', 'none', 'presentation',
]);

export const TEST_ID_ATTRS = [
  'data-testid', 'data-test-id', 'data-test',
  'data-cy', 'data-pw', 'data-qa', 'data-e2e',
];

export function escapeLocatorName(name) {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildLocator(role, name, stableAttr) {
  if (stableAttr) {
    return `[${stableAttr.attr}="${escapeLocatorName(stableAttr.value)}"]`;
  }
  const trimmed = name?.trim();
  if (trimmed) {
    return `role=${role}[name="${escapeLocatorName(trimmed)}"]`;
  }
  return `role=${role}`;
}

export function createSmartDiff(oldText, newText) {
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

export function parseSearchPattern(search) {
  if (!search) return null;
  try {
    return new RegExp(search, 'i');
  } catch (err) {
    throw new Error(`Invalid search regex "${search}": ${err.message}`);
  }
}
