// BrowserForce — Accessibility Label Overlay for Screenshots
// Uses CDP AX tree + DOM.getBoxModel for element positioning,
// then injects browser-side label renderer for Vimium-style labels.

import {
  INTERACTIVE_ROLES, CONTEXT_ROLES, SKIP_ROLES,
  buildLocator, escapeLocatorName,
} from './snapshot.js';

// ─── Semaphore ────────────────────────────────────────────────────────────────

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }

  acquire() {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release() {
    this.count--;
    if (this.queue.length > 0) {
      this.count++;
      this.queue.shift()();
    }
  }
}

// ─── Box Model ────────────────────────────────────────────────────────────────

export function buildBoxFromQuad(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

// ─── CDP AX Tree → Snapshot Text ──────────────────────────────────────────────

export function buildSnapshotFromCdpNodes(nodes, scopeBackendNodeId) {
  // Build lookup maps
  const byId = new Map();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }

  // Find scope root if scoping requested
  let scopeNodeId = null;
  if (scopeBackendNodeId != null) {
    const scopeNode = nodes.find(n => n.backendDOMNodeId === scopeBackendNodeId);
    if (!scopeNode) {
      throw new Error(
        `Scoped element (backendNodeId=${scopeBackendNodeId}) has no matching accessibility node. ` +
        'The element may be aria-hidden or have no accessible role.'
      );
    }
    scopeNodeId = scopeNode.nodeId;
  }

  // Build tree structure from parentId references
  const childrenMap = new Map();
  for (const node of nodes) {
    if (!childrenMap.has(node.nodeId)) childrenMap.set(node.nodeId, []);
    if (node.parentId) {
      if (!childrenMap.has(node.parentId)) childrenMap.set(node.parentId, []);
      childrenMap.get(node.parentId).push(node);
    }
  }

  // Check if a nodeId is inside the scope subtree
  function isInScope(nodeId) {
    if (!scopeNodeId) return true;
    let current = nodeId;
    while (current) {
      if (current === scopeNodeId) return true;
      const node = byId.get(current);
      current = node?.parentId || null;
    }
    return false;
  }

  const lines = [];
  const refs = [];
  let refCounter = 0;

  function walk(nodeId, depth) {
    const node = byId.get(nodeId);
    if (!node || node.ignored) return;

    const role = node.role?.value;
    if (!role) return;

    // Skip root wrapper and generic roles — recurse into children
    if (role === 'RootWebArea' || role === 'WebArea') {
      for (const child of childrenMap.get(nodeId) || []) {
        walk(child.nodeId, depth);
      }
      return;
    }
    if (SKIP_ROLES.has(role)) {
      for (const child of childrenMap.get(nodeId) || []) {
        walk(child.nodeId, depth);
      }
      return;
    }

    // Check scope
    if (!isInScope(nodeId)) return;

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContext = CONTEXT_ROLES.has(role);
    const name = node.name?.value || '';
    const children = childrenMap.get(nodeId) || [];

    // Skip non-interactive, non-context nodes without interactive descendants
    if (!isInteractive && !isContext) {
      const hasInteractive = children.some(c => {
        const r = c.role?.value;
        return r && INTERACTIVE_ROLES.has(r);
      });
      if (!hasInteractive) {
        // Still recurse — children may have interactive descendants
        for (const child of children) {
          walk(child.nodeId, depth);
        }
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
      const ref = `e${refCounter}`;
      const locator = buildLocator(role, name, null);
      lineText += ` [ref=${ref}]`;
      refs.push({ ref, role, name, backendNodeId: node.backendDOMNodeId, locator });
    }

    const relevantChildren = children.filter(c => {
      const r = c.role?.value;
      return r && !c.ignored && (INTERACTIVE_ROLES.has(r) || CONTEXT_ROLES.has(r) || !SKIP_ROLES.has(r));
    });
    if (relevantChildren.length > 0) {
      lineText += ':';
    }

    lines.push(lineText);

    for (const child of children) {
      walk(child.nodeId, depth + 1);
    }
  }

  // Find root nodes (no parentId)
  const roots = nodes.filter(n => !n.parentId);
  for (const root of roots) {
    walk(root.nodeId, 0);
  }

  return { text: lines.join('\n'), refs };
}
