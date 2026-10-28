const CURSOR_ID = '__browserforce_ghost_cursor__';
const CURSOR_API_KEY = '__browserforceGhostCursor';
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

export const CURSOR_SIZE_PX = 24;
export const CURSOR_TIP_X_PX = 12;
export const CURSOR_TIP_Y_PX = 1.6;
export const CURSOR_ARROW_PATH = 'M12.82 3.42 L18.53 16.03 Q19.60 18.40 17.26 17.26 L13.44 15.40 Q12.00 14.70 10.56 15.40 L6.74 17.26 Q4.40 18.40 5.47 16.03 L11.18 3.42 Q12.00 1.60 12.82 3.42 Z';
export const CURSOR_GLOW_FILTER = 'drop-shadow(0 0 6px rgba(51,156,255,.9)) drop-shadow(0 0 15px rgba(51,156,255,.48))';

export function computeCursorTransform(x, y, rotationDeg, scaleX = 1, scaleY = 1) {
  return {
    translateX: x - CURSOR_TIP_X_PX,
    translateY: y - CURSOR_TIP_Y_PX,
    transformOrigin: CURSOR_TIP_X_PX + 'px ' + CURSOR_TIP_Y_PX + 'px',
    transform: 'rotate(' + rotationDeg + 'deg) scale(' + scaleX + ', ' + scaleY + ')',
  };
}

export const FIXED_TIMESTEP_SEC = 1 / 240;
export const FIXED_TIMESTEP_MS = 1000 * FIXED_TIMESTEP_SEC;
export const MAX_FRAME_DELTA_MS = 1000;
const TIMESTEP_EPSILON_MS = 1e-7;
export const SPRING_REST_THRESHOLD = 0.06;
export const SPRING_REST_ERROR_RATIO = 0.01;
export const SPRING_CHANNELS = Object.freeze({
  position: { response: 0.19, dampingFraction: 0.90 },
  rotation: { response: 0.12, dampingFraction: 0.90 },
  tilt: { response: 0.055, dampingFraction: 0.82 },
  squash: { response: 0.12, dampingFraction: 0.86 },
  stretch: { response: 0.20, dampingFraction: 0.85 },
  visibility: { response: 0.42, dampingFraction: 0.86 },
  shortProgress: { response: 0.19, dampingFraction: 0.94 },
  longProgress: { dampingFraction: 0.90 },
});
export const LONG_MOVE_DISTANCE_THRESHOLD_PX = 196;
export const BEZIER_CANDIDATE_COUNT = 20;
export const PATH_SAMPLE_COUNT = 24;
export const VIEWPORT_MARGIN_PX = 20;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
export const RESTING_TILT_DEG = -44;
export const START_HANDLE_RATIO = 0.42;
export const END_HANDLE_RATIO = 0.15;
export const MIN_HANDLE_PX = 48;
export const MAX_HANDLE_PX = 640;
export const MAX_HANDLE_CHORD_RATIO = 0.9;
export const ARC_BEND_RATIO = 0.28;
export const MIN_ARC_BEND_PX = 50;
export const MAX_ARC_BEND_PX = 520;
export const ARC_BEND_OFFSETS = [0.55, 0.8, 1.05];
export const ARC_HANDLE_SCALES = [0.65, 1, 1.35];
export const SINGLE_HANDLE_SCALES = [1, 0.65];
export const ARC_MIDDLE_HANDLE_RATIO = 0.25;
export const PATH_SCORE_WEIGHTS = { excess: 320, angleSquared: 140, maxTurn: 180, totalTurn: 18, opposition: 90, arc: 45 };
export const PATH_RESPONSE = { base: 0.42, distance: 0.22, curviness: 0.12, opposition: 0.28, multiplier: 0.7,
  distanceStart: 180, distanceRange: 760, min: 0.12, max: 2.2 };
export const PATH_FOLLOW_RESPONSE_RATIO = 0.18;
export const MIN_FOLLOW_RESPONSE_SEC = 0.035;
export const MAX_FOLLOW_RESPONSE_SEC = 0.12;
export const MIN_NARROWING_SCALE_X = 0.65;
export const NARROWING_SPEED_PX_PER_SEC = 5500;
export const SHORT_MOVE_MAX_TILT_DEG = 70;
export const SHORT_TILT_X_WEIGHT = 0.75;
export const SHORT_TILT_Y_WEIGHT = -0.62;
export const SHORT_MOVE_SQUASH_DEPTH = 0.15;
export const ARRIVAL_DISTANCE_THRESHOLD_PX = 0.85;
export const ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC = 12;
export const ARRIVAL_PROGRESS_THRESHOLD = 0.999;
export const ARRIVAL_PROGRESS_VELOCITY_THRESHOLD = 0.01;
export const WIGGLE_MAX_AMPLITUDE_DEG = 12.5;
export const WIGGLE_PERIOD_MS = 660;
export const WIGGLE_DURATION_MS = 1410;
export const APPEAR_INITIAL_SCALE = 0.4;
export const APPEAR_INITIAL_BLUR_PX = 5;
export const CLICK_SYNC_MAX_WAIT_MS = 1500;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wrapAngleDegrees(angleDeg) {
  return ((angleDeg + 180) % 360 + 360) % 360 - 180;
}

