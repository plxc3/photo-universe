import test from "node:test";
import assert from "node:assert/strict";
import { FORMATIONS, createFormation } from "./formations.js";

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

test("orbit contains a hollow sculpture and three enclosing orbital rings", () => {
  const count = 3000;
  const formation = createFormation("orbit", count);
  const sculpture = formation.slice(0, Math.round(count * 0.8));
  const rings = formation.slice(sculpture.length);
  for (const { position } of formation) assert.ok(Math.hypot(...position) <= 24.1);
  for (const { position: [x, y, z] } of sculpture) {
    assert.ok(Math.hypot(x, y) >= 3.7 - 1e-9, "center stays open");
    assert.ok(Math.abs(z) <= 14.5);
  }
  assert.equal(rings.length, 600);
  const radii = new Set(rings.map(({ position }) => Math.hypot(...position).toFixed(2)));
  assert.deepEqual([...radii], ["22.10", "22.75", "23.40"]);
});

test("tunnel has seventy evenly distributed square frames and a clear axial passage", () => {
  const formation = createFormation("tunnel", 2800);
  const depths = [...new Set(formation.map(({ position }) => position[2]))];
  assert.equal(depths.length, 70);
  assert.equal(depths[0], -65);
  assert.equal(depths.at(-1), 65);
  for (let index = 1; index < depths.length; index += 1) {
    assert.ok(Math.abs((depths[index] - depths[index - 1]) - 130 / 69) < 1e-10);
  }
  for (let index = 0; index < formation.length; index += 1) {
    const { position: [x, y, z], rotation: [rx, ry] } = formation[index];
    assert.ok(Math.hypot(x, y) >= 12 - 1e-9, "no photo intrudes into the tunnel");
    assert.ok(Math.hypot(x, y) <= Math.SQRT2 * 12 + 1e-9);
    assert.ok(Math.abs(z) <= 65);
    const progress = (z + 65) / 130;
    const angle = -(progress - 0.5) * 2.05;
    const localX = x * Math.cos(angle) - y * Math.sin(angle);
    const localY = x * Math.sin(angle) + y * Math.cos(angle);
    assert.ok(Math.abs(Math.max(Math.abs(localX), Math.abs(localY)) - 12) < 1e-9);
    assert.equal(rx, -0);
    assert.equal(ry, 0);
  }
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
