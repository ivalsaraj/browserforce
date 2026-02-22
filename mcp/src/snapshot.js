// BrowserForce — Accessibility Snapshot Helpers
// Builds a text-based accessibility tree from Playwright's AX snapshot,
// with interactive element refs mapped to Playwright locators.

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

export function walkAxTree(node, visitor, depth = 0, parentNames = []) {
  if (!node) return;
  visitor(node, depth, parentNames);
  const nextNames = node.name ? [...parentNames, node.name] : parentNames;
  if (node.children) {
    for (const child of node.children) {
      walkAxTree(child, visitor, depth + 1, nextNames);
    }
  }
}

export function hasInteractiveDescendant(node) {
  if (!node.children) return false;
  for (const child of node.children) {
    if (INTERACTIVE_ROLES.has(child.role)) return true;
    if (hasInteractiveDescendant(child)) return true;
  }
  return false;
}

export function hasMatchingDescendant(node, pattern) {
  if (!node.children) return false;
  for (const child of node.children) {
    const text = `${child.role} ${child.name || ''}`;
    if (pattern.test(text)) return true;
    if (hasMatchingDescendant(child, pattern)) return true;
  }
  return false;
}

/**
 * Build snapshot text from an AX tree object.
 *
 * stableIdMap: Map<testid/id value → { attr, value }> keyed by the attribute
 * value itself (not by accessible name) to avoid collisions when multiple
 * elements share the same name.
 *
 * The ref for each interactive element is:
 *  1. The stable attribute value if a matching stableIdMap entry exists for this
 *     node's DOM attributes (looked up by the page-evaluate caller).
 *  2. Otherwise, a fallback counter ref: e1, e2, ...
 *
 * When multiple nodes resolve to the same ref, a -2, -3 suffix is appended.
 */
export function buildSnapshotText(axTree, stableIdMap, searchPattern) {
  const lines = [];
  const refs = [];
  let refCounter = 0;
  const refCounts = new Map();

  walkAxTree(axTree, (node, depth) => {
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
      const stableEntry = node._stableAttr || null;
      let baseRef = stableEntry ? stableEntry.value : `e${refCounter}`;
      const count = refCounts.get(baseRef) ?? 0;
      refCounts.set(baseRef, count + 1);
      const ref = count === 0 ? baseRef : `${baseRef}-${count + 1}`;
      const locator = buildLocator(role, name, stableEntry);

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

/**
 * Annotate AX tree nodes with stable DOM attributes (data-testid, id, etc.).
 *
 * stableIdsByAttrValue: an object of { [attrValue]: { attr, value, names } }
 * returned from getStableIds(). We match AX nodes to stable IDs by checking
 * if the node's accessible name appears in the entry's names array.
 *
 * This runs once per snapshot before buildSnapshotText, attaching _stableAttr
 * to matching nodes in-place.
 */
export function annotateStableAttrs(axTree, stableIds) {
  walkAxTree(axTree, (node) => {
    if (!INTERACTIVE_ROLES.has(node.role)) return;
    const name = node.name || '';
    const entry = stableIds[name];
    if (entry) {
      node._stableAttr = { attr: entry.attr, value: entry.value };
    }
  });
}
