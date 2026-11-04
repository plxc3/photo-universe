// One camera rig for the resting sculpture and its thirty-second film.
export const FILM = { total: 29.65, phase1: 5.5, phase2End: 21.8, reassemble: 22.7, exitEnd: 24.6 };
export const ORBIT_CONTENT_RADIUS = 25;
export const REST_ROTATION = [0.06, -0.05, 0.16];
export const PORTRAIT_ROTATION = [-1.35, -0.16, 2.10];
export const TUNNEL_CONVEYOR_SPAN = 180;

const CONVEYOR_START = 8.4;
const BREATH_START = 25.4;
const BREATH_END = 29.15;
const RING_RATES = [0.72, -0.58, 0.86, -0.48];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, s) => a + (b - a) * s;
const mix = (a, b, s) => a.map((v, i) => lerp(v, b[i], s));

export function easeInOut(value) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
const envelope = u => Math.sin(Math.PI * u) ** 2;

// The physical corridor begins straight, winds into a depth-dependent vortex,
// then returns to a straight corridor before the sculpture reforms. The eased
// envelope has zero velocity and acceleration at both ends.
export function tunnelTwistAt(seconds) {
  const t = Number.isFinite(seconds) ? seconds : 0;
  if (t <= FILM.phase1 || t >= FILM.phase2End) return 0;
  return envelope(easeInOut((t - FILM.phase1) / (FILM.phase2End - FILM.phase1))) * 4.35;
}

// Continuous periodic Z-conveyor offset inside the corridor. Starts once the
// camera is well inside the front mouth (+65) and lands at an exact 180-unit
// period at phase2End so slice wrapping introduces zero boundary discontinuity.
export function tunnelConveyorAt(seconds) {
  const t = Number.isFinite(seconds) ? seconds : 0;
  if (t <= CONVEYOR_START) return 0;
  if (t >= FILM.phase2End) return 0;
  return TUNNEL_CONVEYOR_SPAN * easeInOut((t - CONVEYOR_START) / (FILM.phase2End - CONVEYOR_START));
}

// Crystalline stellation breath in Act III (25.4s–29.15s): expands the inner
// octahedron vertices through Stella Octangula into a crystal lattice and back.
export function stellationBreathAt(seconds) {
  const t = Number.isFinite(seconds) ? seconds : 0;
  if (t <= BREATH_START || t >= BREATH_END) return 0;
  return envelope(easeInOut((t - BREATH_START) / (BREATH_END - BREATH_START)));
}

// Independent gyroscopic precession angle for each of the 4 armillary rings.
export function armillarySpinAt(seconds, ringIndex = 0, startAngle = 0) {
  const t = Number.isFinite(seconds) ? clamp(seconds, 0, FILM.total) : 0;
  const rate = RING_RATES[ringIndex & 3] || 0.6;
  const initial = Number.isFinite(startAngle) ? startAngle : 0;
  if (t < FILM.phase1) {
    const s = easeInOut(t / FILM.phase1);
    return initial * (1 - s) + rate * 1.15 * envelope(s);
  }
  if (t <= FILM.exitEnd) return 0;
  const s = easeInOut((t - FILM.exitEnd) / (FILM.total - FILM.exitEnd));
  return rate * 0.95 * envelope(s);
}

export function portraitAmount(aspect = 16 / 9) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return easeInOut((1.25 - a) / 0.55);
}

export function restRotation(aspect = 16 / 9) {
  return mix(REST_ROTATION, PORTRAIT_ROTATION, portraitAmount(aspect));
}

// Fit a sphere inside both horizontal and vertical safe areas. Unlike a phone
// breakpoint this remains continuous when a viewport changes orientation.
export function orbitFraming(aspect = 16 / 9, fov = 54) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const angle = (Number.isFinite(fov) && fov > 0 && fov < 150 ? fov : 54) * Math.PI / 360;
  const horizontal = Math.atan(a * Math.tan(angle) * 0.90);
  const vertical = Math.atan(Math.tan(angle) * 0.80);
  const portrait = portraitAmount(a);
  const distance = Math.max(
    ORBIT_CONTENT_RADIUS / Math.sin(horizontal) * lerp(1, 0.868, portrait),
    ORBIT_CONTENT_RADIUS / Math.sin(vertical) * lerp(1, 1.45, portrait),
  );
  return {
    mobile: a < 0.85,
    distance,
    fov,
    horizontalOffsetFraction: 0,
    verticalOffsetFraction: lerp(0.025, 0.01209, portrait),
    marginRatio: 0.05,
  };
}

