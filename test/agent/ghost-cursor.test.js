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
  WIGGLE_DURATION_MS,
  SPRING_CHANNELS,
  computeSpringParameters,
  generateBezierCandidates,
  scoreBezierPath,
  computePathResponse,
  computeFollowResponse,
  computeDirectionOpposition,
  APPEAR_INITIAL_SCALE,
  APPEAR_INITIAL_BLUR_PX,
  CURSOR_GLOW_FILTER,
  CURSOR_ARROW_PATH,
  computeCursorTransform,
  stepSpring,
  evaluateBezierPoint,
  evaluateBezierTangent,
  isArcInsideViewport,
  selectBezierArc,
  computeTargetRotationDeg,
  computeSpeedNarrowing,
  computeShortMoveTilt,
  computeShortMoveSquash,
  hasCursorArrived,
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
    createElementNS: (_ns, tagName) => new FakeElement(tagName),
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

test('renders the approved inline SVG without loading an extension asset', () => {
  const runtime = createFakeRendererRuntime(buildGhostCursorSource());
  const inner = runtime.inner();
  const svg = inner.firstElementChild;
  assert.equal(inner.style.width, '24px');
  assert.equal(inner.style.height, '24px');
  assert.equal(inner.style.transformOrigin, '12px 1.6px');
  assert.equal(inner.style.backgroundImage, '');
  assert.equal(svg.attributes.get('viewBox'), '0 0 24 24');
  assert.equal(svg.firstElementChild.attributes.get('d'), CURSOR_ARROW_PATH);
  assert.equal(svg.style.filter, CURSOR_GLOW_FILTER);
  assert.ok(!GHOST_CURSOR_SOURCE.includes('chrome-extension://'));
});

test('keeps the tip exactly on the target under rotation and scaling', () => {
  for (const angle of [-180, -44, 0, 90, 180]) {
    const pose = computeCursorTransform(100, 200, angle, 0.65, 0.4);
    assert.equal(pose.translateX + 12, 100);
    assert.equal(pose.translateY + 1.6, 200);
    assert.equal(pose.transformOrigin, '12px 1.6px');
  }
});

test('mounts inline artwork on blank pages and skips subframes', () => {
  const subframe = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { isSubframe: true });
  assert.equal(subframe.inner(), null);
  const blank = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, {
    location: { protocol: 'about:', href: 'about:blank' }, origin: 'null',
  });
  assert.equal(blank.inner().firstElementChild.tagName, 'SVG');
});

// ─── Pure Physics & Motion Unit Tests ────────────────────────────────────────

test('spring channels use measured response and damping fractions at 240 Hz', () => {
  assert.equal(FIXED_TIMESTEP_MS, 1000 / 240);
  assert.deepEqual(SPRING_CHANNELS, {
    position: { response: 0.19, dampingFraction: 0.90 },
    rotation: { response: 0.12, dampingFraction: 0.90 },
    tilt: { response: 0.055, dampingFraction: 0.82 },
    squash: { response: 0.12, dampingFraction: 0.86 },
    stretch: { response: 0.20, dampingFraction: 0.85 },
    visibility: { response: 0.42, dampingFraction: 0.86 },
    shortProgress: { response: 0.19, dampingFraction: 0.94 },
    longProgress: { dampingFraction: 0.90 },
  });
  const { stiffness, damping } = computeSpringParameters(0.19, 0.9);
  assert.equal(stiffness, (2 * Math.PI / 0.19) ** 2);
  assert.equal(damping, 2 * Math.sqrt(stiffness) * 0.9);
});

test('spring integrates semi-implicit Euler and settles a 100px move within 0.4 seconds', () => {
  const dt = 1 / 240;
  const { stiffness } = computeSpringParameters(0.19, 0.9);
  const first = stepSpring({ value: 0, velocity: 0 }, 100);
  assert.equal(first.velocity, stiffness * 100 * dt);
  assert.equal(first.value, first.velocity * dt);
  let state = { value: 0, velocity: 0 };
  for (let i = 0; i < 96; i += 1) state = stepSpring(state, 100);
  assert.ok(Math.abs(state.value - 100) < 0.01);
  assert.ok(Math.abs(state.velocity) < 0.06);
  assert.deepEqual(stepSpring({ value: 100.000001, velocity: 0.000001 }, 100), { value: 100, velocity: 0 });
});

test('spring caps catch-up at one second', () => {
  assert.deepEqual(stepSpring({ value: 0, velocity: 0 }, 100, { dtMs: 10000 }),
    stepSpring({ value: 0, velocity: 0 }, 100, { dtMs: 1000 }));
});

