import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GHOST_CURSOR_SOURCE,
  FIXED_TIMESTEP_MS,
  LONG_MOVE_DISTANCE_THRESHOLD_PX,
  BEZIER_CANDIDATE_COUNT,
  VIEWPORT_MARGIN_PX,
  RESTING_TILT_DEG,
  MIN_NARROWING_SCALE_X,
  ARRIVAL_DISTANCE_THRESHOLD_PX,
  WIGGLE_MAX_AMPLITUDE_DEG,
  WIGGLE_PERIOD_MS,
  WIGGLE_RAMP_IN_MS,
  APPEAR_INITIAL_SCALE,
  APPEAR_INITIAL_BLUR_PX,
  CURSOR_GLOW_COLOR,
  stepSpring,
  evaluateBezierPoint,
  evaluateBezierTangent,
  isArcInsideViewport,
  selectBezierArc,
  computeMoveDurationMs,
  computeTargetRotationDeg,
  computeSpeedNarrowing,
  computeShortMoveStretch,
  hasCursorArrived,
  computeWiggleAmplitude,
  computeWiggleAngleDeg,
  computeVisibilityEffect,
  CLICK_SYNC_MAX_WAIT_MS,
  buildGhostCursorSource,
  buildGhostCursorAction,
  buildGhostCursorActionExpression,
  buildGhostCursorSyncExpression,
  createGhostCursorController,
  handleGhostCursorInput,
  syncGhostCursorBeforeClick,
} from '../../extension/ghost-cursor.js';

const background = fs.readFileSync(new URL('../../extension/background.js', import.meta.url), 'utf8');
const ghostCursorModule = fs.readFileSync(new URL('../../extension/ghost-cursor.js', import.meta.url), 'utf8');
const popupHtml = fs.readFileSync(new URL('../../extension/popup.html', import.meta.url), 'utf8');
const popupJs = fs.readFileSync(new URL('../../extension/popup.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));

function createCommandRecorder({ shouldReject = false, onCommand } = {}) {
  const calls = [];
  const sendCommand = async (tabId, method, params) => {
    calls.push({ tabId, method, params });
    onCommand?.({ tabId, method, params });
    if (shouldReject) throw new Error('cursor command failed');
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      return { identifier: `cursor-script-${tabId}` };
    }
    return {};
  };
  return { calls, sendCommand };
}

function createFakeRendererRuntime(
  source = GHOST_CURSOR_SOURCE,
  {
    hasRoot = true,
    legacyCursor = false,
    withRaf = false,
    reducedMotion = false,
    isSubframe = false,
    location = undefined,
    origin = undefined,
  } = {},
) {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.attributes = new Map();
      this.id = '';
    }

    get firstElementChild() {
      return this.children[0] || null;
    }

    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      child.parentNode = null;
    }

    remove() {
      this.parentNode?.removeChild(this);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
  }

  const documentElement = new FakeElement('html');
  const timers = [];
  const rafQueue = [];
  const listeners = [];
  let nextTimerId = 1;
  let nextRafId = 1;
  let currentRafTimeMs = 0;

  function findById(element, id) {
    if (element.id === id) return element;
    for (const child of element.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  }

  const document = {
    readyState: 'complete',
    // Deferred mount only happens when BOTH roots are absent — the renderer
    // roots at `documentElement || body`.
    documentElement: hasRoot ? documentElement : null,
    body: hasRoot ? documentElement : null,
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => findById(documentElement, id),
    addEventListener: (type, handler) => { listeners.push({ type, handler }); },
  };

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    ...(location !== undefined ? { location } : {}),
    ...(origin !== undefined ? { origin } : {}),
    matchMedia: (query) => ({
      matches: reducedMotion && query.includes('prefers-reduced-motion'),
    }),
  };
  window.top = isSubframe ? {} : window;

  if (withRaf) {
    window.requestAnimationFrame = (callback) => {
      const id = nextRafId++;
      rafQueue.push({ id, callback, cancelled: false });
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const entry = rafQueue.find((candidate) => candidate.id === id);
      if (entry) entry.cancelled = true;
    };
  }

  const context = {
    document,
    window,
    setTimeout: (callback, delay) => {
      const timer = { id: nextTimerId++, callback, delay, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (timerId) => {
      const timer = timers.find((candidate) => candidate.id === timerId);
      if (timer) timer.cleared = true;
    },
  };
  context.globalThis = context;

  if (legacyCursor) {
    // What a pre-label build leaves in the page: the outer element carrying the
    // id, with only the arrow inside. ensureCursorElement() reuses it by id.
    const outer = new FakeElement('div');
    outer.id = '__browserforce_ghost_cursor__';
    outer.appendChild(new FakeElement('div'));
    documentElement.appendChild(outer);
  }

  vm.createContext(context);
  vm.runInContext(source, context);

  return {
    context,
    document,
    documentElement,
    dispatch(action) {
      return context.globalThis.__browserforceGhostCursor.applyMouseAction(action);
    },
    state() {
      return context.globalThis.__browserforceGhostCursor.getState();
    },
    chip() {
      return findById(documentElement, '__browserforce_ghost_cursor_label__');
    },
    agentSpan() {
      return findById(documentElement, '__browserforce_ghost_cursor_agent__');
    },
    inner() {
      const outer = findById(documentElement, '__browserforce_ghost_cursor__');
      return outer ? outer.children[0] : null;
    },
    mountRoots() {
      document.documentElement = documentElement;
      document.body = documentElement;
      listeners.find((entry) => entry.type === 'DOMContentLoaded').handler();
    },
    reinject() {
      vm.runInContext(source, context);
    },
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (!timer) throw new Error('No active fake timer');
      timer.cleared = true;
      timer.callback();
    },
    stepRaf(dtMs = FIXED_TIMESTEP_MS) {
      currentRafTimeMs += dtMs;
      const pending = rafQueue.splice(0, rafQueue.length).filter((entry) => !entry.cancelled);
      if (pending.length > 0) {
        for (const entry of pending) entry.callback(currentRafTimeMs);
      } else {
        context.globalThis.__browserforceGhostCursor.stepFrame(currentRafTimeMs);
      }
      return context.globalThis.__browserforceGhostCursor.getState();
    },
    stepUntilArrived(maxFrames = 240, dtMs = FIXED_TIMESTEP_MS) {
      const trajectory = [];
      for (let i = 0; i < maxFrames; i += 1) {
        const snapshot = this.stepRaf(dtMs);
        trajectory.push(snapshot);
        if (snapshot.arrived) return { arrived: true, frames: i + 1, trajectory };
      }
      return { arrived: false, frames: maxFrames, trajectory };
    },
  };
}

