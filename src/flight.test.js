import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sampleFlight, orbitFraming, orbitPosition, portraitAmount, restRotation, FILM, REST_ROTATION } from './flight.js';
import { PhotoUniverse } from './scene.js';

const DESKTOP = 16 / 9;
const MOBILE = 9 / 16;

const isFiniteVec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function expectShape(s) {
  assert.ok(s.mode === 'orbit' || s.mode === 'tunnel', `bad mode ${s.mode}`);
  assert.ok(isFiniteVec(s.position), 'position not finite vec');
  assert.ok(isFiniteVec(s.target), 'target not finite vec');
  assert.ok(isFiniteVec(s.up), 'up not finite vec');
  assert.ok(isFiniteVec(s.rotation), 'rotation not finite vec');
  assert.ok(Number.isFinite(s.fov), 'fov not finite');
}

test('keyframes: orbit mouth, tunnel entrance, tunnel exit and final orbit', () => {
  const p0 = sampleFlight(0, DESKTOP);
  assert.equal(p0.mode, 'orbit');
  assert.equal(p0.fov, 54);
  assert.deepEqual(p0.target, [0, 0, 0]);
  assert.deepEqual(p0.up, [0, 1, 0]);
  assert.ok(dist(p0.position, [0, 0, 0]) > 60, 'starts outside the halo');
  assert.ok(p0.position[0] > 0 && p0.position[1] > 0, 'starts above-right');
  assert.deepEqual(p0.rotation, REST_ROTATION);

  const entrance = sampleFlight(FILM.phase1, DESKTOP);
  assert.equal(entrance.mode, 'tunnel');
  assert.deepEqual(entrance.position, [0, 0, 76]);
  assert.deepEqual(entrance.target, [0, 0, 0]);
  assert.deepEqual(entrance.up, [0, 1, 0]);
  assert.equal(entrance.fov, 72);
  assert.deepEqual(entrance.rotation, [0, 0, 0]);

  const tunnelExit = sampleFlight(FILM.phase2End, DESKTOP);
  assert.equal(tunnelExit.mode, 'orbit');
  assert.deepEqual(tunnelExit.position, [0, 0, 2]);
  assert.deepEqual(tunnelExit.target, [0, 0, -74]);
  assert.deepEqual(tunnelExit.up, [0, 1, 0]);
  assert.equal(tunnelExit.fov, 72);
  assert.deepEqual(tunnelExit.rotation, [0, 0, 0]);

  const final = sampleFlight(FILM.total, DESKTOP);
  assert.equal(final.mode, 'orbit');
  assert.deepEqual(final.target, [0, 0, 0]);
  assert.deepEqual(final.up, [0, 1, 0]);
  assert.equal(final.fov, 54);
  REST_ROTATION.forEach((value, index) => assert.ok(Math.abs(final.rotation[index] - value) < 1e-9));
  assert.ok(Math.abs(dist(final.position, [0, 0, 0]) - orbitFraming(DESKTOP).distance) < 1e-9);
});

test('mobile starts and ends wider while sharing the tunnel anchor', () => {
  const desk = orbitFraming(DESKTOP);
  const mobile = orbitFraming(MOBILE);
  assert.equal(desk.mobile, false);
  assert.equal(mobile.mobile, true);
  assert.ok(mobile.distance > desk.distance + 20);

  const start = sampleFlight(0, MOBILE);
  assert.ok(dist(start.position, [0, 0, 0]) > dist(sampleFlight(0, DESKTOP).position, [0, 0, 0]) + 20);
  assert.deepEqual(sampleFlight(FILM.phase1, MOBILE).position, [0, 0, 76]);
  assert.deepEqual(sampleFlight(FILM.phase2End, MOBILE).position, [0, 0, 2]);
  const end = sampleFlight(FILM.total, MOBILE);
  assert.ok(Math.abs(dist(end.position, [0, 0, 0]) - mobile.distance) < 1e-9);
});

