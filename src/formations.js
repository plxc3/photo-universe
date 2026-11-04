/** Geometry is independent of Three.js so each formation is reproducible and testable. */
export const FORMATIONS = [
  { id: "orbit", label: "星环" },
  { id: "tunnel", label: "隧道" },
  { id: "sphere", label: "星球" },
  { id: "helix", label: "螺旋" },
];

export const STAR_CORE_A = 6.8;
export const STAR_CORE_B = 11.3;
export const STAR_EXPANDED_A = 15.0;
export const RING_RADII = [21.3, 22.0, 22.7, 23.4];
export const TUNNEL_RADIUS = 12.0;
export const TUNNEL_Z_MIN = -132;
export const TUNNEL_Z_MAX = 48;
export const TUNNEL_SPAN = TUNNEL_Z_MAX - TUNNEL_Z_MIN;

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RING_TILTS = [
  [0.88, 0.46],
  [-0.84, 0.54],
  [0.74, -0.62],
  [-0.96, -0.44],
];

function unit(vector) {
  const length = Math.hypot(...vector) || 1;
  return vector.map((component) => component / length);
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function tiltPoint([x, y, z], [tiltX, tiltY]) {
  const cy = Math.cos(tiltY), sy = Math.sin(tiltY);
  const cx = Math.cos(tiltX), sx = Math.sin(tiltX);
  const u = x * cy + z * sy;
  const v = -x * sy + z * cy;
  return [u, y * cx - v * sx, y * sx + v * cx];
}

export const RING_AXES = RING_TILTS.map((angles) => unit(tiltPoint([0, 0, 1], angles)));

/** Align a photo's width to the tangent and its front (+Z) to the normal. XYZ Euler. */
function photoRotation(tangent, front) {
  const z = unit(front);
  const projection = tangent.reduce((sum, value, index) => sum + value * z[index], 0);
  const x = unit(tangent.map((value, index) => value - projection * z[index]));
  const y = cross(z, x);
  const pitch = Math.asin(Math.max(-1, Math.min(1, z[0])));
  if (Math.abs(z[0]) < 0.9999999) {
    return [Math.atan2(-z[1], z[2]), pitch, Math.atan2(-y[0], x[0])];
  }
  return [Math.atan2(z[0] > 0 ? y[2] : -y[2], y[1]), pitch, 0];
}

const OCTANTS = [
  [-1, -1, -1],
  [-1, -1, 1],
  [-1, 1, -1],
  [-1, 1, 1],
  [1, -1, -1],
  [1, -1, 1],
  [1, 1, -1],
  [1, 1, 1],
];

function facetSpec(facetIndex, a = STAR_CORE_A, b = STAR_CORE_B) {
  const octant = OCTANTS[Math.floor(facetIndex / 3)];
  const face = facetIndex % 3;
  const [sx, sy, sz] = octant;
  const apex = [sx * b, sy * b, sz * b];
  let uAxis, wAxis, normal;
  if (face === 0) {
    uAxis = [sx, 0, 0];
    wAxis = [0, sy, 0];
    normal = [sx * b, sy * b, sz * (a - 2 * b)];
  } else if (face === 1) {
    uAxis = [0, sy, 0];
    wAxis = [0, 0, sz];
    normal = [sx * (a - 2 * b), sy * b, sz * b];
  } else {
    uAxis = [0, 0, sz];
    wAxis = [sx, 0, 0];
    normal = [sx * b, sy * (a - 2 * b), sz * b];
  }
  const uVertex = uAxis.map((c) => c * a);
  const wVertex = wAxis.map((c) => c * a);
  const midpoint = [
    0.5 * (uVertex[0] + wVertex[0]),
    0.5 * (uVertex[1] + wVertex[1]),
    0.5 * (uVertex[2] + wVertex[2]),
  ];
  const altitude = unit([apex[0] - midpoint[0], apex[1] - midpoint[1], apex[2] - midpoint[2]]);
  const outward = unit(normal);
  const tangent = cross(altitude, outward);
  return { apex, uAxis, wAxis, uVertex, wVertex, outward, rotation: photoRotation(tangent, outward) };
}

/** Exact Euler rotation of any of the 24 stellated facets at inner octahedron parameter `a`. */
export function stellatedFacetRotation(facetIndex, a = STAR_CORE_A) {
  return facetSpec(facetIndex, a, STAR_CORE_B).rotation;
}

/** Split a count exactly, while keeping the first and last layers populated. */
function layerCounts(count, layers) {
  if (layers <= 0) return [];
  const base = Math.floor(count / layers);
  const extra = count % layers;
  return Array.from({ length: layers }, (_, index) => base + Number(index < extra));
}

function weightedCounts(count, weights) {
  if (!weights.length || count <= 0) return weights.map(() => 0);
  const minimum = count >= weights.length ? 1 : 0;
  const remaining = count - minimum * weights.length;
  const total = weights.reduce((sum, value) => sum + value, 0);
  const quotas = weights.map((value) => (remaining * value) / total);
  const result = quotas.map((value) => minimum + Math.floor(value));
  const order = quotas
    .map((value, index) => ({ index, fraction: value % 1 }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const left = count - result.reduce((a, b) => a + b, 0);
  for (let index = 0; index < left; index++) result[order[index].index]++;
  return result;
}

/**
 * 24-facet Hyper-Stellated Octahedron core (~72% of photos) surrounded by
 * 4 inclined Double-Track Armillary Ribbons (~28% of photos).
 */
function orbit(count) {
  if (count <= 0) return [];
  const sculptureCount = Math.round(count * 0.72);
  const result = [];
  const expandSpan = STAR_EXPANDED_A - STAR_CORE_A;

  layerCounts(sculptureCount, 24).forEach((facetCount, facetIndex) => {
    if (facetCount <= 0) return;
    const { apex, uAxis, wAxis, uVertex, wVertex, outward, rotation } = facetSpec(facetIndex);
    const rows = Math.max(1, Math.round(Math.sqrt(facetCount * 2.4)));
    const rowWeights = Array.from({ length: rows }, (_, r) => r + 0.85);
    const rowSizes = weightedCounts(facetCount, rowWeights);
    const scale = Math.max(0.56, Math.min(1.12, 7.6 / Math.sqrt(Math.max(1, facetCount))));
    const lift = 0.035;

    rowSizes.forEach((rowSize, row) => {
      if (rowSize <= 0) return;
      for (let col = 0; col < rowSize; col++) {
        let lp, lu, lw;
        if (rows === 1 && rowSize === 1) {
          lp = 0.42;
          lu = 0.29;
          lw = 0.29;
        } else {
          const u = (row + 0.78) / (rows + 0.42);
          const v = (col + 0.5) / rowSize;
          lp = 1 - u;
          lu = u * (1 - v);
          lw = u * v;
        }
        const position = [
          lp * apex[0] + lu * uVertex[0] + lw * wVertex[0] + outward[0] * lift,
          lp * apex[1] + lu * uVertex[1] + lw * wVertex[1] + outward[1] * lift,
          lp * apex[2] + lu * uVertex[2] + lw * wVertex[2] + outward[2] * lift,
        ];
        const breathDelta = [
          expandSpan * (lu * uAxis[0] + lw * wAxis[0]),
          expandSpan * (lu * uAxis[1] + lw * wAxis[1]),
          expandSpan * (lu * uAxis[2] + lw * wAxis[2]),
        ];
        result.push({
          position,
          rotation: [...rotation],
          scale,
          ring: -1,
          facet: facetIndex,
          breathDelta,
        });
      }
    });
  });

  const ringTotal = count - sculptureCount;
  layerCounts(ringTotal, 4).forEach((size, ring) => {
    if (size <= 0) return;
    const angles = RING_TILTS[ring];
    const axis = RING_AXES[ring];
    const radius = RING_RADII[ring];
    const pairCount = Math.max(1, Math.ceil(size / 2));
    const trackSep = size > 1 ? 0.41 : 0;
    const cardScale = Math.max(0.56, Math.min(0.96, 74 / pairCount));

    for (let index = 0; index < size; index++) {
      const pairIndex = Math.floor(index / 2);
      const trackSign = size === 1 ? 0 : index % 2 === 0 ? -1 : 1;
      const theta = (pairIndex / pairCount) * TAU + ring * 0.47;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const position = tiltPoint([cos * radius, sin * radius, trackSign * trackSep], angles);
      const radialOut = tiltPoint([cos, sin, 0], angles);
      const circumferential = tiltPoint([-sin, cos, 0], angles);
      const front = [
        radialOut[0] + axis[0] * 0.18 * trackSign,
        radialOut[1] + axis[1] * 0.18 * trackSign,
        radialOut[2] + axis[2] * 0.18 * trackSign,
      ];
      result.push({
        position,
        rotation: photoRotation(circumferential, front),
        scale: cardScale,
        ring,
      });
    }
  });

  return result;
}

/**
 * Wall-flush architectural square corridor (`z ∈ [-132, 48]`, periodic span 180).
 * Every photograph lies flush on one of the 4 walls facing inward toward the passage.
 */
function tunnel(count) {
  if (count <= 0) return [];
  const radius = TUNNEL_RADIUS;
  const wallHalf = radius - 0.72;
  const result = [];
  const layers = Math.min(60, Math.max(1, Math.ceil(count / 48)));
  const pitch = TUNNEL_SPAN / layers;
  const scale = count <= 1500 ? 1.48 : 1.32;

  const rightRot = photoRotation([0, 0, 1], [-1, 0, 0]);
  const ceilingRot = photoRotation([1, 0, 0], [0, -1, 0]);
  const leftRot = photoRotation([0, 0, -1], [1, 0, 0]);
  const floorRot = photoRotation([1, 0, 0], [0, 1, 0]);

  layerCounts(count, layers).forEach((size, layer) => {
    const z = layers === 1 ? -42 : TUNNEL_Z_MIN + (layer + 0.5) * pitch;
    const wallSizes = layerCounts(size, 4);
    for (let w = 0; w < 4; w++) {
      const side = (w + layer) % 4;
      const wallCount = wallSizes[w];
      for (let k = 0; k < wallCount; k++) {
        const frac = wallCount === 1 ? 0 : ((k + 0.5) / wallCount) * 2 - 1;
        const along = frac * wallHalf;
        if (side === 0) {
          result.push({ position: [radius, along, z], rotation: [...rightRot], scale });
        } else if (side === 1) {
          result.push({ position: [-along, radius, z], rotation: [...ceilingRot], scale });
        } else if (side === 2) {
          result.push({ position: [-radius, -along, z], rotation: [...leftRot], scale });
        } else {
          result.push({ position: [along, -radius, z], rotation: [...floorRot], scale });
        }
      }
    }
  });
  return result;
}

function sphere(count) {
  return Array.from({ length: count }, (_, index) => {
    const y = 1 - 2 * ((index + 0.5) / count);
    const horizontal = Math.sqrt(1 - y * y);
    const angle = index * GOLDEN_ANGLE;
    const front = [Math.cos(angle) * horizontal, y, Math.sin(angle) * horizontal];
    const tangent = [Math.sin(angle), 0, -Math.cos(angle)];
    return {
      position: front.map((component) => component * 20),
      rotation: photoRotation(tangent, front),
      scale: 1.12,
    };
  });
}

function helix(count) {
  const result = [];
  const strands = Math.min(6, Math.max(1, count));
  layerCounts(count, strands).forEach((size, strand) => {
    const radius = 10 + (strand % 3) * 1.1;
    for (let index = 0; index < size; index += 1) {
      const progress = size === 1 ? 0.5 : index / (size - 1);
      const angle = progress * TAU * 3.5 + (strand / strands) * TAU;
      const c = Math.cos(angle), s = Math.sin(angle);
      const position = [radius * c, radius * s, progress * 48 - 24];
      const tangent = [-radius * TAU * 3.5 * s, radius * TAU * 3.5 * c, 48];
      result.push({ position, rotation: photoRotation(tangent, [c, s, 0]), scale: 0.80 });
    }
  });
  return result;
}

const BUILDERS = { orbit, tunnel, sphere, helix };

/**
 * @param {'orbit'|'tunnel'|'sphere'|'helix'} id
 * @param {number} count A non-negative integer.
 * @returns {Array<{position: number[], rotation: number[], scale: number}>}
 */
export function createFormation(id, count, portrait = 0) {
  if (!Object.hasOwn(BUILDERS, id)) throw new RangeError(`Unknown formation: ${id}`);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Formation count must be a non-negative safe integer");
  }
  const result = BUILDERS[id](count);
  const amount = Number.isFinite(portrait) ? Math.max(0, Math.min(1, portrait)) : 0;
  if (id === "orbit" && amount > 0) {
    // Change the sculpture's depth, never the dimensions of an individual print.
    for (const photo of result) photo.position[2] *= 1 + amount * 0.33;
  }
  return result;
}
