// Cinematic flight path sampler for the photo-universe intro.
// Pure function: maps a time in seconds to a camera rig sample.

const TOTAL = 30;
const PHASE1 = 5.5;
const PHASE2_END = 24;
export const FILM = { total: TOTAL, phase1: PHASE1, phase2End: PHASE2_END };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, s) => a + (b - a) * s;
const DEG2RAD = Math.PI / 180;

// Smootherstep: C2 continuous, zero velocity at both ends -> no speed jumps.
const smoother = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// Envelope that is 0 at u=0 and u=1, smooth in between.
const env = (u) => {
  const s = Math.sin(Math.PI * u);
  return s * s;
};

// Bounding radius (world units) of the "orbit" formation, sculpture + outer ring.
// Chosen so the horizontal fit keeps the full card layout inside the edges.
export const ORBIT_CONTENT_RADIUS = 24;

// Desktop establishing-shot anchor: camera position, its distance, and side offset.
const DESKTOP_END = [34, 14, 50];
const DESKTOP_END_DISTANCE = Math.hypot(...DESKTOP_END); // ~61.5
const DESKTOP_H_OFFSET = -0.065; // negative x pushes the scene right (the look to keep)

/**
 * Shared aspect-driven framing used by the resting orbit view, the reset button
 * and both ends of the film, so they never disagree about how far the phone sits.
 * On portrait we fit the formation to horizontal FOV (never a hardcoded 390) so it
 * stays inside the edges with margin, then push a negative vertical view offset to
 * drop the scene below the top title. Desktop keeps its existing side-offset look.
 */
export function orbitFraming(aspect = 16 / 9, fov = 54) {
  const validAspect = Number.isFinite(aspect) && aspect > 0;
  const mobile = validAspect && aspect < 0.8;
  const a = validAspect ? aspect : 16 / 9;
  const tanHalf = Math.tan((fov * DEG2RAD) / 2);
  if (!mobile) {
    return {
      mobile: false,
      distance: DESKTOP_END_DISTANCE,
      fov,
      verticalOffsetFraction: 0, // desktop keeps its current composition
      horizontalOffsetFraction: DESKTOP_H_OFFSET,
      marginRatio: clamp(
        (1 - ORBIT_CONTENT_RADIUS / (DESKTOP_END_DISTANCE * a * tanHalf)) / 2,
        0,
        1,
      ),
    };
  }
  const halfHorizontal = a * tanHalf;
  // Horizontal fraction of the viewport the content may occupy -> ~>=20% margin total.
  const occupancy = 0.8;
  let distance = ORBIT_CONTENT_RADIUS / (occupancy * halfHorizontal);
  // Never so far the cards turn into dots; clamp to a sane range.
  distance = clamp(distance, 72, 150);
  // Negative vertical offset moves the scene down (avoids overlapping the title).
  const verticalOffsetFraction = -0.085;
  return {
    mobile: true,
    distance,
    fov,
    verticalOffsetFraction,
    horizontalOffsetFraction: 0,
    marginRatio: clamp(
      (1 - ORBIT_CONTENT_RADIUS / (distance * halfHorizontal)) / 2,
      0,
      1,
    ),
  };
}

// Resting view-offset fractions for the current viewport. Desktop keeps the
// side offset only when there is room (wideEnough); portrait pushes the scene
// down. These are the same fractions the film must ease back to so a natural
// end is projection-matrix identical to a resize at rest.
export function restingViewFractions(aspect, wideEnough = true) {
  const framing = orbitFraming(aspect, 54);
  const x = framing.mobile || !wideEnough ? 0 : framing.horizontalOffsetFraction;
  const y = framing.mobile ? framing.verticalOffsetFraction : 0;
  return { x, y };
}

/**
 * Continuous view-offset schedule for the cinematic flight, in the SAME
 * fractions as the resting framing. Starts at rest, eases to 0 through the
 * tunnel, and converges exactly back to rest by the 30s mark so the natural
 * handoff to interactive mode causes no projection jump.
 */