test('portrait framing blends continuously into its upright pose and distance', () => {
  for (const aspect of [9 / 16, 0.46, 0.5, 0.5625, 0.79]) {
    const framing = orbitFraming(aspect, 54);
    assert.equal(framing.mobile, true, `aspect ${aspect}`);
    assert.ok(Number.isFinite(framing.distance) && framing.distance > 0);
    assert.ok(portraitAmount(aspect) > 0.9);
    assert.ok(restRotation(aspect)[0] < -0.9);
  }
});

test('boundary continuity at the tunnel entrance and exit', () => {
  const eps = 1e-5;
  const tolerance = 0.02;
  for (const aspect of [DESKTOP, MOBILE]) {
    for (const boundary of [FILM.phase1, FILM.phase2End]) {
      const before = sampleFlight(boundary - eps, aspect);
      const at = sampleFlight(boundary, aspect);
      const after = sampleFlight(boundary + eps, aspect);
      for (const sample of [before, after]) {
        assert.ok(dist(before.position, sample.position) < tolerance);
        assert.ok(dist(before.target, sample.target) < tolerance);
        assert.ok(dist(before.up, sample.up) < tolerance);
        assert.ok(Math.abs(before.fov - sample.fov) < tolerance);
        assert.ok(dist(before.rotation, sample.rotation) < tolerance);
      }
      assert.ok(dist(at.position, before.position) < tolerance);
      assert.ok(dist(at.target, before.target) < tolerance);
    }
  }
});

test('time clamping and non-finite safety', () => {
  assert.deepEqual(sampleFlight(-10, DESKTOP).position, sampleFlight(0, DESKTOP).position);
  assert.deepEqual(sampleFlight(999, DESKTOP).position, sampleFlight(FILM.total, DESKTOP).position);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) {
    expectShape(sampleFlight(bad, DESKTOP));
  }
  expectShape(sampleFlight(3));
  expectShape(sampleFlight(10, NaN));
  expectShape(sampleFlight(10, 0));
  expectShape(sampleFlight(10, -5));
});

test('every sample: finite, unit up, camera separate from target, FOV in range', () => {
  for (const aspect of [DESKTOP, MOBILE]) {
    for (let t = 0; t <= FILM.total + 1e-9; t += 0.1) {
      const s = sampleFlight(t, aspect);
      expectShape(s);
      assert.ok(Math.abs(Math.hypot(...s.up) - 1) < 1e-6, `up not unit at ${t}`);
      assert.ok(dist(s.position, s.target) > 1e-3, `camera coincides target at ${t}`);
      assert.ok(s.fov >= 54 - 1e-9 && s.fov <= 72 + 1e-9, `fov out of range at ${t}`);
    }
  }
});

test('tunnel phase advances through the corridor and rolls back to level', () => {
  let maxRoll = 0;
  for (let t = FILM.phase1 + 0.01; t < FILM.phase2End; t += 0.05) {
    const s = sampleFlight(t, DESKTOP);
    assert.equal(s.mode, 'tunnel');
    assert.ok(s.position[2] > 0 && s.position[2] <= 76);
    assert.equal(s.fov, 72);
    assert.ok(Math.abs(s.rotation[2]) <= 0.55 + 1e-9);
    maxRoll = Math.max(maxRoll, Math.abs(s.rotation[2]));
  }
  assert.ok(maxRoll > 0.45, 'the corridor rolls visibly');
  assert.ok(Math.abs(sampleFlight(FILM.phase1, DESKTOP).rotation[2]) < 1e-9);
  assert.ok(Math.abs(sampleFlight(FILM.phase2End, DESKTOP).rotation[2]) < 1e-9);
});

