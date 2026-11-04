import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from 'three';
import {
  FORMATIONS,
  createFormation,
  stellatedFacetRotation,
  STAR_CORE_A,
  STAR_EXPANDED_A,
  RING_RADII,
  RING_AXES,
  TUNNEL_RADIUS,
  TUNNEL_Z_MIN,
  TUNNEL_Z_MAX,
  TUNNEL_SPAN,
} from "./formations.js";
import { orbitPosition, restingViewFractions, portraitAmount, restRotation, REST_ROTATION } from './flight.js';

test("all formations preserve exact counts and produce deterministic finite transforms", () => {
  for (const { id } of FORMATIONS) {
    for (const count of [0, 1, 4, 39, 71, 2800, 3001]) {
      const formation = createFormation(id, count);
      assert.equal(formation.length, count, `${id}: ${count} photos`);
      assert.deepEqual(formation, createFormation(id, count), `${id}: deterministic`);
      for (const photo of formation) {
        assert.equal(photo.position.length, 3);
        assert.equal(photo.rotation.length, 3);
        assert.ok([...photo.position, ...photo.rotation, photo.scale].every(Number.isFinite));
        assert.ok(photo.scale > 0);
      }
    }
  }
});

test("orbit builds a 24-facet hyper-stellated octahedron inside four double-track armillary rings", () => {
  const count = 3000;
  const formation = createFormation("orbit", count);
  const sculptureCount = Math.round(count * 0.72);
  const sculpture = formation.slice(0, sculptureCount);
  const rings = formation.slice(sculptureCount);
  assert.equal(sculpture.length, 2160);
  assert.equal(rings.length, 840);
  for (const { position } of formation) assert.ok(Math.hypot(...position) <= 23.6);

  const facets = new Map();
  const octantPeaks = new Array(8).fill(0);
  const normal = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();

  for (const card of sculpture) {
    assert.equal(card.ring, -1);
    assert.ok(card.facet >= 0 && card.facet < 24);
    assert.equal(card.breathDelta.length, 3);
    facets.set(card.facet, (facets.get(card.facet) || 0) + 1);
    const radius = Math.hypot(...card.position);
    assert.ok(radius < RING_RADII[0], "star spikes stay inside the innermost armillary ring");
    const octant = Math.floor(card.facet / 3);
    octantPeaks[octant] = Math.max(octantPeaks[octant], radius);

    normal.set(0, 0, 1).applyQuaternion(quaternion.setFromEuler(euler.fromArray(card.rotation)));
    const dot = normal.x * card.position[0] + normal.y * card.position[1] + normal.z * card.position[2];
    assert.ok(dot > 0, "every stellated facet faces outward from the origin");
  }
  assert.equal(facets.size, 24);
  for (const peak of octantPeaks) {
    assert.ok(peak > 17.5, "all eight cube-diagonal star tips extend boldly toward the rings");
  }

  const ringBuckets = new Map();
  for (const card of rings) {
    assert.ok(card.ring >= 0 && card.ring < 4);
    ringBuckets.set(card.ring, (ringBuckets.get(card.ring) || 0) + 1);
    const expectedRadius = Math.hypot(RING_RADII[card.ring], 0.41);
    assert.ok(Math.abs(Math.hypot(...card.position) - expectedRadius) < 1e-6);
  }
  assert.equal(ringBuckets.size, 4);
  for (let i = 0; i < RING_AXES.length; i++) {
    for (let j = i + 1; j < RING_AXES.length; j++) {
      const dot = RING_AXES[i].reduce((sum, v, k) => sum + v * RING_AXES[j][k], 0);
      assert.ok(Math.abs(dot) < 0.95, "armillary rings occupy distinct inclined planes");
    }
  }
});

test("tunnel builds a periodic wall-flush square corridor with upright wall photographs", () => {
  const count = 3000;
  const formation = createFormation("tunnel", count);
  const layers = Math.min(60, Math.ceil(count / 48));
  const depths = [...new Set(formation.map(({ position }) => position[2]))];
  assert.equal(depths.length, layers);
  assert.equal(TUNNEL_SPAN, 180);
  const pitch = TUNNEL_SPAN / layers;
  assert.ok(Math.abs(depths[0] - (TUNNEL_Z_MIN + 0.5 * pitch)) < 1e-10);
  assert.ok(Math.abs(depths.at(-1) - (TUNNEL_Z_MAX - 0.5 * pitch)) < 1e-10);
  for (let index = 1; index < depths.length; index += 1) {
    assert.ok(Math.abs((depths[index] - depths[index - 1]) - pitch) < 1e-10);
  }

  const normal = new THREE.Vector3();
  const up = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();

  for (const { position: [x, y, z], rotation } of formation) {
    assert.ok(Math.hypot(x, y) >= TUNNEL_RADIUS - 1e-9, "no photo intrudes into the tunnel");
    assert.ok(Math.hypot(x, y) <= Math.SQRT2 * TUNNEL_RADIUS + 1e-9);
    assert.ok(z >= TUNNEL_Z_MIN && z <= TUNNEL_Z_MAX);
    assert.ok(Math.abs(Math.max(Math.abs(x), Math.abs(y)) - TUNNEL_RADIUS) < 1e-9, "the corridor has straight square walls");

    quaternion.setFromEuler(euler.fromArray(rotation));
    normal.set(0, 0, 1).applyQuaternion(quaternion);
    up.set(0, 1, 0).applyQuaternion(quaternion);
    if (Math.abs(x - TUNNEL_RADIUS) < 1e-9) {
      assert.ok(normal.x < -0.999999, "right wall faces inward");
      assert.ok(up.y > 0.999999, "right wall photographs stand upright");
    } else if (Math.abs(x + TUNNEL_RADIUS) < 1e-9) {
      assert.ok(normal.x > 0.999999, "left wall faces inward");
      assert.ok(up.y > 0.999999, "left wall photographs stand upright");
    } else if (Math.abs(y - TUNNEL_RADIUS) < 1e-9) {
      assert.ok(normal.y < -0.999999, "ceiling faces downward into corridor");
    } else {
      assert.ok(normal.y > 0.999999, "floor faces upward into corridor");
    }
  }
});