test('packages the PNG and resolves its extension URL in the injected renderer', () => {
  const imageUrl = 'chrome-extension://test-extension/assets/ghost-cursor.png';
  const source = buildGhostCursorSource(imageUrl);
  const runtime = createFakeRendererRuntime(source);
  const inner = runtime.document.getElementById('__browserforce_ghost_cursor__').firstElementChild;

  assert.ok(source.includes(imageUrl));
  assert.ok(!source.includes('__browserforce_ghost_cursor_image_url__'));
  assert.equal(inner.style.backgroundImage, `url("${imageUrl}")`);
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ['assets/ghost-cursor.png'],
    matches: ['<all_urls>'],
  }]);
});

test('guards against chrome-extension:// asset load errors on about:blank and subframes', () => {
  const imageUrl = 'chrome-extension://test-extension/assets/ghost-cursor.png';
  const source = buildGhostCursorSource(imageUrl);

  // Subframes must not mount a ghost cursor element at all.
  const subframeRuntime = createFakeRendererRuntime(source, { isSubframe: true });
  assert.equal(subframeRuntime.document.getElementById('__browserforce_ghost_cursor__'), null);

  // about:blank and opaque origins do not match <all_urls> in web_accessible_resources;
  // renderer falls back to an inline data: SVG URL instead of triggering Chrome's denial log.
  const blankRuntime = createFakeRendererRuntime(source, {
    location: { protocol: 'about:', href: 'about:blank' },
    origin: 'null',
  });
  const blankInner = blankRuntime.inner();
  assert.ok(blankInner);
  assert.match(blankInner.style.backgroundImage, /^url\("data:image\/svg\+xml;utf8,/);
  assert.ok(!blankInner.style.backgroundImage.includes('chrome-extension://'));
});

// ─── Pure Physics & Motion Unit Tests ────────────────────────────────────────

test('stepSpring integrates with fixed-timestep sub-steps and converges to target', () => {
  let stateA = { value: 0, velocity: 0 };
  for (let i = 0; i < 60; i += 1) {
    stateA = stepSpring(stateA, 100, { dtMs: FIXED_TIMESTEP_MS });
  }
  assert.ok(Math.abs(stateA.value - 100) < 0.5);
  assert.ok(Math.abs(stateA.velocity) < 5);

  // Fixed-timestep invariance: one 2*dt step matches two 1*dt steps exactly.
  const oneDouble = stepSpring({ value: 10, velocity: 25 }, 200, { dtMs: FIXED_TIMESTEP_MS * 2 });
  const firstHalf = stepSpring({ value: 10, velocity: 25 }, 200, { dtMs: FIXED_TIMESTEP_MS });
  const secondHalf = stepSpring(firstHalf, 200, { dtMs: FIXED_TIMESTEP_MS });
  assert.ok(Math.abs(oneDouble.value - secondHalf.value) < 1e-9);
  assert.ok(Math.abs(oneDouble.velocity - secondHalf.velocity) < 1e-9);
});

test('selectBezierArc uses straight lines for short moves and curved viewport-safe arcs for long moves', () => {
  const viewport = { width: 1280, height: 800 };

  // Short move (<= 196px): straight line
  const shortArc = selectBezierArc({ x: 100, y: 100 }, { x: 220, y: 180 }, viewport);
  assert.equal(shortArc.isCurved, false);
  const midShort = evaluateBezierPoint(shortArc, 0.5);
  assert.ok(Math.abs(midShort.x - 160) < 1e-6);
  assert.ok(Math.abs(midShort.y - 140) < 1e-6);

  // Long move (> 196px) near top viewport edge: chooses a candidate arc that stays >= 20px inside viewport
  const edgeStart = { x: 80, y: 24 };
  const edgeEnd = { x: 700, y: 24 };
  const longArc = selectBezierArc(edgeStart, edgeEnd, viewport);
  assert.ok(longArc.distance > LONG_MOVE_DISTANCE_THRESHOLD_PX);
  assert.equal(longArc.isCurved, true);
  assert.ok(longArc.candidateIndex >= 0 && longArc.candidateIndex < BEZIER_CANDIDATE_COUNT);
  assert.equal(isArcInsideViewport(longArc, viewport, VIEWPORT_MARGIN_PX), true);
  const midLong = evaluateBezierPoint(longArc, 0.5);
  // Must curve downward into the viewport, not upward past y=20px
  assert.ok(midLong.y > edgeStart.y + 20);

  // Shorter distance -> faster duration
  assert.ok(computeMoveDurationMs(120) < computeMoveDurationMs(400));
});

test('computeTargetRotationDeg follows path tangent on long arcs and peaks mid-move on short moves', () => {
  const tangent = evaluateBezierTangent(
    selectBezierArc({ x: 100, y: 200 }, { x: 600, y: 450 }, { width: 1280, height: 800 }),
    0.5,
  );
  const midArcRotation = computeTargetRotationDeg({
    isCurved: true,
    tangentAngleDeg: tangent.angleDeg,
    progress: 0.5,
    restingTiltDeg: RESTING_TILT_DEG,
  });
  const endArcRotation = computeTargetRotationDeg({
    isCurved: true,
    tangentAngleDeg: tangent.angleDeg,
    progress: 1,
    restingTiltDeg: RESTING_TILT_DEG,
  });
  assert.ok(Math.abs(midArcRotation) > 5);
  assert.ok(Math.abs(endArcRotation) < 1e-6);

  // Short move peaks at progress = 0.5 and settles to 0 at endpoints
  const shortStart = computeTargetRotationDeg({ isCurved: false, progress: 0 });
  const shortMid = computeTargetRotationDeg({ isCurved: false, progress: 0.5 });
  const shortEnd = computeTargetRotationDeg({ isCurved: false, progress: 1 });
  assert.equal(shortStart, 0);
  assert.ok(Math.abs(shortMid) > 5);
  assert.ok(Math.abs(shortEnd) < 1e-6);
});

test('computeSpeedNarrowing and computeShortMoveStretch deform width and squash-stretch', () => {
  assert.equal(computeSpeedNarrowing(0), 1);
  assert.ok(computeSpeedNarrowing(1200) < 1 && computeSpeedNarrowing(1200) > MIN_NARROWING_SCALE_X);
  assert.equal(computeSpeedNarrowing(5000), MIN_NARROWING_SCALE_X);

  const stretchStart = computeShortMoveStretch(0);
  const stretchMid = computeShortMoveStretch(0.5);
  const stretchEnd = computeShortMoveStretch(1);
  assert.equal(stretchStart.scaleX, 1);
  assert.equal(stretchStart.scaleY, 1);
  assert.ok(stretchMid.scaleY > 1);
  assert.ok(stretchMid.scaleX < 1);
  assert.ok(Math.abs(stretchEnd.scaleY - 1) < 1e-6);
});

test('hasCursorArrived enforces <= 0.85px distance and near-zero velocity', () => {
  assert.equal(
    hasCursorArrived({ x: 100.5, y: 200.5, vx: 1, vy: 1 }, { x: 100, y: 200 }),
    true,
  );
  assert.equal(
    hasCursorArrived(
      { x: 100 + ARRIVAL_DISTANCE_THRESHOLD_PX + 0.2, y: 200, vx: 0, vy: 0 },
      { x: 100, y: 200 },
    ),
    false,
  );
  assert.equal(
    hasCursorArrived({ x: 100, y: 200, vx: 40, vy: 0 }, { x: 100, y: 200 }),
    false,
  );
});

test('computeWiggleAmplitude and computeWiggleAngleDeg ramp to 12.5deg over 1.4s with 0.66s period', () => {
  assert.equal(computeWiggleAmplitude(0), 0);
  const halfRamp = computeWiggleAmplitude(WIGGLE_RAMP_IN_MS / 2);
  assert.ok(halfRamp > 0 && halfRamp < WIGGLE_MAX_AMPLITUDE_DEG);
  assert.equal(computeWiggleAmplitude(WIGGLE_RAMP_IN_MS), WIGGLE_MAX_AMPLITUDE_DEG);
  assert.equal(computeWiggleAmplitude(WIGGLE_RAMP_IN_MS + 1000), WIGGLE_MAX_AMPLITUDE_DEG);

  // Quarter period after ramp completes hits peak +12.5 deg; three-quarter period hits -12.5 deg
  const cycleBase = WIGGLE_RAMP_IN_MS * 10; // exact multiple of 660ms? Let's use 10 * WIGGLE_PERIOD_MS (> 1400ms)
  const fullCycleAtRamp = WIGGLE_PERIOD_MS * 3;
  const quarterPeak = computeWiggleAngleDeg(fullCycleAtRamp + WIGGLE_PERIOD_MS * 0.25);
  const threeQuarterPeak = computeWiggleAngleDeg(fullCycleAtRamp + WIGGLE_PERIOD_MS * 0.75);
  assert.ok(Math.abs(quarterPeak - WIGGLE_MAX_AMPLITUDE_DEG) < 1e-6);
  assert.ok(Math.abs(threeQuarterPeak + WIGGLE_MAX_AMPLITUDE_DEG) < 1e-6);
});

test('computeVisibilityEffect combines fade, 40% scale, and 5px->0 blur', () => {
  const hidden = computeVisibilityEffect(0);
  assert.equal(hidden.opacity, 0);
  assert.equal(hidden.scale, APPEAR_INITIAL_SCALE);
  assert.equal(hidden.blurPx, APPEAR_INITIAL_BLUR_PX);

  const visible = computeVisibilityEffect(1);
  assert.equal(visible.opacity, 1);
  assert.equal(visible.scale, 1);
  assert.equal(visible.blurPx, 0);
});

test('renderer bends smoothly when retargeted mid-move, resolves arrival promise, wiggles when idle, and respects reduced motion', async () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true });
  const inner = runtime.inner();
  assert.ok(inner.style.filter.includes(CURSOR_GLOW_COLOR));

  // Initial placement
  await runtime.dispatch({ type: 'move', x: 100, y: 100, button: 'none' });
  assert.equal(runtime.state().arrived, true);

  // Start a long move (> 196px)
  let arrivedResolved = false;
  const movePromise = runtime.dispatch({ type: 'move', x: 500, y: 400, button: 'none' }).then((res) => {
    arrivedResolved = res.arrived;
    return res;
  });
  assert.equal(runtime.state().arrived, false);
  assert.equal(runtime.state().isLongMove, true);

  // Step a few frames into the move
  for (let i = 0; i < 12; i += 1) runtime.stepRaf();
  const midMoveState = runtime.state();
  assert.ok(midMoveState.x > 100 && midMoveState.x < 500);
  assert.ok(Math.hypot(midMoveState.vx, midMoveState.vy) > 10);

  // Retarget mid-move: position and velocity must not jump
  runtime.dispatch({ type: 'move', x: 260, y: 520, button: 'none' });
  const retargetedState = runtime.state();
  assert.equal(retargetedState.x, midMoveState.x);
  assert.equal(retargetedState.y, midMoveState.y);
  assert.equal(retargetedState.vx, midMoveState.vx);
  assert.equal(retargetedState.vy, midMoveState.vy);

  // Step until arrival at the new target
  const result = runtime.stepUntilArrived();
  assert.equal(result.arrived, true);
  await movePromise;
  assert.equal(arrivedResolved, true);
  assert.ok(Math.hypot(runtime.state().x - 260, runtime.state().y - 520) <= ARRIVAL_DISTANCE_THRESHOLD_PX);

  // Step further while idle: thinking wiggle ramps in and rocks rotation; stops on next move
  for (let i = 0; i < 30; i += 1) runtime.stepRaf(20);
  assert.ok(runtime.state().idleWiggleMs > 0);
  assert.ok(Math.abs(runtime.state().rotation) > 0.1);
  runtime.dispatch({ type: 'move', x: 300, y: 530, button: 'none' });
  assert.equal(runtime.state().idleWiggleMs, 0);

  // Reduced motion jumps straight to target and skips wiggle
  const reducedRuntime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, {
    withRaf: true,
    reducedMotion: true,
  });
  await reducedRuntime.dispatch({ type: 'move', x: 50, y: 60, button: 'none' });
  await reducedRuntime.dispatch({ type: 'move', x: 600, y: 500, button: 'none' });
  assert.equal(reducedRuntime.state().x, 600);
  assert.equal(reducedRuntime.state().y, 500);
  assert.equal(reducedRuntime.state().arrived, true);
  reducedRuntime.stepRaf(200);
  assert.equal(reducedRuntime.state().rotation, 0);
});