test('phase motion is smooth and does not jump at segment boundaries', () => {
  const step = 0.05;
  const maxJump = 8;
  for (const aspect of [DESKTOP, MOBILE]) {
    for (let t = 0; t < FILM.total - step; t += step) {
      const straddles = (t < FILM.phase1 && t + step > FILM.phase1)
        || (t < FILM.phase2End && t + step > FILM.phase2End);
      if (straddles) continue;
      const a = sampleFlight(t, aspect);
      const b = sampleFlight(t + step, aspect);
      const positionJump = t >= FILM.phase2End ? 30 : maxJump;
      assert.ok(dist(a.position, b.position) < positionJump, `position jump at ${t}`);
      assert.ok(dist(a.target, b.target) < maxJump, `target jump at ${t}`);
      assert.ok(dist(a.rotation, b.rotation) < 1, `rotation jump at ${t}`);
      assert.ok(Math.abs(a.fov - b.fov) < 2, `fov jump at ${t}`);
    }
  }
});

test('natural film end is continuous into the resting shot', () => {
  for (const aspect of [DESKTOP, MOBILE]) {
    const last = sampleFlight(FILM.total, aspect);
    const justBefore = sampleFlight(FILM.total - 0.05, aspect);
    assert.ok(dist(justBefore.position, last.position) < 2, `end position jump ${aspect}`);
    assert.ok(dist(justBefore.target, last.target) < 0.3, `end target jump ${aspect}`);
    assert.ok(dist(justBefore.rotation, last.rotation) < 0.2, `end rotation jump ${aspect}`);
    assert.equal(last.mode, 'orbit');
    assert.deepEqual(last.target, [0, 0, 0]);
    assert.equal(last.fov, 54);
    assert.deepEqual(sampleFlight(FILM.total + 5, aspect).position, last.position);
  }
});

// ---------------------------------------------------------------------------
// Behavioral tests: run the real PhotoUniverse methods on a hand-built instance
// (real THREE camera/scene/group + fake renderer/container/controls, no WebGL DOM).
// ---------------------------------------------------------------------------

globalThis.document = globalThis.document || { hidden: false };

function makeFakeControls() {
  return {
    target: new THREE.Vector3(),
    enabled: true,
    enableDamping: true,
    dampingFactor: 0.07,
    minDistance: 4,
    maxDistance: 150,
    update() { return false; },
    addEventListener() {},
    dispose() {},
  };
}

function buildHarness(width, height) {
  globalThis.document.hidden = false;
  const O = Object.create(PhotoUniverse.prototype);
  O.camera = new THREE.PerspectiveCamera(54, width / height, 0.08, 360);
  O.scene = new THREE.Scene();
  O.group = new THREE.Group();
  O.scene.add(O.group);
  O.controls = makeFakeControls();
  O.renderer = { setSize() {}, render() {}, setAnimationLoop() {}, dispose() {}, capabilities: { getMaxAnisotropy: () => 8 } };
  O.container = { getBoundingClientRect: () => ({ width, height }) };
  O.callbacks = {};
  O.mode = 'orbit';
  O.film = null;
  O.elapsed = 0;
  O.running = true;
  O.speed = 0.7;
  O.reducedMotion = false;
  O.defaultView = true;
  O._viewW = width;
  O._viewH = height;
  O._tmpVec = new THREE.Vector3();
  O.dummy = new THREE.Object3D();
  O.instances = [];
  O.meshes = [];
  O.textures = [];
  O.atlasCanvases = new Set();
  O.instanceDirty = false;
  O.boundsDirty = false;
  O.viewTransition = null;
  O.lastTime = 0;
  O.setFormation = () => {};
  O.applyViewOffset();
  return O;
}

const projElements = (cam) => cam.projectionMatrix.elements.slice();
const maxMatrixDiff = (a, b) => a.reduce((max, value, index) => Math.max(max, Math.abs(value - b[index])), 0);

test('behaviour: natural film end keeps projection offset and camera stable', () => {
  for (const [w, h] of [[390, 844], [1280, 720], [640, 360]]) {
    const O = buildHarness(w, h);
    O.film = { start: 0, phase: 'orbit', elapsed: 0 };
    O.updateFilm((FILM.total - 0.001) * 1000);
    const projNear = projElements(O.camera);
    const posNear = O.camera.position.clone();
    O.updateFilm(FILM.total * 1000);
    assert.equal(O.film, null, 'film cleared on natural end');
    const projAfter = projElements(O.camera);
    const posAfter = O.camera.position.clone();
    assert.ok(maxMatrixDiff(projNear, projAfter) < 0.01, `projection jump @ ${w}x${h}`);
    assert.ok(posNear.distanceTo(posAfter) < 0.01, `camera position jump @ ${w}x${h}`);
    assert.ok(Math.abs(O.group.rotation.x - restRotation(w / h)[0]) < 1e-9, `group x not preserved @ ${w}x${h}`);
  }
});

