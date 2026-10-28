// BrowserForce — Tab Favicon Badge while an Agent is Driving a Tab
// Marks an attached tab as "driven" on any real (non-passive) top-level CDP
// command, composes the page's favicon with a bottom-right cursor arrow badge,
// keeps it asserted via MutationObserver against dynamic favicon rewrites, and
// restores the original favicon after an idle period or debugger detach.

import { CURSOR_ARROW_PATH, CURSOR_SIZE_PX, RESTING_TILT_DEG } from './ghost-cursor.js';

export const TAB_BADGE_IDLE_MS = 15_000;
export const TAB_BADGE_CANVAS_SIZE_PX = 32;
export const TAB_BADGE_LINK_ID = '__browserforce_tab_badge_icon__';
export const TAB_BADGE_API_KEY = '__browserforceTabBadge';

export const TAB_BADGE_FALLBACK_BG_COLOR = '#e5e7eb';
export const TAB_BADGE_FALLBACK_BORDER_COLOR = '#9ca3af';
export const TAB_BADGE_FILL_COLOR = '#000';
export const TAB_BADGE_OUTLINE_COLOR = '#ffffff';

// Deterministic 1x1 PNG data URL fallback used only when OffscreenCanvas is
// unavailable in the current runtime (e.g. bare Node test environments).
export const TAB_BADGE_STATIC_FALLBACK_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

const NAVIGATION_CDP_METHODS = new Set([
  'Page.navigate',
  'Page.reload',
  'Page.navigateToHistoryEntry',
]);

/**
 * Builds the MV3 extension `_favicon` URL for a given page URL.
 * Format per https://developer.chrome.com/docs/extensions/how-to/ui/favicons:
 *   chrome-extension://<EXTENSION_ID>/_favicon/?pageUrl=<ENCODED>&size=32
 */