test('maps supported CDP mouse events into cursor actions', () => {
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 } }),
    { type: 'move', x: 40, y: 90, button: 'none' },
  );
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mousePressed', params: { x: 40, y: 90, button: 'left' } }),
    { type: 'down', x: 40, y: 90, button: 'left' },
  );
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseReleased', params: { x: 40, y: 90, button: 'left' } }),
    { type: 'up', x: 40, y: 90, button: 'left' },
  );
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseWheel', params: { x: 40, y: 90 } }),
    { type: 'wheel', x: 40, y: 90, button: 'none' },
  );
});

test('rejects unsupported or malformed cursor events', () => {
  assert.equal(buildGhostCursorAction({ type: 'touchStart', params: { x: 1, y: 2 } }), null);
  assert.equal(buildGhostCursorAction({ type: 'mouseMoved', params: { x: '40', y: 90 } }), null);
  assert.equal(buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: Number.NaN } }), null);
});

test('builds a serialized expression for a cursor action', () => {
  const expression = buildGhostCursorActionExpression({
    type: 'move',
    x: 12,
    y: 24,
    button: 'left',
  });

  assert.match(expression, /__browserforceGhostCursor/);
  assert.match(expression, /"x":12/);
  assert.match(expression, /"y":24/);
  assert.match(expression, /"button":"left"/);
});