test('behaviour: first interactive frame after natural end does not snap', () => {
  const O = buildHarness(390, 844);
  O.film = { start: 0, phase: 'orbit', elapsed: 0 };
  O.elapsed = 12.3;
  O.updateFilm(FILM.total * 1000);
  const filmEndX = O.group.rotation.x;
  assert.ok(Math.abs(filmEndX - restRotation(390 / 844)[0]) < 1e-9, 'film ends with the chosen establishing tilt');
  O.lastTime = FILM.total * 1000;
  O.animate(FILM.total * 1000 + 16);
  assert.ok(Math.abs(O.group.rotation.x - filmEndX) < 0.005, 'first interactive frame stays continuous');
});

test('behaviour: resize re-fits default orbit distance across portrait/landscape', () => {
  const O = buildHarness(390, 844);
  O.controls.target.set(0, 0, 0);
  O.camera.position.set(6, 14, 103.6);
  O.resize();
  const portrait = orbitFraming(390 / 844, 54).distance;
  const distPortrait = O.camera.position.length();
  assert.ok(Math.abs(distPortrait - portrait) < 1e-3, `portrait distance ${distPortrait} != ${portrait}`);
  O.container.getBoundingClientRect = () => ({ width: 640, height: 360 });
  O._viewW = 640;
  O._viewH = 360;
  O.resize();
  const landscape = orbitFraming(640 / 360, 54).distance;
  const distLandscape = O.camera.position.length();
  assert.ok(Math.abs(distLandscape - landscape) < 1e-3, `landscape distance ${distLandscape} != ${landscape}`);
  assert.ok(distLandscape < distPortrait - 20, 'landscape should be closer');
  assert.ok(O.camera.position.x > 0, 're-fit keeps the viewing direction');
});

test('behaviour: user-dragged view is left alone on resize', () => {
  const O = buildHarness(390, 844);
  O.defaultView = false;
  O.controls.target.set(0, 0, 0);
  O.camera.position.set(20, 5, 30);
  const before = O.camera.position.clone();
  O.container.getBoundingClientRect = () => ({ width: 640, height: 360 });
  O.resize();
  assert.ok(before.distanceTo(O.camera.position) < 1e-6, 'user view distance must not auto-refit');
});

test('behaviour: steady frames stop touching instanceMatrix', () => {
  const O = buildHarness(1280, 720);
  O.reducedMotion = true;
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 2);
  O.meshes = [mesh];
  const makeInstance = (x, localIndex) => ({
    mesh,
    localIndex,
    position: new THREE.Vector3(x, 0, 0),
    quaternion: new THREE.Quaternion(),
    scale: 1,
    targetPosition: new THREE.Vector3(0, 0, 0),
    targetQuaternion: new THREE.Quaternion(),
    targetScale: 1,
    settled: false,
  });
  O.instances = [makeInstance(5, 0), makeInstance(-5, 1)];
  O.instanceDirty = true;
  O.running = false;
  O.lastTime = 0;

  let t = 16;
  let guard = 0;
  while (O.instanceDirty && guard++ < 20) {
    O.animate(t);
    t += 16;
  }
  assert.equal(O.instanceDirty, false, 'dirty flag cleared after settling');
  assert.ok(guard < 20, 'morph did not settle');
  const versionSettled = mesh.instanceMatrix.version;
  let grew = 0;
  for (let index = 0; index < 6; index++) {
    O.animate(t);
    t += 16;
    grew += mesh.instanceMatrix.version - versionSettled;
  }
  assert.equal(grew, 0, 'steady frames must not bump instanceMatrix.version');
  for (const instance of O.instances) assert.equal(instance.position.distanceTo(instance.targetPosition), 0);
});

