import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAB_BADGE_IDLE_MS,
  TAB_BADGE_CANVAS_SIZE_PX,
  TAB_BADGE_LINK_ID,
  TAB_BADGE_API_KEY,
  TAB_BADGE_FALLBACK_BG_COLOR,
  TAB_BADGE_FILL_COLOR,
  TAB_BADGE_OUTLINE_COLOR,
  TAB_BADGE_SOURCE,
  buildExtensionFaviconUrl,
  computeTabBadgeGeometry,
  renderTabBadgeOnContext,
  composeTabBadgeDataUrl,
  isIconLinkRel,
  captureOriginalIconDescriptor,
  planIconRestore,
  shouldTriggerTabBadge,
  createTabBadgeStateMachine,
  buildTabBadgeApplyExpression,
  buildTabBadgeRestoreExpression,
  createTabBadgeController,
  handleTabBadgeCommand,
} from '../../extension/tab-badge.js';

import { CURSOR_ARROW_PATH, RESTING_TILT_DEG } from '../../extension/ghost-cursor.js';

// Node has no canvas; retain the native Path2D input for geometry assertions.
const originalPath2D = globalThis.Path2D;
globalThis.Path2D = class Path2D {
  constructor(path) { this.path = path; }
};
test.after(() => { globalThis.Path2D = originalPath2D; });

const backgroundSource = fs.readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const manifestJson = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function createMockElement(tagName, ownerDocument) {
  const attrs = new Map();
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    id: '',
    children: [],
    parentNode: null,
    isConnected: false,
    setAttribute(name, value) {
      const key = String(name).toLowerCase();
      const strVal = String(value);
      if (key === 'id') this.id = strVal;
      attrs.set(key, strVal);
      ownerDocument?.notifyMutation({
        type: 'attributes',
        target: this,
        attributeName: key,
      });
    },
    getAttribute(name) {
      const key = String(name).toLowerCase();
      if (key === 'id') return this.id || null;
      return attrs.has(key) ? attrs.get(key) : null;
    },
    hasAttribute(name) {
      const key = String(name).toLowerCase();
      if (key === 'id') return Boolean(this.id);
      return attrs.has(key);
    },
    removeAttribute(name) {
      const key = String(name).toLowerCase();
      if (key === 'id') this.id = '';
      attrs.delete(key);
      ownerDocument?.notifyMutation({
        type: 'attributes',
        target: this,
        attributeName: key,
      });
    },
    appendChild(child) {
      if (child.parentNode) {
        const idx = child.parentNode.children.indexOf(child);
        if (idx !== -1) child.parentNode.children.splice(idx, 1);
      }
      child.parentNode = this;
      child.isConnected = true;
      this.children.push(child);
      ownerDocument?.notifyMutation({
        type: 'childList',
        target: this,
        addedNodes: [child],
        removedNodes: [],
      });
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      const idx = parent.children.indexOf(this);
      if (idx !== -1) parent.children.splice(idx, 1);
      this.parentNode = null;
      this.isConnected = false;
      ownerDocument?.notifyMutation({
        type: 'childList',
        target: parent,
        addedNodes: [],
        removedNodes: [this],
      });
    },
  };
  return element;
}

function createFakePageDom({ initialIcons = [] } = {}) {
  const observers = [];
  const doc = {
    head: null,
    documentElement: null,
    body: null,
    notifyMutation(record) {
      for (const obs of [...observers]) {
        if (obs.connected) {
          obs.callback([record], obs);
        }
      }
    },
    createElement(tagName) {
      return createMockElement(tagName, doc);
    },
    getElementById(id) {
      return doc.head.children.find((el) => el.id === id) || null;
    },
    querySelectorAll(selector) {
      if (selector === 'link') {
        return doc.head.children.filter((el) => el.tagName === 'LINK');
      }
      return [];
    },
  };
  doc.head = createMockElement('head', doc);
  doc.head.isConnected = true;
  doc.documentElement = createMockElement('html', doc);
  doc.documentElement.isConnected = true;
  doc.documentElement.appendChild(doc.head);

  for (const icon of initialIcons) {
    const link = doc.createElement('link');
    if (icon.id) link.id = icon.id;
    if (icon.rel !== undefined) link.setAttribute('rel', icon.rel);
    if (icon.href !== undefined) link.setAttribute('href', icon.href);
    if (icon.type !== undefined) link.setAttribute('type', icon.type);
    doc.head.appendChild(link);
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      this.options = null;
    }

    observe(_target, options) {
      this.connected = true;
      this.options = options;
      if (!observers.includes(this)) observers.push(this);
    }

    disconnect() {
      this.connected = false;
    }
  }

  const context = vm.createContext({
    document: doc,
    MutationObserver: FakeMutationObserver,
  });
  context.globalThis = context;
  vm.runInContext(TAB_BADGE_SOURCE, context);

  return {
    doc,
    context,
    api: context[TAB_BADGE_API_KEY],
    observers,
    getIconLinks() {
      return doc.head.children.filter((el) => el.tagName === 'LINK');
    },
  };
}

