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

// ─── Physics & Motion Tuning Constants ───────────────────────────────────────
// Exported for deterministic unit testing and shared verbatim with the
// injected page renderer so test math and runtime math cannot drift.

export const FIXED_TIMESTEP_MS = 1000 / 120;
export const FIXED_TIMESTEP_SEC = 1 / 120;
export const MAX_FRAME_DELTA_MS = 100;

export const POSITION_SPRING_STIFFNESS = 280;
export const POSITION_SPRING_DAMPING = 28;
export const ROTATION_SPRING_STIFFNESS = 320;
export const ROTATION_SPRING_DAMPING = 26;
export const STRETCH_SPRING_STIFFNESS = 340;
export const STRETCH_SPRING_DAMPING = 28;
export const VISIBILITY_SPRING_STIFFNESS = 220;
export const VISIBILITY_SPRING_DAMPING = 24;

export const LONG_MOVE_DISTANCE_THRESHOLD_PX = 196;
export const BEZIER_CANDIDATE_COUNT = 20;
export const VIEWPORT_MARGIN_PX = 20;
export const RESTING_TILT_DEG = -44;
export const SHORT_MOVE_MAX_TILT_DEG = 10;
export const SHORT_MOVE_STRETCH_PEAK = 0.08;

export const MIN_NARROWING_SCALE_X = 0.65;
export const MAX_NARROWING_SPEED_PX_PER_SEC = 2400;

export const ARRIVAL_DISTANCE_THRESHOLD_PX = 0.85;
export const ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC = 5;

export const WIGGLE_MAX_AMPLITUDE_DEG = 12.5;
export const WIGGLE_PERIOD_MS = 660;
export const WIGGLE_RAMP_IN_MS = 1400;

export const APPEAR_INITIAL_SCALE = 0.4;
export const APPEAR_INITIAL_BLUR_PX = 5;
export const CURSOR_GLOW_COLOR = '#339cff';

export const MIN_MOVE_DURATION_MS = 140;
export const MAX_MOVE_DURATION_MS = 680;
export const MOVE_SPEED_PX_PER_MS = 1.6;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapAngleDegrees(angleDeg) {
  let wrapped = ((angleDeg + 180) % 360 + 360) % 360 - 180;
  if (wrapped === -180) wrapped = 180;
  return wrapped;
}

/**
 * Integrates a 1D damped harmonic oscillator using fixed-timestep sub-steps.
 * Why fixed-timestep: requestAnimationFrame intervals vary across 60/120Hz
 * panels and dropped frames; fixed sub-steps keep spring trajectories and
 * damping identical regardless of frame pacing.
 */
export function stepSpring(
  state,
  target,
  {
    stiffness = POSITION_SPRING_STIFFNESS,
    damping = POSITION_SPRING_DAMPING,
    dtMs = FIXED_TIMESTEP_MS,
    fixedStepMs = FIXED_TIMESTEP_MS,
  } = {},
) {
  let value = Number.isFinite(state?.value) ? state.value : target;
  let velocity = Number.isFinite(state?.velocity) ? state.velocity : 0;
  const clampedDtMs = clampNumber(Number.isFinite(dtMs) ? dtMs : 0, 0, MAX_FRAME_DELTA_MS);
  if (clampedDtMs <= 0) return { value, velocity };

  const stepLimitMs = fixedStepMs > 0 ? fixedStepMs : FIXED_TIMESTEP_MS;
  let remainingMs = clampedDtMs;
  while (remainingMs > 1e-6) {
    const stepMs = Math.min(remainingMs, stepLimitMs);
    const stepSec = stepMs / 1000;
    const displacement = value - target;
    const acceleration = -stiffness * displacement - damping * velocity;
    velocity += acceleration * stepSec;
    value += velocity * stepSec;
    remainingMs -= stepMs;
  }

  return { value, velocity };
}

/**
 * Evaluates a cubic Bézier curve at parameter t in [0, 1].
 */
export function evaluateBezierPoint(arc, t) {
  const u = clampNumber(t, 0, 1);
  const mt = 1 - u;
  const mt2 = mt * mt;
  const u2 = u * u;
  const p0 = arc.p0;
  const p1 = arc.p1;
  const p2 = arc.p2;
  const p3 = arc.p3;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * u * p1.x + 3 * mt * u2 * p2.x + u2 * u * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * u * p1.y + 3 * mt * u2 * p2.y + u2 * u * p3.y,
  };
}

/**
 * Evaluates the tangent vector and angle (in degrees) of a cubic Bézier arc at t in [0, 1].
 */
export function evaluateBezierTangent(arc, t) {
  const u = clampNumber(t, 0, 1);
  const mt = 1 - u;
  const p0 = arc.p0;
  const p1 = arc.p1;
  const p2 = arc.p2;
  const p3 = arc.p3;
  let dx = 3 * mt * mt * (p1.x - p0.x) + 6 * mt * u * (p2.x - p1.x) + 3 * u * u * (p3.x - p2.x);
  let dy = 3 * mt * mt * (p1.y - p0.y) + 6 * mt * u * (p2.y - p1.y) + 3 * u * u * (p3.y - p2.y);
  if (Math.hypot(dx, dy) < 1e-5) {
    dx = p3.x - p0.x;
    dy = p3.y - p0.y;
  }
  const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { dx, dy, angleDeg };
}

