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

// ─── Browser-Side Label Renderer ──────────────────────────────────────────────
// Injected into page context via page.evaluate().
// Port of Playwriter's a11y-client.ts — Vimium-style color-coded labels.

const LABELS_CONTAINER_ID = '__bf_labels__';
const LABELS_TIMER_KEY = '__bf_labels_timer__';

export const ROLE_COLORS = {
  link: ['#FFF785', '#FFC542', '#E3BE23'],
  button: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  textbox: ['#FFCDD2', '#EF9A9A', '#E57373'],
  combobox: ['#F8BBD0', '#F48FB1', '#F06292'],
  searchbox: ['#F8BBD0', '#F48FB1', '#F06292'],
  checkbox: ['#C8E6C9', '#A5D6A7', '#81C784'],
  radio: ['#C8E6C9', '#A5D6A7', '#81C784'],
  slider: ['#BBDEFB', '#90CAF9', '#64B5F6'],
  spinbutton: ['#BBDEFB', '#90CAF9', '#64B5F6'],
  switch: ['#D1C4E9', '#B39DDB', '#9575CD'],
  menuitem: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  menuitemcheckbox: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  menuitemradio: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  option: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  tab: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  treeitem: ['#FFE0B2', '#FFCC80', '#FFB74D'],
  img: ['#B3E5FC', '#81D4FA', '#4FC3F7'],
  video: ['#B3E5FC', '#81D4FA', '#4FC3F7'],
  audio: ['#B3E5FC', '#81D4FA', '#4FC3F7'],
};

const DEFAULT_COLORS = ['#FFF9C4', '#FFF59D', '#FFEB3B'];

// This string is injected into the page via page.evaluate().
// It sets up globalThis.__bf_a11y with renderA11yLabels and hideA11yLabels.
export const A11Y_CLIENT_CODE = `
(function() {
  const CONTAINER_ID = '${LABELS_CONTAINER_ID}';
  const TIMER_KEY = '${LABELS_TIMER_KEY}';
  const ROLE_COLORS = ${JSON.stringify(ROLE_COLORS)};
  const DEFAULT_COLORS = ${JSON.stringify(DEFAULT_COLORS)};

  function renderA11yLabels(labels) {
    const doc = document;
    const win = window;

    if (win[TIMER_KEY]) {
      win.clearTimeout(win[TIMER_KEY]);
      win[TIMER_KEY] = null;
    }

    doc.getElementById(CONTAINER_ID)?.remove();

    const container = doc.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = 'position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none;';

    const style = doc.createElement('style');
    style.textContent = '.__bf_label__{position:absolute;font:bold 12px Helvetica,Arial,sans-serif;padding:1px 4px;border-radius:3px;color:black;text-shadow:0 1px 0 rgba(255,255,255,0.6);white-space:nowrap;}';
    container.appendChild(style);

    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;overflow:visible;';
    svg.setAttribute('width', '' + doc.documentElement.scrollWidth);
    svg.setAttribute('height', '' + doc.documentElement.scrollHeight);

    const defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);
    const markerCache = {};

    function getArrowMarkerId(color) {
      if (markerCache[color]) return markerCache[color];
      const markerId = 'bf-arrow-' + color.replace('#', '');
      const marker = doc.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', markerId);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      path.setAttribute('fill', color);
      marker.appendChild(path);
      defs.appendChild(marker);
      markerCache[color] = markerId;
      return markerId;
    }

    container.appendChild(svg);

    const placedLabels = [];
    const LABEL_HEIGHT = 17;
    const LABEL_CHAR_WIDTH = 7;

    const viewportLeft = win.scrollX;
    const viewportTop = win.scrollY;
    const viewportRight = viewportLeft + win.innerWidth;
    const viewportBottom = viewportTop + win.innerHeight;

    let count = 0;
    for (const item of labels) {
      const ref = item.ref;
      const role = item.role;
      const box = item.box;

      const rectLeft = box.x;
      const rectTop = box.y;
      const rectRight = rectLeft + box.width;
      const rectBottom = rectTop + box.height;

      if (box.width <= 0 || box.height <= 0) continue;
      if (rectRight < viewportLeft || rectLeft > viewportRight ||
          rectBottom < viewportTop || rectTop > viewportBottom) continue;

      const labelWidth = ref.length * LABEL_CHAR_WIDTH + 8;
      const labelLeft = rectLeft;
      const labelTop = Math.max(0, rectTop - LABEL_HEIGHT);
      const labelRect = { left: labelLeft, top: labelTop, right: labelLeft + labelWidth, bottom: labelTop + LABEL_HEIGHT };

      let overlaps = false;
      for (const placed of placedLabels) {
        if (labelRect.left < placed.right && labelRect.right > placed.left &&
            labelRect.top < placed.bottom && labelRect.bottom > placed.top) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const colors = ROLE_COLORS[role] || DEFAULT_COLORS;
      const label = doc.createElement('div');
      label.className = '__bf_label__';
      label.textContent = ref;
      label.style.background = 'linear-gradient(to bottom, ' + colors[0] + ' 0%, ' + colors[1] + ' 100%)';
      label.style.border = '1px solid ' + colors[2];
      label.style.left = labelLeft + 'px';
      label.style.top = labelTop + 'px';
      container.appendChild(label);

      const line = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '' + (labelLeft + labelWidth / 2));
      line.setAttribute('y1', '' + (labelTop + LABEL_HEIGHT));
      line.setAttribute('x2', '' + (rectLeft + box.width / 2));
      line.setAttribute('y2', '' + (rectTop + box.height / 2));
      line.setAttribute('stroke', colors[2]);
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('marker-end', 'url(#' + getArrowMarkerId(colors[2]) + ')');
      svg.appendChild(line);

      placedLabels.push(labelRect);
      count++;
    }

    doc.documentElement.appendChild(container);

    win[TIMER_KEY] = win.setTimeout(function() {
      doc.getElementById(CONTAINER_ID)?.remove();
      win[TIMER_KEY] = null;
    }, 30000);

    return count;
  }

  function hideA11yLabels() {
    if (window['${LABELS_TIMER_KEY}']) {
      window.clearTimeout(window['${LABELS_TIMER_KEY}']);
      window['${LABELS_TIMER_KEY}'] = null;
    }
    document.getElementById('${LABELS_CONTAINER_ID}')?.remove();
  }

  globalThis.__bf_a11y = { renderA11yLabels: renderA11yLabels, hideA11yLabels: hideA11yLabels };
})();
`;
