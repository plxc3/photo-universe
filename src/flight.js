// One camera rig for the resting sculpture and its thirty-second film.
export const FILM = { total: 29.65, phase1: 5.5, phase2End: 21.8 };
export const ORBIT_CONTENT_RADIUS = 25;
export const REST_ROTATION = [-0.08, -0.68, -0.15];
export const PORTRAIT_ROTATION = [-1.05, 0.22, 2.20];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, s) => a + (b - a) * s;
const mix = (a, b, s) => a.map((v, i) => lerp(v, b[i], s));

export function easeInOut(value) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}
const envelope = u => Math.sin(Math.PI * u) ** 2;

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
  // A vertical sculpture uses its narrow side on phones. Fit that side more
  // closely while reserving a vertical floor for shorter portrait/tablet views.
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
  if (t < FILM.phase2End) return { x: 0, y: 0 };
  const s = easeInOut((t - FILM.phase2End) / (FILM.total - FILM.phase2End));
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
    rotation[2] += Math.sin(Math.PI * s) * 0.12;
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
    const e = envelope(s);
    const z = lerp(76, 2, s);
    const x = e * 2.0 * Math.sin(2.6 * Math.PI * u);
    const y = e * 1.4 * Math.cos(1.8 * Math.PI * u);
    const roll = 0.55 * e;
    return {
      mode: 'tunnel',
      position: [x, y, z],
      target: [x * 0.15, y * 0.15, z - 76],
      up: [0, 1, 0],
      fov: 72,
      rotation: [0, 0, roll],
    };
  }
  const u = (t - FILM.phase2End) / (FILM.total - FILM.phase2End);
  const settle = easeInOut(u);
  const spiral = envelope(settle) * 0.85;
  return {
    mode: 'orbit',
    position: [
      lerp(0, end[0], settle) + spiral * Math.sin(2 * Math.PI * u),
      lerp(0, end[1], settle) + spiral * 0.35 * Math.sin(3 * Math.PI * u),
      lerp(2, end[2], settle) + spiral * Math.cos(2 * Math.PI * u),
    ],
    target: [0, 0, lerp(-74, 0, settle)],
    up: [0, 1, 0],
    fov: lerp(72, 54, settle),
    rotation: settle === 0 ? [0, 0, 0] : restingRotation.map(value => value * settle),
  };
}