export function buildExtensionFaviconUrl(
  pageUrl,
  {
    getRuntimeUrl = (path) => globalThis.chrome?.runtime?.getURL?.(path),
    size = TAB_BADGE_CANVAS_SIZE_PX,
  } = {},
) {
  if (typeof pageUrl !== 'string' || !pageUrl.trim()) return '';
  let parsedPage;
  try {
    parsedPage = new URL(pageUrl);
  } catch {
    return '';
  }
  if (parsedPage.protocol !== 'http:' && parsedPage.protocol !== 'https:' && parsedPage.protocol !== 'file:') {
    return '';
  }

  let baseUrl = '';
  try {
    baseUrl = getRuntimeUrl?.('/_favicon/') || '';
  } catch {
    baseUrl = '';
  }
  if (typeof baseUrl !== 'string' || !baseUrl) return '';

  try {
    const url = new URL(baseUrl);
    const safeSize = Number.isFinite(size) && size > 0 ? Math.round(size) : TAB_BADGE_CANVAS_SIZE_PX;
    url.searchParams.set('pageUrl', parsedPage.toString());
    url.searchParams.set('size', String(safeSize));
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Pure geometry calculator for the 32x32 favicon canvas and bottom-right
 * cursor arrow badge with white outline.
 */
export function computeTabBadgeGeometry(canvasSize = TAB_BADGE_CANVAS_SIZE_PX) {
  const size = Number.isFinite(canvasSize) && canvasSize > 0 ? Math.round(canvasSize) : TAB_BADGE_CANVAS_SIZE_PX;
  const badgeSize = Math.max(10, Math.round(size * 0.56));
  const originX = size - badgeSize;
  const originY = size - badgeSize;
  const outlineWidth = Math.max(2, Math.round(size * 0.095));

  return {
    canvasSize: size,
    iconRect: { x: 0, y: 0, width: size, height: size },
    fallbackSquareRect: {
      x: Math.round(size * 0.0625),
      y: Math.round(size * 0.0625),
      width: size - 2 * Math.round(size * 0.0625),
      height: size - 2 * Math.round(size * 0.0625),
    },
    badgeRect: { x: originX, y: originY, width: badgeSize, height: badgeSize },
    outlineWidth,
    arrowPath: CURSOR_ARROW_PATH,
    arrowScale: badgeSize / CURSOR_SIZE_PX,
    arrowRotationRadians: RESTING_TILT_DEG * Math.PI / 180,
    arrowCenter: { x: originX + badgeSize / 2, y: originY + badgeSize / 2 },
  };
}

/**
 * Draws either the page's base favicon or a neutral fallback square, then
 * overlays the white-outlined black cursor arrow in the bottom-right corner.
 */
export function renderTabBadgeOnContext(
  ctx,
  {
    baseImage = null,
    canvasSize = TAB_BADGE_CANVAS_SIZE_PX,
  } = {},
) {
  const geometry = computeTabBadgeGeometry(canvasSize);
  const { size } = { size: geometry.canvasSize };

  ctx.clearRect?.(0, 0, size, size);

  let drewBaseImage = false;
  if (baseImage && typeof ctx.drawImage === 'function') {
    try {
      ctx.drawImage(baseImage, 0, 0, size, size);
      drewBaseImage = true;
    } catch {
      drewBaseImage = false;
    }
  }

  if (!drewBaseImage) {
    const sq = geometry.fallbackSquareRect;
    ctx.fillStyle = TAB_BADGE_FALLBACK_BG_COLOR;
    ctx.fillRect?.(sq.x, sq.y, sq.width, sq.height);
    ctx.strokeStyle = TAB_BADGE_FALLBACK_BORDER_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect?.(sq.x, sq.y, sq.width, sq.height);
  }

  const arrow = new Path2D(geometry.arrowPath);
  ctx.save();
  ctx.translate(geometry.arrowCenter.x, geometry.arrowCenter.y);
  ctx.rotate(geometry.arrowRotationRadians);
  ctx.scale(geometry.arrowScale, geometry.arrowScale);
  ctx.translate(-CURSOR_SIZE_PX / 2, -CURSOR_SIZE_PX / 2);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Keep the existing badge outline width in canvas pixels after scaling the art.
  ctx.lineWidth = geometry.outlineWidth / geometry.arrowScale;
  ctx.strokeStyle = TAB_BADGE_OUTLINE_COLOR;
  ctx.stroke(arrow);
  ctx.fillStyle = TAB_BADGE_FILL_COLOR;
  ctx.fill(arrow);
  ctx.restore();

  return { drewBaseImage, geometry };
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(binary);
  }
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(bytes).toString('base64');
  }
  return '';
}

/**
 * Composes the page's favicon + cursor badge into a PNG data URL using
 * OffscreenCanvas in the service worker. Falls back to a badge-on-neutral-square
 * PNG if the page favicon cannot be fetched/decoded.
 */
export async function composeTabBadgeDataUrl(
  pageUrl,
  {
    fetchImpl = globalThis.fetch,
    createImageBitmapImpl = globalThis.createImageBitmap,
    createCanvas = (size) => (
      typeof globalThis.OffscreenCanvas === 'function'
        ? new globalThis.OffscreenCanvas(size, size)
        : null
    ),
    getRuntimeUrl = (path) => globalThis.chrome?.runtime?.getURL?.(path),
    canvasSize = TAB_BADGE_CANVAS_SIZE_PX,
  } = {},
) {
  const canvas = createCanvas(canvasSize);
  const ctx = canvas?.getContext?.('2d');
  if (!canvas || !ctx) {
    return TAB_BADGE_STATIC_FALLBACK_DATA_URL;
  }

  let baseImage = null;
  const faviconUrl = buildExtensionFaviconUrl(pageUrl, { getRuntimeUrl, size: canvasSize });
  if (faviconUrl && typeof fetchImpl === 'function' && typeof createImageBitmapImpl === 'function') {
    try {
      const response = await fetchImpl(faviconUrl);
      if (response && response.ok) {
        const blob = await response.blob();
        if (blob && blob.size > 0) {
          baseImage = await createImageBitmapImpl(blob);
        }
      }
    } catch {
      baseImage = null;
    }
  }

  try {
    renderTabBadgeOnContext(ctx, { baseImage, canvasSize });
  } finally {
    try {
      baseImage?.close?.();
    } catch {
      // ignore bitmap close errors
    }
  }

  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    if (base64) return `data:image/png;base64,${base64}`;
  }

  if (typeof canvas.toDataURL === 'function') {
    return canvas.toDataURL('image/png');
  }

  return TAB_BADGE_STATIC_FALLBACK_DATA_URL;
}

