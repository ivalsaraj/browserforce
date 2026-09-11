const CURSOR_ID = '__browserforce_ghost_cursor__';
const CURSOR_API_KEY = '__browserforceGhostCursor';
const CURSOR_IMAGE_URL_MARKER = '__browserforce_ghost_cursor_image_url__';
const VALID_BUTTONS = new Set(['left', 'right', 'middle']);
const ACTION_TYPES = new Map([
  ['mouseMoved', 'move'],
  ['mousePressed', 'down'],
  ['mouseReleased', 'up'],
  ['mouseWheel', 'wheel'],
]);

const DISABLE_EXPRESSION = `globalThis.${CURSOR_API_KEY}?.disable?.()`;

export const GHOST_CURSOR_SOURCE = String.raw`(() => {
  const CURSOR_ID = '__browserforce_ghost_cursor__';
  const CURSOR_API_KEY = '__browserforceGhostCursor';
  const CURSOR_IMAGE_URL = ${JSON.stringify(CURSOR_IMAGE_URL_MARKER)};
  const MOVE_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';
  const PRESS_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const PRESS_DURATION_MS = 140;
  const IDLE_HIDE_DELAY_MS = 5000;
  const IDLE_FADE_OUT_MS = 600;
  const MIN_MOVE_DURATION_MS = 220;
  const MAX_MOVE_DURATION_MS = 1500;
  const MOVE_SPEED_PX_PER_MS = 1.2;
  const CURSOR_SIZE_PX = 22;
  const CURSOR_Z_INDEX = 2147483647;
  const MINIMAL_HOTSPOT_X_PX = 0;
  const MINIMAL_HOTSPOT_Y_PX = 0;
  const CHIP_ID = '__browserforce_ghost_cursor_label__';
  const AGENT_ID = '__browserforce_ghost_cursor_agent__';
  const CHIP_PREFIX_TEXT = 'BrowserForce \u00B7';
  const CHIP_PREFIX_GAP_PX = 4;
  const CHIP_OFFSET_X_PX = CURSOR_SIZE_PX - 4;
  const CHIP_OFFSET_Y_PX = CURSOR_SIZE_PX + 2;
  // Sized so the relay's 24-character limit survives intact instead of being
  // ellipsized. Measured in Chrome, not estimated: the worst allowed name
  // ('W' x 24) renders a 357px chip at this font, so the cap clears it with
  // room for a wider fallback face. The overflow/ellipsis below is a backstop
  // for a face wider still, not the normal path.
  const CHIP_MAX_WIDTH_PX = 400;
  const CHIP_PADDING = '2px 6px';
  const CHIP_RADIUS_PX = 4;
  const CHIP_FONT = '500 11px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const CHIP_BACKGROUND = 'rgba(17, 17, 17, 0.9)';
  const CHIP_SHADOW = '0 1px 3px rgba(0, 0, 0, 0.45)';
  const CHIP_PREFIX_COLOR = 'rgba(255, 255, 255, 0.62)';
  const CHIP_NAME_COLOR = '#ffffff';

  const runtime = {
    outerElement: null,
    innerElement: null,
    labelElement: null,
    labelTextElement: null,
    labelText: '',
    chromeOpacity: '1',
    x: 0,
    y: 0,
    hasPosition: false,
    scale: 1,
    enabled: false,
    idleHidden: false,
  };

  let idleHideTimer = null;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function applyTranslate() {
    if (!runtime.outerElement) return;
    runtime.outerElement.style.transform = 'translate3d('
      + (runtime.x - MINIMAL_HOTSPOT_X_PX) + 'px, '
      + (runtime.y - MINIMAL_HOTSPOT_Y_PX) + 'px, 0)';
  }

  function applyScale() {
    if (!runtime.innerElement) return;
    runtime.innerElement.style.transform = 'scale(' + runtime.scale + ')';
  }

  // Page CSS reaches these elements — they are bare divs and spans in the page's
  // own DOM. 'all: initial' MUST be written first: in an inline style block a
  // later longhand overrides the earlier shorthand, so the reverse order would
  // wipe everything set before it. direction/unicode-bidi are not cosmetic —
  // on a globally RTL page the agent name would otherwise render BEFORE the
  // fixed BrowserForce prefix it is supposed to sit behind. pointer-events must
  // be re-set on every element because 'all: initial' restores 'auto', and a
  // pointer-events:auto child inside a pointer-events:none parent IS
  // hit-testable and would swallow real clicks landing under the label.
  //
  // Limit: inline styles, this reset included, lose to a page rule carrying
  // !important. The existing arrow (outer/inner) has the identical exposure, so
  // the guarantee here is against accidental page CSS, not a hostile page.
  function applyOverlayReset(element) {
    element.style.all = 'initial';
    element.style.boxSizing = 'border-box';
    element.style.direction = 'ltr';
    element.style.unicodeBidi = 'isolate';
    element.style.whiteSpace = 'nowrap';
    element.style.pointerEvents = 'none';
  }

  // Appended AFTER the arrow, so ensureCursorElement()'s reuse path can keep
  // re-acquiring the arrow as outer.firstElementChild.
  function createChipElement(outer) {
    const chip = document.createElement('div');
    chip.id = CHIP_ID;
    applyOverlayReset(chip);
    chip.style.position = 'absolute';
    chip.style.display = 'block';
    chip.style.left = CHIP_OFFSET_X_PX + 'px';
    chip.style.top = CHIP_OFFSET_Y_PX + 'px';
    chip.style.maxWidth = CHIP_MAX_WIDTH_PX + 'px';
    chip.style.overflow = 'hidden';
    chip.style.textOverflow = 'ellipsis';
    chip.style.padding = CHIP_PADDING;
    chip.style.borderRadius = CHIP_RADIUS_PX + 'px';
    chip.style.background = CHIP_BACKGROUND;
    chip.style.boxShadow = CHIP_SHADOW;
    chip.style.font = CHIP_FONT;
    chip.style.transitionProperty = 'opacity';
    chip.style.opacity = runtime.chromeOpacity;

    // The prefix is renderer-owned and always present. Agent-supplied text
    // rendered alone over a logged-in page is a phishing primitive — a
    // prompt-injected agent would label itself 'Chrome - confirm your password'.
    const prefix = document.createElement('span');
    applyOverlayReset(prefix);
    prefix.style.display = 'inline';
    prefix.style.font = CHIP_FONT;
    prefix.style.color = CHIP_PREFIX_COLOR;
    // A margin, not a trailing space: 'all: initial' resets white-space on the
    // spans, so a trailing space is collapsible and could render 'BrowserForce
    // \u00B7Claude'. A margin cannot collapse away.
    prefix.style.marginRight = CHIP_PREFIX_GAP_PX + 'px';
    prefix.textContent = CHIP_PREFIX_TEXT;

    const name = document.createElement('span');
    name.id = AGENT_ID;
    applyOverlayReset(name);
    name.style.display = 'inline';
    name.style.font = CHIP_FONT;
    name.style.color = CHIP_NAME_COLOR;

    chip.appendChild(prefix);
    chip.appendChild(name);
    outer.appendChild(chip);
    runtime.labelElement = chip;
    runtime.labelTextElement = name;
    return chip;
  }

  // Rebound from the live DOM rather than trusted from module state: the reuse
  // path can hand back an outer element mounted by a build that had no chip.
  function bindChipElements() {
    runtime.labelElement = document.getElementById(CHIP_ID);
    runtime.labelTextElement = document.getElementById(AGENT_ID);
  }

  // runtime.labelText is the source of truth and the DOM is its reflection.
  // That is what lets a label survive a mount deferred to DOMContentLoaded, and
  // what makes an upgrade over an already-mounted cursor pick up a chip.
  function syncLabel() {
    if (!runtime.labelText) {
      if (runtime.labelElement) runtime.labelElement.remove();
      runtime.labelElement = null;
      runtime.labelTextElement = null;
      return;
    }
    if (!runtime.outerElement) return;
    if (!runtime.labelElement || !runtime.labelTextElement) {
      if (runtime.labelElement) runtime.labelElement.remove();
      createChipElement(runtime.outerElement);
    }
    runtime.labelTextElement.textContent = runtime.labelText;
  }

  function setLabelText(text) {
    if (text === runtime.labelText) return;
    runtime.labelText = text;
    syncLabel();
  }

  // Every opacity write goes through here — an exempted write is how the arrow
  // and the chip drift to different opacities. The press *scale* deliberately
  // stays on the inner element alone: the chip must not grow with a click.
  function setChromeOpacity(value, durationMs) {
    runtime.chromeOpacity = value;
    const elements = [runtime.innerElement, runtime.labelElement];
    for (const element of elements) {
      if (!element) continue;
      element.style.transitionDuration = durationMs + 'ms';
      element.style.transitionTimingFunction = PRESS_EASING;
      element.style.opacity = value;
    }
  }

  function createCursorElement() {
    const outer = document.createElement('div');
    outer.id = CURSOR_ID;
    outer.setAttribute('aria-hidden', 'true');
    outer.style.position = 'fixed';
    outer.style.left = '0';
    outer.style.top = '0';
    outer.style.pointerEvents = 'none';
    outer.style.zIndex = String(CURSOR_Z_INDEX);
    outer.style.transitionProperty = 'transform';
    outer.style.transitionTimingFunction = MOVE_EASING;
    outer.style.transitionDuration = '0ms';
    outer.style.willChange = 'transform';

    const inner = document.createElement('div');
    inner.style.width = CURSOR_SIZE_PX + 'px';
    inner.style.height = CURSOR_SIZE_PX + 'px';
    inner.style.transitionProperty = 'transform, opacity';
    inner.style.transitionTimingFunction = PRESS_EASING;
    inner.style.transitionDuration = PRESS_DURATION_MS + 'ms';
    inner.style.transformOrigin = MINIMAL_HOTSPOT_X_PX + 'px ' + MINIMAL_HOTSPOT_Y_PX + 'px';
    inner.style.backgroundColor = 'transparent';
    inner.style.backgroundRepeat = 'no-repeat';
    inner.style.backgroundSize = 'contain';
    inner.style.filter = 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4))';
    inner.style.opacity = '1';

    inner.style.backgroundImage = CURSOR_IMAGE_URL ? 'url("' + CURSOR_IMAGE_URL + '")' : '';
    outer.appendChild(inner);

    runtime.outerElement = outer;
    runtime.innerElement = inner;
    return outer;
  }

  function ensureCursorElement() {
    const existing = document.getElementById(CURSOR_ID);
    if (existing) {
      runtime.outerElement = existing;
      runtime.innerElement = existing.firstElementChild || null;
      bindChipElements();
      syncLabel();
      return existing;
    }

    const root = document.documentElement || document.body;
    if (!root) {
      document.addEventListener('DOMContentLoaded', ensureCursorElement, { once: true });
      return null;
    }

    const outer = createCursorElement();
    root.appendChild(outer);
    syncLabel();
    return outer;
  }

  function clearIdleHideTimer() {
    if (idleHideTimer !== null) {
      clearTimeout(idleHideTimer);
      idleHideTimer = null;
    }
  }

  function scheduleIdleHide() {
    clearIdleHideTimer();
    idleHideTimer = setTimeout(() => {
      idleHideTimer = null;
      if (!runtime.enabled || !runtime.innerElement) return;
      runtime.idleHidden = true;
      setChromeOpacity('0', IDLE_FADE_OUT_MS);
    }, IDLE_HIDE_DELAY_MS);
  }

  function wakeFromIdle(action) {
    runtime.x = action.x;
    runtime.y = action.y;
    runtime.hasPosition = false;
    runtime.idleHidden = false;
    setChromeOpacity('1', PRESS_DURATION_MS);
  }

  function moveCursor(action) {
    if (!runtime.enabled) return;
    ensureCursorElement();
    if (!runtime.outerElement) return;

    const distance = runtime.hasPosition
      ? Math.hypot(action.x - runtime.x, action.y - runtime.y)
      : 0;
    const duration = runtime.hasPosition
      ? clamp(distance / MOVE_SPEED_PX_PER_MS, MIN_MOVE_DURATION_MS, MAX_MOVE_DURATION_MS)
      : 0;

    runtime.outerElement.style.transitionDuration = Math.round(duration) + 'ms';
    runtime.outerElement.style.transitionTimingFunction = MOVE_EASING;
    runtime.x = action.x;
    runtime.y = action.y;
    runtime.hasPosition = true;
    applyTranslate();
  }

  function setPressed(isPressed) {
    if (!runtime.enabled || !runtime.innerElement) return;
    runtime.scale = isPressed ? 0.95 : 1;
    setChromeOpacity('1', PRESS_DURATION_MS);
    applyScale();
  }

  function enable() {
    runtime.enabled = true;
    ensureCursorElement();
    setChromeOpacity('1', PRESS_DURATION_MS);
    runtime.idleHidden = false;
    applyTranslate();
    applyScale();
    scheduleIdleHide();
  }

  function disable() {
    runtime.enabled = false;
    runtime.hasPosition = false;
    runtime.idleHidden = false;
    runtime.scale = 1;
    runtime.labelText = '';
    runtime.chromeOpacity = '1';
    clearIdleHideTimer();
    if (runtime.outerElement) runtime.outerElement.remove();
    runtime.outerElement = null;
    runtime.innerElement = null;
    runtime.labelElement = null;
    runtime.labelTextElement = null;
  }

  function applyMouseAction(action) {
    if (!runtime.enabled) return;
    // Whoever dispatched THIS event owns the chip, so an unlabelled client's
    // event clears a chip a labelled client left behind.
    setLabelText(action.label || '');
    if (runtime.idleHidden) wakeFromIdle(action);

    if (action.type === 'move' || action.type === 'wheel') {
      moveCursor(action);
    } else if (action.type === 'down') {
      moveCursor(action);
      setPressed(true);
    } else if (action.type === 'up') {
      moveCursor(action);
      setPressed(false);
    }
    scheduleIdleHide();
  }

  globalThis[CURSOR_API_KEY] = { enable, disable, applyMouseAction };
  enable();
})();`;

