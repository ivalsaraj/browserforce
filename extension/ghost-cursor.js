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

  const runtime = {
    outerElement: null,
    innerElement: null,
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
      return existing;
    }

    const root = document.documentElement || document.body;
    if (!root) {
      document.addEventListener('DOMContentLoaded', ensureCursorElement, { once: true });
      return null;
    }

    const outer = createCursorElement();
    root.appendChild(outer);
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
      runtime.innerElement.style.transitionDuration = IDLE_FADE_OUT_MS + 'ms';
      runtime.innerElement.style.transitionTimingFunction = PRESS_EASING;
      runtime.innerElement.style.opacity = '0';
    }, IDLE_HIDE_DELAY_MS);
  }

  function wakeFromIdle(action) {
    runtime.x = action.x;
    runtime.y = action.y;
    runtime.hasPosition = false;
    runtime.idleHidden = false;
    if (runtime.innerElement) {
      runtime.innerElement.style.transitionDuration = PRESS_DURATION_MS + 'ms';
      runtime.innerElement.style.transitionTimingFunction = PRESS_EASING;
      runtime.innerElement.style.opacity = '1';
    }
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
    runtime.innerElement.style.transitionDuration = PRESS_DURATION_MS + 'ms';
    runtime.innerElement.style.transitionTimingFunction = PRESS_EASING;
    runtime.innerElement.style.opacity = '1';
    applyScale();
  }

  function enable() {
    runtime.enabled = true;
    ensureCursorElement();
    if (runtime.innerElement) {
      runtime.innerElement.style.opacity = '1';
      runtime.innerElement.style.transitionDuration = PRESS_DURATION_MS + 'ms';
      runtime.innerElement.style.transitionTimingFunction = PRESS_EASING;
    }
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
    clearIdleHideTimer();
    if (runtime.outerElement) runtime.outerElement.remove();
    runtime.outerElement = null;
    runtime.innerElement = null;
  }

  function applyMouseAction(action) {
    if (!runtime.enabled) return;
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

export function buildGhostCursorAction({ type, params } = {}) {
  const actionType = ACTION_TYPES.get(type);
  const x = params?.x;
  const y = params?.y;
  if (!actionType || !Number.isFinite(x) || !Number.isFinite(y)) return null;

  const button = VALID_BUTTONS.has(params?.button) ? params.button : 'none';
  return { type: actionType, x, y, button };
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
  controller,
  log,
}) {
  if (childSessionId || method !== 'Input.dispatchMouseEvent') return false;
  const action = buildGhostCursorAction({ type: params?.type, params });
  if (!action) return false;

  try {
    const result = controller.queueAction(tabId, action);
    void Promise.resolve(result).catch((error) => safeLog(log, error));
  } catch (error) {
    safeLog(log, error);
  }
  return true;
}