export function orbitPosition(aspect = 16 / 9, fov = 54) {
  const { distance } = orbitFraming(aspect, fov);
  const x = distance * 0.13;
  const y = distance * 0.085;
  return [x, y, Math.sqrt(distance * distance - x * x - y * y)];
}

export function restingViewFractions(aspect) {
  const framing = orbitFraming(aspect);
  return { x: 0, y: framing.verticalOffsetFraction };
}

export function flightViewOffset(seconds, restingX = 0, restingY = 0, start = null) {
  const t = Number.isFinite(seconds) ? clamp(seconds, 0, FILM.total) : 0;
  if (t < FILM.phase1) {
    const k = 1 - easeInOut(t / FILM.phase1);
    return { x: (start?.x ?? restingX) * k, y: (start?.y ?? restingY) * k };
  }
  if (t < FILM.reassemble) return { x: 0, y: 0 };
  const s = easeInOut((t - FILM.reassemble) / (FILM.exitEnd - FILM.reassemble));
  return { x: restingX * s, y: restingY * s };
}

export function sampleFlight(seconds, aspect = 16 / 9, startPose = null) {
  const t = Number.isFinite(seconds) ? clamp(seconds, 0, FILM.total) : 0;
  const end = orbitPosition(aspect);
  const restingRotation = restRotation(aspect);
  if (t < FILM.phase1) {
    const s = easeInOut(t / FILM.phase1);
    const start = startPose || { position: end, target: [0, 0, 0], up: [0, 1, 0], fov: 54, rotation: restingRotation };
    const up = mix(start.up, [0, 1, 0], s);
    const length = Math.hypot(...up) || 1;
    const rotation = mix(start.rotation, [0, 0, 0], s);
    const arc = Math.sin(Math.PI * s);
    rotation[0] -= arc * 0.08;
    rotation[1] -= arc * 0.10;
    rotation[2] += arc * 0.06;
    return {
      mode: 'orbit',
      position: mix(start.position, [0, 0, 76], s),
      target: mix(start.target, [0, 0, 0], s),
      up: up.map(v => v / length),
      fov: lerp(start.fov, 72, s),
      rotation,
    };
  }
  if (t < FILM.phase2End) {
    const u = (t - FILM.phase1) / (FILM.phase2End - FILM.phase1);
    const s = easeInOut(u);
    const entry = easeInOut(Math.min(1, u / 0.20));
    const e = envelope(s);
    const z = 76 - 33 * entry - 41 * s;
    const x = e * 1.65 * Math.sin(2.4 * Math.PI * u);
    const y = e * 1.15 * Math.cos(1.8 * Math.PI * u);
    const roll = 0.52 * e;
    return {
      mode: 'tunnel',
      position: [x, y, z],
      target: [x * 0.12, y * 0.12, z - 76],
      up: [0, 1, 0],
      fov: 72,
      rotation: [0, 0, roll],
    };
  }
  if (t >= FILM.exitEnd) {
    const settle = easeInOut((t - FILM.exitEnd) / (FILM.total - FILM.exitEnd));
    const distance = lerp(1.1, 1, settle);
    return {
      mode: 'orbit', position: end.map(value => value * distance), target: [0, 0, 0],
      up: [0, 1, 0], fov: 54, rotation: restingRotation,
    };
  }
  if (t < FILM.reassemble) {
    const retreat = easeInOut((t - FILM.phase2End) / (FILM.reassemble - FILM.phase2End));
    return {
      mode: 'tunnel', position: [0, 0, lerp(2, 80, retreat)],
      target: [0, 0, lerp(-74, 0, retreat)], up: [0, 1, 0], fov: 72, rotation: [0, 0, 0],
    };
  }
  const u = (t - FILM.reassemble) / (FILM.exitEnd - FILM.reassemble);
  const settle = easeInOut(u);
  const spiral = envelope(settle) * 0.65;
  return {
    mode: 'orbit',
    position: [
      lerp(0, end[0] * 1.1, settle) + spiral * Math.sin(2 * Math.PI * u),
      lerp(0, end[1] * 1.1, settle) + spiral * 0.35 * Math.sin(3 * Math.PI * u),
      lerp(80, end[2] * 1.1, settle) + spiral * Math.cos(2 * Math.PI * u),
    ],
    target: [0, 0, 0],
    up: [0, 1, 0],
    fov: lerp(72, 54, settle),
    rotation: settle === 0 ? [0, 0, 0] : restingRotation.map(value => value * settle),
  };
}