test('controller serializes setup, coalesces movement, and preserves presses', async () => {
  const attachedTabs = new Set([7]);
  const commandRecorder = createCommandRecorder();
  const logs = [];
  const controller = createGhostCursorController({
    isEnabled: () => true,
    isTabAttached: (tabId) => attachedTabs.has(tabId),
    sendCommand: commandRecorder.sendCommand,
    log: (error) => logs.push(error),
  });

  await controller.enable(7);
  commandRecorder.calls.length = 0;

  const firstMove = controller.queueAction(7, { type: 'move', x: 10, y: 20, button: 'none' });
  const secondMove = controller.queueAction(7, { type: 'move', x: 30, y: 40, button: 'none' });
  const press = controller.queueAction(7, { type: 'down', x: 30, y: 40, button: 'left' });
  await Promise.all([firstMove, secondMove, press]);

  const expressions = commandRecorder.calls
    .filter((call) => call.method === 'Runtime.evaluate')
    .map((call) => call.params.expression);
  assert.equal(expressions.length, 2);
  assert.match(expressions[0], /"x":30/);
  assert.match(expressions[0], /"y":40/);
  assert.match(expressions[1], /"type":"down"/);
  assert.deepEqual(logs, []);
});

test('enable does not inject when the live setting is disabled', async () => {
  const commandRecorder = createCommandRecorder();
  const controller = createGhostCursorController({
    isEnabled: () => false,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
  });

  await controller.enable(7);

  assert.deepEqual(commandRecorder.calls, []);
});