export function computeSpringParameters(response, dampingFraction) {
  const stiffness = (2 * Math.PI / response) ** 2;
  return { stiffness, damping: 2 * Math.sqrt(stiffness) * dampingFraction };
}

export function stepSpring(state, target, {
  response = SPRING_CHANNELS.position.response,
  dampingFraction = SPRING_CHANNELS.position.dampingFraction,
  dtMs = FIXED_TIMESTEP_MS,
} = {}) {
  let { value, velocity } = state;
  const { stiffness, damping } = computeSpringParameters(response, dampingFraction);
  let remainingMs = clampNumber(dtMs, 0, MAX_FRAME_DELTA_MS);
  while (remainingMs > 0) {
    const stepMs = Math.min(remainingMs, FIXED_TIMESTEP_MS);
    const dt = stepMs / 1000;
    const force = stiffness * (target - value) - damping * velocity;
    velocity += force * dt;
    value += velocity * dt;
    remainingMs = Math.max(0, remainingMs - stepMs);
  }
  const force = stiffness * (target - value) - damping * velocity;
  if (Math.abs(velocity) <= SPRING_REST_THRESHOLD && Math.abs(force) <= SPRING_REST_THRESHOLD &&
    Math.abs(target - value) <= SPRING_REST_ERROR_RATIO * Math.max(1, Math.abs(target))) {
    return { value: target, velocity: 0 };
  }
  return { value, velocity };
}

export function evaluateBezierPoint(arc, t) {
  if (arc.segments) {
    const scaled = clampNumber(t, 0, 1) * arc.segments.length;
    const index = Math.min(Math.floor(scaled), arc.segments.length - 1);
    return evaluateBezierPoint(arc.segments[index], scaled - index);
  }
  const u = clampNumber(t, 0, 1);
  const v = 1 - u;
  return {
    x: v ** 3 * arc.p0.x + 3 * v ** 2 * u * arc.p1.x + 3 * v * u ** 2 * arc.p2.x + u ** 3 * arc.p3.x,
    y: v ** 3 * arc.p0.y + 3 * v ** 2 * u * arc.p1.y + 3 * v * u ** 2 * arc.p2.y + u ** 3 * arc.p3.y,
  };
}

export function evaluateBezierTangent(arc, t) {
  if (arc.segments) {
    const scaled = clampNumber(t, 0, 1) * arc.segments.length;
    const index = Math.min(Math.floor(scaled), arc.segments.length - 1);
    return evaluateBezierTangent(arc.segments[index], scaled - index);
  }
  const u = clampNumber(t, 0, 1);
  const v = 1 - u;
  let dx = 3 * v * v * (arc.p1.x - arc.p0.x) + 6 * v * u * (arc.p2.x - arc.p1.x) + 3 * u * u * (arc.p3.x - arc.p2.x);
  let dy = 3 * v * v * (arc.p1.y - arc.p0.y) + 6 * v * u * (arc.p2.y - arc.p1.y) + 3 * u * u * (arc.p3.y - arc.p2.y);
  if (dx === 0 && dy === 0) {
    dx = arc.p3.x - arc.p0.x;
    dy = arc.p3.y - arc.p0.y;
  }
  return { dx, dy, angleDeg: Math.atan2(dy, dx) * 180 / Math.PI };
}

function samplePath(arc) {
  const segments = arc.segments || [arc];
  const points = [segments[0].p0];
  for (const segment of segments) {
    for (let i = 1; i <= PATH_SAMPLE_COUNT; i += 1) points.push(evaluateBezierPoint(segment, i / PATH_SAMPLE_COUNT));
  }
  return points;
}

export function isArcInsideViewport(arc, viewport = DEFAULT_VIEWPORT, marginPx = VIEWPORT_MARGIN_PX) {
  return samplePath(arc).every(({ x, y }) => x >= marginPx && x <= viewport.width - marginPx &&
    y >= marginPx && y <= viewport.height - marginPx);
}

export function computeDirectionOpposition(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (!chord) return 0;
  const angle = (RESTING_TILT_DEG - 90) * Math.PI / 180;
  return clampNumber((1 - (dx * Math.cos(angle) + dy * Math.sin(angle)) / chord) / 2, 0, 1);
}

export function scoreBezierPath(arc) {
  const points = samplePath(arc);
  let length = 0;
  let lastAngle = null;
  let totalTurn = 0;
  let angleSquared = 0;
  let maxTurn = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const segmentLength = Math.hypot(dx, dy);
    length += segmentLength;
    if (!segmentLength) continue;
    const angle = Math.atan2(dy, dx);
    if (lastAngle !== null) {
      const turn = Math.abs(wrapAngleDegrees((angle - lastAngle) * 180 / Math.PI) * Math.PI / 180);
      totalTurn += turn;
      angleSquared += turn * turn;
      maxTurn = Math.max(maxTurn, turn);
    }
    lastAngle = angle;
  }
  const chord = Math.hypot(arc.p3.x - arc.p0.x, arc.p3.y - arc.p0.y);
  const excess = chord ? Math.max(0, length / chord - 1) : 0;
  const opposition = computeDirectionOpposition(arc.p0, arc.p3);
  const weights = PATH_SCORE_WEIGHTS;
  const score = length + weights.excess * excess + weights.angleSquared * angleSquared + weights.maxTurn * maxTurn +
    weights.totalTurn * totalTurn + weights.opposition * opposition + (arc.segments ? weights.arc : 0);
  // Both extra travel and direction changes slow a path; either can saturate curviness.
  const curviness = clampNumber(excess + totalTurn / (2 * Math.PI), 0, 1);
  return { score, length, chord, excess, totalTurn, angleSquared, maxTurn, opposition, curviness };
}