test('buildExtensionFaviconUrl formats MV3 _favicon URL and rejects non-web URLs', () => {
  assert.equal(manifestJson.permissions.includes('favicon'), true);

  const getRuntimeUrl = (p) => `chrome-extension://abcdefghijklmnop${p}`;
  const url = buildExtensionFaviconUrl('https://mail.google.com/mail/u/0/#inbox', {
    getRuntimeUrl,
    size: 32,
  });
  assert.equal(
    url,
    'chrome-extension://abcdefghijklmnop/_favicon/?pageUrl=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F%23inbox&size=32',
  );

  assert.equal(buildExtensionFaviconUrl('about:blank', { getRuntimeUrl }), '');
  assert.equal(buildExtensionFaviconUrl('chrome://extensions', { getRuntimeUrl }), '');
  assert.equal(buildExtensionFaviconUrl('data:text/html,hello', { getRuntimeUrl }), '');
  assert.equal(buildExtensionFaviconUrl('', { getRuntimeUrl }), '');
});

test('computeTabBadgeGeometry places cursor arrow badge in bottom-right corner with white outline', () => {
  const geo = computeTabBadgeGeometry(32);
  assert.equal(geo.canvasSize, 32);
  assert.deepEqual(geo.iconRect, { x: 0, y: 0, width: 32, height: 32 });
  assert.equal(geo.badgeRect.x + geo.badgeRect.width, 32);
  assert.equal(geo.badgeRect.y + geo.badgeRect.height, 32);
  assert.equal(geo.badgeRect.x >= 12, true);
  assert.equal(geo.badgeRect.y >= 12, true);
  assert.equal(geo.outlineWidth >= 2, true);
  assert.equal(geo.arrowPath, CURSOR_ARROW_PATH);
  assert.equal(geo.arrowScale, geo.badgeRect.width / 24);
  assert.equal(geo.arrowRotationRadians, RESTING_TILT_DEG * Math.PI / 180);
  assert.deepEqual(geo.arrowCenter, { x: 23, y: 23 });
});