/**
 * Pure helper matching HTML `link[rel~=icon]` token semantics.
 */
export function isIconLinkRel(relValue) {
  if (typeof relValue !== 'string' || !relValue.trim()) return false;
  return relValue
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .includes('icon');
}

/**
 * Pure snapshot helper for saving original `link[rel~=icon]` descriptors before
 * applying the BrowserForce badge.
 */
export function captureOriginalIconDescriptor(links = []) {
  const icons = [];
  for (const link of links) {
    if (!link || link.id === TAB_BADGE_LINK_ID) continue;
    const rel = typeof link.getAttribute === 'function' ? link.getAttribute('rel') : link.rel;
    if (!isIconLinkRel(rel)) continue;
    const hasHrefAttr = typeof link.hasAttribute === 'function'
      ? link.hasAttribute('href')
      : typeof link.href === 'string';
    const href = typeof link.getAttribute === 'function'
      ? link.getAttribute('href')
      : (link.href ?? null);
    const hasTypeAttr = typeof link.hasAttribute === 'function'
      ? link.hasAttribute('type')
      : typeof link.type === 'string';
    const type = typeof link.getAttribute === 'function'
      ? link.getAttribute('type')
      : (link.type ?? null);
    icons.push({
      rel: rel || 'icon',
      hasHrefAttr: Boolean(hasHrefAttr),
      href: hasHrefAttr ? String(href ?? '') : null,
      hasTypeAttr: Boolean(hasTypeAttr),
      type: hasTypeAttr ? String(type ?? '') : null,
    });
  }
  return {
    hadOriginalIcons: icons.length > 0,
    icons,
  };
}

/**
 * Pure restore planner returning whether to restore saved original icon hrefs
 * or remove the injected badge link when no original icon existed.
 */
export function planIconRestore(savedDescriptor) {
  if (!savedDescriptor || !savedDescriptor.hadOriginalIcons || !Array.isArray(savedDescriptor.icons) || savedDescriptor.icons.length === 0) {
    return { action: 'remove-injected', icons: [] };
  }
  return {
    action: 'restore-originals',
    icons: savedDescriptor.icons.map((icon) => ({ ...icon })),
  };
}

/**
 * Predicate determining whether a CDP command should mark a tab as "driven".
 * Only real (non-passive), top-level cdpCommands on attached tabs trigger the badge.
 */
export function shouldTriggerTabBadge({
  method,
  childSessionId,
  passive = false,
  tabId,
  isTabAttached = () => true,
} = {}) {
  if (passive) return false;
  if (childSessionId) return false;
  if (typeof method !== 'string' || !method) return false;
  if (!Number.isInteger(tabId)) return false;
  return Boolean(isTabAttached(tabId));
}

/**
 * Pure state machine tracking driven vs. idle tabs, navigation re-application,
 * and automatic restoration after `idleMs` (15s default).
 */