export function generateBezierCandidates(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  const ux = distance ? dx / distance : 1;
  const uy = distance ? dy / distance : 0;
  const restingAngle = (RESTING_TILT_DEG - 90) * Math.PI / 180;
  const rx = Math.cos(restingAngle);
  const ry = Math.sin(restingAngle);
  const startHandle = Math.min(clampNumber(START_HANDLE_RATIO * distance, MIN_HANDLE_PX, MAX_HANDLE_PX), MAX_HANDLE_CHORD_RATIO * distance);
  const endHandle = Math.min(clampNumber(END_HANDLE_RATIO * distance, MIN_HANDLE_PX, MAX_HANDLE_PX), MAX_HANDLE_CHORD_RATIO * distance);
  const offsetPoint = (point, x, y, amount) => ({ x: point.x + x * amount, y: point.y + y * amount });
  const candidates = SINGLE_HANDLE_SCALES.map((scale) => ({ p0: start,
    p1: offsetPoint(start, rx, ry, startHandle * scale),
    p2: offsetPoint(end, rx, ry, -endHandle * scale), p3: end, distance, isCurved: true }));
  const bend = clampNumber(ARC_BEND_RATIO * distance, MIN_ARC_BEND_PX, MAX_ARC_BEND_PX);
  for (const bendOffset of ARC_BEND_OFFSETS) {
    for (const scale of ARC_HANDLE_SCALES) {
      for (const side of [-1, 1]) {
        const middle = { x: (start.x + end.x) / 2 - uy * bend * bendOffset * side,
          y: (start.y + end.y) / 2 + ux * bend * bendOffset * side };
        const middleHandle = ARC_MIDDLE_HANDLE_RATIO * distance * scale;
        const p1 = offsetPoint(start, rx, ry, Math.min(startHandle * scale, MAX_HANDLE_CHORD_RATIO * distance));
        const p2 = offsetPoint(end, rx, ry, -Math.min(endHandle * scale, MAX_HANDLE_CHORD_RATIO * distance));
        candidates.push({ p0: start, p3: end, distance, isCurved: true, segments: [
          { p0: start, p1, p2: offsetPoint(middle, ux, uy, -middleHandle), p3: middle },
          { p0: middle, p1: offsetPoint(middle, ux, uy, middleHandle), p2, p3: end },
        ] });
      }
    }
  }
  return candidates.map((candidate, candidateIndex) => ({ ...candidate, candidateIndex }));
}

export function selectBezierArc(start, end, viewport = DEFAULT_VIEWPORT) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= LONG_MOVE_DISTANCE_THRESHOLD_PX) {
    return { p0: start, p1: { x: start.x + dx / 3, y: start.y + dy / 3 },
      p2: { x: end.x - dx / 3, y: end.y - dy / 3 }, p3: end, distance, isCurved: false };
  }
  const candidates = generateBezierCandidates(start, end).map((candidate) => ({ ...candidate, ...scoreBezierPath(candidate) }));
  const safe = candidates.filter((candidate) => isArcInsideViewport(candidate, viewport));
  return (safe.length ? safe : candidates).reduce((best, candidate) => candidate.score < best.score ? candidate : best);
}

export function computePathResponse(length, curviness, opposition) {
  const tuning = PATH_RESPONSE;
  const r = clampNumber((length - tuning.distanceStart) / tuning.distanceRange, 0, 1);
  return clampNumber((tuning.base + tuning.distance * r + tuning.curviness * clampNumber(curviness, 0, 1) +
    tuning.opposition * clampNumber(opposition, 0, 1)) * tuning.multiplier, tuning.min, tuning.max);
}

export function computeFollowResponse(pathResponse) {
  return clampNumber(pathResponse * PATH_FOLLOW_RESPONSE_RATIO, MIN_FOLLOW_RESPONSE_SEC, MAX_FOLLOW_RESPONSE_SEC);
}

export function computeTargetRotationDeg({ isCurved = false, tangentAngleDeg = 0, arrived = false,
  currentRotationDeg = RESTING_TILT_DEG } = {}) {
  const target = isCurved && !arrived ? tangentAngleDeg + 90 : RESTING_TILT_DEG;
  return currentRotationDeg + wrapAngleDegrees(target - currentRotationDeg);
}

export function computeSpeedNarrowing(speedPxPerSec) {
  return clampNumber(1 - Math.max(0, speedPxPerSec) / NARROWING_SPEED_PX_PER_SEC, MIN_NARROWING_SCALE_X, 1);
}