export function buildGhostCursorSource(cursorImageUrl = '') {
  const safeImageUrl = typeof cursorImageUrl === 'string' ? cursorImageUrl : '';
  return GHOST_CURSOR_SOURCE.replace(
    JSON.stringify(CURSOR_IMAGE_URL_MARKER),
    JSON.stringify(safeImageUrl),
  );
}

export function buildGhostCursorAction({ type, params, agentName } = {}) {
  const actionType = ACTION_TYPES.get(type);
  const x = params?.x;
  const y = params?.y;
  if (!actionType || !Number.isFinite(x) || !Number.isFinite(y)) return null;

  const button = VALID_BUTTONS.has(params?.button) ? params.button : 'none';
  const action = { type: actionType, x, y, button };
  // Omitted, never empty: an unnamed client's payload stays byte-identical to
  // what it was before labels existed. No truncation and no character filtering
  // here — the relay's sanitizeAgentName is the single authority for that.
  if (typeof agentName === 'string' && agentName) action.label = agentName;
  return action;
}

export function buildGhostCursorActionExpression(action) {
  return `globalThis.${CURSOR_API_KEY}?.applyMouseAction?.(${JSON.stringify(action)})`;
}

function safeLog(log, error) {
  try {
    log?.(error);
  } catch {
    // Cursor diagnostics must never affect browser commands.
  }
}