export function createTabBadgeStateMachine({
  idleMs = TAB_BADGE_IDLE_MS,
  onApply = () => {},
  onRestore = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
} = {}) {
  const tabs = new Map();

  function clearTabTimer(entry) {
    if (entry && entry.timerId !== null) {
      clearTimer(entry.timerId);
      entry.timerId = null;
    }
  }

  function scheduleIdleRestore(tabId, entry) {
    clearTabTimer(entry);
    entry.timerId = setTimer(() => {
      entry.timerId = null;
      if (!tabs.has(tabId)) return;
      tabs.delete(tabId);
      onRestore(tabId, { reason: 'idle' });
    }, idleMs);
  }

  function recordCommand(tabId, { method = '', pageUrl = '' } = {}) {
    let entry = tabs.get(tabId);
    const timestamp = now();
    const isNavCommand = NAVIGATION_CDP_METHODS.has(method);

    if (!entry) {
      entry = {
        tabId,
        driven: true,
        needsReapply: false,
        lastAppliedUrl: pageUrl || '',
        lastCommandAt: timestamp,
        timerId: null,
      };
      tabs.set(tabId, entry);
      scheduleIdleRestore(tabId, entry);
      onApply(tabId, { reason: 'enter-driven', pageUrl: entry.lastAppliedUrl });
      if (isNavCommand) {
        entry.needsReapply = true;
      }
      return { applied: true, reason: 'enter-driven' };
    }

    entry.lastCommandAt = timestamp;
    scheduleIdleRestore(tabId, entry);

    const urlChanged = Boolean(pageUrl && pageUrl !== entry.lastAppliedUrl);
    if (entry.needsReapply || urlChanged) {
      entry.needsReapply = isNavCommand;
      if (pageUrl) entry.lastAppliedUrl = pageUrl;
      onApply(tabId, { reason: 'reapply-after-navigation', pageUrl: entry.lastAppliedUrl });
      return { applied: true, reason: 'reapply-after-navigation' };
    }

    if (isNavCommand) {
      entry.needsReapply = true;
    }

    return { applied: false, reason: 'already-driven' };
  }

  function markNavigated(tabId, { pageUrl = '' } = {}) {
    const entry = tabs.get(tabId);
    if (!entry || !entry.driven) return false;
    entry.needsReapply = true;
    if (pageUrl) entry.lastAppliedUrl = '';
    return true;
  }

  function restore(tabId, { reason = 'manual' } = {}) {
    const entry = tabs.get(tabId);
    if (!entry) return false;
    clearTabTimer(entry);
    tabs.delete(tabId);
    if (entry.driven) {
      onRestore(tabId, { reason });
      return true;
    }
    return false;
  }

  function cleanup(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return false;
    clearTabTimer(entry);
    tabs.delete(tabId);
    return true;
  }

  function isDriven(tabId) {
    return Boolean(tabs.get(tabId)?.driven);
  }

  function getTabState(tabId) {
    const entry = tabs.get(tabId);
    if (!entry) return null;
    return {
      tabId: entry.tabId,
      driven: entry.driven,
      needsReapply: entry.needsReapply,
      lastAppliedUrl: entry.lastAppliedUrl,
      lastCommandAt: entry.lastCommandAt,
    };
  }

  return {
    recordCommand,
    markNavigated,
    restore,
    cleanup,
    isDriven,
    getTabState,
  };
}