export function computeShortMoveTilt(progress, ux, uy) {
  return clampNumber(SHORT_TILT_X_WEIGHT * ux + SHORT_TILT_Y_WEIGHT * uy, -1, 1) *
    SHORT_MOVE_MAX_TILT_DEG * Math.sin(Math.PI * clampNumber(progress, 0, 1));
}

export function computeShortMoveSquash(progress) {
  return 1 - SHORT_MOVE_SQUASH_DEPTH * Math.sin(Math.PI * clampNumber(progress, 0, 1));
}

export function hasCursorArrived(state, target) {
  return state.progress >= ARRIVAL_PROGRESS_THRESHOLD && Math.abs(state.progressVelocity) < ARRIVAL_PROGRESS_VELOCITY_THRESHOLD &&
    Math.hypot(target.x - state.x, target.y - state.y) <= ARRIVAL_DISTANCE_THRESHOLD_PX &&
    Math.abs(state.vx) <= ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC && Math.abs(state.vy) <= ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC;
}

export function computeWiggleAngleDeg(elapsedMs) {
  if (elapsedMs <= 0 || elapsedMs >= WIGGLE_DURATION_MS) return 0;
  return WIGGLE_MAX_AMPLITUDE_DEG * Math.sin(Math.PI * elapsedMs / WIGGLE_DURATION_MS) *
    Math.sin(2 * Math.PI * elapsedMs / WIGGLE_PERIOD_MS);
}

export function computeVisibilityEffect(visibility) {
  const v = clampNumber(visibility, 0, 1);
  return { opacity: v, scale: APPEAR_INITIAL_SCALE + (1 - APPEAR_INITIAL_SCALE) * v,
    blurPx: APPEAR_INITIAL_BLUR_PX * (1 - v) };
}