test('renderTabBadgeOnContext draws base favicon or fallback square plus white-outlined black arrow', () => {
  const ops = [];
  const createCtx = () => ({
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    clearRect: (...args) => ops.push(['clearRect', ...args]),
    save: () => ops.push(['save']),
    restore: () => ops.push(['restore']),
    translate: (...args) => ops.push(['translate', ...args]),
    rotate: (...args) => ops.push(['rotate', ...args]),
    scale: (...args) => ops.push(['scale', ...args]),
    drawImage: (...args) => ops.push(['drawImage', ...args]),
    fillRect: (...args) => ops.push(['fillRect', ...args]),
    strokeRect: (...args) => ops.push(['strokeRect', ...args]),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...args) => ops.push(['moveTo', ...args]),
    lineTo: (...args) => ops.push(['lineTo', ...args]),
    closePath: () => ops.push(['closePath']),
    stroke: function (path) {
      ops.push(['stroke', this.strokeStyle, this.lineWidth, path.path]);
    },
    fill: function () {
      ops.push(['fill', this.fillStyle]);
    },
  });

  // 1. With base favicon image
  const ctxWithBase = createCtx();
  const baseImage = { width: 32, height: 32 };
  const res1 = renderTabBadgeOnContext(ctxWithBase, { baseImage, canvasSize: 32 });
  assert.equal(res1.drewBaseImage, true);
  assert.equal(ops.some((op) => op[0] === 'drawImage'), true);
  assert.equal(ops.some((op) => op[0] === 'fillRect'), false);
  assert.deepEqual(
    ops.find((op) => op[0] === 'stroke'),
    ['stroke', TAB_BADGE_OUTLINE_COLOR, res1.geometry.outlineWidth / res1.geometry.arrowScale, CURSOR_ARROW_PATH],
  );
  assert.deepEqual(ops.find((op) => op[0] === 'fill'), ['fill', TAB_BADGE_FILL_COLOR]);

  // 2. Without base favicon image (fallback neutral square)
  ops.length = 0;
  const ctxFallback = createCtx();
  const res2 = renderTabBadgeOnContext(ctxFallback, { baseImage: null, canvasSize: 32 });
  assert.equal(res2.drewBaseImage, false);
  assert.equal(ops.some((op) => op[0] === 'fillRect'), true);
  assert.equal(ops.some((op) => op[0] === 'stroke' && op[1] === TAB_BADGE_OUTLINE_COLOR), true);
  assert.equal(ops.some((op) => op[0] === 'fill' && op[1] === TAB_BADGE_FILL_COLOR), true);
  assert.equal(TAB_BADGE_FALLBACK_BG_COLOR, '#e5e7eb');
});

test('composeTabBadgeDataUrl composes PNG via OffscreenCanvas and falls back when _favicon fetch fails', async () => {
  let drewImage = false;
  let closedBitmap = false;
  const fakeCanvas = {
    getContext: () => ({
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      scale: () => {},
      drawImage: () => {
        drewImage = true;
      },
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      stroke: () => {},
      fill: () => {},
    }),
    convertToBlob: async () => ({
      arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    }),
  };

  const dataUrl = await composeTabBadgeDataUrl('https://example.com/app', {
    getRuntimeUrl: (p) => `chrome-extension://ext123${p}`,
    fetchImpl: async () => ({
      ok: true,
      blob: async () => ({ size: 12 }),
    }),
    createImageBitmapImpl: async () => ({
      close: () => {
        closedBitmap = true;
      },
    }),
    createCanvas: () => fakeCanvas,
  });

  assert.equal(drewImage, true);
  assert.equal(closedBitmap, true);
  assert.match(dataUrl, /^data:image\/png;base64,/);

  // Fallback when fetch rejects: still produces PNG data URL with neutral square
  drewImage = false;
  const fallbackUrl = await composeTabBadgeDataUrl('https://example.com/app', {
    getRuntimeUrl: (p) => `chrome-extension://ext123${p}`,
    fetchImpl: async () => {
      throw new Error('network error');
    },
    createImageBitmapImpl: async () => ({}),
    createCanvas: () => fakeCanvas,
  });
  assert.equal(drewImage, false);
  assert.match(fallbackUrl, /^data:image\/png;base64,/);
});

test('isIconLinkRel, captureOriginalIconDescriptor, and planIconRestore handle icon bookkeeping', () => {
  assert.equal(isIconLinkRel('icon'), true);
  assert.equal(isIconLinkRel('shortcut icon'), true);
  assert.equal(isIconLinkRel('alternate ICON'), true);
  assert.equal(isIconLinkRel('apple-touch-icon'), false);
  assert.equal(isIconLinkRel('stylesheet'), false);

  const emptyDesc = captureOriginalIconDescriptor([]);
  assert.equal(emptyDesc.hadOriginalIcons, false);
  assert.deepEqual(planIconRestore(emptyDesc), { action: 'remove-injected', icons: [] });

  const populatedDesc = captureOriginalIconDescriptor([
    { rel: 'shortcut icon', href: '/favicon.ico', type: 'image/x-icon' },
    { id: TAB_BADGE_LINK_ID, rel: 'icon', href: 'data:image/png;base64,ours' },
    { rel: 'stylesheet', href: '/app.css' },
  ]);
  assert.equal(populatedDesc.hadOriginalIcons, true);
  assert.equal(populatedDesc.icons.length, 1);
  assert.equal(populatedDesc.icons[0].href, '/favicon.ico');
  assert.deepEqual(planIconRestore(populatedDesc), {
    action: 'restore-originals',
    icons: [{
      rel: 'shortcut icon',
      hasHrefAttr: true,
      href: '/favicon.ico',
      hasTypeAttr: true,
      type: 'image/x-icon',
    }],
  });
});

