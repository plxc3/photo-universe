import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  NARRATIVE_ACTS,
  actForSeconds,
  cipherScramble,
  buildMemoryBeacons,
  projectMemoryBeacons,
} from './narrative-script.js';
import { PhotoUniverse } from './scene.js';
import { SpatialSoundscape } from './audio.js';

function makeNarrativeHarness(width = 1440, height = 900) {
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
  O.warpDriveActive = false;
  O._warpIntensity = 0;
  O._portalPulse = 0;
  O._fluidEnergy = 0;
  O.audioEnergy = 0;
  O.lastTime = 0;
  O.resize();
  O.resetView(true);
  return O;
}

test('5-Act narrative script maps timeline boundaries cleanly and decodes cipher-scramble typography deterministically', () => {
  assert.equal(NARRATIVE_ACTS.length, 5);
  assert.equal(actForSeconds(0).id, 'prologue');
  assert.equal(actForSeconds(5.8).id, 'implosion');
  assert.equal(actForSeconds(13.5).id, 'corridor');
  assert.equal(actForSeconds(22.8).id, 'reassembly');
  assert.equal(actForSeconds(28.0).id, 'lattice');

  const target = '每一张快门，都是从时间洪流里截获的一粒光子。';
  assert.equal(cipherScramble(target, 1), target, 'progress=1 resolves exact target copy');
  const mid = cipherScramble(target, 0.45);
  assert.notEqual(mid, target, 'mid-decode displays optical cipher glyphs before full lock');
  assert.equal(cipherScramble(target, 0.45), mid, 'cipherScramble is deterministic for given progress');
  assert.ok(mid.startsWith(target.slice(0, 6)), 'leading prefix resolves progressively left-to-right');
});

test('buildMemoryBeacons selects 5 chromatic 3D nodes and projectMemoryBeacons tracks live world-to-screen coordinates', () => {
  const O = makeNarrativeHarness(1440, 900);
  const photos = Array.from({ length: 15 }, (_, i) => ({
    index: i,
    spectralKey: i / 15,
    accentHex: `#${String(i).padStart(2, '0')}a27c`,
    capturedYear: 2018 + (i % 7),
    width: 1200,
    height: 800,
  }));
  const atlases = [{
    canvas: { width: 1024, height: 1024 },
    photoIndices: Array.from({ length: 15 }, (_, i) => i),
  }];
  O.setPhotos(photos, atlases, 150, { genesis: false });
  O.animate(50);

  const beacons = buildMemoryBeacons(O);
  assert.equal(beacons.length, 5, 'constructs 5 chromatic memory beacons');
  const uniqueInstances = new Set(beacons.map((b) => b.instanceIndex));
  assert.equal(uniqueInstances.size, 5, 'each beacon binds a distinct 3D card instance');

  const projected = projectMemoryBeacons(O, beacons, 1440, 900);
  assert.equal(projected.length, 5);
  const visibleOnes = projected.filter((p) => p.visibility > 0.1);
  assert.ok(visibleOnes.length >= 2, 'front-facing ring beacons project cleanly inside viewport');
  for (const b of visibleOnes) {
    assert.ok(b.x > 0 && b.x < 1440 && b.y > 0 && b.y < 900, 'projected coordinates lie within screen bounds');
  }

  // Move an instance behind camera and verify immediate frustum cull
  const inst0 = O.instances[beacons[0].instanceIndex];
  inst0.position.set(0, 0, O.camera.position.z + 40);
  O.writeInstanceMatrices();
  O.scene.updateMatrixWorld(true);
  const culled = projectMemoryBeacons(O, beacons, 1440, 900)[0];
  assert.equal(culled.visibility, 0, 'behind-camera beacon culls cleanly to visibility=0');

  O.clearPhotos();
});