test('behaviour: clearPhotos releases stale canvases but keeps reused ones', () => {
  const O = buildHarness(1280, 720);
  const makeCanvas = () => ({ width: 512, height: 512 });
  const reused = makeCanvas();
  const stale = makeCanvas();
  const newOne = makeCanvas();
  O.atlasCanvases = new Set([reused, stale]);
  O.clearPhotos(new Set([reused, newOne]));
  assert.equal(stale.width, 0, 'stale canvas released');
  assert.equal(stale.height, 0, 'stale canvas released');
  assert.equal(reused.width, 512, 'reused canvas must not be zeroed');
  assert.equal(reused.height, 512, 'reused canvas must not be zeroed');
  assert.equal(O.atlasCanvases.size, 0, 'tracked canvas set cleared');

  const a = makeCanvas();
  const b = makeCanvas();
  O.atlasCanvases = new Set([a, b]);
  O.clearPhotos();
  assert.equal(a.width, 0);
  assert.equal(b.width, 0);
});

test('film boundaries have matching zero velocity for camera, target, FOV and rotation', () => {
  const step = 1e-3;
  for (const aspect of [DESKTOP, MOBILE]) {
    for (const t of [FILM.phase1, FILM.phase2End, FILM.total]) {
      const at = sampleFlight(t, aspect);
      for (const sample of [sampleFlight(t - step, aspect), sampleFlight(t + step, aspect)]) {
        assert.ok(dist(at.position, sample.position) / step < 0.01, `camera velocity boundary ${t}`);
        assert.ok(dist(at.target, sample.target) / step < 0.01, `target velocity boundary ${t}`);
        assert.ok(dist(at.rotation, sample.rotation) / step < 0.01, `rotation velocity boundary ${t}`);
        assert.ok(Math.abs(at.fov - sample.fov) / step < 0.01, `FOV velocity boundary ${t}`);
      }
    }
  }
});

test('framing has no discontinuity at former phone/tablet aspect breakpoints', () => {
  for (const aspect of [0.7, 0.8, 0.85, 1.25]) {
    assert.ok(Math.abs(orbitFraming(aspect - 1e-5).distance - orbitFraming(aspect + 1e-5).distance) < 0.01);
    assert.ok(dist(restRotation(aspect - 1e-5), restRotation(aspect + 1e-5)) < 0.001);
  }
});

test('responsive film start and end share the resting pose on phones and desktop', () => {
  for (const aspect of [390 / 844, 320 / 568, 0.85, 1, 16 / 9]) {
    assert.deepEqual(sampleFlight(0, aspect).rotation, restRotation(aspect));
    assert.deepEqual(sampleFlight(FILM.total, aspect).rotation, restRotation(aspect));
    assert.deepEqual(sampleFlight(0, aspect).position, orbitPosition(aspect));
    assert.deepEqual(sampleFlight(FILM.total, aspect).position, orbitPosition(aspect));
  }
});

test('default orientation changes morph smoothly; manually dragged views retain their layout', () => {
  const O = buildHarness(1440, 900);
  loadActualPhotos(O, 1200, 1200);
  O.running = false;
  const position = O.camera.position.clone();
  const shape = O.instances.map(instance => instance.position.clone());
  O.container.getBoundingClientRect = () => ({ width: 390, height: 844 });
  O.resize();
  assert.ok(O.camera.position.distanceTo(position) < 1e-10, 'resize starts at the visible camera');
  assert.ok(O.instances.every((instance, index) => instance.position.equals(shape[index])), 'resize starts at the visible sculpture');
  assert.equal(O.formationPortrait, 1);
  for (let time = 20; time <= 2200; time += 20) O.animate(time);
  assert.equal(O.instanceDirty, false);
  assert.ok(O.camera.position.distanceTo(new THREE.Vector3(...orbitPosition(390 / 844))) < 1e-9);
  const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(...restRotation(390 / 844)));
  assert.ok(O.group.quaternion.angleTo(expected) < 1e-7);
  const versions = O.meshes.map(mesh => mesh.instanceMatrix.version);
  O.defaultView = false;
  const manual = O.camera.position.clone();
  O.container.getBoundingClientRect = () => ({ width: 1440, height: 900 });
  O.resize();
  assert.ok(O.camera.position.distanceTo(manual) < 1e-10);
  assert.equal(O.formationPortrait, 1, 'manual layout is not pulled back to the new default');
  assert.deepEqual(O.meshes.map(mesh => mesh.instanceMatrix.version), versions);
  O.resetView(false);
  assert.equal(O.formationPortrait, 0, 'an explicit reset adopts the new aspect');
  O.clearPhotos();
});