/**
 * Checks whether an entire Bézier arc stays at least `marginPx` inside the viewport.
 */
export function isArcInsideViewport(arc, viewport, marginPx = VIEWPORT_MARGIN_PX, sampleCount = 16) {
  const width = Number.isFinite(viewport?.width) ? viewport.width : 1280;
  const height = Number.isFinite(viewport?.height) ? viewport.height : 800;
  const minX = marginPx;
  const maxX = width - marginPx;
  const minY = marginPx;
  const maxY = height - marginPx;
  if (maxX < minX || maxY < minY) return false;

  const steps = Math.max(4, sampleCount);
  for (let i = 0; i <= steps; i += 1) {
    const point = evaluateBezierPoint(arc, i / steps);
    if (point.x < minX || point.x > maxX || point.y < minY || point.y > maxY) {
      return false;
    }
  }
  return true;
}

/**
 * Selects a path between `start` and `end`.
 * - Short moves (<= 196px): collinear cubic control points (straight line).
 * - Long moves (> 196px): tries up to 20 candidate Bézier arcs varying bend
 *   magnitude and side, keeping the first whose sampled path stays >= 20px
 *   inside the viewport.
 */
export function selectBezierArc(
  start,
  end,
  viewport = { width: 1280, height: 800 },
  {
    thresholdPx = LONG_MOVE_DISTANCE_THRESHOLD_PX,
    candidateCount = BEZIER_CANDIDATE_COUNT,
    marginPx = VIEWPORT_MARGIN_PX,
  } = {},
) {
  const p0 = { x: Number(start?.x) || 0, y: Number(start?.y) || 0 };
  const p3 = { x: Number(end?.x) || 0, y: Number(end?.y) || 0 };
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const distance = Math.hypot(dx, dy);

  const straightArc = {
    p0,
    p1: { x: p0.x + dx / 3, y: p0.y + dy / 3 },
    p2: { x: p0.x + (2 * dx) / 3, y: p0.y + (2 * dy) / 3 },
    p3,
    distance,
    isCurved: false,
    bendSide: 0,
    bendRatio: 0,
    candidateIndex: -1,
  };

  if (distance <= thresholdPx) {
    return straightArc;
  }

  const ux = dx / distance;
  const uy = dy / distance;
  // Perpendicular normal for lateral arc bend.
  const nx = -uy;
  const ny = ux;

  // Deterministic progression of 20 bend ratios + sides so moves try natural
  // moderate arcs on both sides first, then wider or tighter arcs if near an edge.
  const bendMagnitudes = [0.22, 0.28, 0.16, 0.34, 0.12, 0.38, 0.09, 0.25, 0.06, 0.03];
  const maxCandidates = Math.max(1, Math.min(candidateCount, bendMagnitudes.length * 2));
  // Prefer the side facing the viewport center first so arcs naturally curve inward.
  const midX = (p0.x + p3.x) * 0.5;
  const midY = (p0.y + p3.y) * 0.5;
  const vpCenterX = (Number.isFinite(viewport?.width) ? viewport.width : 1280) * 0.5;
  const vpCenterY = (Number.isFinite(viewport?.height) ? viewport.height : 800) * 0.5;
  const dotToCenter = (vpCenterX - midX) * nx + (vpCenterY - midY) * ny;
  const primarySide = dotToCenter >= 0 ? 1 : -1;

  for (let i = 0; i < maxCandidates; i += 1) {
    const magnitude = bendMagnitudes[Math.floor(i / 2)];
    const side = i % 2 === 0 ? primarySide : -primarySide;
    const offset = distance * magnitude * side;
    const t1 = 0.3 + (i % 3) * 0.02;
    const t2 = 0.7 - (i % 3) * 0.02;
    const candidate = {
      p0,
      p1: {
        x: p0.x + dx * t1 + nx * offset,
        y: p0.y + dy * t1 + ny * offset,
      },
      p2: {
        x: p0.x + dx * t2 + nx * offset * 0.85,
        y: p0.y + dy * t2 + ny * offset * 0.85,
      },
      p3,
      distance,
      isCurved: true,
      bendSide: side,
      bendRatio: magnitude,
      candidateIndex: i,
    };

    if (isArcInsideViewport(candidate, viewport, marginPx)) {
      return candidate;
    }
  }

  // Fallback when start or end itself sits within marginPx of the viewport edge:
  // clamp control points inside the safe viewport box so the curve never steps
  // further outside the viewport than the endpoints themselves.
  const width = Number.isFinite(viewport?.width) ? viewport.width : 1280;
  const height = Number.isFinite(viewport?.height) ? viewport.height : 800;
  const safeMinX = Math.min(marginPx, width * 0.5);
  const safeMaxX = Math.max(safeMinX, width - marginPx);
  const safeMinY = Math.min(marginPx, height * 0.5);
  const safeMaxY = Math.max(safeMinY, height - marginPx);
  const fallbackOffset = distance * 0.14 * primarySide;
  return {
    p0,
    p1: {
      x: clampNumber(p0.x + dx * 0.33 + nx * fallbackOffset, safeMinX, safeMaxX),
      y: clampNumber(p0.y + dy * 0.33 + ny * fallbackOffset, safeMinY, safeMaxY),
    },
    p2: {
      x: clampNumber(p0.x + dx * 0.67 + nx * fallbackOffset * 0.85, safeMinX, safeMaxX),
      y: clampNumber(p0.y + dy * 0.67 + ny * fallbackOffset * 0.85, safeMinY, safeMaxY),
    },
    p3,
    distance,
    isCurved: true,
    bendSide: primarySide,
    bendRatio: 0.14,
    candidateIndex: maxCandidates,
  };
}