test('generates 20 paths with tip-first departure and arrival handles', () => {
  const start = { x: 400, y: 400 };
  const end = { x: 1000, y: 600 };
  const candidates = generateBezierCandidates(start, end);
  assert.equal(candidates.length, BEZIER_CANDIDATE_COUNT);
  assert.equal(candidates.filter((path) => path.segments).length, 18);
  const distance = Math.hypot(600, 200);
  assert.ok(Math.abs(Math.hypot(candidates[0].p1.x - start.x, candidates[0].p1.y - start.y) - 0.42 * distance) < 1e-9);
  assert.ok(Math.abs(Math.hypot(candidates[0].p2.x - end.x, candidates[0].p2.y - end.y) - 0.15 * distance) < 1e-9);
  for (const path of candidates) {
    assert.deepEqual(evaluateBezierPoint(path, 0), start);
    assert.deepEqual(evaluateBezierPoint(path, 1), end);
    assert.ok(Math.abs(evaluateBezierTangent(path, 0).angleDeg - (-134)) < 1e-9);
    assert.ok(Math.abs(evaluateBezierTangent(path, 1).angleDeg - (-134)) < 1e-9);
  }
});

test('scores paths with measured length and turning weights', () => {
  for (const candidate of generateBezierCandidates({ x: 300, y: 300 }, { x: 900, y: 500 })) {
    const stats = scoreBezierPath(candidate);
    assert.equal(stats.score, stats.length + 320 * stats.excess + 140 * stats.angleSquared +
      180 * stats.maxTurn + 18 * stats.totalTurn + 90 * stats.opposition + (candidate.segments ? 45 : 0));
    assert.ok(stats.curviness >= 0 && stats.curviness <= 1);
  }
});

test('selects the lowest scoring safe path or the lowest overall if no path fits', () => {
  const start = { x: 400, y: 400 };
  const end = { x: 1000, y: 600 };
  for (const viewport of [{ width: 1400, height: 900 }, { width: 40, height: 40 }]) {
    const candidates = generateBezierCandidates(start, end);
    const safe = candidates.filter((path) => isArcInsideViewport(path, viewport, VIEWPORT_MARGIN_PX));
    const pool = safe.length ? safe : candidates;
    const best = Math.min(...pool.map((path) => scoreBezierPath(path).score));
    const selected = selectBezierArc(start, end, viewport);
    assert.equal(selected.score, best);
    assert.equal(isArcInsideViewport(selected, viewport), safe.length > 0);
  }
});

test('splits short and long modes at exactly 196px', () => {
  const start = { x: 300, y: 300 };
  assert.equal(selectBezierArc(start, { x: 300 + LONG_MOVE_DISTANCE_THRESHOLD_PX, y: 300 }).isCurved, false);
  assert.equal(selectBezierArc(start, { x: 497, y: 300 }).isCurved, true);
  const straight = selectBezierArc(start, { x: 400, y: 350 });
  assert.deepEqual(evaluateBezierPoint(straight, 0.5), { x: 350, y: 325 });
});

test('computes opposition and the measured per-path response', () => {
  const radians = -134 * Math.PI / 180;
  const resting = { x: Math.cos(radians), y: Math.sin(radians) };
  assert.ok(computeDirectionOpposition({ x: 0, y: 0 }, resting) < 1e-9);
  assert.equal(computeDirectionOpposition(resting, { x: 0, y: 0 }), 1);
  assert.equal(computePathResponse(180, 0, 0), 0.42 * 0.7);
  assert.equal(computePathResponse(940, 1, 1), (0.42 + 0.22 + 0.12 + 0.28) * 0.7);
  assert.equal(computePathResponse(560, 0.5, 0.25), (0.42 + 0.22 * 0.5 + 0.12 * 0.5 + 0.28 * 0.25) * 0.7);
});

test('long-path position response follows tightly with measured clamps', () => {
  assert.equal(computeFollowResponse(0.12), 0.035);
  assert.equal(computeFollowResponse(0.5), 0.09);
  assert.equal(computeFollowResponse(2.2), 0.12);
});

test('tangent rotation starts immediately and takes the shortest angular route', () => {
  assert.equal(computeTargetRotationDeg({ isCurved: true, tangentAngleDeg: 0, currentRotationDeg: 80 }), 90);
  assert.equal(computeTargetRotationDeg({ isCurved: true, tangentAngleDeg: 100, currentRotationDeg: -175 }), -170);
  assert.equal(computeTargetRotationDeg({ isCurved: true, tangentAngleDeg: 0, arrived: true }), RESTING_TILT_DEG);
  assert.equal(computeTargetRotationDeg({ isCurved: false }), RESTING_TILT_DEG);
});

