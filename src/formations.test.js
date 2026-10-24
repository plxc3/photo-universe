import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from 'three';
import { FORMATIONS, createFormation } from "./formations.js";
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

test("orbit keeps a hollow square double cone inside three separate photo rings", () => {
  const count = 3000;
  const formation = createFormation("orbit", count);
  const ringCount = count - Math.round(count * 0.80);
  const sculpture = formation.slice(0, count - ringCount);
  const rings = formation.slice(count - ringCount);
  assert.equal(rings.length, ringCount);
  assert.equal(sculpture.length, 2400);
  for (const { position } of formation) assert.ok(Math.hypot(...position) <= 24.1);
  for (const { position: [x, y, z] } of sculpture) {
    assert.ok(Math.hypot(x, y) >= 3.7, "waist stays open");
    assert.ok(Math.abs(z) <= 14.5, "both cones stay bounded");
    const twist = z / 29 * 2.15;
    const localX = x * Math.cos(twist) + y * Math.sin(twist);
    const localY = -x * Math.sin(twist) + y * Math.cos(twist);
    const radius = 3.7 + 9.8 * (Math.abs(z) / 14.5) ** 0.82;
    assert.ok(Math.abs(Math.max(Math.abs(localX), Math.abs(localY)) - radius) < 1e-9, 'square wall profile');
  }
  assert.ok(sculpture.some(({ position }) => position[2] === 14.5), "front rim");
  assert.ok(sculpture.some(({ position }) => position[2] === -14.5), "back rim");
  const radii = rings.map(({ position }) => Math.hypot(...position));
  assert.deepEqual([...new Set(radii.map(radius => radius.toFixed(2)))], ['22.10', '22.75', '23.40']);
});

test("tunnel keeps a clear axial passage and square photo frames", () => {
  const count = 2800;
  const formation = createFormation("tunnel", count);
  const layers = Math.min(55, Math.ceil(count / 55));
  const depths = [...new Set(formation.map(({ position }) => position[2]))];
  assert.equal(depths.length, layers);
  assert.equal(depths[0], -65);
  assert.equal(depths.at(-1), 65);
  for (let index = 1; index < depths.length; index += 1) {
    assert.ok(Math.abs((depths[index] - depths[index - 1]) - 130 / (layers - 1)) < 1e-10);
  }
  for (const { position: [x, y, z] } of formation) {
    assert.ok(Math.hypot(x, y) >= 12 - 1e-9, "no photo intrudes into the tunnel");
    assert.ok(Math.hypot(x, y) <= Math.SQRT2 * 12 + 1e-9);
    assert.ok(Math.abs(z) <= 65);
    assert.ok(Math.abs(Math.max(Math.abs(x), Math.abs(y)) - 12) < 1e-9, 'the resting corridor has straight square walls');
  }
});

test('dense tunnel prints leave black gaps between the square frames', () => {
  const formation = createFormation('tunnel', 3000);
  const rows = new Map();
  for (const card of formation) {
    if (!rows.has(card.position[2])) rows.set(card.position[2], []);
    rows.get(card.position[2]).push(card);
  }
  for (const cards of rows.values()) {
    const spacing = 96 / cards.length;
    assert.ok(1.08 * cards[0].scale / spacing <= 0.81, 'dense rows reserve at least 19% of their perimeter for negative space');
    assert.ok(1.08 * cards[0].scale / spacing > 0.75, 'prints remain readable at full tunnel density');
  }
  assert.ok(createFormation('tunnel', 1200).every(card => card.scale === 1.8), 'the less dense tunnel retains its established size');
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

test('double-cone rows keep a clear waist by assigning cards in proportion to perimeter', () => {
  for (const count of [1200, 3000]) {
    const rows = new Map();
    const body = createFormation('orbit', count).slice(0, Math.round(count * 0.8));
    for (const card of body) {
      const z = card.position[2];
      if (!rows.has(z)) rows.set(z, []);
      rows.get(z).push(card);
    }
    const depths = [...rows.keys()];
    assert.ok(rows.size <= 48);
    assert.ok(depths[1] - depths[0] >= 0.61, 'axial rows are separated');
    const waist = [...rows.entries()].sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]))[0][1];
    const rim = rows.get(depths[0]);
    assert.ok(waist.length < rim.length * 0.5, 'the waist must have fewer cards than the rim');
    for (const [z, cards] of rows) {
      const radius = 3.7 + 9.8 * (Math.abs(z) / 14.5) ** 0.82;
      const spacing = radius * 8 / cards.length;
      assert.ok(spacing > 1.08 * cards[0].scale + 0.05, 'card widths leave a visible gap along each row');
    }
    const normal = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    for (const card of body) {
      normal.set(0, 0, 1).applyQuaternion(quaternion.setFromEuler(euler.fromArray(card.rotation)));
      assert.ok(normal.z > 0.9, 'photographs present readable faces rather than thin wall edges');
    }
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
