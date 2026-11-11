import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function repairNeighbourDuplicates(pool, uniqueCount) {
  if (uniqueCount <= 1) return pool;
  for (let index = 1; index < pool.length; index++) {
    const repeated = pool[index].photoIndex;
    if (pool[index - 1].photoIndex !== repeated) continue;
    for (let step = 1; step < pool.length; step++) {
      const target = (index + step) % pool.length;
      if (target === index - 1 || pool[target].photoIndex === repeated) continue;
      if (target > 0 && target - 1 !== index && pool[target - 1].photoIndex === repeated) continue;
      if (target + 1 < pool.length && target + 1 !== index && pool[target + 1].photoIndex === repeated) continue;
      [pool[index], pool[target]] = [pool[target], pool[index]];
      break;
    }
  }
  return pool;
}

export function shuffledPhotoPool(photos, count) {
  const pool = Array.from({ length: count }, (_, index) => photos[index % photos.length]);
  let seed = (0x6d656d6f ^ count ^ photos.length) >>> 0;
  for (let index = pool.length - 1; index > 0; index--) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const target = (seed >>> 0) % (index + 1);
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  return repairNeighbourDuplicates(pool, photos.length);
}

/**
 * Perceptual OKLab chromatic flow pool: orders cards along a continuous warm-gold
 * to crimson, violet, cobalt, emerald, and silver spectrum with gentle local
 * golden-ratio dither while preserving exact balanced quotas and neighbour uniqueness.
 */
export function chromaticPhotoPool(successful, photos, count) {
  const hasSpectral = Array.isArray(photos) && successful.some(
    (entry) => Number.isFinite(photos[entry.photoIndex]?.spectralKey),
  );
  if (!hasSpectral) return shuffledPhotoPool(successful, count);

  const sorted = [...successful].sort((a, b) => {
    const ka = photos[a.photoIndex]?.spectralKey ?? 0.5;
    const kb = photos[b.photoIndex]?.spectralKey ?? 0.5;
    return ka - kb || a.photoIndex - b.photoIndex;
  });

  const uniqueCount = sorted.length;
  const windowSpan = Math.min(uniqueCount - 1, Math.max(2, uniqueCount * 0.14));
  const ranked = Array.from({ length: count }, (_, index) => {
    const rank = index % uniqueCount;
    const copyIndex = Math.floor(index / uniqueCount);
    const dither = (((copyIndex * 0.61803398875 + rank * 0.38196601125) % 1) - 0.5) * windowSpan;
    return { entry: sorted[rank], score: rank + dither, index };
  });
  ranked.sort((a, b) => a.score - b.score || a.index - b.index);
  return repairNeighbourDuplicates(ranked.map((item) => item.entry), uniqueCount);
}

export function deterministicHash(index) {
  let x = ((index + 1) * 0x9e3779b1) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 0xffffffff;
}

export function aspectScaleFactors(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) return [1, 1];
  const ratio = clamp(aspect, 0.68, 1.55) / 1.5;
  const root = Math.sqrt(ratio);
  return [clamp(root, 0.70, 1.04), clamp(1 / root, 0.96, 1.32)];
}

// C2 soft-launch, long velvet-out glide: zero initial velocity shock (f'(0) = 0)
// and feathered zero-overshoot cushion landing (f'(1) = 0, max = 1.0).
export function silkFlightEase(value) {
  const u = clamp(value, 0, 1);
  return 1 - Math.pow(1 - u * u, 2.8);
}

// Matches the 3-point gallery chiaroscuro in the InstancedMesh fragment shader
// so a clicked 3D crystal card never flashes in brightness on frame 0 of lift-off.
export function computeFacetSculptShade(worldNormal, tunnelFactor = 0) {
  const nx = worldNormal?.x ?? 0;
  const ny = worldNormal?.y ?? 0;
  const nz = worldNormal?.z ?? 1;
  const keyLight = clamp(nx * -0.48 + ny * 0.60 + nz * 0.64, 0, 1);
  const rimLight = clamp(nx * 0.6996 + ny * 0.2199 + nz * -0.6796, 0, 1);
  const skyFill = clamp(ny * 0.5 + 0.5, 0, 1);
  const kPow = Math.pow(keyLight, 1.15);
  const rPow = Math.pow(rimLight, 1.6);
  const sx = 0.38 + 0.84 * kPow + 0.24 * rPow + 0.07 * skyFill;
  const sy = 0.40 + 0.81 * kPow + 0.27 * rPow + 0.08 * skyFill;
  const sz = 0.45 + 0.76 * kPow + 0.34 * rPow + 0.10 * skyFill;
  const tf = clamp(tunnelFactor, 0, 1);
  return new THREE.Vector3(
    clamp(THREE.MathUtils.lerp(sx, 1.03, tf), 0.35, 1.12),
    clamp(THREE.MathUtils.lerp(sy, 1.02, tf), 0.35, 1.12),
    clamp(THREE.MathUtils.lerp(sz, 1.00, tf), 0.35, 1.12),
  );
}
