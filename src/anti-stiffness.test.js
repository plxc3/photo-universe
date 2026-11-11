import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { PhotoUniverse } from './scene.js';
import { createWheelStepGate } from './reticle.js';

function makeHarness(width = 1440, height = 900) {
  globalThis.document ||= { hidden: false };
  globalThis.document.hidden = false;
  const O = Object.create(PhotoUniverse.prototype);
  O.camera = new THREE.PerspectiveCamera(54, width / height, 0.08, 600);
  O.scene = new THREE.Scene();
  O.scene.fog = new THREE.FogExp2('#000000', 0.0022);
  O.group = new THREE.Group();
  O.parallaxGroup = new THREE.Group();
  O.parallaxGroup.add(O.group);
  O.scene.add(O.parallaxGroup);
  O.controls = {
    target: new THREE.Vector3(),
    enableDamping: true,
    enabled: true,
    minDistance: 4,
    update() {},
  };
  O.renderer = {
    pixelRatio: 1.5,
    domElement: {
      style: { cursor: 'grab' },
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    },
    setPixelRatio(r) { this.pixelRatio = r; },
    getPixelRatio() { return this.pixelRatio; },
    setSize() {},
    render() {},
    capabilities: { getMaxAnisotropy: () => 8 },
  };
  O.container = { getBoundingClientRect: () => ({ width, height }) };
  O.callbacks = {};
  O.mode = 'orbit';
  O.film = null;
  O.focusState = null;
  O.focusPlate = null;
  O.focusGeneration = 0;
  O.exportResolution = null;
  O.elapsed = 0;
  O.running = true;
  O.speed = 0.7;
  O.reducedMotion = false;
  O.pointerEnabled = true;
  O.pointerTarget = new THREE.Vector2();
  O.pointerCurrent = new THREE.Vector2();
  O.hoverNdc = new THREE.Vector2();
  O.raycaster = new THREE.Raycaster();
  O.defaultView = true;
  O._viewW = width;
  O._viewH = height;
  O._tmpVec = new THREE.Vector3();
  O.dummy = new THREE.Object3D();
  O.euler = new THREE.Euler();
  O.instances = [];
  O.meshes = [];
  O.textures = [];
  O.atlasCanvases = new Set();
  O.instanceDirty = false;
  O.boundsDirty = false;
  O.viewTransition = null;
  O.lastTime = 0;
  O.resize();
  O.resetView(true);
  return O;
}

test('Scroll-theatre captures live idle pose without frame-0 snap, supports 360° orbit drag inertia, and keeps viewOffset continuous', () => {
  const O = makeHarness(1440, 900);
  const photos = Array.from({ length: 16 }, (_, i) => ({
    index: i,
    spectralKey: i / 16,
    width: 1200,
    height: 800,
  }));
  const atlases = [{
    canvas: { width: 1024, height: 1024 },
    photoIndices: Array.from({ length: 16 }, (_, i) => i),
  }];
  O.setPhotos(photos, atlases, 160, { genesis: false });
  O.enableScrollTheatre(true);

  // Simulate several seconds of idle orbit rotation & armillary ring spin before first wheel gesture
  let clock = 50;
  for (; clock <= 4000; clock += 50) O.animate(clock);
  assert.ok(Math.abs(O.group.rotation.y) > 0.15, 'sculpture has rotated meaningfully during idle');
  const liveQuatBeforeScroll = O.group.quaternion.clone();
  const liveCamBeforeScroll = O.camera.position.clone();
  const liveRingsBeforeScroll = [...O.ringAngles];

  // First wheel input enters scrollTimeline at t=0 -> targetTime=0.45 without snapping pose!
  O.scrollByTimeline(0.45);
  assert.ok(
    O.group.quaternion.angleTo(liveQuatBeforeScroll) < 1e-5,
    'Frame-0 scroll entry preserves exact live sculpture quaternion (zero snap)',
  );
  assert.ok(
    O.camera.position.distanceTo(liveCamBeforeScroll) < 1e-4,
    'Frame-0 scroll entry preserves exact live camera position (zero snap)',
  );
  for (let r = 0; r < 4; r++) {
    assert.ok(Math.abs(O.ringAngles[r] - liveRingsBeforeScroll[r]) < 1e-5, `ring ${r} preserves live angle`);
  }

  // Test 360° orbit drag + coasting inertia in opening orbit region
  O.beginPointer({ pointerId: 1, clientX: 500, clientY: 450, button: 0, pointerType: 'mouse', timeStamp: 100 });
  O.movePointer({ pointerId: 1, clientX: 680, clientY: 430, timeStamp: 116 });
  O.movePointer({ pointerId: 1, clientX: 900, clientY: 410, timeStamp: 132 });
  O.endPointer({ pointerId: 1, clientX: 900, clientY: 410, timeStamp: 132 });
  const yawAtRelease = O.scrollTimeline.targetYaw;
  assert.ok(O.scrollTimeline.yawVel > 0.5, 'captures release angular velocity for coasting inertia');

  for (let i = 0; i < 12; i++) O.animate((clock += 16));
  assert.ok(O.scrollTimeline.targetYaw > yawAtRelease + 0.05, 'inertia coasts smoothly past release angle');

  // Verify viewOffset stays continuous across the 5.5s orbit->tunnel boundary (no 27px vertical jump)
  O.setScrollTimeline(5.48, { immediate: true });
  const offsetBeforeBoundary = O.camera.view?.enabled ? O.camera.view.offsetY : 0;
  O.setScrollTimeline(5.52, { immediate: true });
  const offsetAfterBoundary = O.camera.view?.enabled ? O.camera.view.offsetY : 0;
  assert.ok(
    Math.abs(offsetAfterBoundary - offsetBeforeBoundary) < 0.5,
    `projection offsetY must not jump at t=5.5s (before=${offsetBeforeBoundary}, after=${offsetAfterBoundary})`,
  );

  O.clearPhotos();
});

