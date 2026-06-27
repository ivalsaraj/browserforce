// BrowserForce — CDP Accessibility Snapshot Engine
// Ported from Playwriter (aria-snapshot.ts) to standard playwright-core. Builds an
// AX snapshot via CDP Accessibility.getFullAXTree + DOM.getFlattenedDocument,
// cross-referenced by backendNodeId, with frame/locator/interactiveOnly scoping.
// Phase 2 stitches same-origin + cross-origin (OOPIF) subframe content under their iframe
// leaves with frameChain-aware refs (see getAriaSnapshot).

import crypto from 'node:crypto';
import {
  INTERACTIVE_ROLES, CONTEXT_ROLES, TEST_ID_ATTRS, escapeLocatorName,
} from './snapshot.js';

// Unnamed wrapper roles are collapsed. Includes 'group', which snapshot.js
// SKIP_ROLES (consumed by a11y-labels.js) intentionally omits — keep a local set
// rather than widening the shared constant.
const SKIP_WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation']);
const LABEL_ROLES = new Set(['labeltext']);
const EMPTY_AX_RETRY_DELAY_MS = 150;

function toAttributeMap(attributes) {
  const result = new Map();
  if (!attributes) return result;
  for (let i = 0; i < attributes.length; i += 2) {
    const name = attributes[i];
    if (name) result.set(name, attributes[i + 1] ?? '');
  }
  return result;
}

function getStableRefFromAttributes(attributes) {
  for (const attr of TEST_ID_ATTRS) {
    const value = attributes.get(attr);
    if (value) return { value, attr };
  }
  const id = attributes.get('id');
  if (id) return { value: id, attr: 'id' };
  return null;
}

function buildLocatorFromStable(stable) {
  return `[${stable.attr}="${escapeLocatorName(stable.value)}"]`;
}

function buildBaseLocator({ role, name, stable, isPromotedContentEditable }) {
  if (stable) return buildLocatorFromStable(stable);
  // Bare <div contenteditable="true"> (ProseMirror/Tiptap/etc.) is promoted to
  // textbox below; Playwright's role=textbox won't match it, so use a CSS attr.
  if (isPromotedContentEditable) return `[contenteditable="true"]`;
  const trimmed = name.trim();
  if (trimmed.length > 0) return `role=${role}[name="${escapeLocatorName(trimmed)}"]`;
  return `role=${role}`;
}

function getAxValueString(value) {
  if (!value) return '';
  const raw = value.value;
  if (typeof raw === 'string') return raw;
  if (raw === undefined || raw === null) return '';
  return String(raw);
}

function getAxRole(node) {
  return getAxValueString(node.role).toLowerCase();
}

function isTextRole(role) {
  return role === 'statictext' || role === 'inlinetextbox';
}

// Per HTML spec, contenteditable is editable for "", "true", or "plaintext-only".
function isContentEditable(value) {
  if (value == null) return false;
  const v = value.trim().toLowerCase();
  return v === '' || v === 'true' || v === 'plaintext-only';
}

function isSubstringOfAny(needle, haystack) {
  for (const str of haystack) {
    if (str.includes(needle)) return true;
  }
  return false;
}

function isTruthy(value) {
  return Boolean(value);
}

function buildSnapshotLine({ role, name, baseLocator, indent, hasChildren }) {
  const prefix = '  '.repeat(indent);
  let text = `${prefix}- ${role}`;
  if (name) text += ` "${escapeLocatorName(name)}"`;
  return { text, baseLocator, hasChildren, role, name, indent };
}

function buildTextLine(text, indent) {
  const prefix = '  '.repeat(indent);
  return { text: `${prefix}- text: "${escapeLocatorName(text)}"` };
}

export function buildSnapshotLines(nodes, indent = 0) {
  return nodes.flatMap((node) => {
    const nodeIndent = indent + (node.indentOffset ?? 0);
    const line = node.role === 'text'
      ? buildTextLine(node.name, nodeIndent)
      : buildSnapshotLine({
          role: node.role, name: node.name, baseLocator: node.baseLocator,
          indent: nodeIndent, hasChildren: node.children.length > 0,
        });
    return [line, ...buildSnapshotLines(node.children, nodeIndent + 1)];
  });
}

function shiftIndent(nodes, offset) {
  return nodes.map((node) => ({ ...node, indentOffset: (node.indentOffset ?? 0) + offset }));
}

export function buildRawSnapshotTree({ nodeId, axById, isNodeInScope, frameBoundaryBackendIds }) {
  const node = axById.get(nodeId);
  if (!node) return null;
  const role = getAxRole(node);
  const name = getAxValueString(node.name).trim();
  // An <iframe>/<frame> element node is a frame boundary: keep it but stop recursing
  // (its content is (re)assembled by the frame walk and stitched back under it).
  const isFrameBoundary = !!frameBoundaryBackendIds
    && node.backendDOMNodeId != null
    && frameBoundaryBackendIds.has(node.backendDOMNodeId);
  const children = isFrameBoundary
    ? []
    : (node.childIds ?? [])
        .map((childId) => buildRawSnapshotTree({ nodeId: childId, axById, isNodeInScope, frameBoundaryBackendIds }))
        .filter(isTruthy);
  const inScope = isNodeInScope(node) || children.length > 0 || isFrameBoundary;
  if (!inScope) return null;
  return { role, name, backendNodeId: node.backendDOMNodeId, ignored: node.ignored, isFrameBoundary, children };
}

