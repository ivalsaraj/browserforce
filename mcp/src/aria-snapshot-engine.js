// BrowserForce — CDP Accessibility Snapshot Engine
// Ported from Playwriter (aria-snapshot.ts) to standard playwright-core. Builds an
// AX snapshot via CDP Accessibility.getFullAXTree + DOM.getFlattenedDocument,
// cross-referenced by backendNodeId, with frame/locator/interactiveOnly scoping.
// Cross-origin OOPIF stitching is added in Phase 2.

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

export function buildRawSnapshotTree({ nodeId, axById, isNodeInScope }) {
  const node = axById.get(nodeId);
  if (!node) return null;
  const role = getAxRole(node);
  const name = getAxValueString(node.name).trim();
  const children = (node.childIds ?? [])
    .map((childId) => buildRawSnapshotTree({ nodeId: childId, axById, isNodeInScope }))
    .filter(isTruthy);
  const inScope = isNodeInScope(node) || children.length > 0;
  if (!inScope) return null;
  return { role, name, backendNodeId: node.backendDOMNodeId, ignored: node.ignored, children };
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

// Pure assembly from already-fetched CDP arrays. Separated from I/O so it can be
// unit-tested with fabricated fixtures (no browser).
export function assembleSnapshot({ axNodes, domNodes, scopeBackendId = null, interactiveOnly = false, refFilter, frameChain = [] }) {
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

  const refCounts = new Map();
  let fallbackCounter = 0;
  const refs = [];
  const createRefForNode = ({ backendNodeId, role, name }) => {
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

  let snapshotNodes = [];
  if (rootAxNodeId) {
    const rootNode = axById.get(rootAxNodeId);
    const rootRole = rootNode ? getAxRole(rootNode) : '';
    const rawRoots = (rootNode && (rootRole === 'rootwebarea' || rootRole === 'webarea') && rootNode.childIds)
      ? rootNode.childIds.map((id) => buildRawSnapshotTree({ nodeId: id, axById, isNodeInScope })).filter(isTruthy)
      : [buildRawSnapshotTree({ nodeId: rootAxNodeId, axById, isNodeInScope })].filter(isTruthy);
    snapshotNodes = rawRoots.flatMap((rawNode) => (interactiveOnly
      ? filterInteractiveSnapshotTree({ node: rawNode, ancestorNames: [], labelContext: false, refFilter, domByBackendId, promotedContentEditableIds, createRefForNode }).nodes
      : filterFullSnapshotTree({ node: rawNode, ancestorNames: [], refFilter, domByBackendId, promotedContentEditableIds, createRefForNode }).nodes));
  }

  const lines = buildSnapshotLines(snapshotNodes);
  const shortRefMap = buildShortRefMap({ refs });
  const { snapshot, tree } = finalizeSnapshotOutput(lines, snapshotNodes, shortRefMap);
  // Replace each ref's bare baseLocator with the nth-disambiguated locator from
  // the finalized tree so refs and rendered text agree.
  const finalLocatorByRef = new Map();
  const collect = (items) => items.forEach((it) => { if (it.ref) finalLocatorByRef.set(it.ref, it.locator); collect(it.children); });
  collect(tree);
  const refsOut = refs.map((r) => ({ ...r, locator: finalLocatorByRef.get(r.ref) ?? r.locator, shortRef: shortRefMap.get(r.ref) ?? r.ref }));
  return { snapshot, tree, refs: refsOut };
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
 * Returns { snapshot, tree, refs, mainDomNodes }. mainDomNodes is the scope session's
 * flattened DOM, consumed by the Phase 2 frame walk (Task 13). refs:
 * { ref, role, name, locator, backendNodeId, frameChain, shortRef }.
 */
export async function getAriaSnapshot({ page, frame, locator, refFilter, interactiveOnly = false, cdp }) {
  if (!cdp) throw new Error('getAriaSnapshot requires a page CDP session (cdp). Pass getCDPSession({ page }).');
  const resolvedFrame = await resolveFrame({ frame, page });
  const isSubframe = !!resolvedFrame && resolvedFrame !== page.mainFrame();

  let scopeCdp = cdp;
  let ownsScopeCdp = false;
  let sameOriginFrame = null; // resolved Frame when we must scope a same-origin subframe
  if (isSubframe) {
    try {
      scopeCdp = await page.context().newCDPSession(resolvedFrame); // OOPIF: own target
      ownsScopeCdp = true;
    } catch {
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

  try {
    // Reconciliation 5: Accessibility.enable is NOT in the relay's INIT_ONLY_METHODS, so it
    // triggers lazy debugger attach. DOM.enable IS init-only and would no-op on an
    // unattached tab — enable AX first so the debugger is attached before DOM use.
    await scopeCdp.send('Accessibility.enable');
    await scopeCdp.send('DOM.enable');

    if (scopeTarget) {
      await scopeTarget.evaluate((el, data) => el.setAttribute(data.attr, data.value), { attr: scopeAttr, value: scopeValue });
      scopeApplied = true;
    }

    const fetchData = async () => {
      // Back-to-back, no awaits between, to minimise backendNodeId staleness. Both come
      // from scopeCdp so DOM and AX backendNodeIds agree.
      const domP = scopeCdp.send('DOM.getFlattenedDocument', { depth: -1, pierce: true });
      const axP = scopeCdp.send('Accessibility.getFullAXTree');
      const [{ nodes: domNodes }, { nodes: axNodes }] = await Promise.all([domP, axP]);
      return { domNodes, axNodes };
    };

    let { domNodes, axNodes } = await fetchData();
    if (isEmptyAx(axNodes)) {
      await new Promise((r) => setTimeout(r, EMPTY_AX_RETRY_DELAY_MS));
      ({ domNodes, axNodes } = await fetchData());
      if (isEmptyAx(axNodes)) {
        throw new Error('Accessibility tree is empty after retry — the page may still be loading or has no accessible content. Wait for load and retry; do not fall back to a weaker engine.');
      }
    }

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
  } finally {
    if (scopeApplied && scopeTarget) {
      await scopeTarget.evaluate((el, attr) => el.removeAttribute(attr), scopeAttr).catch(() => {});
    }
    if (ownsScopeCdp) await scopeCdp.detach().catch(() => {});
  }
}