export const TAB_BADGE_SOURCE = `(() => {
  const LINK_ID = ${JSON.stringify(TAB_BADGE_LINK_ID)};
  const API_KEY = ${JSON.stringify(TAB_BADGE_API_KEY)};
  const existingApi = globalThis[API_KEY];
  if (existingApi && typeof existingApi.apply === 'function' && typeof existingApi.restore === 'function') {
    if (typeof existingApi.touch === 'function') return existingApi;
    // Restore saved originals before replacing a pre-expiry API in an open page.
    existingApi.restore();
  }

  const state = {
    active: false,
    isMutating: false,
    badgeDataUrl: '',
    hadOriginalIcons: false,
    originalIcons: [],
    observer: null,
    expiryTimer: null,
  };

  function isIconRel(relValue) {
    if (typeof relValue !== 'string' || !relValue.trim()) return false;
    return relValue.trim().toLowerCase().split(/\\s+/).includes('icon');
  }

  function getHeadRoot() {
    return document.head || document.documentElement || document.body || null;
  }

  function findIconLinks() {
    if (typeof document.querySelectorAll === 'function') {
      const candidates = Array.from(document.querySelectorAll('link'));
      return candidates.filter((el) => el && el.id !== LINK_ID && isIconRel(el.getAttribute?.('rel') ?? el.rel));
    }
    const root = getHeadRoot();
    if (!root || !Array.isArray(root.children)) return [];
    return root.children.filter((el) => (
      el &&
      String(el.tagName || '').toLowerCase() === 'link' &&
      el.id !== LINK_ID &&
      isIconRel(el.getAttribute?.('rel') ?? el.rel)
    ));
  }

  function snapshotLinkRecord(link) {
    const hasHrefAttr = typeof link.hasAttribute === 'function'
      ? link.hasAttribute('href')
      : typeof link.href === 'string';
    const href = typeof link.getAttribute === 'function'
      ? link.getAttribute('href')
      : (link.href ?? null);
    const hasTypeAttr = typeof link.hasAttribute === 'function'
      ? link.hasAttribute('type')
      : typeof link.type === 'string';
    const type = typeof link.getAttribute === 'function'
      ? link.getAttribute('type')
      : (link.type ?? null);
    const rel = (typeof link.getAttribute === 'function' ? link.getAttribute('rel') : link.rel) || 'icon';
    return {
      node: link,
      rel,
      hasHrefAttr: Boolean(hasHrefAttr),
      href: hasHrefAttr ? String(href ?? '') : null,
      hasTypeAttr: Boolean(hasTypeAttr),
      type: hasTypeAttr ? String(type ?? '') : null,
    };
  }

  function setAttr(el, name, value) {
    if (typeof el.setAttribute === 'function') {
      el.setAttribute(name, value);
    } else {
      el[name] = value;
    }
  }

  function getAttr(el, name) {
    if (typeof el.getAttribute === 'function') {
      return el.getAttribute(name);
    }
    return el[name] ?? null;
  }

  function removeAttr(el, name) {
    if (typeof el.removeAttribute === 'function') {
      el.removeAttribute(name);
    } else {
      delete el[name];
    }
  }

  function ensureManagedLink(root) {
    let badgeLink = typeof document.getElementById === 'function'
      ? document.getElementById(LINK_ID)
      : null;
    if (!badgeLink && root && Array.isArray(root.children)) {
      badgeLink = root.children.find((el) => el && el.id === LINK_ID) || null;
    }
    if (!badgeLink) {
      badgeLink = document.createElement('link');
      badgeLink.id = LINK_ID;
      setAttr(badgeLink, 'rel', 'icon');
      setAttr(badgeLink, 'type', 'image/png');
      root.appendChild(badgeLink);
    }
    return badgeLink;
  }

  function assertBadgeDom() {
    if (!state.active || !state.badgeDataUrl || state.isMutating) return;
    const root = getHeadRoot();
    if (!root) return;

    state.isMutating = true;
    try {
      const currentLinks = findIconLinks();
      for (const link of currentLinks) {
        let record = state.originalIcons.find((item) => item.node === link);
        const currentHref = getAttr(link, 'href');
        if (!record) {
          // A new icon link was inserted by the page while driven; capture its
          // href as an original to restore later unless it already has our URL.
          if (currentHref !== state.badgeDataUrl) {
            record = snapshotLinkRecord(link);
            state.originalIcons.push(record);
            state.hadOriginalIcons = true;
          }
        } else if (currentHref !== state.badgeDataUrl) {
          // The page rewrote its existing icon href (e.g. unread badge); keep
          // the original snapshot intact and re-assert our badge URL.
        }
        if (currentHref !== state.badgeDataUrl) {
          setAttr(link, 'href', state.badgeDataUrl);
        }
        setAttr(link, 'type', 'image/png');
      }

      const badgeLink = ensureManagedLink(root);
      if (getAttr(badgeLink, 'rel') !== 'icon') {
        setAttr(badgeLink, 'rel', 'icon');
      }
      if (getAttr(badgeLink, 'type') !== 'image/png') {
        setAttr(badgeLink, 'type', 'image/png');
      }
      if (getAttr(badgeLink, 'href') !== state.badgeDataUrl) {
        setAttr(badgeLink, 'href', state.badgeDataUrl);
      }
    } finally {
      state.isMutating = false;
    }
  }

  function ensureObserver() {
    if (state.observer || typeof MutationObserver !== 'function') return;
    const root = getHeadRoot();
    if (!root) return;
    state.observer = new MutationObserver(() => {
      if (!state.active || state.isMutating) return;
      const currentLinks = findIconLinks();
      const anyRewritten = currentLinks.some((link) => getAttr(link, 'href') !== state.badgeDataUrl);
      const badgeLink = typeof document.getElementById === 'function'
        ? document.getElementById(LINK_ID)
        : null;
      const badgeMissingOrChanged = !badgeLink || getAttr(badgeLink, 'href') !== state.badgeDataUrl;
      if (anyRewritten || badgeMissingOrChanged) {
        assertBadgeDom();
      }
    });
    state.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'rel'],
    });
  }

  function disconnectObserver() {
    if (!state.observer) return;
    try {
      state.observer.disconnect();
    } catch {
      // ignore observer disconnect errors
    }
    state.observer = null;
  }

  function touch() {
    if (!state.active) return false;
    clearTimeout(state.expiryTimer);
    state.expiryTimer = setTimeout(restore, ${TAB_BADGE_IDLE_MS});
    return true;
  }

  function apply(badgeDataUrl) {
    if (typeof badgeDataUrl !== 'string' || !badgeDataUrl) return false;
    const root = getHeadRoot();
    if (!root) return false;

    if (!state.active) {
      const existingLinks = findIconLinks();
      state.originalIcons = existingLinks.map(snapshotLinkRecord);
      state.hadOriginalIcons = state.originalIcons.length > 0;
      state.active = true;
    }

    state.badgeDataUrl = badgeDataUrl;
    assertBadgeDom();
    ensureObserver();
    touch();
    return true;
  }

  function restore() {
    clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
    disconnectObserver();
    const wasActive = state.active;
    state.active = false;
    state.isMutating = true;
    try {
      const root = getHeadRoot();
      let badgeLink = typeof document.getElementById === 'function'
        ? document.getElementById(LINK_ID)
        : null;
      if (!badgeLink && root && Array.isArray(root.children)) {
        badgeLink = root.children.find((el) => el && el.id === LINK_ID) || null;
      }
      if (badgeLink && typeof badgeLink.remove === 'function') {
        badgeLink.remove();
      }

      if (state.hadOriginalIcons) {
        let restoredAny = false;
        for (const record of state.originalIcons) {
          const node = record.node;
          if (!node) continue;
          const isConnected = node.isConnected !== false;
          if (isConnected) {
            if (record.hasHrefAttr) setAttr(node, 'href', record.href);
            else removeAttr(node, 'href');
            if (record.hasTypeAttr) setAttr(node, 'type', record.type);
            else removeAttr(node, 'type');
            restoredAny = true;
          } else if (root) {
            const recreated = document.createElement('link');
            setAttr(recreated, 'rel', record.rel || 'icon');
            if (record.hasHrefAttr) setAttr(recreated, 'href', record.href);
            if (record.hasTypeAttr) setAttr(recreated, 'type', record.type);
            root.appendChild(recreated);
            restoredAny = true;
          }
        }
        void restoredAny;
      }
    } finally {
      state.originalIcons = [];
      state.hadOriginalIcons = false;
      state.badgeDataUrl = '';
      state.isMutating = false;
    }
    return wasActive;
  }

  function getState() {
    return {
      active: state.active,
      badgeDataUrl: state.badgeDataUrl,
      hadOriginalIcons: state.hadOriginalIcons,
      originalCount: state.originalIcons.length,
      observing: Boolean(state.observer),
    };
  }

  const api = { apply, restore, getState, touch };
  globalThis[API_KEY] = api;
  return api;
})()`;