test('disable bypasses the live enabled predicate and removes cursor registration', async () => {
  let isEnabled = true;
  const commandRecorder = createCommandRecorder();
  const controller = createGhostCursorController({
    isEnabled: () => isEnabled,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
    log: () => {},
  });

  await controller.enable(11);
  commandRecorder.calls.length = 0;
  isEnabled = false;
  await controller.disable(11);

  assert.deepEqual(
    commandRecorder.calls.map((call) => call.method),
    ['Runtime.evaluate', 'Page.removeScriptToEvaluateOnNewDocument'],
  );
});

test('controller contains debugger failures and keeps cleanup independent per tab', async () => {
  const logs = [];
  const commandRecorder = createCommandRecorder({ shouldReject: true });
  const controller = createGhostCursorController({
    isEnabled: () => true,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
    log: (error) => logs.push(error),
  });

  await assert.doesNotReject(() => controller.enable(1));
  await assert.doesNotReject(() => controller.enable(2));
  await assert.doesNotReject(() => controller.queueAction(1, {
    type: 'move',
    x: 1,
    y: 2,
    button: 'none',
  }));
  await assert.doesNotReject(() => controller.cleanup(1));

  assert.equal(commandRecorder.calls.some((call) => call.tabId === 1), true);
  assert.equal(commandRecorder.calls.some((call) => call.tabId === 2), true);
  assert.equal(logs.length > 0, true);
});