export function createGhostCursorController({
  isEnabled,
  isTabAttached,
  sendCommand,
  cursorImageUrl = '',
  log = () => {},
}) {
  const stateByTab = new Map();
  const cursorSource = buildGhostCursorSource(cursorImageUrl);

  function getState(tabId) {
    let state = stateByTab.get(tabId);
    if (!state) {
      state = {
        scriptId: null,
        generation: 0,
        queue: [],
        isProcessing: false,
    };
    stateByTab.set(tabId, state);
  }
    return state;
  }

  function drain(state) {
    if (state.isProcessing) return state.drainPromise;
    state.isProcessing = true;
    state.drainPromise = (async () => {
      while (state.queue.length > 0) {
        const entry = state.queue.shift();
        try {
          entry.resolve(await entry.operation());
        } catch (error) {
          safeLog(log, error);
          entry.resolve(undefined);
        }
      }
    })().finally(() => {
      state.isProcessing = false;
      state.drainPromise = null;
      if (state.queue.length > 0) drain(state);
    });
    return state.drainPromise;
  }

  function enqueue(tabId, operation, { action, generation } = {}) {
    const state = getState(tabId);
    if (action?.type === 'move') {
      const pending = state.queue[state.queue.length - 1];
      if (pending?.action?.type === 'move') {
        pending.action = action;
        pending.generation = generation;
        pending.operation = operation;
        return pending.promise;
      }
    }

    let resolvePromise;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    state.queue.push({ operation, resolve: resolvePromise, promise, action, generation });
    queueMicrotask(() => void drain(state));
    return promise;
  }

  async function removeRegisteredScript(tabId, state, { canSendCommands = true } = {}) {
    const scriptId = state.scriptId;
    state.scriptId = null;
    if (!scriptId || !canSendCommands) return;
    await sendCommand(tabId, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  }

  async function ensureScript(tabId, state, generation) {
    if (state.scriptId) return true;
    const result = await sendCommand(tabId, 'Page.addScriptToEvaluateOnNewDocument', {
      source: cursorSource,
    });
    const scriptId = result?.identifier;
    if (!scriptId) throw new Error('Ghost cursor injection did not return a script identifier');
    state.scriptId = scriptId;

    if (generation !== state.generation || !isEnabled() || !isTabAttached(tabId)) {
      await removeRegisteredScript(tabId, state);
      return false;
    }
    return true;
  }

  function enable(tabId) {
    const state = getState(tabId);
    const generation = state.generation;
    return enqueue(tabId, async () => {
      if (!isEnabled() || !isTabAttached(tabId) || generation !== state.generation) return false;
      if (!(await ensureScript(tabId, state, generation))) return false;
      if (!isEnabled() || !isTabAttached(tabId) || generation !== state.generation) return false;
      await sendCommand(tabId, 'Runtime.evaluate', { expression: cursorSource });
      return true;
    });
  }

  function queueAction(tabId, action) {
    const state = getState(tabId);
    const generation = state.generation;
    return enqueue(tabId, async () => {
      if (!isEnabled() || !isTabAttached(tabId) || generation !== state.generation) return false;
      if (!(await ensureScript(tabId, state, generation))) return false;
      if (!isEnabled() || !isTabAttached(tabId) || generation !== state.generation) return false;
      await sendCommand(tabId, 'Runtime.evaluate', {
        expression: buildGhostCursorActionExpression(action),
      });
      return true;
    }, { action, generation });
  }

  function disable(tabId) {
    const state = getState(tabId);
    state.generation += 1;
    return enqueue(tabId, async () => {
      if (!isTabAttached(tabId)) {
        state.scriptId = null;
        return false;
      }

      const results = await Promise.allSettled([
        sendCommand(tabId, 'Runtime.evaluate', { expression: DISABLE_EXPRESSION }),
        removeRegisteredScript(tabId, state),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') safeLog(log, result.reason);
      }
      return true;
    });
  }

  function cleanup(tabId) {
    const state = stateByTab.get(tabId);
    if (!state) return Promise.resolve(false);
    state.generation += 1;
    return enqueue(tabId, async () => {
      state.scriptId = null;
      stateByTab.delete(tabId);
      return true;
    });
  }

  return { enable, queueAction, disable, cleanup };
}

export function handleGhostCursorInput({
  method,
  childSessionId,
  tabId,
  params,
  agentName,
  controller,
  log,
}) {
  if (childSessionId || method !== 'Input.dispatchMouseEvent') return false;
  const action = buildGhostCursorAction({ type: params?.type, params, agentName });
  if (!action) return false;

  try {
    const result = controller.queueAction(tabId, action);
    void Promise.resolve(result).catch((error) => safeLog(log, error));
  } catch (error) {
    safeLog(log, error);
  }
  return true;
}