test('Sphere and Helix formation transitions sweep along meridian shellArc instead of collapsing linearly through origin', () => {
  const O = makeHarness(1440, 900);
  const photos = Array.from({ length: 12 }, (_, i) => ({
    index: i,
    spectralKey: i / 12,
    width: 1200,
    height: 800,
  }));
  const atlases = [{
    canvas: { width: 1024, height: 1024 },
    photoIndices: Array.from({ length: 12 }, (_, i) => i),
  }];
  O.setPhotos(photos, atlases, 120, { genesis: false });
  O.setFormation('sphere', true, false);

  // Pick a card that flips nearly across the sphere when morphing sphere -> helix -> sphere
  O.setFormation('helix', false, false, 2.0);
  assert.equal(O.morph.shellArc, true, 'sphere -> helix activates curved meridian shellArc');

  let maxRadialExpansion = 0;
  for (let step = 1; step <= 20; step++) {
    O.updateInstanceTransforms(0.05);
    if (!O.morph) break;
    for (const inst of O.instances) {
      const p0 = inst.fromPosition;
      const p1 = inst.targetPosition;
      const midLin = p0.clone().lerp(p1, 0.5);
      const rActual = Math.hypot(inst.position.x, inst.position.z);
      const rMidLin = Math.hypot(midLin.x, midLin.z);
      maxRadialExpansion = Math.max(maxRadialExpansion, rActual - rMidLin);
    }
  }
  assert.ok(maxRadialExpansion > 1.5, 'shellArc bows cards outward along spherical shell instead of chordal collapse');

  for (let step = 0; step < 30; step++) O.updateInstanceTransforms(0.05);
  assert.equal(O.morph, null, 'shellArc morph settles cleanly');
  assert.ok(O.instances[0].position.distanceTo(O.instances[0].targetPosition) < 1e-5);
  O.clearPhotos();
});

test('updateHover snaps uHoverWorld immediately on fresh entry instead of lerping from z=9999', () => {
  const O = makeHarness(1440, 900);
  const photos = [{ index: 0, spectralKey: 0.2, width: 1200, height: 800 }];
  const atlases = [{ canvas: { width: 512, height: 512 }, photoIndices: [0] }];
  O.setPhotos(photos, atlases, 1, { genesis: false });

  // Place single card directly at center of view so NDC (0,0) raycast hits it
  const inst = O.instances[0];
  inst.position.set(0, 0, 0);
  inst.quaternion.identity();
  inst.scale = 4;
  O.group.quaternion.identity();
  O.camera.clearViewOffset();
  O.camera.position.set(0, 0, 18);
  O.controls.target.set(0, 0, 0);
  O.camera.lookAt(0, 0, 0);
  O.writeInstanceMatrices();

  assert.equal(O.photoUniforms.uHoverWorld.value.z, 9999);
  O.hoverPointer = [720, 450];
  O.updateHover(200);
  assert.equal(O.hoverActive, true);
  assert.ok(
    O.photoUniforms.uHoverWorld.value.length() < 2.0,
    `fresh hover immediately syncs uHoverWorld to hit point instead of dragging from z=9999 (got z=${O.photoUniforms.uHoverWorld.value.z})`,
  );
  O.clearPhotos();
});

test('createWheelStepGate collapses MacBook trackpad inertia bursts into 1 step while honoring reversals and new flicks', () => {
  const gate = createWheelStepGate();
  const trackpadTail = [16, 38, 34, 28, 22, 16, 11, 7, 3];
  let steps = 0;
  let now = 1000;
  for (const delta of trackpadTail) {
    const dir = gate(delta, now, 0);
    if (dir !== 0) steps += dir;
    now += 45; // spans 360ms inertia tail
  }
  assert.equal(steps, 1, 'entire decaying trackpad momentum tail advances exactly 1 photo');

  // Immediate opposite flick reverses without waiting out lock
  assert.equal(gate(-28, now + 30, 0), -1, 'direction reversal steps backward immediately');

  // Fresh deliberate second flick spike in same direction (>1.45x decayed delta after 190ms) re-triggers
  let t2 = now + 260;
  assert.equal(gate(-8, t2, 0), 0, 'continued decay stays gated');
  assert.equal(gate(-26, t2 + 30, 0), -1, 'second deliberate finger flick spike triggers cleanly');
});

test('AI engineering modularity gate: every runtime JS and CSS file in src/ stays strictly below 1,000 lines', async () => {
  const srcRoot = new URL('./', import.meta.url);
  const checkDir = async (dirUrl, prefix = '') => {
    const entries = await readdir(dirUrl, { withFileTypes: true });
    for (const entry of entries) {
      const childUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
      if (entry.isDirectory()) {
        await checkDir(childUrl, `${prefix}${entry.name}/`);
      } else if ((entry.name.endsWith('.js') || entry.name.endsWith('.css')) && !entry.name.endsWith('.test.js')) {
        const text = await readFile(childUrl, 'utf8');
        const lines = text.split('\n').length;
        assert.ok(
          lines < 1000,
          `src/${prefix}${entry.name} has ${lines} lines (must stay < 1,000 lines for single-window AI engineering modularity)`,
        );
      }
    }
  };
  await checkDir(srcRoot);
});