test('repeated portrait resizes retain the pose destination until the transition finishes', () => {
  const O = buildHarness(1440, 900);
  loadActualPhotos(O, 1200, 1200);
  O.running = false;
  const size = { width: 390, height: 844 };
  O.container.getBoundingClientRect = () => size;
  O.resize();
  const expectedRotation = O.viewTransition.rotation.clone();
  for (let time = 20; time <= 500; time += 20) O.animate(time);
  assert.ok(O.group.quaternion.angleTo(expectedRotation) > 1, 'the second resize occurs before the initial rotation completes');
  const beforeResize = O.camera.position.clone();
  size.width = 391;
  O.resize();
  assert.ok(O.camera.position.distanceTo(beforeResize) < 1e-10);
  assert.ok(O.viewTransition.rotation.angleTo(expectedRotation) < 1e-7);
  for (let time = 520; time <= 900; time += 20) O.animate(time);
  size.width = 392;
  O.resize();
  assert.ok(O.viewTransition.rotation.angleTo(expectedRotation) < 1e-7);
  for (let time = 920; time <= 3200; time += 20) O.animate(time);
  assert.equal(O.viewTransition, null);
  assert.ok(O.group.quaternion.angleTo(expectedRotation) < 1e-7);
  assert.ok(O.camera.position.distanceTo(new THREE.Vector3(...orbitPosition(size.width / size.height))) < 1e-8);
  O.clearPhotos();
});

test('resizes across intermediate aspects refresh the responsive destination and retain it on repetition', () => {
  const O = buildHarness(1440, 900);
  loadActualPhotos(O, 1200, 1200);
  O.running = false;
  const size = { width: 844, height: 844 };
  O.container.getBoundingClientRect = () => size;
  let time = 0;
  for (const width of [844, 717, 590, 390, 391]) {
    size.width = width;
    const position = O.camera.position.clone();
    O.resize();
    const aspect = width / size.height;
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(...restRotation(aspect)));
    assert.ok(O.camera.position.distanceTo(position) < 1e-10, 'resize retargeting preserves the visible camera');
    assert.ok(O.viewTransition.rotation.angleTo(expected) < 1e-7, `responsive rotation for aspect ${aspect}`);
    assert.equal(O.formationPortrait, portraitAmount(aspect));
    for (let frame = 0; frame < 15; frame++) { time += 20; O.animate(time); }
  }
  const finish = time + 2400;
  for (; time <= finish; time += 20) O.animate(time);
  const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(...restRotation(size.width / size.height)));
  assert.equal(O.viewTransition, null);
  assert.equal(O.instanceDirty, false);
  assert.ok(O.group.quaternion.angleTo(expected) < 1e-7);
  assert.ok(O.camera.position.distanceTo(new THREE.Vector3(...orbitPosition(size.width / size.height))) < 1e-8);
  O.clearPhotos();
});