test('shouldTriggerTabBadge and createTabBadgeStateMachine drive, reset idle timer, reapply on navigation, and restore after 15s', () => {
  assert.equal(TAB_BADGE_IDLE_MS, 15_000);
  assert.equal(shouldTriggerTabBadge({
    method: 'Input.dispatchMouseEvent',
    passive: false,
    tabId: 10,
    isTabAttached: () => true,
  }), true);
  assert.equal(shouldTriggerTabBadge({
    method: 'Page.enable',
    passive: true,
    tabId: 10,
    isTabAttached: () => true,
  }), false);
  assert.equal(shouldTriggerTabBadge({
    method: 'Runtime.evaluate',
    childSessionId: 'iframe-1',
    passive: false,
    tabId: 10,
    isTabAttached: () => true,
  }), false);

  const applied = [];
  const restored = [];
  const timers = new Map();
  let nextTimerId = 1;
  let clock = 1000;

  const sm = createTabBadgeStateMachine({
    idleMs: TAB_BADGE_IDLE_MS,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    onApply: (tabId, meta) => applied.push({ tabId, ...meta }),
    onRestore: (tabId, meta) => restored.push({ tabId, ...meta }),
  });

  // First real command marks tab driven and applies badge
  const r1 = sm.recordCommand(7, { method: 'DOM.getDocument', pageUrl: 'https://a.example' });
  assert.equal(r1.applied, true);
  assert.equal(sm.isDriven(7), true);
  assert.equal(applied.length, 1);
  assert.equal(timers.size, 1);

  // Second real command on same URL resets timer without redundant apply
  clock += 5000;
  const r2 = sm.recordCommand(7, { method: 'Input.dispatchMouseEvent', pageUrl: 'https://a.example' });
  assert.equal(r2.applied, false);
  assert.equal(applied.length, 1);
  assert.equal(timers.size, 1);

  // Navigation marks tab for reapply on the NEXT real command
  sm.markNavigated(7, { pageUrl: 'https://b.example' });
  const r3 = sm.recordCommand(7, { method: 'Runtime.evaluate', pageUrl: 'https://b.example' });
  assert.equal(r3.applied, true);
  assert.equal(r3.reason, 'reapply-after-navigation');
  assert.equal(applied.length, 2);

  // Idle timer expiry after 15s restores original favicon
  const activeTimer = [...timers.values()][0];
  assert.equal(activeTimer.ms, 15_000);
  activeTimer.fn();
  assert.equal(sm.isDriven(7), false);
  assert.deepEqual(restored, [{ tabId: 7, reason: 'idle' }]);
});

test('in-page runtime saves original icon hrefs, re-asserts via MutationObserver when page rewrites icon, and restores originals', () => {
  const page = createFakePageDom({
    initialIcons: [
      { rel: 'icon', href: 'https://mail.example/favicon.ico', type: 'image/x-icon' },
      { rel: 'shortcut icon', href: 'https://mail.example/favicon-32.png', type: 'image/png' },
    ],
  });

  const badgeUrl = 'data:image/png;base64,BADGE_ONE';
  assert.equal(page.api.apply(badgeUrl), true);

  // Both original icons + our managed idempotent link carry the badge URL
  const linksDuring = page.getIconLinks();
  assert.equal(linksDuring.length, 3);
  assert.equal(linksDuring.every((l) => l.getAttribute('href') === badgeUrl), true);

  // Idempotent re-apply does not duplicate #__browserforce_tab_badge_icon__
  page.api.apply(badgeUrl);
  assert.equal(
    page.getIconLinks().filter((l) => l.id === TAB_BADGE_LINK_ID).length,
    1,
  );

  // Simulate Gmail/Slack rewriting its icon href for unread counts while driven:
  // MutationObserver immediately re-asserts our badge URL!
  const firstOriginal = linksDuring[0];
  firstOriginal.setAttribute('href', 'https://mail.example/unread-5.ico');
  assert.equal(firstOriginal.getAttribute('href'), badgeUrl);

  // Restore disconnects observer, removes #__browserforce_tab_badge_icon__,
  // and puts exact original hrefs and types back.
  assert.equal(page.api.restore(), true);
  assert.equal(page.doc.getElementById(TAB_BADGE_LINK_ID), null);
  assert.equal(page.observers.every((o) => !o.connected), true);

  const restoredLinks = page.getIconLinks();
  assert.equal(restoredLinks.length, 2);
  assert.equal(restoredLinks[0].getAttribute('href'), 'https://mail.example/favicon.ico');
  assert.equal(restoredLinks[0].getAttribute('type'), 'image/x-icon');
  assert.equal(restoredLinks[1].getAttribute('href'), 'https://mail.example/favicon-32.png');
  assert.equal(restoredLinks[1].getAttribute('type'), 'image/png');
});

