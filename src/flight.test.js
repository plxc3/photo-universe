import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sampleFlight, orbitFraming, ORBIT_CONTENT_RADIUS } from './flight.js';
import { PhotoUniverse } from './scene.js';

const DESKTOP = 16 / 9;
const MOBILE = 9 / 16; // < 0.8 -> mobile branch (portrait phone)

const isFiniteVec = (v) =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n));

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function expectShape(s) {
  assert.ok(s.mode === 'orbit' || s.mode === 'tunnel', `bad mode ${s.mode}`);
  assert.ok(isFiniteVec(s.position), 'position not finite vec');
  assert.ok(isFiniteVec(s.target), 'target not finite vec');
  assert.ok(isFiniteVec(s.up), 'up not finite vec');
  assert.ok(isFiniteVec(s.rotation), 'rotation not finite vec');
  assert.ok(Number.isFinite(s.fov), 'fov not finite');
}

test('keyframes: desktop at 0 / 5.5 / 24 / 30 match spec', () => {
  const p0 = sampleFlight(0, DESKTOP);
  assert.equal(p0.mode, 'orbit');
  assert.equal(p0.fov, 54);
  assert.deepEqual(p0.target, [0, 0, 0]);
  assert.deepEqual(p0.up, [0, 1, 0]);
  // starts at radius ~90, slight yaw and y
  assert.ok(Math.abs(dist(p0.position, [0, 0, 0]) - 90) < 2, 'start radius ~90');
  assert.ok(p0.position[1] > 6 && p0.position[1] < 9, 'start y ~8');
  assert.ok(p0.position[0] > 0, 'start yaw pushes +x');
  // initial tilt present
  assert.ok(p0.rotation.some((n) => n !== 0), 'has initial tilt');

  const p55 = sampleFlight(5.5, DESKTOP);
  assert.deepEqual(p55.position, [0, 0, 38]);
  assert.deepEqual(p55.target, [0, 0, 0]);
  assert.deepEqual(p55.up, [0, 1, 0]);
  assert.equal(p55.fov, 75);
  assert.deepEqual(p55.rotation, [0, 0, 0]);

  const p24 = sampleFlight(24, DESKTOP);
  assert.deepEqual(p24.position, [0, 0, 14]);
  assert.deepEqual(p24.target, [0, 0, -24]);
  assert.deepEqual(p24.up, [0, 1, 0]);
  assert.equal(p24.fov, 75);
  assert.deepEqual(p24.rotation, [0, 0, 0]);

  const p30 = sampleFlight(30, DESKTOP);
  assert.equal(p30.mode, 'orbit');
  assert.deepEqual(p30.position, [34, 14, 50]);
  assert.deepEqual(p30.target, [0, 0, 0]);
  assert.deepEqual(p30.up, [0, 1, 0]);
  assert.equal(p30.fov, 54);
  assert.ok(p30.rotation.some((n) => n !== 0), 'ends with slight tilt');
});

test('keyframes: mobile lands same 5.5 / 24 points, wider aspect-driven start and finish', () => {
  const framing = orbitFraming(MOBILE);
  assert.equal(framing.mobile, true, '9:16 must be mobile');
  const p0 = sampleFlight(0, MOBILE);
  // mobile starts further out than desktop (90) and near the aspect fit distance
  const startR = dist(p0.position, [0, 0, 0]);
  assert.ok(startR > 90 && startR < 160, `mobile start radius in range, got ${startR}`);
  assert.ok(startR > dist(sampleFlight(0, DESKTOP).position, [0, 0, 0]) + 5, 'mobile starts further than desktop');
  // same 5.5 / 24 anchor points as desktop (shared tunnel entrance)
  assert.deepEqual(sampleFlight(5.5, MOBILE).position, [0, 0, 38]);
  assert.deepEqual(sampleFlight(24, MOBILE).position, [0, 0, 14]);
  assert.deepEqual(sampleFlight(5.5, MOBILE).target, [0, 0, 0]);
  assert.deepEqual(sampleFlight(24, MOBILE).target, [0, 0, -24]);
  // mobile finish distance == framing distance (resting view == film end)
  const end = sampleFlight(30, MOBILE).position;
  assert.ok(Math.abs(dist(end, [0, 0, 0]) - framing.distance) < 1e-6, 'end matches framing distance');
  assert.ok(dist(end, [0, 0, 0]) > dist(sampleFlight(30, DESKTOP).position, [0, 0, 0]) + 10, 'mobile ends further out');
});