export function filterInteractiveSnapshotTree(options) {
  const { node, ancestorNames, labelContext, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode } = options;
  const role = node.role;
  const name = node.name;
  const hasName = name.length > 0;
  const nextAncestors = hasName ? [...ancestorNames, name] : ancestorNames;
  const isLabel = LABEL_ROLES.has(role);
  const nextLabelContext = labelContext || isLabel;

  const childResults = node.children.map((child) => filterInteractiveSnapshotTree({
    node: child, ancestorNames: nextAncestors, labelContext: nextLabelContext,
    refFilter, domByBackendId, promotedContentEditableIds, createRefForNode,
  }));
  const childNodes = childResults.flatMap((r) => r.nodes);
  const childNames = childResults.reduce((acc, r) => { r.names.forEach((n) => acc.add(n)); return acc; }, new Set());

  // Frame-boundary nodes always survive so the walk can stitch frame content under them.
  if (node.isFrameBoundary) {
    return { nodes: [{ role, name, baseLocator: undefined, ref: undefined, backendNodeId: node.backendNodeId, children: childNodes }], names: childNames };
  }

  if (node.ignored) return { nodes: shiftIndent(childNodes, 1), names: childNames };

  if (isTextRole(role)) {
    if (!hasName || !labelContext) return { nodes: childNodes, names: childNames };
    const isRedundant = ancestorNames.some((a) => a.includes(name) || name.includes(a));
    if (isRedundant) return { nodes: childNodes, names: childNames };
    const names = new Set(childNames); names.add(name);
    return { nodes: [{ role: 'text', name, children: [] }], names };
  }

  const hasChildren = childNodes.length > 0;
  const nameToUse = hasName && (childNames.has(name) || isSubstringOfAny(name, childNames)) ? '' : name;
  const hasNameToUse = nameToUse.length > 0;
  const isWrapper = SKIP_WRAPPER_ROLES.has(role);
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const isContext = CONTEXT_ROLES.has(role);
  const passesRefFilter = !refFilter || refFilter({ role, name });
  const includeInteractive = isInteractive && passesRefFilter;
  const shouldInclude = includeInteractive || isLabel || isContext || hasChildren;
  if (!shouldInclude) return { nodes: childNodes, names: childNames };

  if (!includeInteractive && !isLabel && !isContext) {
    return hasChildren ? { nodes: childNodes, names: childNames } : { nodes: [], names: childNames };
  }
  if (isWrapper && !hasNameToUse) {
    return hasChildren ? { nodes: childNodes, names: childNames } : { nodes: [], names: childNames };
  }

  let baseLocator;
  let ref = null;
  if (includeInteractive) {
    const domInfo = node.backendNodeId ? domByBackendId.get(node.backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    const isPromoted = node.backendNodeId != null && (promotedContentEditableIds?.has(node.backendNodeId) ?? false);
    baseLocator = buildBaseLocator({ role, name, stable, isPromotedContentEditable: isPromoted });
    ref = createRefForNode({ backendNodeId: node.backendNodeId, role, name });
  }

  const nodeEntry = { role, name: nameToUse, baseLocator, ref: ref ?? undefined, backendNodeId: node.backendNodeId, children: childNodes };
  const names = new Set(childNames);
  if (hasNameToUse) names.add(nameToUse);
  return { nodes: [nodeEntry], names };
}

export function filterFullSnapshotTree(options) {
  const { node, ancestorNames, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode } = options;
  const role = node.role;
  const name = node.name;
  const hasName = name.length > 0;
  const nextAncestors = hasName ? [...ancestorNames, name] : ancestorNames;

  const childResults = node.children.map((child) => filterFullSnapshotTree({
    node: child, ancestorNames: nextAncestors, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode,
  }));
  const childNodes = childResults.flatMap((r) => r.nodes);
  const childNames = childResults.reduce((acc, r) => { r.names.forEach((n) => acc.add(n)); return acc; }, new Set());

  // Frame-boundary nodes always survive so the walk can stitch frame content under them.
  if (node.isFrameBoundary) {
    return { nodes: [{ role, name, baseLocator: undefined, ref: undefined, backendNodeId: node.backendNodeId, children: childNodes }], names: childNames };
  }

  if (node.ignored) return { nodes: shiftIndent(childNodes, 1), names: childNames };

  if (isTextRole(role)) {
    if (!hasName) return { nodes: childNodes, names: childNames };
    const isRedundant = ancestorNames.some((a) => a.includes(name) || name.includes(a));
    if (isRedundant) return { nodes: childNodes, names: childNames };
    const names = new Set(childNames); names.add(name);
    return { nodes: [{ role: 'text', name, children: [] }], names };
  }

  const hasChildren = childNodes.length > 0;
  const nameToUse = hasName && (childNames.has(name) || isSubstringOfAny(name, childNames)) ? '' : name;
  const hasNameToUse = nameToUse.length > 0;
  const isWrapper = SKIP_WRAPPER_ROLES.has(role);
  const isInteractive = INTERACTIVE_ROLES.has(role);
  const passesRefFilter = !refFilter || refFilter({ role, name });
  const includeInteractive = isInteractive && passesRefFilter;
  const shouldInclude = includeInteractive || hasNameToUse || hasChildren;
  if (!shouldInclude) return { nodes: childNodes, names: childNames };

  if (isWrapper && !hasNameToUse) {
    return hasChildren ? { nodes: childNodes, names: childNames } : { nodes: [], names: childNames };
  }

  let baseLocator;
  let ref = null;
  if (includeInteractive) {
    const domInfo = node.backendNodeId ? domByBackendId.get(node.backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    const isPromoted = node.backendNodeId != null && (promotedContentEditableIds?.has(node.backendNodeId) ?? false);
    baseLocator = buildBaseLocator({ role, name, stable, isPromotedContentEditable: isPromoted });
    ref = createRefForNode({ backendNodeId: node.backendNodeId, role, name });
  }

  const nodeEntry = { role, name: nameToUse, baseLocator, ref: ref ?? undefined, backendNodeId: node.backendNodeId, children: childNodes };
  const names = new Set(childNames);
  if (hasNameToUse) names.add(nameToUse);
  return { nodes: [nodeEntry], names };
}

function buildLocatorLineText({ line, locator }) {
  const prefix = '  '.repeat(line.indent ?? 0);
  const role = line.role ?? '';
  const name = line.name ?? '';
  const escapedName = escapeLocatorName(name);
  const hasRoleInLocator = role ? locator.includes(role) : false;
  const hasNameInLocator = name ? locator.includes(escapedName) : false;
  const parts = [];
  if (role && !hasRoleInLocator) parts.push(role);
  if (name && !hasNameInLocator) parts.push(`"${escapedName}"`);
  const base = parts.length > 0 ? `${prefix}- ${parts.join(' ')}` : `${prefix}-`;
  return `${base} ${locator}`;
}

export function finalizeSnapshotOutput(lines, nodes, shortRefMap) {
  const locatorCounts = lines.reduce((acc, line) => {
    if (line.baseLocator) acc.set(line.baseLocator, (acc.get(line.baseLocator) ?? 0) + 1);
    return acc;
  }, new Map());

  const locatorIndices = new Map();
  const locatorSequence = lines.reduce((acc, line) => {
    if (!line.baseLocator) return acc;
    const count = locatorCounts.get(line.baseLocator) ?? 0;
    const index = locatorIndices.get(line.baseLocator) ?? 0;
    locatorIndices.set(line.baseLocator, index + 1);
    acc.push(count > 1 ? `${line.baseLocator} >> nth=${index}` : line.baseLocator);
    return acc;
  }, []);

  let lineLocatorIndex = 0;
  const snapshot = lines.map((line) => {
    let text = line.text;
    if (line.baseLocator) {
      text = buildLocatorLineText({ line, locator: locatorSequence[lineLocatorIndex] });
      lineLocatorIndex += 1;
    }
    if (line.hasChildren) text += ':';
    return text;
  }).join('\n');

  let nodeLocatorIndex = 0;
  const applyLocators = (items) => items.map((item) => {
    const locator = item.baseLocator ? locatorSequence[nodeLocatorIndex++] : undefined;
    const children = applyLocators(item.children);
    return {
      role: item.role, name: item.name, locator, ref: item.ref,
      shortRef: item.ref ? (shortRefMap.get(item.ref) ?? item.ref) : undefined,
      backendNodeId: item.backendNodeId, children,
    };
  });

  return { snapshot, tree: applyLocators(nodes) };
}

// BrowserForce-specific renderer: keeps the existing `[ref=eN]` line contract
// (Reconciliation 8) while sourcing roles/names/refs from the CDP-built tree.
// The CDP-accurate, frame-aware locator lives in the ref table (exec-engine),
// not inline — so the MCP tool contract and ref-keyed consumers stay intact.
export function renderRefLines(tree) {
  const walk = (nodes, indent) => nodes.flatMap((node) => {
    const prefix = '  '.repeat(indent);
    if (node.role === 'text') return [`${prefix}- text: "${escapeLocatorName(node.name)}"`];
    let line = `${prefix}- ${node.role}`;
    if (node.name) line += ` "${escapeLocatorName(node.name)}"`;
    if (node.ref) line += ` [ref=${node.shortRef ?? node.ref}]`;
    const childLines = walk(node.children ?? [], indent + 1);
    if (childLines.length > 0) line += ':';
    return [line, ...childLines];
  });
  return walk(tree, 0).join('\n');
}

export function buildDomIndex(nodes) {
  const domById = new Map();
  const domByBackendId = new Map();
  const childrenByParent = new Map();
  for (const node of nodes) {
    const info = {
      nodeId: node.nodeId, parentId: node.parentId, backendNodeId: node.backendNodeId,
      nodeName: node.nodeName, attributes: toAttributeMap(node.attributes),
    };
    domById.set(node.nodeId, info);
    domByBackendId.set(node.backendNodeId, info);
    if (node.parentId) {
      if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
      childrenByParent.get(node.parentId).push(node.nodeId);
    }
  }
  return { domById, domByBackendId, childrenByParent };
}

function findScopeRootNodeId(nodes, attrName, attrValue) {
  for (const node of nodes) {
    if (!node.attributes) continue;
    for (let i = 0; i < node.attributes.length; i += 2) {
      if (node.attributes[i] === attrName && node.attributes[i + 1] === attrValue) return node.nodeId;
    }
  }
  return null;
}

function buildBackendIdSet(rootNodeId, childrenByParent, domById) {
  const result = new Set();
  const stack = [rootNodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const node = domById.get(current);
    if (node) result.add(node.backendNodeId);
    const children = childrenByParent.get(current);
    if (children?.length) stack.push(...children);
  }
  return result;
}

export function buildShortRefMap({ refs }) {
  const map = new Map();
  refs.forEach((entry, index) => map.set(entry.ref, `e${index + 1}`));
  return map;
}

// Resolve a Frame | FrameLocator to a real Frame. Detection uses PUBLIC API only:
// a Playwright Frame has childFrames(); a FrameLocator has owner() (a Locator) instead
// (there is no public Frame.frameId() — Reconciliation 7). Used for explicit-frame
// scoping (Phase 1) and OOPIF acquisition (Phase 2).
async function resolveFrame({ frame, page }) {
  if (!frame) return undefined;
  if (typeof frame.childFrames === 'function') return frame;        // already a Frame
  if (typeof frame.owner !== 'function') throw new Error('Unsupported frame argument: expected Frame or FrameLocator');
  const handle = await frame.owner().elementHandle();               // FrameLocator → owning <iframe>
  if (!handle) throw new Error('Could not resolve FrameLocator to a Frame: iframe element not found');
  const resolved = await handle.contentFrame();
  if (!resolved) throw new Error('Could not resolve FrameLocator to a Frame: contentFrame() returned null');
  return resolved;
}

function indexAxNodes(axNodes) {
  const axById = new Map();
  const axByBackendId = new Map();
  for (const node of axNodes) {
    axById.set(node.nodeId, node);
    if (node.backendDOMNodeId) axByBackendId.set(node.backendDOMNodeId, node);
  }
  return { axById, axByBackendId };
}

// Promote bare contenteditable elements Chrome reports as generic so rich-text
// editors appear as interactive textboxes.
function promoteContentEditable(domByBackendId, axByBackendId) {
  const promoted = new Set();
  for (const [, domInfo] of domByBackendId) {
    if (!isContentEditable(domInfo.attributes.get('contenteditable'))) continue;
    const axNode = axByBackendId.get(domInfo.backendNodeId);
    if (!axNode || INTERACTIVE_ROLES.has(getAxRole(axNode))) continue;
    axNode.role = { type: 'role', value: 'textbox' };
    promoted.add(domInfo.backendNodeId);
  }
  return promoted;
}

function findRootAxNodeId(axNodes, scopeRootBackendId, axByBackendId) {
  if (scopeRootBackendId) {
    const scoped = axByBackendId.get(scopeRootBackendId);
    if (scoped) return scoped.nodeId;
  }
  const root = axNodes.find((n) => getAxRole(n) === 'rootwebarea')
    || axNodes.find((n) => getAxRole(n) === 'webarea')
    || axNodes.find((n) => !n.parentId);
  return root ? root.nodeId : null;
}

// ── Phase 2 frame helpers (pure) ─────────────────────────────────────────────

// backendNodeIds of <iframe>/<frame> elements — the frame-boundary leaves of an assembly.
export function collectFrameBoundaryBackendIds(domNodes) {
  const ids = new Set();
  for (const n of domNodes) {
    const name = (n.nodeName || '').toUpperCase();
    if ((name === 'IFRAME' || name === 'FRAME') && n.backendNodeId != null) ids.add(n.backendNodeId);
  }
  return ids;
}

// Selector for an <iframe> element from its DOM attributes (a Map), preferring stable
// attributes, then name/title/src, then nth among iframes (computed by the caller).
export function deriveIframeSelector(ownerAttrs, nthIndex) {
  const attrs = ownerAttrs instanceof Map ? ownerAttrs : new Map();
  const stable = getStableRefFromAttributes(attrs);
  if (stable) return buildLocatorFromStable(stable);
  for (const attr of ['name', 'title', 'src']) {
    const v = attrs.get(attr);
    if (v) return `iframe[${attr}="${escapeLocatorName(v)}"]`;
  }
  return `iframe >> nth=${nthIndex ?? 0}`;
}

// Attach childNodes under the tree node whose backendNodeId === ownerBackendId. Pure.
// Default 'append' is used for every frame because parent assembly cut iframe content
// (frame boundaries are leaves); the walk supplies the real content.
export function stitchFrameTree(tree, ownerBackendId, childNodes, { mode = 'append' } = {}) {
  const walk = (nodes) => nodes.map((node) => {
    if (node.backendNodeId === ownerBackendId) {
      const base = mode === 'replace' ? [] : (node.children ?? []);
      return { ...node, children: [...base, ...childNodes] };
    }
    return { ...node, children: walk(node.children ?? []) };
  });
  return walk(tree);
}

// token value (from a tagged attribute) → { backendNodeId, attrs } by scanning flattened DOM.
export function mapTokenToBackendId(domNodes, attr) {
  const map = new Map();
  for (const n of domNodes) {
    if (!n.attributes) continue;
    for (let i = 0; i < n.attributes.length; i += 2) {
      if (n.attributes[i] === attr) {
        map.set(n.attributes[i + 1], { backendNodeId: n.backendNodeId, attrs: toAttributeMap(n.attributes) });
      }
    }
  }
  return map;
}

// Owner index in flattened-DOM order — deterministic nth fallback for deriveIframeSelector.
// Global DOM order; per-parent-document nth for nested same-origin frames is a documented
// edge (see Task 13 limitation) — acceptable since attribute-less nested iframes are rare.
function iframeNthIndex(domNodes, backendNodeId) {
  let seen = -1;
  for (const n of domNodes) {
    const name = (n.nodeName || '').toUpperCase();
    if (name !== 'IFRAME' && name !== 'FRAME') continue;
    seen += 1;
    if (n.backendNodeId === backendNodeId) return seen;
  }
  return 0;
}

// Topologically order frame metas so a parent is stitched before its children (stitchFrameTree
// needs the parent's iframe leaf already present in the tree). Uses PUBLIC parentFrame() only.
export function orderFramesParentFirst(frameMeta) {
  const depth = (f) => {
    let d = 0;
    let cur = typeof f?.parentFrame === 'function' ? f.parentFrame() : null;
    while (cur) { d += 1; cur = typeof cur.parentFrame === 'function' ? cur.parentFrame() : null; }
    return d;
  };
  return [...frameMeta].sort((a, b) => depth(a.frame) - depth(b.frame));
}

// Compose the iframe-selector chain (top → target) by walking the PUBLIC parentFrame() chain.
// Each meta carries a precomputed `iframeSelector` (deriveIframeSelector of its owner element),
// resolved at the call site where owner attrs are in hand. (Codex plan's loose
// `(frame, ownerByToken, domNodes)` signature can't map frame→owner-token without per-frame
// state, so the selector is precomputed and read here.) Pure given metaByFrame.
export function buildFrameChain(frame, metaByFrame) {
  const chain = [];
  let cur = frame;
  while (cur && typeof cur.parentFrame === 'function' && cur.parentFrame()) {
    const meta = metaByFrame.get(cur);
    chain.unshift(meta?.iframeSelector ?? 'iframe');
    cur = cur.parentFrame();
  }
  return chain;
}

// Shared ref context: one per snapshot so eN fallbacks + dedup stay globally unique across
// every (main + per-frame) assembly. Per-assembly data (domByBackendId, promoted ids,
// frameChain) is passed per call, NOT closed over, so one context spans multiple frames.
export function createRefContext() {
  const refCounts = new Map();
  let fallbackCounter = 0;
  const refs = [];
  const createRefForNode = ({ backendNodeId, role, name, frameChain, domByBackendId, promotedContentEditableIds }) => {
    if (!INTERACTIVE_ROLES.has(role)) return null;
    const domInfo = backendNodeId ? domByBackendId.get(backendNodeId) : undefined;
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null;
    let baseRef = stable?.value;
    if (!baseRef) { fallbackCounter += 1; baseRef = `e${fallbackCounter}`; }
    const count = refCounts.get(baseRef) ?? 0;
    refCounts.set(baseRef, count + 1);
    const ref = count === 0 ? baseRef : `${baseRef}-${count + 1}`;
    let locator;
    if (stable && count === 0) locator = buildLocatorFromStable(stable);
    if (!locator && backendNodeId != null && promotedContentEditableIds.has(backendNodeId)) locator = '[contenteditable="true"]';
    refs.push({ ref, role, name, locator, backendNodeId, frameChain });
    return ref;
  };
  return { refCounts, refs, createRefForNode };
}

// Replace each ref's bare baseLocator with the nth-disambiguated locator from the finalized
// tree (and attach shortRef). Refs not present in the finalized tree keep their own locator.
// Shared by the standalone and multi-frame paths so both agree with the rendered text.
export function reconcileRefLocators(refs, finalizedTree, shortRefMap) {
  const finalLocatorByRef = new Map();
  const collect = (items) => items.forEach((it) => { if (it.ref) finalLocatorByRef.set(it.ref, it.locator); collect(it.children ?? []); });
  collect(finalizedTree);
  return refs.map((r) => ({ ...r, locator: finalLocatorByRef.get(r.ref) ?? r.locator, shortRef: shortRefMap.get(r.ref) ?? r.ref }));
}

// PRE-finalize builder: filtered/scoped node tree whose nodes still carry `baseLocator` +
// `ref`, with refs pushed into the shared refCtx. Used by the main tree AND every per-frame
// call. `frameBoundaryBackendIds` makes <iframe>/<frame> nodes leaves (content stitched later).
// NOT finalized — callers finalize once (assembleSnapshot for one tree; the walk for many).
export function buildScopedNodes({ axNodes, domNodes, scopeBackendId = null, interactiveOnly = false, refFilter, frameChain = [], refCtx, frameBoundaryBackendIds }) {
  const ctx = refCtx ?? createRefContext();
  const { domById, domByBackendId, childrenByParent } = buildDomIndex(domNodes);
  const { axById, axByBackendId } = indexAxNodes(axNodes);
  const promotedContentEditableIds = promoteContentEditable(domByBackendId, axByBackendId);

  let allowedBackendIds = null;
  if (scopeBackendId != null) {
    // scopeBackendId is a DOM backendNodeId; map to its nodeId then collect subtree.
    let scopeNodeId = null;
    for (const [nodeId, info] of domById) {
      if (info.backendNodeId === scopeBackendId) { scopeNodeId = nodeId; break; }
    }
    allowedBackendIds = scopeNodeId ? buildBackendIdSet(scopeNodeId, childrenByParent, domById) : new Set();
  }

  const rootAxNodeId = findRootAxNodeId(axNodes, scopeBackendId, axByBackendId);
  const isNodeInScope = (node) => {
    if (!allowedBackendIds) return true;
    if (!node.backendDOMNodeId) return false;
    return allowedBackendIds.has(node.backendDOMNodeId);
  };

  // Per-assembly wrapper: binds this frame's domByBackendId/promoted ids/frameChain to the
  // shared ref context so the filter call signature stays unchanged.
  const createRefForNode = ({ backendNodeId, role, name }) => ctx.createRefForNode({
    backendNodeId, role, name, frameChain, domByBackendId, promotedContentEditableIds,
  });

  let snapshotNodes = [];
  if (rootAxNodeId) {
    const rootNode = axById.get(rootAxNodeId);
    const rootRole = rootNode ? getAxRole(rootNode) : '';
    const rawRoots = (rootNode && (rootRole === 'rootwebarea' || rootRole === 'webarea') && rootNode.childIds)
      ? rootNode.childIds.map((id) => buildRawSnapshotTree({ nodeId: id, axById, isNodeInScope, frameBoundaryBackendIds })).filter(isTruthy)
      : [buildRawSnapshotTree({ nodeId: rootAxNodeId, axById, isNodeInScope, frameBoundaryBackendIds })].filter(isTruthy);
    snapshotNodes = rawRoots.flatMap((rawNode) => (interactiveOnly
      ? filterInteractiveSnapshotTree({ node: rawNode, ancestorNames: [], labelContext: false, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode }).nodes
      : filterFullSnapshotTree({ node: rawNode, ancestorNames: [], refFilter, domByBackendId, promotedContentEditableIds, createRefForNode }).nodes));
  }

  return { nodes: snapshotNodes, refCtx: ctx };
}

// Standalone single-tree assembly (Phase 1 / explicit scope): build + finalize once.
// NEVER call twice with a shared refCtx — it finalizes/reconciles its OWN tree per call.
// Multi-frame stitching uses buildScopedNodes per frame + a single finalize (see the walk).
export function assembleSnapshot(opts) {
  const { nodes, refCtx } = buildScopedNodes(opts);
  const lines = buildSnapshotLines(nodes);
  const shortRefMap = buildShortRefMap({ refs: refCtx.refs });
  const { snapshot, tree } = finalizeSnapshotOutput(lines, nodes, shortRefMap);
  const refs = reconcileRefLocators(refCtx.refs, tree, shortRefMap);
  return { snapshot, tree, refs, refCtx };
}

function isEmptyAx(axNodes) {
  if (!Array.isArray(axNodes) || axNodes.length === 0) return true;
  // Only a RootWebArea with no children → tree not computed yet.
  const meaningful = axNodes.filter((n) => {
    const role = getAxRole(n);
    return role && role !== 'rootwebarea' && role !== 'webarea';
  });
  return meaningful.length === 0;
}

// Playwright throws this EXACT message (playwright-core crBrowser.js `newCDPSession`) when a
// Frame has no own CDP target — i.e. it is an in-process same-origin frame. ANY other
// newCDPSession failure (e.g. the relay could not resolve an OOPIF's Target.attachToTarget,
// or the frame detached) is an UNEXPECTED acquisition error and must NOT be silently treated
// as same-origin: doing so would mis-scope an explicit subframe to the whole page, or stitch
// the wrong content on the full-page walk. Match the stable, unique substring.
export function isSameOriginFrameSessionError(err) {
  const msg = (err && (err.message ?? String(err))) || '';
  return /separate CDP session/i.test(msg);
}

/**
 * Get an accessibility snapshot.
 *
 * Session ownership (Codex Round-1 CRITICAL fix — grounded in
 * `node_modules/playwright-core/lib/coreBundle.js:38176` `newCDPSession`):
 *   - main frame: use the page `cdp` session, `getFullAXTree()` (no frameId).
 *   - explicit OOPIF subframe: `newCDPSession(resolvedFrame)` SUCCEEDS (the frame has its
 *     own target in `delegate._sessions`); fetch DOM+AX on that frame session (its root IS
 *     the frame, so no frameId/scope needed). Engine owns + detaches this session.
 *   - explicit same-origin subframe: `newCDPSession(resolvedFrame)` THROWS by design
 *     ("This frame does not have a separate CDP session…"). Fall back to the page session
 *     and scope to the frame's content root via the same data-attr mechanism used for
 *     `locator` (no public `Frame.frameId()` exists in std playwright-core, so we never
 *     pass `getFullAXTree({ frameId })`).
 * DOM + AX are ALWAYS fetched from the SAME session — backendNodeIds are per-process, so
 * mixing a page session's DOM with a frame session's AX would mis-resolve refs.
 *
 * Phase 2 (Task 13): with NO explicit `frame`/`locator`, the engine also stitches subframe
 * content. Every <iframe>/<frame> is a leaf in the main tree (boundary cutoff); each subframe
 * is (re)assembled once into the SAME shared `refCtx` — OOPIF via `newCDPSession(frame)`,
 * same-origin from the parent session scoped to the frame root — then stitched under its owner
 * leaf by backendNodeId, and the whole tree is finalized exactly once. In-frame refs carry a
 * `frameChain` (iframe selectors top→target) so `locatorForRef` can pierce via `frameLocator`.
 * Explicit `frame`/`locator` keeps Phase-1 single-region behavior (empty frameChain).
 *
 * Returns { snapshot, tree, refs, mainDomNodes }. mainDomNodes is the page session's flattened
 * DOM. refs: { ref, role, name, locator, backendNodeId, frameChain, shortRef }.
 */
export async function getAriaSnapshot({ page, frame, locator, refFilter, interactiveOnly = false, cdp }) {
  if (!cdp) throw new Error('getAriaSnapshot requires a page CDP session (cdp). Pass getCDPSession({ page }).');
  const resolvedFrame = await resolveFrame({ frame, page });
  const isSubframe = !!resolvedFrame && resolvedFrame !== page.mainFrame();
  const explicitScope = !!locator || isSubframe; // explicit region → Phase-1 single assembly

  let scopeCdp = cdp;
  let ownsScopeCdp = false;
  let sameOriginFrame = null; // resolved Frame when we must scope a same-origin subframe
  if (isSubframe) {
    try {
      scopeCdp = await page.context().newCDPSession(resolvedFrame); // OOPIF: own target
      ownsScopeCdp = true;
    } catch (err) {
      if (!isSameOriginFrameSessionError(err)) {
        // Real OOPIF acquisition failure (relay couldn't resolve the frame's target, frame
        // detached, …). Falling back to the page session would silently return the WHOLE page
        // for an explicitly-requested subframe — fail loudly instead of mis-scoping.
        throw new Error(`Failed to acquire a CDP session for the requested subframe (the relay may not have resolved its OOPIF target): ${err?.message ?? err}`);
      }
      scopeCdp = cdp;                 // same-origin in-process frame → page session + scope
      sameOriginFrame = resolvedFrame;
    }
  }

  // A locator scopes within the chosen session's document. For a same-origin frame with no
  // explicit locator, scope to that frame's root element.
  const scopeTarget = locator || (sameOriginFrame ? sameOriginFrame.locator(':root') : null);

  const scopeAttr = 'data-pw-scope';
  const scopeValue = crypto.randomUUID();
  let scopeApplied = false;

  // Phase-2 frame-walk bookkeeping (populated only on the no-explicit-scope page path).
  const OWNER_ATTR = 'data-pw-frame-owner';
  const ROOT_ATTR = 'data-pw-frame-root';
  const frameMeta = [];      // { frame, ownerToken, rootToken, iframeSelector?, frameChain? }
  const tagged = [];         // { ownerHandle, frame, rootToken } — attributes to clean up
  const childSessions = [];  // OOPIF sessions owned + detached by the walk

  try {
    // Reconciliation 5: Accessibility.enable is NOT in the relay's INIT_ONLY_METHODS, so it
    // triggers lazy debugger attach. DOM.enable IS init-only and would no-op on an
    // unattached tab — enable AX first so the debugger is attached before DOM use.
    await scopeCdp.send('Accessibility.enable');
    await scopeCdp.send('DOM.enable');

    // Tag every subframe's owner element + content root BEFORE the main fetch so the page DOM
    // carries the tokens in one pass. Owner attrs land in the page DOM (the <iframe> lives in
    // the parent doc); same-origin content roots land there too (pierce:true), OOPIF roots do
    // not (cross-process) — those go through the newCDPSession branch instead.
    if (!explicitScope && typeof page.frames === 'function') {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const ownerToken = crypto.randomUUID();
        const rootToken = crypto.randomUUID();
        let ownerHandle;
        try {
          ownerHandle = await f.frameElement();
          await ownerHandle.evaluate((el, t) => el.setAttribute('data-pw-frame-owner', t), ownerToken);
        } catch { continue; }   // frame detached / owner not reachable
        await f.locator(':root').evaluate((el, t) => el.setAttribute('data-pw-frame-root', t), rootToken).catch(() => {});
        tagged.push({ ownerHandle, frame: f, rootToken });
        frameMeta.push({ frame: f, ownerToken, rootToken });
      }
    }

    if (scopeTarget) {
      await scopeTarget.evaluate((el, data) => el.setAttribute(data.attr, data.value), { attr: scopeAttr, value: scopeValue });
      scopeApplied = true;
    }

    // DOM + AX are fetched back-to-back from the SAME session (no awaits between) to minimise
    // backendNodeId staleness; mixing sessions would mis-resolve refs (ids are per-process).
    const fetchDomAndAx = async (session) => {
      const domP = session.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
      const axP = session.send('Accessibility.getFullAXTree');
      const [{ nodes: domNodes }, { nodes: axNodes }] = await Promise.all([domP, axP]);
      return { domNodes, axNodes };
    };
    // One bounded retry for an empty AX tree (the page/frame may still be computing it). Shared
    // by the main session and every child-frame session so subframes get the same contract.
    const fetchDomAndAxWithRetry = async (session) => {
      let res = await fetchDomAndAx(session);
      if (isEmptyAx(res.axNodes)) {
        await new Promise((r) => setTimeout(r, EMPTY_AX_RETRY_DELAY_MS));
        res = await fetchDomAndAx(session);
      }
      return res;
    };

    let { domNodes, axNodes } = await fetchDomAndAxWithRetry(scopeCdp);
    if (isEmptyAx(axNodes)) {
      throw new Error('Accessibility tree is empty after retry — the page may still be loading or has no accessible content. Wait for load and retry; do not fall back to a weaker engine.');
    }

    // ── Explicit scope (Phase 1): one region, no recursive walk, empty frameChain. ──
    if (explicitScope) {
      let scopeBackendId = null;
      if (scopeTarget) {
        const scopeNodeId = findScopeRootNodeId(domNodes, scopeAttr, scopeValue);
        if (scopeNodeId != null) {
          const { domById } = buildDomIndex(domNodes);
          scopeBackendId = domById.get(scopeNodeId)?.backendNodeId ?? null;
        }
      }
      const assembled = assembleSnapshot({ axNodes, domNodes, scopeBackendId, interactiveOnly, refFilter, frameChain: [] });
      return { ...assembled, mainDomNodes: domNodes };
    }

    // ── Full page (Phase 2): main tree with iframes as leaves, then stitch each subframe. ──
    const mainBoundaryIds = collectFrameBoundaryBackendIds(domNodes);
    const { nodes: mainNodes, refCtx } = buildScopedNodes({
      axNodes, domNodes, interactiveOnly, refFilter, frameChain: [],
      frameBoundaryBackendIds: mainBoundaryIds,
    });

    const ownerByToken = mapTokenToBackendId(domNodes, OWNER_ATTR); // token -> { backendNodeId, attrs }
    const rootByToken = mapTokenToBackendId(domNodes, ROOT_ATTR);   // same-origin content roots
    const metaByFrame = new Map();
    for (const meta of frameMeta) {
      const owner = ownerByToken.get(meta.ownerToken);
      meta.iframeSelector = owner
        ? deriveIframeSelector(owner.attrs, iframeNthIndex(domNodes, owner.backendNodeId))
        : 'iframe';
      metaByFrame.set(meta.frame, meta);
    }

    let stitched = mainNodes;
    for (const meta of orderFramesParentFirst(frameMeta)) {
      const owner = ownerByToken.get(meta.ownerToken);
      if (!owner) continue;   // owner not in the page-process DOM (e.g. nested inside an OOPIF)
      meta.frameChain = buildFrameChain(meta.frame, metaByFrame);
      let childNodes;
      try {
        const frameCdp = await page.context().newCDPSession(meta.frame); // OOPIF only (else throws)
        childSessions.push(frameCdp);
        await frameCdp.send('Accessibility.enable');
        await frameCdp.send('DOM.enable');
        // Same empty-AX retry contract as the main session (a child tree can lag); on the
        // full-page walk an empty/never-ready child is best-effort skipped, not thrown.
        const { domNodes: cDom, axNodes: cAx } = await fetchDomAndAxWithRetry(frameCdp);
        if (isEmptyAx(cAx)) continue;
        ({ nodes: childNodes } = buildScopedNodes({
          axNodes: cAx, domNodes: cDom, interactiveOnly, refFilter,
          frameChain: meta.frameChain, refCtx,
          frameBoundaryBackendIds: collectFrameBoundaryBackendIds(cDom),
        }));
      } catch (err) {
        // ONLY the genuine same-origin "no separate CDP session" error means we should
        // re-assemble from the parent session. Any other failure (real OOPIF acquisition
        // error, frame detach, AX enable failure) is best-effort skipped so one bad frame
        // never poisons the whole-page snapshot (documented one-level-OOPIF limitation).
        if (!isSameOriginFrameSessionError(err)) continue;
        // same-origin: re-assemble from the parent session's already-fetched axNodes/domNodes,
        // scoped to the frame's content root, SAME boundary cutoff (nested iframes stay leaves).
        const rootBackendId = rootByToken.get(meta.rootToken)?.backendNodeId;
        if (rootBackendId == null) continue;
        ({ nodes: childNodes } = buildScopedNodes({
          axNodes, domNodes, scopeBackendId: rootBackendId, interactiveOnly, refFilter,
          frameChain: meta.frameChain, refCtx, frameBoundaryBackendIds: mainBoundaryIds,
        }));
      }
      stitched = stitchFrameTree(stitched, owner.backendNodeId, childNodes);
    }

    // ── finalize ONCE over the fully-stitched pre-finalize node tree ──
    const lines = buildSnapshotLines(stitched);
    const shortRefMap = buildShortRefMap({ refs: refCtx.refs });
    const { snapshot, tree } = finalizeSnapshotOutput(lines, stitched, shortRefMap);
    const refs = reconcileRefLocators(refCtx.refs, tree, shortRefMap);
    return { snapshot, tree, refs, mainDomNodes: domNodes };
  } finally {
    if (scopeApplied && scopeTarget) {
      await scopeTarget.evaluate((el, attr) => el.removeAttribute(attr), scopeAttr).catch(() => {});
    }
    for (const s of childSessions) await s.detach().catch(() => {});
    for (const t of tagged) {
      await t.ownerHandle.evaluate((el, a) => el.removeAttribute(a), OWNER_ATTR).catch(() => {});
      await t.frame.locator(`[data-pw-frame-root="${t.rootToken}"]`).evaluate((el, a) => el.removeAttribute(a), ROOT_ATTR).catch(() => {});
    }
    if (ownsScopeCdp) await scopeCdp.detach().catch(() => {});
  }
}
