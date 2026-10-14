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

function orbit(count) {
  const sculptureCount = Math.round(count * 0.8);
  const result = [];
  const layers = Math.min(64, Math.max(1, Math.ceil(sculptureCount / 38)));

  layerCounts(sculptureCount, layers).forEach((size, layer) => {
    const progress = layers === 1 ? 0.5 : layer / (layers - 1);
    const axial = progress * 2 - 1;
    const z = axial * 14.5;
    const radius = 3.7 + 9.8 * Math.pow(Math.abs(axial), 0.82);
    const twist = (progress - 0.5) * 2.15;
    // Slope gives each photo a visible face on the pyramid wall.
    const slope = Math.sign(axial) * (9.8 * 0.82 / 14.5)
      * Math.pow(Math.max(0.05, Math.abs(axial)), -0.18);
    for (let index = 0; index < size; index += 1) {
      const point = squarePoint(index / size, radius);
      const position = rotateZ(point.position, twist);
      position[2] = z;
      const tangent = rotateZ(point.tangent, twist);
      const front = rotateZ([point.normal[0], point.normal[1], -slope], twist);
      result.push({ position, rotation: photoRotation(tangent, front), scale: 0.87 });
    }
  });

  const ringCount = count - sculptureCount;
  const tilts = [[0.95, 0.22], [-0.75, 0.65], [0.35, -1.05]];
  layerCounts(ringCount, 3).forEach((size, ring) => {
    const [tiltX, tiltY] = tilts[ring];
    const tilt = ([x, y, z]) => {
      const cy = Math.cos(tiltY), sy = Math.sin(tiltY);
      const cx = Math.cos(tiltX), sx = Math.sin(tiltX);
      const u = x * cy + z * sy;
      const v = -x * sy + z * cy;
      return [u, y * cx - v * sx, y * sx + v * cx];
    };
    for (let index = 0; index < size; index += 1) {
      const angle = index / size * TAU + ring * 0.37;
      const radius = 22.1 + ring * 0.65;
      const position = tilt([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
      const tangent = tilt([-Math.sin(angle), Math.cos(angle), 0]);
      result.push({ position, rotation: photoRotation(tangent, tilt([0, 0, 1])), scale: 0.60 });
    }
  });
  return result;
}

function tunnel(count) {
  const result = [];
  const layers = Math.min(70, Math.max(1, Math.ceil(count / 40)));
  layerCounts(count, layers).forEach((size, layer) => {
    const progress = layers === 1 ? 0.5 : layer / (layers - 1);
    const z = progress * 130 - 65;
    const twist = (progress - 0.5) * 2.05;
    for (let index = 0; index < size; index += 1) {
      const point = squarePoint(index / size, 12);
      const position = rotateZ(point.position, twist);
      position[2] = z;
      const tangent = rotateZ(point.tangent, twist);
      result.push({ position, rotation: photoRotation(tangent, [0, 0, 1]), scale: 1.65 });
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
export function createFormation(id, count) {
  if (!Object.hasOwn(BUILDERS, id)) throw new RangeError(`Unknown formation: ${id}`);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Formation count must be a non-negative safe integer");
  }
  return BUILDERS[id](count);
}