test('orbitFraming: desktop keeps side-offset look; portrait fits with horizontal margin', () => {
  const desk = orbitFraming(DESKTOP);
  assert.equal(desk.mobile, false);
  assert.equal(desk.verticalOffsetFraction, 0, 'no vertical shift on desktop');
  assert.ok(desk.horizontalOffsetFraction < 0, 'desktop keeps the negative side offset');
  assert.ok(Math.abs(desk.distance - Math.hypot(34, 14, 50)) < 1e-9, 'desktop distance unchanged');

  // Sweep portrait-ish aspects and verify the scene fits horizontally with >=10%
  // margin on EACH side, using the real camera.aspect (no hardcoded 390).
  const fov = 54;
  const tanHalf = Math.tan((fov * Math.PI) / 180 / 2);
  for (const aspect of [9 / 16, 0.46, 0.5, 0.5625, 0.79]) {
    const f = orbitFraming(aspect, fov);
    assert.equal(f.mobile, true, `aspect ${aspect} should be mobile`);
    assert.ok(f.verticalOffsetFraction < 0, 'portrait pushes the scene downward');
    assert.equal(f.horizontalOffsetFraction, 0, 'portrait keeps content horizontally centered');
    const halfViewport = aspect * tanHalf; // world half-width at unit distance
    const contentHalf = ORBIT_CONTENT_RADIUS / f.distance; // world half-width of scene
    const occupancy = contentHalf / halfViewport; // fraction of half-width used
    assert.ok(occupancy <= 0.9 + 1e-6, `>=10% margin, occupancy ${occupancy} @ ${aspect}`);
    assert.ok(f.marginRatio >= 0.1 - 1e-6, `marginRatio below 10% at ${aspect}`);
    assert.ok(Number.isFinite(f.distance) && f.distance > 0, 'finite distance');
  }
});

test('boundary continuity at 5.5s and 24s for desktop and mobile', () => {
  const eps = 1e-6;
  for (const aspect of [DESKTOP, MOBILE]) {
    for (const b of [5.5, 24]) {
      const before = sampleFlight(b - 0.001, aspect);
      const at = sampleFlight(b, aspect);
      const after = sampleFlight(b + 0.001, aspect);
      assert.ok(dist(before.position, at.position) < eps, `${b} pos jump`);
      assert.ok(dist(before.target, at.target) < eps, `${b} target jump`);
      assert.ok(dist(before.up, at.up) < eps, `${b} up jump`);
      assert.ok(Math.abs(before.fov - at.fov) < eps, `${b} fov jump`);
      assert.ok(dist(before.rotation, at.rotation) < eps, `${b} rot jump`);
      assert.ok(dist(at.position, after.position) < eps, `${b} pos jump+`);
      assert.ok(dist(at.target, after.target) < eps, `${b} target jump+`);
      assert.ok(dist(at.up, after.up) < eps, `${b} up jump+`);
      assert.ok(Math.abs(at.fov - after.fov) < eps, `${b} fov jump+`);
      assert.ok(dist(at.rotation, after.rotation) < eps, `${b} rot jump+`);
    }
  }
});

test('time clamping and non-finite safety', () => {
  assert.deepEqual(sampleFlight(-10, DESKTOP).position, sampleFlight(0, DESKTOP).position);
  assert.deepEqual(sampleFlight(999, DESKTOP).position, sampleFlight(30, DESKTOP).position);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) {
    expectShape(sampleFlight(bad, DESKTOP));
  }
  // default aspect arg works
  expectShape(sampleFlight(3));
  // non-finite / odd aspect still produces valid (desktop) sample
  expectShape(sampleFlight(10, NaN));
  expectShape(sampleFlight(10, 0));
  expectShape(sampleFlight(10, -5));
});

test('every sample: finite, up ~unit, camera != target', () => {
  for (const aspect of [DESKTOP, MOBILE]) {
    for (let t = 0; t <= 30 + 1e-9; t += 0.1) {
      const s = sampleFlight(t, aspect);
      expectShape(s);
      assert.ok(Math.abs(dist(s.up, [0, 0, 0]) - 1) < 1e-6, `up not unit at ${t}`);
      assert.ok(dist(s.position, s.target) > 1e-3, `camera coincides target at ${t}`);
      // fov within expected band
      assert.ok(s.fov >= 54 - 1e-9 && s.fov <= 75 + 1e-9, `fov out of range at ${t}`);
    }
  }
});

test('tunnel phase keeps camera z positive and mode/tunnel behavior', () => {
  let sawTunnel = false;
  for (let t = 5.5; t < 24; t += 0.05) {
    const s = sampleFlight(t, DESKTOP);
    assert.equal(s.mode, 'tunnel');
    assert.ok(s.position[2] > 0, 'camera z must stay positive');
    assert.deepEqual(s.rotation, [0, 0, 0]);
    assert.equal(s.fov, 75);
    sawTunnel = true;
  }
  assert.ok(sawTunnel);
  // x/y sway returns to 0 at both ends of the phase
  assert.equal(sampleFlight(5.5, DESKTOP).position[0], 0);
  assert.equal(sampleFlight(24, DESKTOP).position[0], 0);
});