test('stretch narrows at speed divided by 5500 and never below 65 percent', () => {
  assert.equal(computeSpeedNarrowing(0), 1);
  assert.equal(computeSpeedNarrowing(1100), 0.8);
  assert.equal(computeSpeedNarrowing(5500), MIN_NARROWING_SCALE_X);
});

test('short tilt and move-axis squash peak at mid-progress', () => {
  assert.equal(computeShortMoveTilt(0, 1, 0), 0);
  assert.equal(computeShortMoveTilt(0.5, 1, 0), 0.75 * 70);
  assert.equal(computeShortMoveTilt(0.5, 0, 1), -0.62 * 70);
  assert.equal(computeShortMoveSquash(0), 1);
  assert.equal(computeShortMoveSquash(0.5), 0.85);
  assert.equal(computeShortMoveSquash(1), 1);
});

test('arrival gates progress, progress velocity, position and each position velocity', () => {
  const target = { x: 100, y: 200 };
  const state = { x: 100.5, y: 200.5, vx: 12, vy: -12, progress: 0.999, progressVelocity: 0.009 };
  assert.equal(hasCursorArrived(state, target), true);
  for (const change of [{ x: 101 }, { vx: 12.01 }, { vy: -12.01 }, { progress: 0.9989 }, { progressVelocity: 0.01 }]) {
    assert.equal(hasCursorArrived({ ...state, ...change }, target), false);
  }
});

test('wiggle is a single 1.41 second sine-windowed burst', () => {
  assert.equal(computeWiggleAngleDeg(0), 0);
  assert.equal(computeWiggleAngleDeg(WIGGLE_DURATION_MS), 0);
  assert.equal(computeWiggleAngleDeg(WIGGLE_DURATION_MS + 1000), 0);
  const t = 330 / 2;
  assert.equal(computeWiggleAngleDeg(t), WIGGLE_MAX_AMPLITUDE_DEG * Math.sin(Math.PI * t / 1410) * Math.sin(2 * Math.PI * t / WIGGLE_PERIOD_MS));
});

test('visibility maps spring value to opacity, scale and blur together', () => {
  assert.deepEqual(computeVisibilityEffect(0), { opacity: 0, scale: APPEAR_INITIAL_SCALE, blurPx: APPEAR_INITIAL_BLUR_PX });
  assert.deepEqual(computeVisibilityEffect(0.5), { opacity: 0.5, scale: 0.7, blurPx: 2.5 });
  assert.deepEqual(computeVisibilityEffect(1), { opacity: 1, scale: 1, blurPx: 0 });
});

test('renderer preserves position and velocity when retargeted and resolves arrival', async () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true });
  await runtime.dispatch({ type: 'move', x: 400, y: 400 });
  runtime.stepRaf();
  let resolved = false;
  const arrival = runtime.dispatch({ type: 'move', x: 900, y: 600 }).then(() => { resolved = true; });
  for (let i = 0; i < 12; i += 1) runtime.stepRaf();
  const mid = runtime.state();
  assert.equal(mid.isLongMove, true);
  runtime.dispatch({ type: 'move', x: 250, y: 500 });
  const retarget = runtime.state();
  for (const key of ['x', 'y', 'vx', 'vy']) assert.equal(retarget[key], mid[key]);
  const result = runtime.stepUntilArrived(480);
  assert.equal(result.arrived, true);
  await arrival;
  assert.equal(resolved, true);
  assert.equal(runtime.state().x, 250);
  assert.equal(runtime.state().y, 500);
  for (let i = 0; i < 200; i += 1) runtime.stepRaf(10);
  assert.equal(runtime.state().idleWiggleMs, WIGGLE_DURATION_MS);
  assert.ok(Math.abs(runtime.state().rotation - RESTING_TILT_DEG) < 1e-6);
});

test('renderer first appearance and idle wake snap before spring visibility', async () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true });
  assert.equal(runtime.inner().style.opacity, '0');
  await runtime.dispatch({ type: 'move', x: 400, y: 300, label: 'Codex' });
  assert.equal(runtime.state().x, 400);
  assert.equal(runtime.state().visibility, 0);
  runtime.stepRaf(100);
  assert.ok(runtime.state().visibility > 0 && runtime.state().visibility < 1);
  assert.equal(runtime.chip().style.opacity, runtime.inner().style.opacity);
  for (let i = 0; i < 150; i += 1) runtime.stepRaf(10);
  runtime.runNextTimer();
  assert.equal(runtime.state().targetVisibility, 0);
  assert.equal(runtime.state().visibility, 1);
  for (let i = 0; i < 150; i += 1) runtime.stepRaf(10);
  assert.equal(runtime.state().visibility, 0);
  await runtime.dispatch({ type: 'move', x: 900, y: 500, label: 'Codex' });
  assert.equal(runtime.state().x, 900);
  assert.equal(runtime.state().y, 500);
  assert.equal(runtime.state().visibility, 0);
});

