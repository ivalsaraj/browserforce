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
