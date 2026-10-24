/** Geometry is independent of Three.js so each formation is reproducible and testable. */
export const FORMATIONS = [
  { id: "orbit", label: "星环" },
  { id: "tunnel", label: "隧道" },
  { id: "sphere", label: "星球" },
  { id: "helix", label: "螺旋" },
];

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function unit(vector) {
  const length = Math.hypot(...vector);
  return vector.map((component) => component / length);
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

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
  return [Math.atan2(y[2], y[1]), pitch, 0];
}

function rotateZ([x, y, z], angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c - y * s, x * s + y * c, z];
}

/** The four edges share a perimeter; no duplicate corner photos. */
function squarePoint(progress, radius) {
  const perimeter = (progress % 1) * 4;
  const side = Math.floor(perimeter);
  const along = radius * (perimeter - side) * 2 - radius;
  switch (side) {
    case 0: return { position: [radius, along, 0], tangent: [0, 1, 0], normal: [1, 0, 0] };
    case 1: return { position: [-along, radius, 0], tangent: [-1, 0, 0], normal: [0, 1, 0] };
    case 2: return { position: [-radius, -along, 0], tangent: [0, -1, 0], normal: [-1, 0, 0] };
    default: return { position: [along, -radius, 0], tangent: [1, 0, 0], normal: [0, -1, 0] };
  }
}

/** Split a count exactly, while keeping the first and last layers populated. */
function layerCounts(count, layers) {
  const base = Math.floor(count / layers);
  const extra = count % layers;
  return Array.from({ length: layers }, (_, index) => base + Number(index < extra));
}

// Allocate by perimeter so the narrow waist has the same spacing as the rims.
function weightedCounts(count, weights) {
  const minimum = count >= weights.length ? 1 : 0;
  const remaining = count - minimum * weights.length;
  const total = weights.reduce((sum, value) => sum + value, 0);
  const quotas = weights.map(value => remaining * value / total);
  const result = quotas.map(value => minimum + Math.floor(value));
  const order = quotas.map((value, index) => ({ index, fraction: value % 1 }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const left = count - result.reduce((a, b) => a + b, 0);
  for (let index = 0; index < left; index++) result[order[index].index]++;
  return result;
}

function orbit(count) {
  const sculptureCount = Math.round(count * 0.80);
  const result = [];
  const layers = Math.min(48, Math.max(1, Math.ceil(sculptureCount / 44)));
  const radii = Array.from({ length: layers }, (_, layer) => {
    const axial = layers === 1 ? 0 : layer / (layers - 1) * 2 - 1;
    return 3.7 + 9.8 * Math.abs(axial) ** 0.82;
  });
  const scale = count <= 1500 ? 1.18 : 1.04;
  weightedCounts(sculptureCount, radii).forEach((size, layer) => {
    const progress = layers === 1 ? 0.5 : layer / (layers - 1);
    const axial = progress * 2 - 1;
    const twist = (progress - 0.5) * 2.15;
    for (let index = 0; index < size; index++) {
      const point = squarePoint((index + (layer % 2) * 0.5) / size, radii[layer]);
      const position = rotateZ(point.position, twist);
      position[2] = axial * 14.5;
      // The wall retains its square double-cone silhouette, while the card
      // normal leans toward the viewer instead of becoming an edge-on stripe.
      const wall = rotateZ(point.normal, twist);
      const front = [wall[0] * 0.30, wall[1] * 0.30, 1];
      const tangent = rotateZ([1, 0, 0], twist * 0.10);
      result.push({ position, rotation: photoRotation(tangent, front), scale });
    }
  });

  const tilts = [[0.95, 0.22], [-0.75, 0.65], [0.35, -1.05]];
  layerCounts(count - sculptureCount, 3).forEach((size, ring) => {
    const [tiltX, tiltY] = tilts[ring];
    const tilt = ([x, y, z]) => {
      const cy = Math.cos(tiltY), sy = Math.sin(tiltY);
      const cx = Math.cos(tiltX), sx = Math.sin(tiltX);
      const u = x * cy + z * sy;
      const v = -x * sy + z * cy;
      return [u, y * cx - v * sx, y * sx + v * cx];
    };
    const radius = 22.1 + ring * 0.65;
    const normal = tilt([0, 0, 1]);
    const front = [normal[0] * 0.38, normal[1] * 0.38, 0.62 + normal[2] * 0.38];
    const cardScale = Math.max(0.62, Math.min(1.22, 130 / Math.max(1, size)));
    for (let index = 0; index < size; index++) {
      const angle = index / size * TAU + ring * 0.37;
      const position = tilt([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
      result.push({ position, rotation: photoRotation([1, 0, 0], front), scale: cardScale });
    }
  });
  return result;
}

function tunnel(count) {
  if (count <= 0) return [];
  const radius = 12.0;
  const result = [];
  const layers = Math.min(55, Math.max(1, Math.ceil(count / 55)));
  layerCounts(count, layers).forEach((size, layer) => {
    const progress = layers === 1 ? 0.5 : layer / (layers - 1);
    const z = progress * 130 - 65;
    const twist = (progress - 0.5) * 1.2;
    for (let index = 0; index < size; index += 1) {
      const point = squarePoint((index + (layer % 2) * 0.5) / size, radius);
      const position = rotateZ(point.position, twist);
      position[2] = z;
      const tangent = rotateZ([1, 0, 0], twist * 0.12);
      result.push({ position, rotation: photoRotation(tangent, [0, 0, 1]), scale: count <= 1500 ? 1.80 : 1.50 });
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
      const angle = progress * TAU * 3.5 + strand / strands * TAU;
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
 * Suggested views: orbit [0, 6, 55], sphere [0, 0, 55], helix [0, 4, 62].
 * Tunnel: [0, 0, 52] facing [0, 0, -65], FOV 75, slowly advance toward -Z.
 */
export function createFormation(id, count, portrait = 0) {
  if (!Object.hasOwn(BUILDERS, id)) throw new RangeError(`Unknown formation: ${id}`);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Formation count must be a non-negative safe integer");
  }
  const result = BUILDERS[id](count);
  const amount = Number.isFinite(portrait) ? Math.max(0, Math.min(1, portrait)) : 0;
  if (id === 'orbit' && amount > 0) {
    // Change the sculpture's depth, never the dimensions of an individual print.
    for (const photo of result) photo.position[2] *= 1 + amount * 0.33;
  }
  return result;
}
