import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rgbToSpectralKey, createDustField } from './post.js';
import { SpatialSoundscape } from './audio.js';
import { CanvasRecorder, CINEMA_VIDEO_BITS_PER_SECOND } from './recording.js';
import { PhotoUniverse, chromaticPhotoPool } from './scene.js';

function makeAudioNode(name) {
  return {
    name,
    connected: [],
    started: false,
    stopped: false,
    disconnected: false,
    type: 'sine',
    loop: false,
    buffer: null,
    frequency: {
      value: 0,
      setValueAtTime(v) { this.value = v; },
      setTargetAtTime(v) { this.value = v; },
      exponentialRampToValueAtTime(v) { this.value = v; },
    },
    Q: { value: 1 },
    gain: {
      value: 1,
      setValueAtTime(v) { this.value = v; },
      setTargetAtTime(v) { this.value = v; },
      exponentialRampToValueAtTime(v) { this.value = v; },
    },
    pan: {
      value: 0,
      setTargetAtTime(v) { this.value = v; },
    },
    connect(dest) { this.connected.push(dest); return dest; },
    disconnect() { this.disconnected = true; },
    start() { this.started = true; },
    stop() { this.stopped = true; },
  };
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 1.0;
    this.sampleRate = 8000;
    this.destination = makeAudioNode('destination');
    this.nodes = [];
    this.closed = false;
  }
  _track(node) { this.nodes.push(node); return node; }
  createGain() { return this._track(makeAudioNode('gain')); }
  createOscillator() { return this._track(makeAudioNode('osc')); }
  createBiquadFilter() { return this._track(makeAudioNode('filter')); }
  createStereoPanner() { return this._track(makeAudioNode('panner')); }
  createBuffer(_ch, length, sampleRate) {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  }
  createBufferSource() { return this._track(makeAudioNode('bufferSource')); }
  createMediaStreamDestination() {
    const audioTrack = {
      kind: 'audio',
      stopped: false,
      stop() { this.stopped = true; },
      clone() { return { ...this, cloned: true, stop() { this.stopped = true; } }; },
    };
    return {
      stream: { getAudioTracks: () => [audioTrack] },
    };
  }
  async resume() { this.state = 'running'; }
  async close() { this.closed = true; this.state = 'closed'; }
}