test('input adapter ignores child/unsupported events and contains controller throws', () => {
  const logs = [];
  const controller = {
    queueAction: () => {
      throw new Error('queue failed');
    },
  };

  assert.equal(handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    childSessionId: 'child-1',
    tabId: 1,
    params: { type: 'mouseMoved', x: 1, y: 2 },
    controller,
    log: (error) => logs.push(error),
  }), false);
  assert.equal(handleGhostCursorInput({
    method: 'Runtime.evaluate',
    tabId: 1,
    params: { type: 'mouseMoved', x: 1, y: 2 },
    controller,
    log: (error) => logs.push(error),
  }), false);
  assert.equal(handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    tabId: 1,
    params: { type: 'mouseMoved', x: '1', y: 2 },
    controller,
    log: (error) => logs.push(error),
  }), false);
  assert.doesNotThrow(() => handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    tabId: 1,
    params: { type: 'mouseMoved', x: 1, y: 2 },
    controller,
    log: (error) => logs.push(error),
  }));
  assert.equal(logs.length, 1);
});

test('renderer source mounts, animates, fades, wakes, navigates, and disables', () => {
  const runtime = createFakeRendererRuntime();
  const api = runtime.context.__browserforceGhostCursor;
  const outer = runtime.document.getElementById('__browserforce_ghost_cursor__');
  const inner = outer.firstElementChild;

  assert.ok(api);
  assert.ok(outer);
  api.applyMouseAction({ type: 'move', x: 10, y: 20, button: 'none' });
  assert.match(outer.style.transform, /translate3d\(10px, 20px, 0\)/);

  api.applyMouseAction({ type: 'move', x: 310, y: 420, button: 'none' });
  assert.match(outer.style.transform, /translate3d\(310px, 420px, 0\)/);

  api.applyMouseAction({ type: 'down', x: 310, y: 420, button: 'left' });
  assert.equal(inner.style.transform, 'scale(0.95)');
  assert.equal(inner.style.opacity, '1');
  api.applyMouseAction({ type: 'up', x: 310, y: 420, button: 'left' });
  assert.equal(inner.style.transform, 'scale(1)');

  runtime.runNextTimer();
  assert.equal(inner.style.opacity, '0');
  assert.match(inner.style.filter, /blur\(5px\)/);
  api.applyMouseAction({ type: 'move', x: 500, y: 520, button: 'none' });
  assert.equal(inner.style.opacity, '1');
  assert.match(outer.style.transform, /500px/);

  const navigatedRuntime = createFakeRendererRuntime();
  assert.ok(navigatedRuntime.document.getElementById('__browserforce_ghost_cursor__'));

  api.disable();
  assert.equal(runtime.document.getElementById('__browserforce_ghost_cursor__'), null);
});

test('extension wiring keeps cursor updates cosmetic and settings default-off', () => {
  assert.match(popupHtml, /id="bf-ghost-cursor"/);
  assert.match(popupHtml, /Show ghost cursor for agent actions/);
  assert.match(popupJs, /ghostCursorEnabled/);
  assert.match(popupHtml, /id="bf-ghost-cursor-click-sync-row"[^>]*hidden/);
  assert.match(popupHtml, /id="bf-ghost-cursor-click-sync"[^>]*disabled/);
  assert.match(popupHtml, /Sync clicks with cursor arrival/);
  assert.match(popupJs, /ghostCursorClickSync/);
  assert.match(popupJs, /syncGhostCursorClickSyncState/);
  assert.match(background, /syncGhostCursorBeforeClick/);
  assert.match(background, /ghostCursorClickSync/);
  assert.match(background, /handleGhostCursorInput/);
  assert.match(background, /ghostCursorController/);
  assert.match(background, /chrome\.runtime\.getURL\(['"]assets\/ghost-cursor\.png['"]\)/);
  assert.match(ghostCursorModule, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(ghostCursorModule, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(packageJson.scripts.test, /test\/agent\/ghost-cursor\.test\.js/);
  assert.match(packageJson.scripts['test:agent'], /test\/agent\/ghost-cursor\.test\.js/);
});

// ─── Agent label chip ────────────────────────────────────────────────────────

const CHIP_ID = '__browserforce_ghost_cursor_label__';
const AGENT_ID = '__browserforce_ghost_cursor_agent__';
const CHIP_PREFIX_TEXT = 'BrowserForce ·';

const move = (label) => ({ type: 'move', x: 40, y: 90, button: 'none', ...(label ? { label } : {}) });

test('renders no chip element at all when no client ever sends a name', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move());
  assert.equal(runtime.chip(), null);
});

test('renders the agent name behind a renderer-owned BrowserForce prefix', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  const chip = runtime.chip();
  assert.ok(chip);
  assert.equal(runtime.agentSpan().textContent, 'Claude');
  assert.equal(chip.children[0].textContent, CHIP_PREFIX_TEXT);
  // A margin, not a trailing space: `all: initial` resets white-space, so a
  // trailing space could collapse and render 'BrowserForce ·Claude'.
  assert.equal(chip.children[0].style.marginRight, '4px');
});

test('updates the name in place when a different agent takes over the tab', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  const firstChip = runtime.chip();

  runtime.dispatch(move('Codex'));

  assert.equal(runtime.agentSpan().textContent, 'Codex');
  assert.equal(runtime.chip(), firstChip);
  assert.equal(runtime.documentElement.children[0].children.filter((c) => c.id === CHIP_ID).length, 1);
});

test('removes the chip when an unlabelled client dispatches the next event', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  assert.ok(runtime.chip());

  runtime.dispatch(move());

  assert.equal(runtime.chip(), null);
});