export function buildTabBadgeApplyExpression(badgeDataUrl) {
  return `${TAB_BADGE_SOURCE}.apply(${JSON.stringify(badgeDataUrl)})`;
}

export function buildTabBadgeRestoreExpression() {
  return `globalThis.${TAB_BADGE_API_KEY}?.restore?.()`;
}

function safeLog(log, error) {
  try {
    log?.(error);
  } catch {
    // Badge diagnostics must never break browser commands.
  }
}

/**
 * Per-tab controller that serializes badge composition + Runtime.evaluate
 * injection and restores the original favicon on idle or debugger detach.
 */
export function createTabBadgeController({
  isTabAttached,
  getTabUrl = () => '',
  sendCommand,
  composeBadgeDataUrl = composeTabBadgeDataUrl,
  idleMs = TAB_BADGE_IDLE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
  log = () => {},
}) {
  const queues = new Map();
  const badgeCacheByUrl = new Map();

  function enqueue(tabId, task) {
    const previous = queues.get(tabId) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .catch((error) => {
        safeLog(log, error);
        return false;
      });
    queues.set(tabId, next);
    return next;
  }

  async function resolveBadgeUrl(pageUrl) {
    const cacheKey = typeof pageUrl === 'string' ? pageUrl : '';
    if (cacheKey && badgeCacheByUrl.has(cacheKey)) {
      return badgeCacheByUrl.get(cacheKey);
    }
    const dataUrl = await composeBadgeDataUrl(cacheKey);
    if (cacheKey && typeof dataUrl === 'string' && dataUrl) {
      if (badgeCacheByUrl.size >= 64) {
        const oldestKey = badgeCacheByUrl.keys().next().value;
        badgeCacheByUrl.delete(oldestKey);
      }
      badgeCacheByUrl.set(cacheKey, dataUrl);
    }
    return dataUrl;
  }

  function applyToTab(tabId, { pageUrl = '' } = {}) {
    return enqueue(tabId, async () => {
      if (!isTabAttached(tabId)) return false;
      const effectiveUrl = pageUrl || getTabUrl(tabId) || '';
      const badgeDataUrl = await resolveBadgeUrl(effectiveUrl);
      if (!isTabAttached(tabId) || !badgeDataUrl) return false;
      await sendCommand(tabId, 'Runtime.evaluate', {
        expression: buildTabBadgeApplyExpression(badgeDataUrl),
      });
      return true;
    });
  }

  function restoreTabInPage(tabId) {
    return enqueue(tabId, async () => {
      if (!isTabAttached(tabId)) return false;
      await sendCommand(tabId, 'Runtime.evaluate', {
        expression: buildTabBadgeRestoreExpression(),
      });
      return true;
    });
  }

  const stateMachine = createTabBadgeStateMachine({
    idleMs,
    setTimer,
    clearTimer,
    now,
    onApply: (tabId, { pageUrl }) => {
      void applyToTab(tabId, { pageUrl });
    },
    onRestore: (tabId) => {
      void restoreTabInPage(tabId);
    },
  });

  function recordCommand(tabId, { method = '', pageUrl = '' } = {}) {
    if (!isTabAttached(tabId)) return Promise.resolve(false);
    const effectiveUrl = pageUrl || getTabUrl(tabId) || '';
    const result = stateMachine.recordCommand(tabId, { method, pageUrl: effectiveUrl });
    if (!result.applied) {
      return enqueue(tabId, async () => {
        if (!isTabAttached(tabId)) return false;
        await sendCommand(tabId, 'Runtime.evaluate', {
          expression: `globalThis.${TAB_BADGE_API_KEY}?.touch?.()`,
        });
        return true;
      });
    }
    return queues.get(tabId) || Promise.resolve(true);
  }

  function markNavigated(tabId, { pageUrl = '' } = {}) {
    return stateMachine.markNavigated(tabId, { pageUrl });
  }

  function disable(tabId) {
    const wasDriven = stateMachine.isDriven(tabId);
    stateMachine.cleanup(tabId);
    if (!wasDriven) return Promise.resolve(false);
    return restoreTabInPage(tabId);
  }

  function cleanup(tabId) {
    stateMachine.cleanup(tabId);
    queues.delete(tabId);
    return Promise.resolve(true);
  }

  return {
    recordCommand,
    markNavigated,
    disable,
    cleanup,
    isDriven: (tabId) => stateMachine.isDriven(tabId),
    getTabState: (tabId) => stateMachine.getTabState(tabId),
  };
}

/**
 * Background hook helper invoked on CDP commands.
 */
export function handleTabBadgeCommand({
  method,
  childSessionId,
  passive = false,
  tabId,
  pageUrl = '',
  controller,
  isTabAttached = () => true,
  log,
}) {
  if (!shouldTriggerTabBadge({ method, childSessionId, passive, tabId, isTabAttached })) {
    return false;
  }
  try {
    const result = controller.recordCommand(tabId, { method, pageUrl });
    void Promise.resolve(result).catch((error) => safeLog(log, error));
  } catch (error) {
    safeLog(log, error);
  }
  return true;
}