test("dense tunnel prints form closed square portals while leaving crisp dark gaps", () => {
  const formation = createFormation("tunnel", 3000);
  const rows = new Map();
  for (const card of formation) {
    if (!rows.has(card.position[2])) rows.set(card.position[2], []);
    rows.get(card.position[2]).push(card);
  }
  for (const cards of rows.values()) {
    const spacing = (TUNNEL_RADIUS * 8) / cards.length;
    assert.ok((1.08 * cards[0].scale) / spacing <= 0.82, "dense rows reserve clear negative space between frames");
    assert.ok((1.08 * cards[0].scale) / spacing > 0.68, "prints remain bold and readable at full tunnel density");
  }
  assert.ok(createFormation("tunnel", 1200).every(card => card.scale === 1.48));
});

test("sphere lies on a Fibonacci shell and helix stays within viewing bounds", () => {
  for (const { position } of createFormation("sphere", 3000)) {
    assert.ok(Math.abs(Math.hypot(...position) - 20) < 1e-10);
  }
  for (const { position: [x, y, z] } of createFormation("helix", 3000)) {
    assert.ok(Math.hypot(x, y) <= 12.2 + 1e-9);
    assert.ok(Math.abs(z) <= 24);
    assert.ok(Math.hypot(x, y, z) < 27);
  }
});

test("invalid ids and counts fail clearly", () => {
  assert.throws(() => createFormation("missing", 10), RangeError);
  assert.throws(() => createFormation("constructor", 10), RangeError);
  for (const count of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createFormation("orbit", count), RangeError);
  }
});

test("stellated facet normals pivot smoothly during crystalline expansion", () => {
  const qCore = new THREE.Quaternion();
  const qExpanded = new THREE.Quaternion();
  const euler = new THREE.Euler();
  for (let facet = 0; facet < 24; facet++) {
    qCore.setFromEuler(euler.fromArray(stellatedFacetRotation(facet, STAR_CORE_A)));
    qExpanded.setFromEuler(euler.fromArray(stellatedFacetRotation(facet, STAR_EXPANDED_A)));
    const angle = qCore.angleTo(qExpanded);
    assert.ok(angle > 0.25 && angle < 1.25, `facet ${facet} tilts cleanly into crystal lattice`);
  }
});

test('full card corners fit portrait safe margins and make a large desktop sculpture', () => {
  const point = new THREE.Vector3(), quaternion = new THREE.Quaternion(), euler = new THREE.Euler();
  for (const [width, height] of [[1440, 900], [390, 844], [320, 568]]) {
    const camera = new THREE.PerspectiveCamera(54, width / height, 0.08, 600);
    camera.position.fromArray(orbitPosition(width / height));
    camera.lookAt(0, 0, 0);
    camera.setViewOffset(width, height, 0, restingViewFractions(width / height).y * height, width, height);
    camera.updateMatrixWorld();
    const rotation = restRotation(width / height);
    const formation = createFormation('orbit', 1200, portraitAmount(width / height));
    const angles = width > height ? [rotation[1], Math.PI / 2, Math.PI, Math.PI * 1.5] : [rotation[1] - 0.06, rotation[1], rotation[1] + 0.06];
    for (const angle of angles) {
      const group = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], angle, rotation[2]));
      let top = Infinity, bottom = -Infinity;
      for (const card of formation) {
        quaternion.setFromEuler(euler.fromArray(card.rotation));
        for (const [x, y] of [[-.54, -.36], [.54, -.36], [.54, .36], [-.54, .36]]) {
          point.set(x * card.scale, y * card.scale, 0).applyQuaternion(quaternion);
          point.x += card.position[0]; point.y += card.position[1]; point.z += card.position[2];
          point.applyQuaternion(group).project(camera);
          assert.ok(Math.abs(point.x) < 0.92, `horizontal border at ${width}x${height}`);
          assert.ok(point.y < 0.88 && point.y > -0.84, `navigation/brand border at ${width}x${height}`);
          top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
        }
      }
      if (width > height && angle === REST_ROTATION[1]) assert.ok((bottom - top) / 2 > 0.55, 'desktop sculpture fills at least 55% of the canvas height');
      if (width < height && angle === rotation[1]) assert.ok((bottom - top) / 2 > 0.55, 'portrait sculpture fills at least 55% of the canvas height');
    }
  }
});

test('portrait layout only elongates the orbit centres, keeping every photograph undistorted', () => {
  for (const count of [1200, 3000]) {
    const desktop = createFormation('orbit', count);
    for (const amount of [0.25, 0.5, 1]) {
      const portrait = createFormation('orbit', count, amount);
      portrait.forEach((photo, index) => {
        assert.equal(photo.position[0], desktop[index].position[0]);
        assert.equal(photo.position[1], desktop[index].position[1]);
        assert.equal(photo.position[2], desktop[index].position[2] * (1 + amount * 0.33));
        assert.equal(photo.scale, desktop[index].scale);
        assert.deepEqual(photo.rotation, desktop[index].rotation);
      });
    }
    assert.deepEqual(createFormation('tunnel', count, 1), createFormation('tunnel', count));
  }
});