test('does not rebuild the chip when the same name repeats', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  const chip = runtime.chip();

  runtime.dispatch(move('Claude'));

  assert.equal(runtime.chip(), chip);
});

test('adds a chip to a cursor element mounted by a build that had none', () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { legacyCursor: true });
  assert.equal(runtime.documentElement.children.length, 1);
  assert.equal(runtime.chip(), null);

  runtime.dispatch(move('Claude'));

  assert.equal(runtime.agentSpan().textContent, 'Claude');
  assert.equal(runtime.documentElement.children.length, 1);
});

test('does not duplicate the chip when the renderer is re-injected', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  runtime.reinject();
  runtime.dispatch(move('Codex'));

  const outer = runtime.documentElement.children[0];
  assert.equal(outer.children.filter((child) => child.id === CHIP_ID).length, 1);
  assert.equal(runtime.agentSpan().textContent, 'Codex');
});

test('replays a label that arrived before the document had a root', () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { hasRoot: false });
  runtime.dispatch(move('Claude'));
  assert.equal(runtime.chip(), null);

  runtime.mountRoots();

  assert.equal(runtime.agentSpan().textContent, 'Claude');
});

test('isolates the chip from page CSS without breaking its inline layout', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  const chip = runtime.chip();

  for (const element of [chip, chip.children[0], chip.children[1]]) {
    assert.equal(element.style.all, 'initial');
    assert.equal(element.style.direction, 'ltr');
    assert.equal(element.style.unicodeBidi, 'isolate');
    assert.equal(element.style.boxSizing, 'border-box');
    assert.equal(element.style.pointerEvents, 'none');
    assert.equal(element.style.whiteSpace, 'nowrap');
  }
  assert.equal(chip.style.position, 'absolute');
  assert.equal(chip.style.display, 'block');
  assert.equal(chip.children[0].style.display, 'inline');
  assert.equal(chip.children[1].style.display, 'inline');
  assert.equal(chip.children[0].style.position, undefined);
  assert.equal(chip.children[1].style.position, undefined);
});

test('fades the chip with the arrow when the cursor goes idle', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  runtime.runNextTimer();

  assert.equal(runtime.inner().style.opacity, '0');
  assert.equal(runtime.chip().style.opacity, '0');
});

test('wakes the chip and the arrow together on a press after idle', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));
  runtime.runNextTimer();

  runtime.dispatch({ type: 'down', x: 41, y: 91, button: 'left', label: 'Claude' });

  assert.equal(runtime.inner().style.opacity, '1');
  assert.equal(runtime.chip().style.opacity, '1');
});

test('scales only the arrow on press, never the chip', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch({ type: 'down', x: 40, y: 90, button: 'left', label: 'Claude' });

  assert.equal(runtime.inner().style.transform, 'scale(0.95)');
  assert.equal(runtime.chip().style.transform, undefined);
});

test('leaves no chip anywhere in the document after disable', () => {
  const runtime = createFakeRendererRuntime();
  runtime.dispatch(move('Claude'));

  runtime.context.globalThis.__browserforceGhostCursor.disable();

  assert.equal(runtime.chip(), null);
  assert.equal(runtime.agentSpan(), null);
});