function makeSceneHarness(width = 1280, height = 720) {
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
  const sizes = [];
  O.renderer = {
    sizes,
    pixelRatio: 1.5,
    setPixelRatio(r) { this.pixelRatio = r; },
    getPixelRatio() { return this.pixelRatio; },
    setSize(w, h, style) { sizes.push([w, h, style]); },
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

test('rgbToSpectralKey maps warm-to-cool OKLab hues in [0,1) and monochrome prints in [1,1.25]', () => {
  const gold = rgbToSpectralKey(242, 188, 58);
  const cobalt = rgbToSpectralKey(38, 96, 232);
  const charcoal = rgbToSpectralKey(36, 36, 36);
  const silver = rgbToSpectralKey(214, 214, 214);

  assert.ok(gold >= 0 && gold < 1, 'chromatic gold lies on the [0,1) hue wheel');
  assert.ok(cobalt >= 0 && cobalt < 1, 'chromatic cobalt lies on the [0,1) hue wheel');
  assert.ok(Math.abs(gold - cobalt) > 0.2, 'warm gold and cool cobalt separate cleanly in OKLab');
  assert.ok(charcoal >= 1 && charcoal <= 1.25, 'dark neutral gray enters monochrome bridge');
  assert.ok(silver > charcoal && silver <= 1.25, 'lighter silver sorts after charcoal');
});

test('chromaticPhotoPool preserves exact quotas, spectral gradient, and neighbour uniqueness', () => {
  const unique = 30;
  const count = 3000;
  const photos = Array.from({ length: unique }, (_, i) => ({
    spectralKey: i / unique,
  }));
  const successful = Array.from({ length: unique }, (_, photoIndex) => ({
    atlasIndex: 0,
    photoIndex,
    tile: photoIndex,
  }));

  const pool = chromaticPhotoPool(successful, photos, count);
  assert.equal(pool.length, count);

  const tally = new Map();
  for (let i = 0; i < pool.length; i++) {
    const id = pool[i].photoIndex;
    tally.set(id, (tally.get(id) || 0) + 1);
    if (i > 0) {
      assert.notEqual(pool[i].photoIndex, pool[i - 1].photoIndex, 'adjacent cards never duplicate');
    }
  }
  assert.equal(tally.size, unique);
  for (const n of tally.values()) assert.equal(n, count / unique);

  // First decile average spectralKey must be substantially warmer/lower than final decile.
  const avgSlice = (start, end) =>
    pool.slice(start, end).reduce((s, e) => s + photos[e.photoIndex].spectralKey, 0) / (end - start);
  assert.ok(avgSlice(0, 300) < 0.20, 'opening slice carries warm low spectral keys');
  assert.ok(avgSlice(2700, 3000) > 0.80, 'closing slice carries cool/monochrome high spectral keys');
});

test('createDustField builds additive 3D dust motes and disposes GPU buffers cleanly', () => {
  const dust = createDustField(180);
  assert.equal(dust.points.geometry.getAttribute('position').count, 180);
  assert.equal(dust.uniforms.uOpacity.value, 0.24);
  let disposed = 0;
  dust.points.geometry.addEventListener('dispose', () => disposed++);
  dust.points.material.addEventListener('dispose', () => disposed++);
  dust.dispose();
  assert.equal(disposed, 2);
});

test('SpatialSoundscape synthesizes Web Audio nodes, modulates state, clones export track, and disposes cleanly', () => {
  const sound = new SpatialSoundscape({ AudioContextClass: FakeAudioContext });
  assert.equal(sound.isSupported(), true);
  assert.equal(sound.ensureStarted(), true);
  assert.equal(sound.active, true);

  const track = sound.createRecordingTrack();
  assert.ok(track && track.kind === 'audio' && track.cloned === true);

  sound.update({ tunnelFactor: 1, twist: 4.2, breath: 0.85, morphImpulse: 0.5, focused: false, pan: -0.4 });
  assert.ok(sound._windGain.gain.value > 0.04, 'tunnel flight raises Brownian wind rush');
  assert.ok(sound._crystalGain.gain.value > 0.04, 'Act III breath raises crystalline choir');
  assert.equal(sound._windPanner.pan.value, -0.4);

  const nodesBefore = sound._ctx.nodes.length;
  sound.playHoverTick(0.35, 500);
  assert.ok(sound._ctx.nodes.length > nodesBefore, 'hover chime schedules oscillator + envelope');
  const afterFirstTick = sound._ctx.nodes.length;
  sound.playHoverTick(0.35, 530);
  assert.equal(sound._ctx.nodes.length, afterFirstTick, 'hover chimes are rate-limited');

  sound.playFocusPulse(true);
  assert.ok(sound._ctx.nodes.length > afterFirstTick);

  assert.equal(sound.toggleMuted(), true);
  assert.equal(sound.createRecordingTrack(), null, 'muted soundscape omits audio track');
  assert.equal(sound.toggleMuted(), false);

  const ctx = sound._ctx;
  sound.dispose();
  assert.equal(ctx.closed, true);
});

test('CanvasRecorder exports 18 Mbps cinema bitrate, muxes audio track, and falls back if audio codec is rejected', () => {
  assert.equal(CINEMA_VIDEO_BITS_PER_SECOND, 18_000_000);
  const originalMediaRecorder = globalThis.MediaRecorder;
  const originalCanvas = globalThis.HTMLCanvasElement;
  try {
    globalThis.HTMLCanvasElement = class { captureStream() {} };
    const addedTracks = [];
    let stoppedAudio = false;
    const audioTrack = { kind: 'audio', stop() { stoppedAudio = true; } };
    const videoTrack = { kind: 'video', stop() {} };
    const canvas = {
      width: 1920,
      height: 1080,
      captureStream: () => ({
        addTrack(t) { addedTracks.push(t); },
        getTracks: () => [videoTrack],
      }),
    };

    let attempt = 0;
    let recordedOptions = null;
    globalThis.MediaRecorder = class {
      static isTypeSupported(mime) {
        return mime.includes('vp9');
      }
      constructor(_stream, options) {
        attempt++;
        if (attempt === 1 && options.mimeType.includes('opus')) {
          throw new Error('Opus muxing unsupported on mock');
        }
        recordedOptions = options;
        this.state = 'inactive';
      }
      start() {
        this.state = 'recording';
        this.onstart?.();
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['frame'], { type: 'video/webm' }) });
        this.onstop?.();
      }
    };

    let finished = null;
    const rec = new CanvasRecorder(canvas, {
      audioTrack,
      videoBitsPerSecond: CINEMA_VIDEO_BITS_PER_SECOND,
      onStop: (result) => { finished = result; },
    });
    rec.start();
    assert.equal(rec.state, 'recording');
    assert.equal(attempt, 2, 'automatically retried video-only after combined audio+video rejection');
    assert.equal(recordedOptions.videoBitsPerSecond, 18_000_000);
    assert.equal(addedTracks.length, 1);
    rec.stop();
    assert.ok(finished?.blob.size > 0);
    assert.equal(stoppedAudio, true, 'cloned audio track is stopped when recording releases');
  } finally {
    if (originalMediaRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalMediaRecorder;
    if (originalCanvas === undefined) delete globalThis.HTMLCanvasElement;
    else globalThis.HTMLCanvasElement = originalCanvas;
  }
});