test('in-page runtime removes injected badge cleanly when page had no original icon links', () => {
  const page = createFakePageDom({ initialIcons: [] });
  const badgeUrl = 'data:image/png;base64,BADGE_NO_ORIG';

  page.api.apply(badgeUrl);
  assert.equal(page.getIconLinks().length, 1);
  assert.equal(page.doc.getElementById(TAB_BADGE_LINK_ID).getAttribute('href'), badgeUrl);

  page.api.restore();
  assert.equal(page.getIconLinks().length, 0);
  assert.equal(page.doc.getElementById(TAB_BADGE_LINK_ID), null);
});

test('controller composes, injects, re-applies after navigation, and restores on disable or idle', async () => {
  const calls = [];
  const timers = [];
  let currentUrl = 'https://app.example/home';

  const controller = createTabBadgeController({
    isTabAttached: () => true,
    getTabUrl: () => currentUrl,
    sendCommand: async (tabId, method, params) => {
      calls.push({ tabId, method, params });
      return {};
    },
    composeBadgeDataUrl: async (url) => `data:image/png;base64,${encodeURIComponent(url)}`,
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      if (entry) entry.cleared = true;
    },
  });

  // Passive command is ignored
  assert.equal(handleTabBadgeCommand({
    method: 'Page.enable',
    passive: true,
    tabId: 3,
    controller,
  }), false);
  assert.equal(calls.length, 0);

  // Real top-level command applies badge
  assert.equal(handleTabBadgeCommand({
    method: 'Runtime.evaluate',
    passive: false,
    tabId: 3,
    controller,
  }), true);
  await controller.recordCommand(3, { method: 'Runtime.evaluate' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'Runtime.evaluate');
  assert.match(calls[0].params.expression, /apply\("data:image\/png;base64,https%3A%2F%2Fapp\.example%2Fhome"\)/);

  // Navigation followed by next real command re-applies badge on new document
  currentUrl = 'https://app.example/settings';
  controller.markNavigated(3, { pageUrl: currentUrl });
  await controller.recordCommand(3, { method: 'DOM.getDocument' });
  assert.equal(calls.length, 2);
  assert.match(calls[1].params.expression, /apply\("data:image\/png;base64,https%3A%2F%2Fapp\.example%2Fsettings"\)/);

  // Disable restores original icon before debugger detach
  await controller.disable(3);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].params.expression, buildTabBadgeRestoreExpression());
  assert.equal(controller.isDriven(3), false);
  assert.equal(buildTabBadgeApplyExpression('data:image/png;base64,x').includes('.apply('), true);
});

test('background and package.json wire tab-badge lifecycle and test suite', () => {
  assert.match(backgroundSource, /createTabBadgeController/);
  assert.match(backgroundSource, /handleTabBadgeCommand/);
  assert.match(backgroundSource, /tabBadgeController\.disable/);
  assert.match(backgroundSource, /tabBadgeController\.cleanup/);
  assert.match(backgroundSource, /tabBadgeController\.markNavigated/);
  assert.match(packageJson.scripts.test, /test\/agent\/tab-badge\.test\.js/);
  assert.match(packageJson.scripts['test:agent'], /test\/agent\/tab-badge\.test\.js/);
});