test('phase motion is smooth within segments (no discrete jump mid-phase)', () => {
  const step = 0.05;
  const maxJump = 5; // max plausible per-0.05s motion; catches real discontinuities
  for (const aspect of [DESKTOP, MOBILE]) {
    for (let t = 0; t < 30 - step; t += step) {
      // skip straddling the two boundaries, handled by continuity test
      const straddles = (t < 5.5 && t + step > 5.5) || (t < 24 && t + step > 24);
      if (straddles) continue;
      const a = sampleFlight(t, aspect);
      const b = sampleFlight(t + step, aspect);
      assert.ok(dist(a.position, b.position) < maxJump, `pos jump at ${t}`);
      assert.ok(dist(a.target, b.target) < maxJump, `target jump at ${t}`);
      assert.ok(dist(a.rotation, b.rotation) < 1, `rotation jump at ${t}`);
    }
  }
});

test('natural film end is continuous into the resting shot (no flip / snap)', () => {
  for (const aspect of [DESKTOP, MOBILE]) {
    const last = sampleFlight(30, aspect);
    const justBefore = sampleFlight(29.95, aspect);
    // Approaching 30s the camera eases into the end (zero velocity via smoother+env).
    assert.ok(dist(justBefore.position, last.position) < 1.2, `end position jump ${aspect}`);
    assert.ok(dist(justBefore.target, last.target) < 0.2, `end target jump ${aspect}`);
    assert.ok(dist(justBefore.rotation, last.rotation) < 0.2, `end rotation jump ${aspect}`);
    // Final shot is the orbit establishing shot, matching the resting framing.
    assert.equal(last.mode, 'orbit');
    assert.deepEqual(last.target, [0, 0, 0]);
    assert.equal(last.fov, 54);
    assert.equal(last.up.join(), [0, 1, 0].join());
    // Clamped past-the-end still lands on the same resting camera (preserves last shot).
    assert.deepEqual(sampleFlight(45, aspect).position, last.position);
  }
});

// ---------------------------------------------------------------------------
// Behavioral tests: run the real PhotoUniverse methods on a hand-built instance
// (real THREE camera/scene/group + fake renderer/container/controls, no WebGL DOM)
// so we can assert view-offset continuity, aspect re-fit, and steady-state cost.
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
  // Formation morph is out of scope for the camera/offset checks.
  O.setFormation = () => {};
  O.applyViewOffset();
  return O;
}

const projElements = (cam) => cam.projectionMatrix.elements.slice();
const maxMatrixDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

test('behaviour: natural film end keeps projection offset identical (no reframe jump)', () => {
  for (const [w, h] of [[390, 844], [1280, 720], [640, 360]]) {
    const O = buildHarness(w, h);
    O.film = { start: 0, phase: 'orbit', elapsed: 0 };
    const nearEnd = 29.999;
    O.updateFilm(nearEnd * 1000);
    const projNear = projElements(O.camera);
    const posNear = O.camera.position.clone();
    // updateFilm(30) trips the natural end and stopFilm(...,false).
    O.updateFilm(30 * 1000);
    assert.equal(O.film, null, 'film cleared on natural end');
    const projAfter = projElements(O.camera);
    const posAfter = O.camera.position.clone();
    // offset restored by resize() must equal the eased-to offset at 30s: identical projection
    assert.ok(maxMatrixDiff(projNear, projAfter) < 1e-3, `projection jump @ ${w}x${h}`);
    assert.ok(posNear.distanceTo(posAfter) < 1e-3, `camera position jump @ ${w}x${h}`);
    // group tilt preserved (natural end does not zero it)
    assert.ok(Math.abs(O.group.rotation.x - 0.08) < 1e-3, `group x not preserved @ ${w}x${h}`);
  }
});

test('behaviour: first interactive frame after natural end does not snap group.rotation.x', () => {
  const O = buildHarness(390, 844);
  O.film = { start: 0, phase: 'orbit', elapsed: 0 };
  O.elapsed = 12.3; // deliberate idle-drifted clock, as if we spun before the film
  O.updateFilm(30 * 1000); // -> natural end; alignIdlePhase should reseed O.elapsed
  const filmEndX = O.group.rotation.x; // ~0.08
  assert.ok(Math.abs(filmEndX - 0.08) < 1e-3, 'film ends near 0.08 tilt');
  // first interactive frame: elapsed continues from the reseeded phase
  O.lastTime = 30000;
  O.animate(30016);
  const nextX = O.group.rotation.x;
  const staleX = Math.sin((12.3 + 0.016 * 0.7) * 0.16) * 0.14; // what a stale clock yields
  assert.ok(Math.abs(nextX - filmEndX) < 0.012, `group.x jumped ${nextX} from ${filmEndX}`);
  assert.ok(Math.abs(nextX - staleX) > 0.02, 'test is not meaningful if stale coincides');
});