/**
 * Maps travel distance to arc traversal duration. Shorter distance -> faster.
 */
export function computeMoveDurationMs(distancePx) {
  const d = Math.max(0, Number(distancePx) || 0);
  if (d === 0) return 0;
  return clampNumber(
    MIN_MOVE_DURATION_MS + d / MOVE_SPEED_PX_PER_MS,
    MIN_MOVE_DURATION_MS,
    MAX_MOVE_DURATION_MS,
  );
}

/**
 * Computes the target rotation angle (degrees) for the cursor arrow.
 * - Long curved moves: rotates from the arrow's resting pose (-44 deg relative
 *   to travel) to follow the path tangent, then settles back to 0 deg CSS
 *   rotation (normal pointer pose) on arrival.
 * - Short moves: peaks tilt at mid-move (progress = 0.5) and settles to 0 deg.
 */
export function computeTargetRotationDeg({
  isCurved = false,
  tangentAngleDeg = 0,
  progress = 0,
  restingTiltDeg = RESTING_TILT_DEG,
  shortMoveTiltDeg = SHORT_MOVE_MAX_TILT_DEG,
  directionSign = 1,
} = {}) {
  const p = clampNumber(progress, 0, 1);
  const envelope = Math.sin(Math.PI * p);
  if (isCurved) {
    // Standard pointer artwork points up-left (-134 deg in screen coords, i.e.
    // -44 deg relative to vertical/travel). Rotating by the wrapped delta
    // aligns the arrow with the path tangent mid-flight and settles back to
    // the resting pose (0 deg CSS offset, -44 deg pointer pose) as envelope -> 0.
    const restingPointerScreenAngleDeg = -90 + restingTiltDeg;
    const deltaDeg = wrapAngleDegrees(tangentAngleDeg - restingPointerScreenAngleDeg);
    return deltaDeg * envelope;
  }
  return shortMoveTiltDeg * (directionSign >= 0 ? 1 : -1) * envelope;
}

/**
 * Speed-dependent width narrowing (down to 65% width at high speed) to simulate
 * directional motion blur.
 */
export function computeSpeedNarrowing(
  speedPxPerSec,
  {
    minScaleX = MIN_NARROWING_SCALE_X,
    maxSpeedPxPerSec = MAX_NARROWING_SPEED_PX_PER_SEC,
  } = {},
) {
  const speed = Math.max(0, Number(speedPxPerSec) || 0);
  const ratio = clampNumber(speed / maxSpeedPxPerSec, 0, 1);
  return 1 - ratio * (1 - minScaleX);
}

/**
 * Short-move squash-and-stretch deformation peaking at mid-move (progress = 0.5).
 */
export function computeShortMoveStretch(
  progress,
  { peakStretch = SHORT_MOVE_STRETCH_PEAK } = {},
) {
  const p = clampNumber(progress, 0, 1);
  const bell = Math.sin(Math.PI * p);
  const scaleY = 1 + peakStretch * bell;
  const scaleX = 1 / scaleY;
  return { scaleX, scaleY };
}

/**
 * Arrival predicate: cursor is within ~0.85px of target and has near-zero velocity.
 */
export function hasCursorArrived(
  state,
  target,
  {
    distanceThresholdPx = ARRIVAL_DISTANCE_THRESHOLD_PX,
    velocityThresholdPxPerSec = ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC,
  } = {},
) {
  const dx = (Number(target?.x) || 0) - (Number(state?.x) || 0);
  const dy = (Number(target?.y) || 0) - (Number(state?.y) || 0);
  const distance = Math.hypot(dx, dy);
  const speed = Math.hypot(Number(state?.vx) || 0, Number(state?.vy) || 0);
  return distance <= distanceThresholdPx && speed <= velocityThresholdPxPerSec;
}

/**
 * Idle "thinking" wiggle amplitude ramp: ramps smoothly from 0 deg to 12.5 deg
 * over 1.4s after arrival.
 */
export function computeWiggleAmplitude(
  idleElapsedMs,
  {
    maxAmplitudeDeg = WIGGLE_MAX_AMPLITUDE_DEG,
    rampInMs = WIGGLE_RAMP_IN_MS,
  } = {},
) {
  if (!(idleElapsedMs > 0)) return 0;
  const t = clampNumber(idleElapsedMs / rampInMs, 0, 1);
  const smooth = t * t * (3 - 2 * t);
  return smooth * maxAmplitudeDeg;
}

/**
 * Idle "thinking" wiggle angle at `idleElapsedMs`: +/-12.5 deg rock with 0.66s period.
 */