test('reduced motion jumps with no tilt, stretch or wiggle', async () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true, reducedMotion: true });
  await runtime.dispatch({ type: 'move', x: 50, y: 60 });
  await runtime.dispatch({ type: 'move', x: 600, y: 500 });
  assert.equal(runtime.state().x, 600);
  assert.equal(runtime.state().y, 500);
  assert.equal(runtime.state().rotation, RESTING_TILT_DEG);
  assert.equal(runtime.state().tilt, 0);
  assert.equal(runtime.state().squash, 1);
  assert.equal(runtime.state().scaleX, 1);
  assert.equal(runtime.state().visibility, 1);
  assert.equal(computeWiggleAngleDeg(runtime.state().idleWiggleMs), 0);
});

test('renderer advances the same trajectory at 60 and 120 Hz', async () => {
  const slow = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true });
  const fast = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true });
  for (const runtime of [slow, fast]) {
    await runtime.dispatch({ type: 'move', x: 400, y: 400 });
    runtime.stepRaf();
    runtime.dispatch({ type: 'move', x: 900, y: 600 });
  }
  for (let i = 0; i < 15; i += 1) slow.stepRaf(1000 / 60);
  for (let i = 0; i < 30; i += 1) fast.stepRaf(1000 / 120);
  for (const key of ['x', 'y', 'vx', 'vy', 'rotation', 'progress', 'visibility']) {
    assert.ok(Math.abs(slow.state()[key] - fast.state()[key]) < 1e-8, key);
  }
});

test('short renderer moves stay straight with spring tilt and axis squash', async () => {
  const runtime = createFakeRendererRuntime(GHOST_CURSOR_SOURCE, { withRaf: true });
  await runtime.dispatch({ type: 'move', x: 300, y: 300 });
  runtime.stepRaf();
  runtime.dispatch({ type: 'move', x: 400, y: 350 });
  for (let i = 0; i < 20; i += 1) runtime.stepRaf();
  const state = runtime.state();
  assert.equal(state.isLongMove, false);
  assert.ok(Math.abs((state.x - 300) - 2 * (state.y - 300)) < 1e-8);
  assert.equal(state.rotation, RESTING_TILT_DEG);
  assert.ok(state.tilt > 0);
  assert.ok(state.squash < 1);
  assert.ok(runtime.inner().style.transform.startsWith('rotate(26.565'));
});

test('click sync uses the approved 1500ms named bound', () => {
  assert.equal(CLICK_SYNC_MAX_WAIT_MS, 1500);
  assert.match(buildGhostCursorSyncExpression({ type: 'move', x: 1, y: 2 }), /1500/);
});

test('seeded candidate sweeps are deterministic with finite scores and exact endpoints', () => {
  let seed = 0x28c0ffee;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 40; i += 1) {
    const start = { x: random() * 1280, y: random() * 800 };
    const end = { x: random() * 1280, y: random() * 800 };
    const first = selectBezierArc(start, end);
    assert.deepEqual(first, selectBezierArc(start, end));
    assert.deepEqual(evaluateBezierPoint(first, 0), start);
    assert.deepEqual(evaluateBezierPoint(first, 1), end);
    assert.ok(Number.isFinite(scoreBezierPath(first).score));
  }
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
  assert.match(outer.style.transform, /translate3d\(-2px, 18.4px, 0\)/);

  api.applyMouseAction({ type: 'move', x: 310, y: 420, button: 'none' });
  assert.match(outer.style.transform, /translate3d\(298px, 418.4px, 0\)/);

  api.applyMouseAction({ type: 'down', x: 310, y: 420, button: 'left' });
  assert.equal(inner.style.transform, 'rotate(-44deg) scale(0.95, 0.95)');
  assert.equal(inner.style.opacity, '1');
  api.applyMouseAction({ type: 'up', x: 310, y: 420, button: 'left' });
  assert.equal(inner.style.transform, 'rotate(-44deg) scale(1, 1)');

  runtime.runNextTimer();
  assert.equal(inner.style.opacity, '0');
  assert.match(inner.style.filter, /blur\(5px\)/);
  api.applyMouseAction({ type: 'move', x: 500, y: 520, button: 'none' });
  assert.equal(inner.style.opacity, '1');
  assert.match(outer.style.transform, /488px/);

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

  assert.equal(runtime.inner().style.transform, 'rotate(-44deg) scale(0.95, 0.95)');
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