test('behaviour: resize re-fits default orbit distance across portrait/landscape', () => {
  const O = buildHarness(390, 844);
  O.controls.target.set(0, 0, 0);
  O.camera.position.set(6, 14, 103.6); // a portrait framing
  O.resize();
  const portrait = orbitFraming(390 / 844, 54).distance;
  const distPortrait = O.camera.position.length();
  assert.ok(Math.abs(distPortrait - portrait) < 1e-3, `portrait distance ${distPortrait} != ${portrait}`);
  // flip to landscape: default view must re-fit to the (much closer) desktop distance
  O.container.getBoundingClientRect = () => ({ width: 640, height: 360 });
  O._viewW = 640;
  O._viewH = 360;
  O.resize();
  const landscape = orbitFraming(640 / 360, 54).distance;
  const distLandscape = O.camera.position.length();
  assert.ok(Math.abs(distLandscape - landscape) < 1e-3, `landscape distance ${distLandscape} != ${landscape}`);
  assert.ok(distLandscape < distPortrait - 20, 'landscape should be closer, not stuck far');
  // direction preserved (roughly +z side composition, x>0)
  assert.ok(O.camera.position.x > 0, 're-fit keeps the viewing direction');
});

test('behaviour: user-dragged view is left alone on resize', () => {
  const O = buildHarness(390, 844);
  O.defaultView = false; // pretend the user grabbed the orbit
  O.controls.target.set(0, 0, 0);
  O.camera.position.set(20, 5, 30);
  const before = O.camera.position.clone();
  O.container.getBoundingClientRect = () => ({ width: 640, height: 360 });
  O.resize();
  assert.ok(before.distanceTo(O.camera.position) < 1e-6, 'user view distance must not auto-refit');
});

test('behaviour: steady frames stop touching instanceMatrix (no GPU re-upload)', () => {
  const O = buildHarness(1280, 720);
  O.reducedMotion = true; // lerp = 1 -> snap in a single frame
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial(), 2);
  O.meshes = [mesh];
  const mk = (x) => ({
    mesh, localIndex: 0,
    position: new THREE.Vector3(x, 0, 0), quaternion: new THREE.Quaternion(), scale: 1,
    targetPosition: new THREE.Vector3(0, 0, 0), targetQuaternion: new THREE.Quaternion(), targetScale: 1,
    settled: false,
  });
  O.instances = [mk(5), mk(-5)];
  // tag localIndex so setMatrixAt writes distinct slots
  O.instances[1].localIndex = 1;
  O.instanceDirty = true;
  O.lastTime = 0;
  O.running = false; // isolate the instance loop from idle rotation

  // Run until the morph has fully settled and the dirty flag is cleared.
  let t = 16;
  let guard = 0;
  while (O.instanceDirty && guard++ < 20) { O.animate(t); t += 16; }
  assert.equal(O.instanceDirty, false, 'dirty flag cleared after settling');
  assert.ok(guard < 20, 'morph did not settle');

  const versionSettled = mesh.instanceMatrix.version;
  let grew = 0;
  for (let k = 0; k < 6; k++) { O.animate(t); t += 16; grew += mesh.instanceMatrix.version - versionSettled; }
  assert.equal(grew, 0, 'steady frames must not bump instanceMatrix.version');
  // instances actually reached their targets
  for (const inst of O.instances) assert.equal(inst.position.distanceTo(inst.targetPosition), 0);
});

test('behaviour: clearPhotos releases stale canvases but keeps reused ones', () => {
  const O = buildHarness(1280, 720);
  const makeCanvas = () => ({ width: 512, height: 512 });
  const reused = makeCanvas();
  const stale = makeCanvas();
  const newOne = makeCanvas();
  O.atlasCanvases = new Set([reused, stale]);
  // incoming reuses `reused`, adds `newOne`, drops `stale`
  O.clearPhotos(new Set([reused, newOne]));
  assert.equal(stale.width, 0, 'stale canvas released');
  assert.equal(stale.height, 0, 'stale canvas released');
  assert.equal(reused.width, 512, 'reused canvas must not be zeroed (no black texture)');
  assert.equal(reused.height, 512, 'reused canvas must not be zeroed');
  assert.equal(O.atlasCanvases.size, 0, 'tracked canvas set cleared');

  // direct call (no keep set) releases every backing canvas
  const a = makeCanvas();
  const b = makeCanvas();
  O.atlasCanvases = new Set([a, b]);
  O.clearPhotos();
  assert.equal(a.width, 0);
  assert.equal(b.width, 0);
});