export const GHOST_CURSOR_SOURCE = String.raw`(() => {
  const CURSOR_ID = '__browserforce_ghost_cursor__';
  const CURSOR_API_KEY = '__browserforceGhostCursor';
  const PRESS_EASING = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const PRESS_SCALE = 0.95;
  const IDLE_HIDE_DELAY_MS = 5000;
  const CURSOR_SIZE_PX = ${CURSOR_SIZE_PX};
  const CURSOR_TIP_X_PX = ${CURSOR_TIP_X_PX};
  const CURSOR_TIP_Y_PX = ${CURSOR_TIP_Y_PX};
  const CURSOR_ARROW_PATH = ${JSON.stringify(CURSOR_ARROW_PATH)};
  const CURSOR_GLOW_FILTER = ${JSON.stringify(CURSOR_GLOW_FILTER)};
  ${computeCursorTransform.toString()}
  const CURSOR_Z_INDEX = 2147483647;
  const CHIP_ID = '__browserforce_ghost_cursor_label__';
  const AGENT_ID = '__browserforce_ghost_cursor_agent__';
  const CHIP_PREFIX_TEXT = 'BrowserForce \u00B7';
  const CHIP_PREFIX_GAP_PX = 4;
  const CHIP_OFFSET_X_PX = CURSOR_TIP_X_PX + 18;
  const CHIP_OFFSET_Y_PX = CURSOR_TIP_Y_PX + 20;
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

  const FIXED_TIMESTEP_SEC = ${JSON.stringify(FIXED_TIMESTEP_SEC)};
  const FIXED_TIMESTEP_MS = ${JSON.stringify(FIXED_TIMESTEP_MS)};
  const MAX_FRAME_DELTA_MS = ${JSON.stringify(MAX_FRAME_DELTA_MS)};
  const TIMESTEP_EPSILON_MS = ${TIMESTEP_EPSILON_MS};
  const SPRING_REST_THRESHOLD = ${JSON.stringify(SPRING_REST_THRESHOLD)};
  const SPRING_REST_ERROR_RATIO = ${JSON.stringify(SPRING_REST_ERROR_RATIO)};
  const SPRING_CHANNELS = ${JSON.stringify(SPRING_CHANNELS)};
  const LONG_MOVE_DISTANCE_THRESHOLD_PX = ${JSON.stringify(LONG_MOVE_DISTANCE_THRESHOLD_PX)};
  const BEZIER_CANDIDATE_COUNT = ${JSON.stringify(BEZIER_CANDIDATE_COUNT)};
  const PATH_SAMPLE_COUNT = ${JSON.stringify(PATH_SAMPLE_COUNT)};
  const VIEWPORT_MARGIN_PX = ${JSON.stringify(VIEWPORT_MARGIN_PX)};
  const DEFAULT_VIEWPORT = ${JSON.stringify(DEFAULT_VIEWPORT)};
  const RESTING_TILT_DEG = ${JSON.stringify(RESTING_TILT_DEG)};
  const START_HANDLE_RATIO = ${JSON.stringify(START_HANDLE_RATIO)};
  const END_HANDLE_RATIO = ${JSON.stringify(END_HANDLE_RATIO)};
  const MIN_HANDLE_PX = ${JSON.stringify(MIN_HANDLE_PX)};
  const MAX_HANDLE_PX = ${JSON.stringify(MAX_HANDLE_PX)};
  const MAX_HANDLE_CHORD_RATIO = ${JSON.stringify(MAX_HANDLE_CHORD_RATIO)};
  const ARC_BEND_RATIO = ${JSON.stringify(ARC_BEND_RATIO)};
  const MIN_ARC_BEND_PX = ${JSON.stringify(MIN_ARC_BEND_PX)};
  const MAX_ARC_BEND_PX = ${JSON.stringify(MAX_ARC_BEND_PX)};
  const ARC_BEND_OFFSETS = ${JSON.stringify(ARC_BEND_OFFSETS)};
  const ARC_HANDLE_SCALES = ${JSON.stringify(ARC_HANDLE_SCALES)};
  const SINGLE_HANDLE_SCALES = ${JSON.stringify(SINGLE_HANDLE_SCALES)};
  const ARC_MIDDLE_HANDLE_RATIO = ${JSON.stringify(ARC_MIDDLE_HANDLE_RATIO)};
  const PATH_SCORE_WEIGHTS = ${JSON.stringify(PATH_SCORE_WEIGHTS)};
  const PATH_RESPONSE = ${JSON.stringify(PATH_RESPONSE)};
  const PATH_FOLLOW_RESPONSE_RATIO = ${JSON.stringify(PATH_FOLLOW_RESPONSE_RATIO)};
  const MIN_FOLLOW_RESPONSE_SEC = ${JSON.stringify(MIN_FOLLOW_RESPONSE_SEC)};
  const MAX_FOLLOW_RESPONSE_SEC = ${JSON.stringify(MAX_FOLLOW_RESPONSE_SEC)};
  const MIN_NARROWING_SCALE_X = ${JSON.stringify(MIN_NARROWING_SCALE_X)};
  const NARROWING_SPEED_PX_PER_SEC = ${JSON.stringify(NARROWING_SPEED_PX_PER_SEC)};
  const SHORT_MOVE_MAX_TILT_DEG = ${JSON.stringify(SHORT_MOVE_MAX_TILT_DEG)};
  const SHORT_TILT_X_WEIGHT = ${JSON.stringify(SHORT_TILT_X_WEIGHT)};
  const SHORT_TILT_Y_WEIGHT = ${JSON.stringify(SHORT_TILT_Y_WEIGHT)};
  const SHORT_MOVE_SQUASH_DEPTH = ${JSON.stringify(SHORT_MOVE_SQUASH_DEPTH)};
  const ARRIVAL_DISTANCE_THRESHOLD_PX = ${JSON.stringify(ARRIVAL_DISTANCE_THRESHOLD_PX)};
  const ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC = ${JSON.stringify(ARRIVAL_VELOCITY_THRESHOLD_PX_PER_SEC)};
  const ARRIVAL_PROGRESS_THRESHOLD = ${JSON.stringify(ARRIVAL_PROGRESS_THRESHOLD)};
  const ARRIVAL_PROGRESS_VELOCITY_THRESHOLD = ${JSON.stringify(ARRIVAL_PROGRESS_VELOCITY_THRESHOLD)};
  const WIGGLE_MAX_AMPLITUDE_DEG = ${JSON.stringify(WIGGLE_MAX_AMPLITUDE_DEG)};
  const WIGGLE_PERIOD_MS = ${JSON.stringify(WIGGLE_PERIOD_MS)};
  const WIGGLE_DURATION_MS = ${JSON.stringify(WIGGLE_DURATION_MS)};
  const APPEAR_INITIAL_SCALE = ${JSON.stringify(APPEAR_INITIAL_SCALE)};
  const APPEAR_INITIAL_BLUR_PX = ${JSON.stringify(APPEAR_INITIAL_BLUR_PX)};
  const CLICK_SYNC_MAX_WAIT_MS = ${JSON.stringify(CLICK_SYNC_MAX_WAIT_MS)};

  ${clampNumber.toString()}
  ${wrapAngleDegrees.toString()}
  ${computeSpringParameters.toString()}
  ${stepSpring.toString()}
  ${evaluateBezierPoint.toString()}
  ${evaluateBezierTangent.toString()}
  ${samplePath.toString()}
  ${isArcInsideViewport.toString()}
  ${computeDirectionOpposition.toString()}
  ${scoreBezierPath.toString()}
  ${generateBezierCandidates.toString()}
  ${selectBezierArc.toString()}
  ${computePathResponse.toString()}
  ${computeFollowResponse.toString()}
  ${computeTargetRotationDeg.toString()}
  ${computeSpeedNarrowing.toString()}
  ${computeShortMoveTilt.toString()}
  ${computeShortMoveSquash.toString()}
  ${hasCursorArrived.toString()}
  ${computeWiggleAngleDeg.toString()}
  ${computeVisibilityEffect.toString()}

  // New-document scripts run in every frame; only top-level input owns a cursor.
  function isSubframe() {
    try {
      return Boolean(window.top && window.top !== window);
    } catch {
      return true;
    }
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
    rotation: RESTING_TILT_DEG,
    rotationVelocity: 0,
    scaleX: 1,
    scaleXVelocity: 0,
    scaleY: 1,
    visibility: 0,
    visibilityVelocity: 0,
    targetVisibility: 0,
    blurPx: 0,
    activeArc: null,
    progress: 1,
    progressVelocity: 0,
    pathResponse: SPRING_CHANNELS.shortProgress.response,
    tilt: 0,
    tiltVelocity: 0,
    squash: 1,
    squashVelocity: 0,
    frameAccumulatorMs: 0,
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

  function applyTranslate() {
    if (!runtime.outerElement) return;
    const pose = computeCursorTransform(runtime.x, runtime.y, runtime.rotation + runtime.tilt + computeWiggleAngleDeg(runtime.idleWiggleMs));
    runtime.outerElement.style.transform = 'translate3d(' + pose.translateX + 'px, ' + pose.translateY + 'px, 0)';
  }

  function applyInnerTransformAndFilter() {
    if (!runtime.innerElement) return;
    const visEffect = computeVisibilityEffect(runtime.visibility);
    const pose = computeCursorTransform(runtime.x, runtime.y, runtime.rotation + runtime.tilt + computeWiggleAngleDeg(runtime.idleWiggleMs),
      runtime.pressScale * runtime.scaleX * visEffect.scale,
      runtime.pressScale * runtime.scaleY * visEffect.scale);
    const arc = runtime.activeArc;
    const moveAngle = arc ? Math.atan2(arc.p3.y - arc.p0.y, arc.p3.x - arc.p0.x) * 180 / Math.PI : 0;
    const squashTransform = runtime.squash === 1 ? '' : 'rotate(' + moveAngle + 'deg) scale(' + runtime.squash + ', 1) rotate(' + (-moveAngle) + 'deg) ';
    runtime.innerElement.style.transform = squashTransform + pose.transform;
    runtime.blurPx = visEffect.blurPx;
    runtime.innerElement.style.filter = 'blur(' + visEffect.blurPx + 'px)';
  }

  function configureCursorArt(inner) {
    applyOverlayReset(inner);
    inner.style.display = 'block';
    inner.style.width = CURSOR_SIZE_PX + 'px';
    inner.style.height = CURSOR_SIZE_PX + 'px';
    inner.style.transformOrigin = computeCursorTransform(0, 0, 0).transformOrigin;
    inner.style.backgroundImage = '';
    let svg = inner.firstElementChild;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') {
      const namespace = 'http://www.w3.org/2000/svg';
      svg = document.createElementNS(namespace, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', String(CURSOR_SIZE_PX));
      svg.setAttribute('height', String(CURSOR_SIZE_PX));
      const path = document.createElementNS(namespace, 'path');
      for (const [key, value] of Object.entries({ d: CURSOR_ARROW_PATH, fill: '#000', stroke: '#fff',
        'stroke-width': '1.5', 'stroke-linejoin': 'round', 'paint-order': 'stroke fill' })) {
        path.setAttribute(key, value);
      }
      inner.appendChild(svg);
      svg.appendChild(path);
    }
    applyOverlayReset(svg);
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    svg.style.filter = CURSOR_GLOW_FILTER;
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
    configureCursorArt(inner);
    inner.style.opacity = '1';
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
      if (runtime.innerElement) configureCursorArt(runtime.innerElement);
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
    runtime.frameAccumulatorMs = 0;
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

  function advanceSpring(key, velocityKey, target, channel) {
    const next = stepSpring({ value: runtime[key], velocity: runtime[velocityKey] }, target, channel);
    runtime[key] = next.value;
    runtime[velocityKey] = next.velocity;
  }

  function advanceMotion() {
    advanceSpring('visibility', 'visibilityVelocity', runtime.targetVisibility, SPRING_CHANNELS.visibility);
    const arc = runtime.activeArc;
    if (arc && !runtime.arrived) {
      const progressChannel = arc.isCurved
        ? { ...SPRING_CHANNELS.longProgress, response: runtime.pathResponse }
        : SPRING_CHANNELS.shortProgress;
      advanceSpring('progress', 'progressVelocity', 1, progressChannel);
      const progress = clampNumber(runtime.progress, 0, 1);
      const guide = arc.isCurved ? evaluateBezierPoint(arc, progress) : arc.p3;
      const positionChannel = arc.isCurved
        ? { response: computeFollowResponse(runtime.pathResponse), dampingFraction: SPRING_CHANNELS.position.dampingFraction }
        : SPRING_CHANNELS.position;
      advanceSpring('x', 'vx', guide.x, positionChannel);
      advanceSpring('y', 'vy', guide.y, positionChannel);
      if (hasCursorArrived(runtime, { x: runtime.targetX, y: runtime.targetY })) {
        runtime.arrived = true;
        runtime.x = runtime.targetX;
        runtime.y = runtime.targetY;
        runtime.vx = runtime.vy = 0;
        runtime.progress = 1;
        runtime.progressVelocity = 0;
        runtime.idleWiggleMs = 0;
        resolveArrivalWaiters();
      }
    } else if (runtime.hasPosition && !runtime.idleHidden) {
      runtime.idleWiggleMs = Math.min(WIGGLE_DURATION_MS, runtime.idleWiggleMs + FIXED_TIMESTEP_MS);
    }

    const moving = arc && !runtime.arrived;
    const progress = clampNumber(runtime.progress, 0, 1);
    const tangentAngleDeg = moving ? evaluateBezierTangent(arc, progress).angleDeg : 0;
    const rotationTarget = computeTargetRotationDeg({ isCurved: Boolean(moving && arc.isCurved),
      tangentAngleDeg, currentRotationDeg: runtime.rotation });
    advanceSpring('rotation', 'rotationVelocity', rotationTarget, SPRING_CHANNELS.rotation);
    const distance = arc?.distance || 1;
    const tiltTarget = moving && !arc.isCurved
      ? computeShortMoveTilt(progress, (arc.p3.x - arc.p0.x) / distance, (arc.p3.y - arc.p0.y) / distance) : 0;
    advanceSpring('tilt', 'tiltVelocity', tiltTarget, SPRING_CHANNELS.tilt);
    advanceSpring('squash', 'squashVelocity', moving && !arc.isCurved ? computeShortMoveSquash(progress) : 1, SPRING_CHANNELS.squash);
    advanceSpring('scaleX', 'scaleXVelocity', moving ? computeSpeedNarrowing(Math.hypot(runtime.vx, runtime.vy)) : 1, SPRING_CHANNELS.stretch);
    runtime.scaleY = 1;
  }

  function stepFrame(timestampMs) {
    if (!runtime.enabled) return;
    const nowMs = Number.isFinite(timestampMs) ? timestampMs : FIXED_TIMESTEP_MS;
    const elapsedMs = runtime.lastFrameTimeMs === null ? FIXED_TIMESTEP_MS :
      clampNumber(nowMs - runtime.lastFrameTimeMs, 0, MAX_FRAME_DELTA_MS);
    runtime.lastFrameTimeMs = nowMs;
    // Carry fractional steps across frames; after a suspended tab, discard time beyond one second.
    runtime.frameAccumulatorMs += elapsedMs;
    while (runtime.frameAccumulatorMs + TIMESTEP_EPSILON_MS >= FIXED_TIMESTEP_MS) {
      advanceMotion();
      runtime.frameAccumulatorMs = Math.max(0, runtime.frameAccumulatorMs - FIXED_TIMESTEP_MS);
    }
    setChromeOpacity(String(computeVisibilityEffect(runtime.visibility).opacity), 0);
    applyTranslate();
    applyInnerTransformAndFilter();
    const channelsSettled = runtime.rotationVelocity === 0 && runtime.tiltVelocity === 0 &&
      runtime.squashVelocity === 0 && runtime.scaleXVelocity === 0 && runtime.visibilityVelocity === 0;
    if (!runtime.arrived || !channelsSettled || (!runtime.idleHidden && runtime.hasPosition && runtime.idleWiggleMs < WIGGLE_DURATION_MS)) {
      scheduleAnimationFrame();
    } else {
      runtime.lastFrameTimeMs = null;
      runtime.frameAccumulatorMs = 0;
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
      runtime.idleWiggleMs = WIGGLE_DURATION_MS;
      if (isReducedMotionPreferred() || typeof window.requestAnimationFrame !== 'function') {
        runtime.visibility = 0;
        runtime.visibilityVelocity = 0;
        setChromeOpacity('0', 0);
        applyInnerTransformAndFilter();
      }
      scheduleAnimationFrame();
    }, IDLE_HIDE_DELAY_MS);
  }

  function wakeFromIdle() {
    runtime.hasPosition = false;
    runtime.idleHidden = false;
  }

  function moveCursor(action) {
    if (!runtime.enabled) return;
    ensureCursorElement();
    if (!runtime.outerElement) return;

    const reducedMotion = isReducedMotionPreferred();
    if (!runtime.hasPosition || reducedMotion || runtime.visibility === 0) {
      runtime.x = action.x;
      runtime.y = action.y;
      runtime.vx = 0;
      runtime.vy = 0;
      runtime.targetX = action.x;
      runtime.targetY = action.y;
      runtime.rotation = RESTING_TILT_DEG;
      runtime.rotationVelocity = 0;
      runtime.scaleX = 1;
      runtime.scaleY = 1;
      runtime.activeArc = null;
      runtime.progress = 1;
      runtime.progressVelocity = 0;
      runtime.tilt = runtime.tiltVelocity = 0;
      runtime.squash = 1;
      runtime.squashVelocity = 0;
      runtime.scaleXVelocity = 0;
      runtime.idleWiggleMs = reducedMotion ? WIGGLE_DURATION_MS : 0;
      runtime.visibility = reducedMotion || typeof window.requestAnimationFrame !== 'function' ? 1 : 0;
      runtime.visibilityVelocity = 0;
      runtime.targetVisibility = 1;
      setChromeOpacity(String(runtime.visibility), 0);
      runtime.hasPosition = true;
      runtime.arrived = true;
      applyTranslate();
      applyInnerTransformAndFilter();
      resolveArrivalWaiters();
      if (!isReducedMotionPreferred()) scheduleAnimationFrame();
      return;
    }

    const distance = Math.hypot(action.x - runtime.x, action.y - runtime.y);
    if (distance === 0 && runtime.arrived) {
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
      width: Number(window.innerWidth) || DEFAULT_VIEWPORT.width,
      height: Number(window.innerHeight) || DEFAULT_VIEWPORT.height,
    };
    const arc = selectBezierArc(
      { x: runtime.x, y: runtime.y },
      { x: action.x, y: action.y },
      viewport,
    );
    runtime.targetX = action.x;
    runtime.targetY = action.y;
    runtime.activeArc = arc;
    runtime.progress = 0;
    runtime.progressVelocity = 0;
    runtime.pathResponse = arc.isCurved ? computePathResponse(arc.length, arc.curviness, arc.opposition) : SPRING_CHANNELS.shortProgress.response;
    runtime.idleWiggleMs = WIGGLE_DURATION_MS;
    runtime.targetVisibility = 1;
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
    runtime.pressScale = isPressed ? PRESS_SCALE : 1;
    runtime.targetVisibility = 1;
    applyInnerTransformAndFilter();
  }

  function beginAppearTransition() {
    runtime.visibility = 0;
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
      tilt: runtime.tilt,
      squash: runtime.squash,
      progress: runtime.progress,
      progressVelocity: runtime.progressVelocity,
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
    runtime.visibility = 0;
    runtime.targetVisibility = 0;
    setChromeOpacity('0', 0);
    applyTranslate();
    applyInnerTransformAndFilter();
    scheduleIdleHide();
  }

  function disable() {
    runtime.enabled = false;
    runtime.hasPosition = false;
    runtime.idleHidden = false;
    runtime.pressScale = 1;
    runtime.rotation = RESTING_TILT_DEG;
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

export function buildGhostCursorSource() {
  return GHOST_CURSOR_SOURCE;
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

export function buildGhostCursorSyncExpression(action, maxWaitMs = CLICK_SYNC_MAX_WAIT_MS) {
  const safeTimeoutMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0
    ? Math.round(maxWaitMs)
    : CLICK_SYNC_MAX_WAIT_MS;
  const moveAction = { ...action, type: "move" };
  return `(() => {
    const api = globalThis.${CURSOR_API_KEY};
    if (!api || typeof api.applyMouseAction !== "function") return Promise.resolve({ arrived: false });
    const arrival = Promise.resolve(api.applyMouseAction(${JSON.stringify(moveAction)}));
    return Promise.race([
      arrival,
      new Promise((resolve) => setTimeout(() => resolve({ arrived: false, timedOut: true }), ${safeTimeoutMs})),
    ]);
  })()`;
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
  log = () => {},
}) {
  const stateByTab = new Map();
  const cursorSource = buildGhostCursorSource();

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

  function syncBeforeClick(tabId, action, { maxWaitMs = CLICK_SYNC_MAX_WAIT_MS } = {}) {
    if (!isEnabled() || !isTabAttached(tabId)) return Promise.resolve(false);
    const state = getState(tabId);
    const generation = state.generation;
    const moveAction = { ...action, type: "move" };
    const safeTimeoutMs = Number.isFinite(maxWaitMs) && maxWaitMs > 0
      ? maxWaitMs
      : CLICK_SYNC_MAX_WAIT_MS;

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, safeTimeoutMs);

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Boolean(value));
      };

      const queued = enqueue(tabId, async () => {
        if (!isEnabled() || !isTabAttached(tabId) || generation !== state.generation) return false;
        if (!(await ensureScript(tabId, state, generation))) return false;
        if (!isEnabled() || !isTabAttached(tabId) || generation !== state.generation) return false;
        let evalTimer = null;
        try {
          return await Promise.race([
            sendCommand(tabId, "Runtime.evaluate", {
              expression: buildGhostCursorSyncExpression(moveAction, safeTimeoutMs),
              awaitPromise: true,
              returnByValue: true,
            }).then(() => true),
            new Promise((r) => {
              evalTimer = setTimeout(() => r(false), safeTimeoutMs);
            }),
          ]);
        } finally {
          if (evalTimer !== null) clearTimeout(evalTimer);
        }
      }, { action: moveAction, generation });

      Promise.resolve(queued).then(finish, (error) => {
        safeLog(log, error);
        finish(false);
      });
    });
  }

  return { enable, queueAction, syncBeforeClick, disable, cleanup };
}

export async function syncGhostCursorBeforeClick({
  method,
  childSessionId,
  tabId,
  params,
  agentName,
  controller,
  isClickSyncEnabled = false,
  maxWaitMs = CLICK_SYNC_MAX_WAIT_MS,
  log,
}) {
  const enabled = typeof isClickSyncEnabled === "function"
    ? Boolean(isClickSyncEnabled())
    : Boolean(isClickSyncEnabled);
  if (!enabled) return false;
  if (childSessionId || method !== "Input.dispatchMouseEvent" || params?.type !== "mousePressed") {
    return false;
  }
  const action = buildGhostCursorAction({ type: "mouseMoved", params, agentName });
  if (!action) return false;

  try {
    if (typeof controller?.syncBeforeClick === "function") {
      return Boolean(await controller.syncBeforeClick(tabId, action, { maxWaitMs }));
    }
    const result = await controller?.queueAction?.(tabId, action);
    return Boolean(result);
  } catch (error) {
    safeLog(log, error);
    return false;
  }
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