test('carries the agent name on a cursor action and omits the key without one', () => {
  assert.deepEqual(
    buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 }, agentName: 'Claude' }),
    { type: 'move', x: 40, y: 90, button: 'none', label: 'Claude' },
  );
  assert.equal('label' in buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 } }), false);
  assert.equal('label' in buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 }, agentName: '' }), false);
  assert.equal('label' in buildGhostCursorAction({ type: 'mouseMoved', params: { x: 40, y: 90 }, agentName: 42 }), false);
});

test('does not re-apply the relay length policy to the agent name', () => {
  const longName = 'x'.repeat(40);
  assert.equal(
    buildGhostCursorAction({ type: 'mouseMoved', params: { x: 1, y: 2 }, agentName: longName }).label,
    longName,
  );
});

test('forwards the agent name from the debugger bridge to the cursor action', () => {
  const actions = [];
  const controller = { queueAction: (tabId, action) => { actions.push(action); return Promise.resolve(true); } };

  handleGhostCursorInput({
    method: 'Input.dispatchMouseEvent',
    tabId: 7,
    params: { type: 'mouseMoved', x: 5, y: 6 },
    agentName: 'Codex',
    controller,
  });

  assert.equal(actions[0].label, 'Codex');
});

test('buildGhostCursorSyncExpression normalizes to move and races arrival with timeout', () => {
  const expr = buildGhostCursorSyncExpression(
    { type: 'down', x: 180, y: 260, button: 'left', label: 'Claude' },
    CLICK_SYNC_MAX_WAIT_MS,
  );
  assert.match(expr, /"type":"move"/);
  assert.match(expr, /"x":180,"y":260/);
  assert.match(expr, /"label":"Claude"/);
  assert.match(expr, /Promise\.race/);
  assert.match(expr, new RegExp(String(CLICK_SYNC_MAX_WAIT_MS)));
});

test('syncGhostCursorBeforeClick animates before mousePressed only when click sync is enabled', async () => {
  const commandRecorder = createCommandRecorder();
  const controller = createGhostCursorController({
    isEnabled: () => true,
    isTabAttached: () => true,
    sendCommand: commandRecorder.sendCommand,
  });

  const offResult = await syncGhostCursorBeforeClick({
    method: 'Input.dispatchMouseEvent',
    tabId: 5,
    params: { type: 'mousePressed', x: 120, y: 240, button: 'left' },
    agentName: 'Claude',
    controller,
    isClickSyncEnabled: false,
  });
  assert.equal(offResult, false);
  assert.equal(commandRecorder.calls.length, 0);

  const moveResult = await syncGhostCursorBeforeClick({
    method: 'Input.dispatchMouseEvent',
    tabId: 5,
    params: { type: 'mouseMoved', x: 120, y: 240 },
    controller,
    isClickSyncEnabled: true,
  });
  assert.equal(moveResult, false);
  assert.equal(commandRecorder.calls.length, 0);

  const childResult = await syncGhostCursorBeforeClick({
    method: 'Input.dispatchMouseEvent',
    childSessionId: 'child-1',
    tabId: 5,
    params: { type: 'mousePressed', x: 120, y: 240, button: 'left' },
    controller,
    isClickSyncEnabled: true,
  });
  assert.equal(childResult, false);
  assert.equal(commandRecorder.calls.length, 0);

  const onResult = await syncGhostCursorBeforeClick({
    method: 'Input.dispatchMouseEvent',
    tabId: 5,
    params: { type: 'mousePressed', x: 120, y: 240, button: 'left' },
    agentName: 'Claude',
    controller,
    isClickSyncEnabled: true,
  });
  assert.equal(onResult, true);
  assert.deepEqual(
    commandRecorder.calls.map((c) => c.method),
    ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate'],
  );
  assert.equal(commandRecorder.calls[1].params.awaitPromise, true);
  assert.match(commandRecorder.calls[1].params.expression, /"type":"move"/);
  assert.match(commandRecorder.calls[1].params.expression, /"label":"Claude"/);
});

test('syncGhostCursorBeforeClick bounds wait by maxWaitMs so a stuck animation never blocks a click', async () => {
  const controller = createGhostCursorController({
    isEnabled: () => true,
    isTabAttached: () => true,
    sendCommand: (_tabId, method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return Promise.resolve({ identifier: 'script-1' });
      }
      return new Promise(() => {});
    },
  });

  const startedAt = Date.now();
  const result = await syncGhostCursorBeforeClick({
    method: 'Input.dispatchMouseEvent',
    tabId: 9,
    params: { type: 'mousePressed', x: 400, y: 300, button: 'left' },
    controller,
    isClickSyncEnabled: true,
    maxWaitMs: 35,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result, false);
  assert.ok(elapsedMs < 250, `Expected bounded wait < 250ms, got ${elapsedMs}ms`);
});