test('PhotoUniverse supports 2.25s stardust genesis, 3D in-situ camera gaze, live scrubbing, and 9:16 export lock', () => {
  const O = makeSceneHarness(1440, 900);
  const photos = Array.from({ length: 24 }, (_, i) => ({
    index: i,
    spectralKey: i / 24,
  }));
  const atlases = [{
    canvas: { width: 2048, height: 2048 },
    photoIndices: Array.from({ length: 24 }, (_, i) => i),
  }];

  // 1) Stardust Genesis ritual (`{ genesis: true }`) starts dispersed and converges in 2.25s.
  O.setPhotos(photos, atlases, 240, { genesis: true });
  assert.equal(O.instanceDirty, true);
  assert.equal(O.morph.duration, 2.25);
  assert.ok(!O.instances[0].position.equals(O.instances[0].targetPosition), 'cards begin in dispersed stardust nebula');
  for (let t = 50; t <= 2300; t += 50) O.animate(t);
  assert.equal(O.instanceDirty, false, 'stardust genesis settles cleanly at 2.25s');
  assert.ok(O.instances[0].position.equals(O.instances[0].targetPosition));

  // 2) 3D In-Situ Gaze (`focusPhoto` / `closeFocus`) flies to card without polluting `O.meshes`.
  const meshCountBefore = O.meshes.length;
  const focusEvents = [];
  O.callbacks.onFocusChange = (ev) => focusEvents.push(ev);
  const savedPos = O.camera.position.clone();
  assert.equal(O.focusPhoto(5, 5), true);
  assert.ok(O.focusState);
  assert.equal(O.meshes.length, meshCountBefore, 'hero plate never pollutes instanced raycast meshes');
  assert.ok(O.focusPlate, 'hero plate is mounted in scene');
  for (let t = 2350; t <= 3500; t += 50) O.animate(t);
  assert.equal(O.camera.fov, 42);
  assert.ok(O.photoUniforms.uFocusAmount.value > 0.95, 'surrounding cards dim via shader uniform');
  assert.ok(O.controls.target.distanceTo(O.focusState.heroPos) < 1e-4, 'camera gazes directly at levitated 3D hero card');
  assert.ok(O.focusPlate.position.distanceTo(O.focusState.heroPos) < 1e-4, 'hero plate levitates smoothly out of facet');

  assert.equal(O.closeFocus(false), true);
  assert.equal(O.focusState, null);
  assert.equal(O.focusPlate, null, 'hero plate is disposed on exit');
  for (let t = 3550; t <= 4600; t += 50) O.animate(t);
  assert.ok(O.camera.position.distanceTo(savedPos) < 0.05, 'camera glides smoothly back to pre-focus pose');
  assert.equal(focusEvents.length, 2);

  // 3) Interactive Live Scrubber (`seekFilmLive`) scrubs across acts while keeping film session live.
  let latestFilmTime = 0;
  O.callbacks.onFilmProgress = (sec) => { latestFilmTime = sec; };
  O.startFilm();
  O.seekFilmLive(14.0, { paused: true });
  assert.ok(O.film && O.film.scrubPaused === true);
  assert.equal(O.mode, 'tunnel');
  assert.ok(O.tunnelTwist > 4.0, 'scrubbing to 14s immediately twists corridor into deep helix');
  assert.equal(latestFilmTime, 14.0);

  O.seekFilmLive(27.28, { paused: false });
  assert.equal(O.mode, 'orbit');
  assert.ok(O.stellationBreath > 0.95, 'scrubbing to 27.28s blooms Act III crystalline stellation');
  assert.equal(O.film.scrubPaused, false);
  O.stopFilm(false, true);

  // 4) Export Resolution Lock (`setExportResolution(1080, 1920)`) frames native 9:16 portrait.
  O.setExportResolution(1080, 1920);
  assert.ok(Math.abs(O.camera.aspect - 1080 / 1920) < 1e-6);
  assert.equal(O.renderer.pixelRatio, 1);
  assert.deepEqual(O.renderer.sizes.at(-1), [1080, 1920, false]);
  O.clearExportResolution();
  assert.ok(Math.abs(O.camera.aspect - 1440 / 900) < 1e-6);

  O.clearPhotos();
});