test('the whole repeated photo pool is deterministic, balanced and has no 24-photo stripes', () => {
  const sequence = O => O.instances.map(instance => instance.mesh.userData.photoIndices[instance.localIndex]);
  const first = buildHarness(1280, 720), second = buildHarness(1280, 720);
  loadActualPhotos(first, 24, 1200);
  loadActualPhotos(second, 24, 1200);
  const photos = sequence(first);
  assert.deepEqual(photos, sequence(second));
  const counts = new Map();
  for (const id of photos) counts.set(id, (counts.get(id) || 0) + 1);
  assert.equal(counts.size, 24);
  assert.ok([...counts.values()].every(count => count === 50));
  assert.ok(photos.every((id, index) => !index || photos[index - 1] !== id), 'neighbours use distinct photos');
  const repeated = photos.slice(24).filter((id, index) => photos[index] === id).length;
  assert.ok(repeated / (photos.length - 24) < 0.15, 'a full repeated cycle must not survive at the old 24-card period');
  first.clearPhotos(); second.clearPhotos();
});

test('film starts from the visible camera and world pose despite pending damping and parallax', () => {
  const O = buildHarness(1280, 720);
  O.camera.position.set(20, 8, 55);
  O.controls.target.set(2, 1, -3);
  O.camera.lookAt(O.controls.target);
  O.group.rotation.set(0.04, 0.23, -0.12);
  O.parallaxGroup = new THREE.Group();
  O.scene.remove(O.group);
  O.scene.add(O.parallaxGroup);
  O.parallaxGroup.add(O.group);
  O.parallaxGroup.rotation.set(0.01, -0.012, 0);
  O.pointerCurrent = new THREE.Vector2(0.7, 0.5);
  O.pointerTarget = new THREE.Vector2(0.7, 0.5);
  O.scene.updateMatrixWorld(true);
  const matrix = O.group.matrixWorld.elements.slice();
  const position = O.camera.position.clone();
  const target = O.controls.target.clone();
  const projection = projElements(O.camera);
  let pending = true;
  O.controls.update = () => {
    if (!O.controls.enableDamping && pending) {
      O.camera.position.x += 8;
      O.controls.target.y += 2;
      pending = false;
    }
  };
  O.startFilm();
  const film = O.film;
  O.updateFilm(film.start);
  O.scene.updateMatrixWorld(true);
  assert.ok(O.camera.position.distanceTo(position) < 1e-10);
  assert.ok(O.controls.target.distanceTo(target) < 1e-10);
  assert.ok(maxMatrixDiff(matrix, O.group.matrixWorld.elements) < 1e-10);
  assert.ok(maxMatrixDiff(projection, projElements(O.camera)) < 1e-10);
  O.startFilm();
  assert.equal(O.film, film, 'duplicate start does not restart the camera');
});

test('continuous film cancellation preserves projection, camera and target before smooth reset', () => {
  for (const time of [2.5, 12, 24]) {
    const O = buildHarness(390, 844);
    O.film = { start: 0, phase: 'orbit', elapsed: 0 };
    O.updateFilm(time * 1000);
    const position = O.camera.position.clone();
    const target = O.controls.target.clone();
    const up = O.camera.up.clone();
    const projection = projElements(O.camera);
    const rotation = O.group.quaternion.clone();
    O.stopFilm(false);
    O.resize();
    assert.equal(O.film, null);
    assert.ok(O.camera.position.distanceTo(position) < 1e-10);
    assert.ok(O.controls.target.distanceTo(target) < 1e-10);
    assert.ok(O.camera.up.distanceTo(up) < 1e-10);
    assert.ok(maxMatrixDiff(projection, projElements(O.camera)) < 1e-10);
    assert.ok(O.group.quaternion.angleTo(rotation) < 1e-7);
    O.resetView(false);
    assert.ok(O.camera.position.distanceTo(position) < 1e-10, 'reset begins without teleporting');
    O.lastTime = time * 1000;
    O.animate(time * 1000 + 16);
    assert.ok(O.camera.position.distanceTo(position) < 0.01, 'first reset frame eases out of rest');
  }
});