export function computeWiggleAngleDeg(
  idleElapsedMs,
  {
    maxAmplitudeDeg = WIGGLE_MAX_AMPLITUDE_DEG,
    rampInMs = WIGGLE_RAMP_IN_MS,
    periodMs = WIGGLE_PERIOD_MS,
  } = {},
) {
  const amplitude = computeWiggleAmplitude(idleElapsedMs, { maxAmplitudeDeg, rampInMs });
  if (amplitude === 0) return 0;
  return amplitude * Math.sin((2 * Math.PI * idleElapsedMs) / periodMs);
}

/**
 * Appear/disappear visibility mapping: fade (0 -> 1) + scale (40% -> 100%) +
 * blur (5px -> 0px) together.
 */
export function computeVisibilityEffect(
  visibility,
  {
    initialScale = APPEAR_INITIAL_SCALE,
    initialBlurPx = APPEAR_INITIAL_BLUR_PX,
  } = {},
) {
  const v = clampNumber(Number.isFinite(visibility) ? visibility : 1, 0, 1);
  return {
    opacity: v,
    scale: initialScale + (1 - initialScale) * v,
    blurPx: (1 - v) * initialBlurPx,
  };
}

export const GHOST_CURSOR_SOURCE = String.raw`(() => {
  const CURSOR_ID = '__browserforce_ghost_cursor__';
  const CURSOR_API_KEY = '__browserforceGhostCursor';
  const CURSOR_IMAGE_URL = ${JSON.stringify(CURSOR_IMAGE_URL_MARKER)};
  const FALLBACK_CURSOR_DATA_URL = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">'
    + '<path d="M2 1.5L18.5 10.2L11.2 12.1L8.5 19.5L2 1.5Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>'
    + '</svg>'
  );
  const PRESS_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const PRESS_DURATION_MS = 140;
  const IDLE_HIDE_DELAY_MS = 5000;
  const IDLE_FADE_OUT_MS = 600;
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

  const FIXED_TIMESTEP_MS = ${FIXED_TIMESTEP_MS};
  const MAX_FRAME_DELTA_MS = ${MAX_FRAME_DELTA_MS};
  const POSITION_SPRING_STIFFNESS = ${POSITION_SPRING_STIFFNESS};
  const POSITION_SPRING_DAMPING = ${POSITION_SPRING_DAMPING};
  const ROTATION_SPRING_STIFFNESS = ${ROTATION_SPRING_STIFFNESS};
  const ROTATION_SPRING_DAMPING = ${ROTATION_SPRING_DAMPING};
  const STRETCH_SPRING_STIFFNESS = ${STRETCH_SPRING_STIFFNESS};
  const STRETCH_SPRING_DAMPING = ${STRETCH_SPRING_DAMPING};
  const VISIBILITY_SPRING_STIFFNESS = ${VISIBILITY_SPRING_STIFFNESS};
  const VISIBILITY_SPRING_DAMPING = ${VISIBILITY_SPRING_DAMPING};
  const LONG_MOVE_DISTANCE_THRESHOLD_PX = ${LONG_MOVE_DISTANCE_THRESHOLD_PX};
  const BEZIER_CANDIDATE_COUNT = ${BEZIER_CANDIDATE_COUNT};
  const VIEWPORT_MARGIN_PX = ${VIEWPORT_MARGIN_PX};
  const RESTING_TILT_DEG = ${RESTING_TILT_DEG};
  const SHORT_MOVE_MAX_TILT_DEG = ${SHORT_MOVE_MAX_TILT_DEG};
  const SHORT_MOVE_STRETCH_PEAK = ${SHORT_MOVE_STRETCH_PEAK};
  const MIN_NARROWING_SCALE_X = ${MIN_NARROWING_SCALE_X};
  const MAX_NARROWING_SPEED_PX_PER_SEC = ${MAX_NARROWING_SPEED_PX_PER_SEC};
  const ARRIVAL_DISTANCE_THRESHOLD_PX = ${ARRIVAL_DISTANCE_THRESHOLD_PX};
  const ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC = ${ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC};
  const WIGGLE_MAX_AMPLITUDE_DEG = ${WIGGLE_MAX_AMPLITUDE_DEG};
  const WIGGLE_PERIOD_MS = ${WIGGLE_PERIOD_MS};
  const WIGGLE_RAMP_IN_MS = ${WIGGLE_RAMP_IN_MS};
  const APPEAR_INITIAL_SCALE = ${APPEAR_INITIAL_SCALE};
  const APPEAR_INITIAL_BLUR_PX = ${APPEAR_INITIAL_BLUR_PX};
  const CURSOR_GLOW_COLOR = ${JSON.stringify(CURSOR_GLOW_COLOR)};
  const MIN_MOVE_DURATION_MS = ${MIN_MOVE_DURATION_MS};
  const MAX_MOVE_DURATION_MS = ${MAX_MOVE_DURATION_MS};
  const MOVE_SPEED_PX_PER_MS = ${MOVE_SPEED_PX_PER_MS};

  ${clampNumber.toString()}
  ${wrapAngleDegrees.toString()}
  ${stepSpring.toString()}
  ${evaluateBezierPoint.toString()}
  ${evaluateBezierTangent.toString()}
  ${isArcInsideViewport.toString()}
  ${selectBezierArc.toString()}
  ${computeMoveDurationMs.toString()}
  ${computeTargetRotationDeg.toString()}
  ${computeSpeedNarrowing.toString()}
  ${computeShortMoveStretch.toString()}
  ${hasCursorArrived.toString()}
  ${computeWiggleAmplitude.toString()}
  ${computeWiggleAngleDeg.toString()}
  ${computeVisibilityEffect.toString()}

  // Page.addScriptToEvaluateOnNewDocument runs in every frame of the page,
  // including about:blank and sandboxed iframes where <all_urls> web_accessible_resources
  // loads are denied by Chrome. Only top-level mouse events drive the cursor, so
  // subframes must never mount a cursor element.
  function isSubframe() {
    try {
      return Boolean(window.top && window.top !== window);
    } catch {
      return true;
    }
  }

  // Chrome's <all_urls> pattern in web_accessible_resources only matches http:,
  // https:, ws:, wss:, ftp:, file:, and chrome-extension:. On about:blank, data:,
  // blob:, or opaque ('null') origins, requesting chrome-extension://<id>/assets/ghost-cursor.png
  // logs "Denying load of chrome-extension://<id>/assets/ghost-cursor.png".
  function resolveSafeCursorImageUrl() {
    if (!CURSOR_IMAGE_URL) return '';
    if (!CURSOR_IMAGE_URL.startsWith('chrome-extension://')) return CURSOR_IMAGE_URL;
    const loc = window.location;
    if (!loc) return CURSOR_IMAGE_URL;
    const protocol = loc.protocol || '';
    if (
      protocol === 'about:' ||
      protocol === 'data:' ||
      protocol === 'blob:' ||
      protocol === 'javascript:' ||
      (typeof window.origin === 'string' && window.origin === 'null')
    ) {
      return FALLBACK_CURSOR_DATA_URL;
    }
    return CURSOR_IMAGE_URL;
  }

  function isReducedMotionPreferred() {
    try {
      return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch {
      return false;
    }
  }

  const runtime = {
    outerElement: null,
    innerElement: null,
    labelElement: null,
    labelTextElement: null,
    labelText: '',
    chromeOpacity: '1',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    targetX: 0,
    targetY: 0,
    hasPosition: false,
    pressScale: 1,
    rotation: 0,
    rotationVelocity: 0,
    scaleX: 1,
    scaleXVelocity: 0,
    scaleY: 1,
    scaleYVelocity: 0,
    visibility: 1,
    visibilityVelocity: 0,
    targetVisibility: 1,
    blurPx: 0,
    activeArc: null,
    arcElapsedMs: 0,
    arcDurationMs: 0,
    arrived: true,
    idleWiggleMs: 0,
    lastFrameTimeMs: null,
    rafId: null,
    enabled: false,
    idleHidden: false,
    arrivalWaiters: [],
  };

  let idleHideTimer = null;

  function resolveArrivalWaiters() {
    if (runtime.arrivalWaiters.length === 0) return;
    const waiters = runtime.arrivalWaiters.splice(0, runtime.arrivalWaiters.length);
    for (const resolve of waiters) {
      try {
        resolve({ arrived: true, x: runtime.x, y: runtime.y });
      } catch {
        // Ignore waiter errors
      }
    }
  }

  function waitForArrival(timeoutMs = 0) {
    if (!runtime.enabled || runtime.arrived || isReducedMotionPreferred()) {
      return Promise.resolve({ arrived: true, x: runtime.x, y: runtime.y });
    }
    return new Promise((resolve) => {
      let settled = false;
      let timerId = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        if (timerId !== null) clearTimeout(timerId);
        resolve(value);
      };
      if (timeoutMs > 0) {
        timerId = setTimeout(() => {
          done({ arrived: false, x: runtime.x, y: runtime.y });
        }, timeoutMs);
      }
      runtime.arrivalWaiters.push(done);
    });
  }

  function buildFilterString(blurPx) {
    const baseFilter = 'drop-shadow(0 0 6px ' + CURSOR_GLOW_COLOR + ') drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4))';
    if (blurPx > 0.05) {
      return 'blur(' + Number(blurPx.toFixed(2)) + 'px) ' + baseFilter;
    }
    return baseFilter;
  }

  function applyTranslate() {
    if (!runtime.outerElement) return;
    const tx = Number((runtime.x - MINIMAL_HOTSPOT_X_PX).toFixed(2));
    const ty = Number((runtime.y - MINIMAL_HOTSPOT_Y_PX).toFixed(2));
    runtime.outerElement.style.transform = 'translate3d(' + tx + 'px, ' + ty + 'px, 0)';
  }

  function applyInnerTransformAndFilter() {
    if (!runtime.innerElement) return;
    const visEffect = computeVisibilityEffect(runtime.visibility);
    const effectiveScaleX = runtime.pressScale * runtime.scaleX * visEffect.scale;
    const effectiveScaleY = runtime.pressScale * runtime.scaleY * visEffect.scale;
    const rot = runtime.rotation;

    const isDefaultPose =
      Math.abs(rot) < 0.05 &&
      Math.abs(effectiveScaleX - effectiveScaleY) < 0.005 &&
      Math.abs(visEffect.scale - 1) < 0.005;

    if (isDefaultPose) {
      runtime.innerElement.style.transform = 'scale(' + runtime.pressScale + ')';
    } else {
      runtime.innerElement.style.transform =
        'rotate(' + Number(rot.toFixed(2)) + 'deg) '
        + 'scale(' + Number(effectiveScaleX.toFixed(3)) + ', ' + Number(effectiveScaleY.toFixed(3)) + ')';
    }
    runtime.blurPx = visEffect.blurPx;
    runtime.innerElement.style.filter = buildFilterString(visEffect.blurPx);
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

    const prefix = document.createElement('span');
    applyOverlayReset(prefix);
    prefix.style.display = 'inline';
    prefix.style.font = CHIP_FONT;
    prefix.style.color = CHIP_PREFIX_COLOR;
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

  function bindChipElements() {
    runtime.labelElement = document.getElementById(CHIP_ID);
    runtime.labelTextElement = document.getElementById(AGENT_ID);
  }

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
    outer.style.willChange = 'transform';

    const inner = document.createElement('div');
    inner.style.width = CURSOR_SIZE_PX + 'px';
    inner.style.height = CURSOR_SIZE_PX + 'px';
    inner.style.transformOrigin = MINIMAL_HOTSPOT_X_PX + 'px ' + MINIMAL_HOTSPOT_Y_PX + 'px';
    inner.style.backgroundColor = 'transparent';
    inner.style.backgroundRepeat = 'no-repeat';
    inner.style.backgroundSize = 'contain';
    inner.style.filter = buildFilterString(0);
    inner.style.opacity = '1';

    const resolvedUrl = resolveSafeCursorImageUrl();
    inner.style.backgroundImage = resolvedUrl ? 'url("' + resolvedUrl + '")' : '';
    outer.appendChild(inner);

    runtime.outerElement = outer;
    runtime.innerElement = inner;
    return outer;
  }

  function ensureCursorElement() {
    if (isSubframe()) return null;
    const existing = document.getElementById(CURSOR_ID);
    if (existing) {
      runtime.outerElement = existing;
      runtime.innerElement = existing.firstElementChild || null;
      if (runtime.innerElement) {
        const resolvedUrl = resolveSafeCursorImageUrl();
        if (resolvedUrl) {
          runtime.innerElement.style.backgroundImage = 'url("' + resolvedUrl + '")';
        }
        if (!runtime.innerElement.style.filter) {
          runtime.innerElement.style.filter = buildFilterString(runtime.blurPx);
        }
      }
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

  function cancelAnimationLoop() {
    if (runtime.rafId !== null && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(runtime.rafId);
    }
    runtime.rafId = null;
    runtime.lastFrameTimeMs = null;
  }

  function scheduleAnimationFrame() {
    if (!runtime.enabled || isSubframe() || isReducedMotionPreferred()) return;
    if (runtime.rafId !== null) return;
    if (typeof window.requestAnimationFrame !== 'function') return;
    runtime.rafId = window.requestAnimationFrame((timestampMs) => {
      runtime.rafId = null;
      stepFrame(timestampMs);
    });
  }

  function stepFrame(timestampMs) {
    if (!runtime.enabled) return;
    const nowMs = Number.isFinite(timestampMs) ? timestampMs : FIXED_TIMESTEP_MS;
    const dtMs = runtime.lastFrameTimeMs === null
      ? FIXED_TIMESTEP_MS
      : clampNumber(nowMs - runtime.lastFrameTimeMs, 1, MAX_FRAME_DELTA_MS);
    runtime.lastFrameTimeMs = nowMs;

    // 1. Visibility spring (appear/disappear fade + scale from 40% + blur 5px->0)
    const visStep = stepSpring(
      { value: runtime.visibility, velocity: runtime.visibilityVelocity },
      runtime.targetVisibility,
      {
        stiffness: VISIBILITY_SPRING_STIFFNESS,
        damping: VISIBILITY_SPRING_DAMPING,
        dtMs,
      },
    );
    runtime.visibility = clampNumber(visStep.value, 0, 1);
    runtime.visibilityVelocity = visStep.velocity;
    const visEffect = computeVisibilityEffect(runtime.visibility);
    setChromeOpacity(String(Number(visEffect.opacity.toFixed(3))), 0);

    // 2. Position & path tracking
    let progress = 1;
    let guideX = runtime.targetX;
    let guideY = runtime.targetY;
    let tangentAngleDeg = 0;
    const arc = runtime.activeArc;

    if (arc && !runtime.arrived) {
      runtime.arcElapsedMs += dtMs;
      progress = runtime.arcDurationMs > 0
        ? clampNumber(runtime.arcElapsedMs / runtime.arcDurationMs, 0, 1)
        : 1;
      const point = evaluateBezierPoint(arc, progress);
      const tangent = evaluateBezierTangent(arc, progress);
      guideX = point.x;
      guideY = point.y;
      tangentAngleDeg = tangent.angleDeg;
    }

    const xStep = stepSpring(
      { value: runtime.x, velocity: runtime.vx },
      guideX,
      { stiffness: POSITION_SPRING_STIFFNESS, damping: POSITION_SPRING_DAMPING, dtMs },
    );
    const yStep = stepSpring(
      { value: runtime.y, velocity: runtime.vy },
      guideY,
      { stiffness: POSITION_SPRING_STIFFNESS, damping: POSITION_SPRING_DAMPING, dtMs },
    );
    runtime.x = xStep.value;
    runtime.vx = xStep.velocity;
    runtime.y = yStep.value;
    runtime.vy = yStep.velocity;

    const speed = Math.hypot(runtime.vx, runtime.vy);
    const arrivedNow = progress >= 1 && hasCursorArrived(
      { x: runtime.x, y: runtime.y, vx: runtime.vx, vy: runtime.vy },
      { x: runtime.targetX, y: runtime.targetY },
    );

    if (arrivedNow && !runtime.arrived) {
      runtime.arrived = true;
      runtime.x = runtime.targetX;
      runtime.y = runtime.targetY;
      runtime.vx = 0;
      runtime.vy = 0;
      runtime.idleWiggleMs = 0;
      resolveArrivalWaiters();
    }

    // 3. Target rotation & stretch/narrowing
    let targetRotation = 0;
    let targetScaleX = 1;
    let targetScaleY = 1;

    if (!runtime.arrived && arc) {
      const directionSign = (arc.p3.x - arc.p0.x) >= 0 ? 1 : -1;
      targetRotation = computeTargetRotationDeg({
        isCurved: arc.isCurved,
        tangentAngleDeg,
        progress,
        directionSign,
      });
      const narrowing = computeSpeedNarrowing(speed);
      if (arc.isCurved) {
        targetScaleX = narrowing;
        targetScaleY = 1;
      } else {
        const stretch = computeShortMoveStretch(progress);
        targetScaleX = Math.min(narrowing, stretch.scaleX);
        targetScaleY = stretch.scaleY;
      }
    } else if (runtime.arrived && !runtime.idleHidden && !isReducedMotionPreferred()) {
      runtime.idleWiggleMs += dtMs;
      targetRotation = computeWiggleAngleDeg(runtime.idleWiggleMs);
    }

    const rotStep = stepSpring(
      { value: runtime.rotation, velocity: runtime.rotationVelocity },
      targetRotation,
      { stiffness: ROTATION_SPRING_STIFFNESS, damping: ROTATION_SPRING_DAMPING, dtMs },
    );
    runtime.rotation = rotStep.value;
    runtime.rotationVelocity = rotStep.velocity;

    const sxStep = stepSpring(
      { value: runtime.scaleX, velocity: runtime.scaleXVelocity },
      targetScaleX,
      { stiffness: STRETCH_SPRING_STIFFNESS, damping: STRETCH_SPRING_DAMPING, dtMs },
    );
    const syStep = stepSpring(
      { value: runtime.scaleY, velocity: runtime.scaleYVelocity },
      targetScaleY,
      { stiffness: STRETCH_SPRING_STIFFNESS, damping: STRETCH_SPRING_DAMPING, dtMs },
    );
    runtime.scaleX = sxStep.value;
    runtime.scaleXVelocity = sxStep.velocity;
    runtime.scaleY = syStep.value;
    runtime.scaleYVelocity = syStep.velocity;

    applyTranslate();
    applyInnerTransformAndFilter();

    const visibilitySettled =
      Math.abs(runtime.visibility - runtime.targetVisibility) < 0.005 &&
      Math.abs(runtime.visibilityVelocity) < 0.05;

    if (!runtime.arrived || !runtime.idleHidden || !visibilitySettled) {
      scheduleAnimationFrame();
    }
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
      runtime.targetVisibility = 0;
      runtime.visibility = 0;
      runtime.rotation = 0;
      runtime.rotationVelocity = 0;
      setChromeOpacity('0', IDLE_FADE_OUT_MS);
      applyInnerTransformAndFilter();
      scheduleAnimationFrame();
    }, IDLE_HIDE_DELAY_MS);
  }

  function wakeFromIdle(action) {
    runtime.x = action.x;
    runtime.y = action.y;
    runtime.vx = 0;
    runtime.vy = 0;
    runtime.targetX = action.x;
    runtime.targetY = action.y;
    runtime.hasPosition = false;
    runtime.idleHidden = false;
    runtime.visibility = isReducedMotionPreferred() ? 1 : APPEAR_INITIAL_SCALE;
    runtime.targetVisibility = 1;
    setChromeOpacity('1', PRESS_DURATION_MS);
    runtime.visibility = 1;
    applyInnerTransformAndFilter();
  }

  function moveCursor(action) {
    if (!runtime.enabled) return;
    ensureCursorElement();
    if (!runtime.outerElement) return;

    runtime.idleWiggleMs = 0;

    if (!runtime.hasPosition || isReducedMotionPreferred()) {
      runtime.x = action.x;
      runtime.y = action.y;
      runtime.vx = 0;
      runtime.vy = 0;
      runtime.targetX = action.x;
      runtime.targetY = action.y;
      runtime.rotation = 0;
      runtime.rotationVelocity = 0;
      runtime.scaleX = 1;
      runtime.scaleY = 1;
      runtime.activeArc = null;
      runtime.arcElapsedMs = 0;
      runtime.arcDurationMs = 0;
      runtime.hasPosition = true;
      runtime.arrived = true;
      applyTranslate();
      applyInnerTransformAndFilter();
      resolveArrivalWaiters();
      if (!isReducedMotionPreferred()) scheduleAnimationFrame();
      return;
    }

    const distance = Math.hypot(action.x - runtime.x, action.y - runtime.y);
    if (distance <= ARRIVAL_DISTANCE_THRESHOLD_PX && Math.hypot(runtime.vx, runtime.vy) <= ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC) {
      runtime.x = action.x;
      runtime.y = action.y;
      runtime.targetX = action.x;
      runtime.targetY = action.y;
      runtime.arrived = true;
      applyTranslate();
      applyInnerTransformAndFilter();
      resolveArrivalWaiters();
      scheduleAnimationFrame();
      return;
    }

    // Start the new arc from the current live position while preserving (vx, vy)
    // so retargeting mid-flight bends smoothly toward the new target with no jump.
    const viewport = {
      width: Number(window.innerWidth) || 1280,
      height: Number(window.innerHeight) || 800,
    };
    const arc = selectBezierArc(
      { x: runtime.x, y: runtime.y },
      { x: action.x, y: action.y },
      viewport,
    );
    runtime.targetX = action.x;
    runtime.targetY = action.y;
    runtime.activeArc = arc;
    runtime.arcElapsedMs = 0;
    runtime.arcDurationMs = computeMoveDurationMs(arc.distance);
    runtime.arrived = false;
    runtime.hasPosition = true;

    // When requestAnimationFrame is unavailable (e.g. basic synchronous DOM tests),
    // update outer position immediately so non-rAF callers still observe the move.
    if (typeof window.requestAnimationFrame !== 'function') {
      runtime.x = action.x;
      runtime.y = action.y;
      runtime.vx = 0;
      runtime.vy = 0;
      runtime.arrived = true;
      applyTranslate();
      applyInnerTransformAndFilter();
      resolveArrivalWaiters();
      return;
    }

    scheduleAnimationFrame();
  }

  function setPressed(isPressed) {
    if (!runtime.enabled || !runtime.innerElement) return;
    runtime.pressScale = isPressed ? 0.95 : 1;
    runtime.targetVisibility = 1;
    runtime.visibility = 1;
    setChromeOpacity('1', PRESS_DURATION_MS);
    applyInnerTransformAndFilter();
  }

  function beginAppearTransition() {
    runtime.visibility = APPEAR_INITIAL_SCALE;
    runtime.visibilityVelocity = 0;
    runtime.targetVisibility = 1;
    applyInnerTransformAndFilter();
    scheduleAnimationFrame();
  }

  function beginDisappearTransition() {
    runtime.targetVisibility = 0;
    scheduleAnimationFrame();
  }

  function getState() {
    return {
      x: runtime.x,
      y: runtime.y,
      vx: runtime.vx,
      vy: runtime.vy,
      targetX: runtime.targetX,
      targetY: runtime.targetY,
      rotation: runtime.rotation,
      scaleX: runtime.scaleX,
      scaleY: runtime.scaleY,
      pressScale: runtime.pressScale,
      visibility: runtime.visibility,
      targetVisibility: runtime.targetVisibility,
      blurPx: runtime.blurPx,
      arrived: runtime.arrived,
      isLongMove: Boolean(runtime.activeArc?.isCurved),
      idleWiggleMs: runtime.idleWiggleMs,
    };
  }

  function enable() {
    if (isSubframe()) return;
    runtime.enabled = true;
    ensureCursorElement();
    runtime.idleHidden = false;
    runtime.visibility = 1;
    runtime.targetVisibility = 1;
    setChromeOpacity('1', PRESS_DURATION_MS);
    applyTranslate();
    applyInnerTransformAndFilter();
    scheduleIdleHide();
  }

  function disable() {
    runtime.enabled = false;
    runtime.hasPosition = false;
    runtime.idleHidden = false;
    runtime.pressScale = 1;
    runtime.rotation = 0;
    runtime.rotationVelocity = 0;
    runtime.scaleX = 1;
    runtime.scaleY = 1;
    runtime.visibility = 1;
    runtime.targetVisibility = 1;
    runtime.blurPx = 0;
    runtime.activeArc = null;
    runtime.arrived = true;
    runtime.idleWiggleMs = 0;
    runtime.labelText = '';
    runtime.chromeOpacity = '1';
    cancelAnimationLoop();
    clearIdleHideTimer();
    resolveArrivalWaiters();
    if (runtime.outerElement) runtime.outerElement.remove();
    runtime.outerElement = null;
    runtime.innerElement = null;
    runtime.labelElement = null;
    runtime.labelTextElement = null;
  }

  function applyMouseAction(action) {
    if (!runtime.enabled || isSubframe()) return Promise.resolve({ arrived: false, x: runtime.x, y: runtime.y });
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
    return waitForArrival();
  }

  globalThis[CURSOR_API_KEY] = {
    enable,
    disable,
    applyMouseAction,
    waitForArrival,
    stepFrame,
    getState,
    beginAppearTransition,
    beginDisappearTransition,
  };
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