test('Hold-to-Warp propulsion, portalToAct spatial jump, and fluid pointer wake integrate smoothly without breaking pose invariants', () => {
  const O = makeNarrativeHarness(1440, 900);
  const photos = Array.from({ length: 10 }, (_, i) => ({
    index: i,
    spectralKey: i / 10,
    width: 1200,
    height: 800,
  }));
  const atlases = [{
    canvas: { width: 1024, height: 1024 },
    photoIndices: Array.from({ length: 10 }, (_, i) => i),
  }];
  O.setPhotos(photos, atlases, 100, { genesis: false });
  O.enableScrollTheatre(true);

  // Engage Hold-to-Warp from idle orbit -> enters scrollTimeline and accelerates forward
  assert.equal(O.setWarpDrive(true), true);
  assert.ok(O.scrollTimeline, 'engaging warp from idle initializes reversible scrollTimeline');
  let clock = 50;
  for (; clock <= 650; clock += 50) O.animate(clock);
  assert.ok(O._warpIntensity > 0.7, 'warp intensity ramps up smoothly');
  assert.ok(O.scrollTimeline.currentTime > 0.6, 'Hold-to-Warp propels narrative timeline forward');
  const modWhileWarping = O.getAudioModulation();
  assert.ok(modWhileWarping.warpBoost > 0.7, 'audio modulation receives live warpBoost');

  // Release Hold-to-Warp -> intensity decays smoothly back to 0
  assert.equal(O.setWarpDrive(false), false);
  for (; clock <= 1800; clock += 50) O.animate(clock);
  assert.ok(O._warpIntensity < 0.02, 'releasing warp coasts smoothly down to rest');

  // Spatial Portal jump to Act III (13.5s) triggers radial portal pulse and timeline seek
  assert.equal(O.portalToAct(13.5), true);
  assert.ok(O._portalPulse > 0.8, 'portalToAct triggers radial dispersion pulse');
  assert.equal(O.scrollTimeline.targetTime, 13.5);

  // Screen-space fluid pointer wake records velocity and decays cleanly
  O._recordFluidPointer(-0.2, 0.1);
  O._recordFluidPointer(0.15, -0.1);
  assert.ok(O._fluidEnergy > 0.2, 'pointer sweep excites screen-space fluid ripple energy');
  assert.ok(O._fluidVel.length() > 0.2, 'pointer sweep records directional glass wake velocity');
  for (; clock <= 3000; clock += 50) O.animate(clock);
  assert.ok(O._fluidEnergy < 0.02, 'fluid ripple energy dissipates smoothly to zero');

  O.clearPhotos();
});

test('SpatialSoundscape provides real-time audio energy spectrum and debounced Active Theory UI foley', () => {
  const makeNode = () => ({
    frequency: { value: 0, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} },
    Q: { value: 1 },
    gain: { value: 1, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} },
    pan: { value: 0, setTargetAtTime() {} },
    fftSize: 64,
    smoothingTimeConstant: 0.78,
    frequencyBinCount: 32,
    getByteFrequencyData(arr) {
      for (let i = 0; i < arr.length; i++) arr[i] = i < 6 ? 180 : 90;
    },
    connect(d) { return d; },
    disconnect() {},
    start() {},
    stop() {},
  });
  let createdOscs = 0;
  class AnalyserMockContext {
    constructor() {
      this.state = 'running';
      this.currentTime = 2.0;
      this.sampleRate = 8000;
      this.destination = makeNode();
    }
    createGain() { return makeNode(); }
    createOscillator() { createdOscs++; return makeNode(); }
    createBiquadFilter() { return makeNode(); }
    createStereoPanner() { return makeNode(); }
    createAnalyser() { return makeNode(); }
    createBuffer(_c, len, sr) { return { length: len, sampleRate: sr, getChannelData: () => new Float32Array(len) }; }
    createBufferSource() { return makeNode(); }
    async resume() {}
    async close() {}
  }

  const sound = new SpatialSoundscape({ AudioContextClass: AnalyserMockContext });
  assert.equal(sound.getEnergy(1.0).active, false, 'inactive before audio start');
  sound.ensureStarted();
  let energy = sound.getEnergy(1.0);
  for (let frame = 0; frame < 8; frame++) energy = sound.getEnergy(1.0 + frame * 0.016);
  assert.equal(energy.active, true);
  assert.ok(energy.bass > 0.5 && energy.level > 0.3, 'extracts live bass & overall spectrum energy from AnalyserNode');

  const oscBeforeUi = createdOscs;
  sound.playUiTick(1000);
  sound.playUiTick(1010); // debounced within 42ms
  assert.equal(createdOscs, oscBeforeUi + 1, 'playUiTick synthesizes 1 micro-tick and debounces rapid bursts');

  sound.playPortalWarp(true);
  assert.equal(createdOscs, oscBeforeUi + 3, 'playPortalWarp synthesizes dual-harmonic portal sweep');
  sound.dispose();
});