function loadActualPhotos(O, count = 3000, requested = 1200) {
  O.euler = new THREE.Euler();
  O.setFormation = PhotoUniverse.prototype.setFormation;
  O.photoUniforms = { uReveal: { value: 1 }, uDepthNear: { value: 1 }, uDepthFar: { value: 2 }, uPaperBackground: { value: new THREE.Color('#11100f') } };
  O.scene.fog = new THREE.FogExp2('#11100f', 0.0024);
  const photos = Array.from({ length: count }, (_, index) => ({ index }));
  const atlases = Array.from({ length: Math.ceil(count / 256) }, (_, atlas) => ({
    canvas: { width: 2048, height: 2048 },
    photoIndices: Array.from({ length: Math.min(256, count - atlas * 256) }, (_, index) => atlas * 256 + index),
  }));
  O.setPhotos(photos, atlases, requested);
  return atlases;
}

test('3000 imported photos all appear and a paused 2.2s morph settles without further uploads', () => {
  const O = buildHarness(1280, 720);
  loadActualPhotos(O);
  assert.equal(O.count, 3000);
  assert.equal(O.instances.length, 3000);
  assert.equal(new Set(O.meshes.flatMap(mesh => mesh.userData.photoIndices)).size, 3000);
  O.running = false;
  O.setFormation('tunnel', false, false);
  for (let time = 20; time <= 2200; time += 20) O.animate(time);
  assert.equal(O.instanceDirty, false, 'morph ends at its specified duration');
  assert.equal(O.morph, null);
  for (const instance of O.instances) {
    assert.ok(instance.position.equals(instance.targetPosition));
    assert.ok(instance.quaternion.equals(instance.targetQuaternion));
    assert.equal(instance.scale, instance.targetScale);
  }
  const versions = O.meshes.map(mesh => mesh.instanceMatrix.version);
  O.running = true;
  for (let time = 2220; time <= 2800; time += 20) O.animate(time);
  assert.deepEqual(O.meshes.map(mesh => mesh.instanceMatrix.version), versions, 'camera/group motion must not upload instance matrices');
  let disposed = 0;
  for (const mesh of O.meshes) {
    mesh.geometry.addEventListener('dispose', () => disposed++);
    mesh.material.addEventListener('dispose', () => disposed++);
  }
  for (const texture of O.textures) texture.addEventListener('dispose', () => disposed++);
  const batches = O.meshes.length;
  O.clearPhotos();
  assert.equal(disposed, batches * 3);
  assert.equal(O.photos.length, 0);
  assert.equal(O.count, 0);
});

test('parallax returns to rest for dragging, film and reduced motion; mobile amplitude is smaller', () => {
  const setup = (width, height) => {
    const O = buildHarness(width, height);
    O.parallaxGroup = new THREE.Group();
    O.pointerEnabled = true;
    O.pointerTarget = new THREE.Vector2(1, 1);
    O.pointerCurrent = new THREE.Vector2();
    return O;
  };
  const desktop = setup(1280, 720), mobile = setup(390, 844);
  desktop.animate(16); mobile.animate(16);
  assert.ok(desktop.parallaxGroup.rotation.x > mobile.parallaxGroup.rotation.x * 2);
  const before = desktop.pointerCurrent.length();
  desktop.dragging = true;
  desktop.animate(32);
  assert.equal(desktop.pointerTarget.length(), 0);
  assert.ok(desktop.pointerCurrent.length() < before);
  desktop.reducedMotion = true;
  desktop.animate(48);
  assert.equal(desktop.parallaxGroup.rotation.x, 0);
  assert.equal(desktop.parallaxGroup.rotation.y, 0);
  mobile.film = { manual: true };
  mobile.animate(32);
  assert.equal(mobile.parallaxGroup.rotation.x, 0);
  assert.equal(mobile.parallaxGroup.rotation.y, 0);
});

test('onFrame is optional and runs after each actual render, excluding hidden idle frames', () => {
  const O = buildHarness(1280, 720);
  const events = [];
  O.renderer.render = () => events.push('render');
  O.callbacks.onFrame = time => events.push(time);
  O.animate(16);
  assert.deepEqual(events, ['render', 16]);
  globalThis.document.hidden = true;
  O.animate(32);
  assert.deepEqual(events, ['render', 16]);
  globalThis.document.hidden = false;
  delete O.callbacks.onFrame;
  assert.doesNotThrow(() => O.animate(48));
});