export function flightViewOffset(t, restingX = 0, restingY = 0) {
  const time = Number.isFinite(t) ? clamp(t, 0, TOTAL) : 0;
  if (time < PHASE1) {
    const k = 1 - smoother(time / PHASE1);
    return { x: restingX * k, y: restingY * k };
  }
  if (time < PHASE2_END) return { x: 0, y: 0 };
  const s = smoother((time - PHASE2_END) / (TOTAL - PHASE2_END));
  return { x: restingX * s, y: restingY * s };
}

// Establishing-shot camera position. Desktop keeps the fixed side composition;
// portrait keeps a gentle lateral offset but pushes z back so |position| == the
// aspect-driven framing distance (matches the resting orbit view exactly).
function framingPosition(framing) {
  if (!framing.mobile) return [...DESKTOP_END];
  const d = framing.distance;
  const x = 6;
  const y = DESKTOP_END[1];
  const z = Math.sqrt(Math.max(1, d * d - x * x - y * y));
  return [x, y, z];
}

export function sampleFlight(seconds, aspect = 16 / 9) {
  const t = Number.isFinite(seconds) ? clamp(seconds, 0, TOTAL) : 0;
  const framing = orbitFraming(aspect, 54);
  // Mobile starts further out (aspect-driven), desktop uses the cinematic 90.
  const startRadius = framing.mobile ? Math.max(90, framing.distance * 1.08) : 90;
  const end = framingPosition(framing);

  // Phase 1 (0 - 5.5s): orbit from outside, closing in.
  if (t < PHASE1) {
    const s = smoother(t / PHASE1);
    const radius = lerp(startRadius, 38, s);
    const yaw = 0.35 * (1 - s);
    const y = 8 * (1 - s);
    return {
      mode: 'orbit',
      position: [radius * Math.sin(yaw), y, radius * Math.cos(yaw)],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: lerp(54, 75, s),
      rotation: [0.15 * (1 - s), 0.1 * (1 - s), 0.05 * (1 - s)],
    };
  }

  // Phase 2 (5.5s - 24s): fly through the square tunnel.
  if (t < PHASE2_END) {
    const u = (t - PHASE1) / (PHASE2_END - PHASE1);
    const s = smoother(u);
    const e = env(u);
    const z = lerp(38, 14, s); // always positive -> never flips backward
    const upX = e * 0.1 * Math.sin(4 * Math.PI * u);
    const upZ = e * 0.08 * Math.cos(4 * Math.PI * u);
    const upY = Math.sqrt(Math.max(0, 1 - upX * upX - upZ * upZ));
    return {
      mode: 'tunnel',
      position: [
        e * 3.2 * Math.sin(3.5 * Math.PI * u + 0.4),
        e * 2.6 * Math.cos(2.5 * Math.PI * u),
        z,
      ],
      // target.z = position.z - 38 keeps [0,0,0] at 5.5s and [0,0,-24] at 24s.
      target: [0, 0, z - 38],
      up: [upX, upY, upZ],
      fov: 75,
      rotation: [0, 0, 0],
    };
  }

  // Phase 3 (24s - 30s): pull back out to the establishing shot.
  const u = (t - PHASE2_END) / (TOTAL - PHASE2_END);
  const s = smoother(u);
  const e = env(u);
  const spiral = e * 2.2; // zero at both ends
  return {
    mode: 'orbit',
    position: [
      lerp(0, end[0], s) + spiral * Math.sin(2.5 * Math.PI * u),
      lerp(0, end[1], s) + spiral * 0.5 * Math.sin(3 * Math.PI * u),
      lerp(14, end[2], s) + spiral * Math.cos(2.5 * Math.PI * u),
    ],
    target: [0, 0, lerp(-24, 0, s)],
    up: [0, 1, 0],
    fov: lerp(75, 54, s),
    rotation: [0.08 * s, 0.05 * s, 0.03 * s],
  };
}
