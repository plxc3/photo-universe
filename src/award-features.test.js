import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { rgbToSpectralKey, extractPhotoMood, createAtmosphereField, createDustField } from './post.js';
import { SpatialSoundscape } from './audio.js';
import { AlbumVault } from './storage.js';
import {
  loadDemoPhotos,
  loadLocalPhotos,
  buildPhotoAtlases,
  releasePhotos,
  extractLocalPhotoFiles,
  buildYearChapters,
} from './photos.js';
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
  async decodeAudioData(arrayBuffer) {
    return {
      duration: 24,
      length: arrayBuffer.byteLength,
      sampleRate: this.sampleRate,
    };
  }
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

test('extractPhotoMood derives luminous gallery swatches and createAtmosphereField disposes cleanly', () => {
  const amber = extractPhotoMood(228, 168, 54);
  const cobalt = extractPhotoMood(32, 88, 224);
  const silver = extractPhotoMood(140, 140, 140);
  assert.match(amber.accentHex, /^#[0-9a-f]{6}$/);
  assert.match(cobalt.accentHex, /^#[0-9a-f]{6}$/);
  assert.notEqual(amber.accentHex, cobalt.accentHex);
  assert.ok(amber.toneLabel.includes('AMBER'));
  assert.ok(cobalt.toneLabel.includes('COBALT'));
  assert.equal(silver.toneLabel, '银盐 · SILVER');

  const atmo = createAtmosphereField();
  assert.equal(atmo.mesh.renderOrder, -10);
  assert.equal(atmo.mesh.material.depthWrite, false);
  let disposed = 0;
  atmo.mesh.geometry.addEventListener('dispose', () => disposed++);
  atmo.mesh.material.addEventListener('dispose', () => disposed++);
  atmo.dispose();
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
    spectralKey: i < 16 ? (i / 16) * 0.92 : 1.08,
    moodRgb: [0.8, 0.5, 0.3],
    width: i % 2 === 0 ? 1200 : 900,
    height: i % 2 === 0 ? 800 : 1200,
  }));
  const atlases = [{
    canvas: { width: 2048, height: 2048 },
    photoIndices: Array.from({ length: 24 }, (_, i) => i),
  }];

  // 1) Stardust Genesis ritual (`{ genesis: true }`) starts dispersed and converges in 2.25s,
  //    weaving chromatic waves so outer orbital rings also carry saturated photographs.
  O.setPhotos(photos, atlases, 3000, { genesis: true });
  const ringColored = O.instances
    .slice(1680, 3000)
    .filter((inst) => photos[inst.mesh.userData.photoIndices[inst.localIndex]].spectralKey < 1.0).length;
  assert.ok(ringColored > 600, 'outer armillary orbital rings carry full-spectrum color alongside core facets');
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
  assert.ok(O.focusPlate, 'hero plate is mounted in overlay scene');
  assert.ok(O.focusOverlayScene?.children.includes(O.focusPlate), 'hero plate renders in crisp post-bokeh overlay scene');
  assert.ok(O.focusPlate.userData.liquidMat, 'Monopo borderless liquid-displacement shader is attached');
  assert.equal(O.focusPlate.geometry.parameters.widthSegments, 32, '32x24 subdivided silk mesh');
  assert.equal(O.focusPlate.geometry.parameters.heightSegments, 24);
  for (let t = 2350; t <= 3500; t += 50) O.animate(t);
  assert.equal(O.camera.fov, 42);
  assert.ok(O.photoUniforms.uFocusAmount.value > 0.95, 'surrounding cards dim via shader uniform');
  assert.ok(O.focusPlate.scale.y > O.focusPlate.scale.x, 'portrait photograph expands to native portrait aspect');
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

function createFakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name) {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        let dbEntry = dbs.get(name);
        const isNew = !dbEntry;
        if (!dbEntry) {
          const stores = new Map();
          dbEntry = {
            stores,
            closed: false,
            objectStoreNames: { contains: (s) => stores.has(s) },
            createObjectStore(s, opts = {}) {
              const map = new Map();
              map.keyPath = opts.keyPath || 'seq';
              stores.set(s, map);
              return {};
            },
            transaction(s) {
              const map = stores.get(s);
              const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
              const storeApi = {
                clear() { map?.clear(); },
                put(rec) { map?.set(rec[map.keyPath], rec); },
                getAll() {
                  const r = { result: null, onsuccess: null, onerror: null };
                  queueMicrotask(() => {
                    r.result = map ? [...map.values()] : [];
                    r.onsuccess?.();
                  });
                  return r;
                },
              };
              queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
              tx.objectStore = () => storeApi;
              return tx;
            },
            close() { this.closed = true; },
          };
          dbs.set(name, dbEntry);
        }
        req.result = dbEntry;
        if (isNew) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
}

test('AlbumVault defaults to disabled privacy mode, round-trips local Files when enabled, and purges IndexedDB on disable', async () => {
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const indexedDBImpl = createFakeIndexedDB();
  const vault = new AlbumVault({ indexedDBImpl, storage });

  assert.equal(vault.isSupported(), true);
  assert.equal(vault.enabled, false, 'local persistence must default to OFF');

  const f1 = new File([new Uint8Array([1, 2, 3, 4])], 'kyoto-2024.jpg', { type: 'image/jpeg', lastModified: 1715000000000 });
  const f2 = new File([new Uint8Array([5, 6, 7, 8, 9, 10])], 'tokyo-2022.jpg', { type: 'image/jpeg', lastModified: 1652000000000 });

  assert.deepEqual(await vault.saveFiles([f1, f2]), { saved: 0, totalBytes: 0 }, 'disabled vault never writes files');
  assert.deepEqual(await vault.loadFiles(), []);

  assert.equal(await vault.setEnabled(true), true);
  assert.equal(vault.enabled, true);
  const saved = await vault.saveFiles([f1, f2]);
  assert.deepEqual(saved, { saved: 2, totalBytes: 10 });
  assert.deepEqual(await vault.getStats(), { count: 2, totalBytes: 10 });

  const restored = await vault.loadFiles();
  assert.equal(restored.length, 2);
  assert.deepEqual(restored.map(f => [f.name, f.type, f.size, f.lastModified]), [
    ['kyoto-2024.jpg', 'image/jpeg', 4, 1715000000000],
    ['tokyo-2022.jpg', 'image/jpeg', 6, 1652000000000],
  ]);

  assert.equal(await vault.setEnabled(false), false);
  assert.equal(vault.enabled, false);
  assert.deepEqual(await vault.getStats(), { count: 0, totalBytes: 0 }, 'disabling vault auto-purges IndexedDB');
  vault.dispose();
});

function buildExifDateApp1(dateStr, orientation = 1, littleEndian = true) {
  // TIFF header (8) + IFD0 count(2) + 2 entries(24) + nextIFD(4) = 38 -> align 40
  // ExifIFD at 40: count(2) + 1 entry(12) + nextIFD(4) = 18 -> offset 58
  // Date string (20 bytes incl null) at TIFF offset 58 -> total TIFF 78 bytes, APP1 body = 6 + 78 = 84 bytes
  const tiffLen = 78;
  const body = Buffer.alloc(6 + tiffLen);
  body.write('Exif\0\0', 0, 'binary');
  const tiff = 6;
  body.write(littleEndian ? 'II' : 'MM', tiff, 'ascii');
  const u16 = (off, v) => (littleEndian ? body.writeUInt16LE(v, tiff + off) : body.writeUInt16BE(v, tiff + off));
  const u32 = (off, v) => (littleEndian ? body.writeUInt32LE(v, tiff + off) : body.writeUInt32BE(v, tiff + off));
  u16(2, 42);
  u32(4, 8);
  // IFD0 at 8: 2 entries (Orientation 0x0112, ExifIFD 0x8769)
  u16(8, 2);
  u16(10, 0x0112); u16(12, 3); u32(14, 1); u16(18, orientation);
  u16(22, 0x8769); u16(24, 4); u32(26, 1); u32(30, 40);
  u32(34, 0);
  // ExifIFD at 40: 1 entry (DateTimeOriginal 0x9003, ASCII count=20 at offset 58)
  u16(40, 1);
  u16(42, 0x9003); u16(44, 2); u32(46, 20); u32(50, 58);
  u32(54, 0);
  body.write(dateStr.padEnd(19, ' ') + '\0', tiff + 58, 'ascii');

  const prefix = Buffer.alloc(4);
  prefix[0] = 0xff;
  prefix[1] = 0xe1;
  prefix.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([prefix, body]);
}

function addPngTimeChunk(pngBuf, year, month, day) {
  // Insert 7-byte tIME chunk right after 8-byte PNG signature + 25-byte IHDR chunk (offset 33)
  const data = Buffer.alloc(7);
  data.writeUInt16BE(year, 0);
  data[2] = month;
  data[3] = day;
  data[4] = 12;
  data[5] = 0;
  data[6] = 0;
  const chunk = Buffer.alloc(12 + 7);
  chunk.writeUInt32BE(7, 0);
  chunk.write('tIME', 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(0, 15);
  return Buffer.concat([pngBuf.subarray(0, 33), chunk, pngBuf.subarray(33)]);
}

test('EXIF DateTimeOriginal (II/MM), PNG tIME, and mtime fallback populate descending Year Chapters', async () => {
  const sampleJpeg = await readFile(new URL('../public/photos/photo-01.jpg', import.meta.url));
  // Strip existing APP1 segments
  const strippedChunks = [sampleJpeg.subarray(0, 2)];
  let off = 2;
  while (off + 4 <= sampleJpeg.length && sampleJpeg[off] === 0xff && sampleJpeg[off + 1] !== 0xda) {
    const end = off + 2 + sampleJpeg.readUInt16BE(off + 2);
    if (sampleJpeg[off + 1] !== 0xe1) strippedChunks.push(sampleJpeg.subarray(off, end));
    off = end;
  }
  strippedChunks.push(sampleJpeg.subarray(off));
  const cleanJpeg = Buffer.concat(strippedChunks);

  const xmpPayload = Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>');
  const xmpSeg = Buffer.alloc(4 + xmpPayload.length);
  xmpSeg[0] = 0xff; xmpSeg[1] = 0xe1; xmpSeg.writeUInt16BE(xmpPayload.length + 2, 2);
  xmpPayload.copy(xmpSeg, 4);

  const jpeg2024LE = Buffer.concat([cleanJpeg.subarray(0, 2), buildExifDateApp1('2024:09:18 17:42:10', 1, true), xmpSeg, cleanJpeg.subarray(2)]);
  const jpeg2021BE = Buffer.concat([cleanJpeg.subarray(0, 2), buildExifDateApp1('2021:04:03 08:15:00', 6, false), xmpSeg, cleanJpeg.subarray(2)]);
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1UAAAAASUVORK5CYII=', 'base64');
  const png2023 = addPngTimeChunk(png1x1, 2023, 11, 5);

  const prevDoc = globalThis.document;
  const prevBitmap = globalThis.createImageBitmap;
  let loadedPhotos = [];
  try {
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          fillRect() {},
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray([180, 140, 90, 255]) }),
        }),
      }),
    };
    globalThis.createImageBitmap = async (_blob, opts) => ({
      width: opts.resizeWidth,
      height: opts.resizeHeight,
      close() {},
    });

    const f1 = new File([jpeg2024LE], 'autumn-2024.jpg', { type: 'image/jpeg', lastModified: Date.UTC(2026, 0, 1) });
    const f2 = new File([jpeg2021BE], 'spring-2021.jpg', { type: 'image/jpeg', lastModified: Date.UTC(2026, 0, 1) });
    const f3 = new File([png2023], 'still-2023.png', { type: 'image/png', lastModified: Date.UTC(2026, 0, 1) });
    const f4 = new File([cleanJpeg], 'mtime-2019.jpg', { type: 'image/jpeg', lastModified: Date.UTC(2019, 6, 15) });

    const { photos } = await loadLocalPhotos([f1, f2, f3, f4]);
    loadedPhotos = photos;
    assert.equal(extractLocalPhotoFiles(photos).length, 4);
    assert.deepEqual(extractLocalPhotoFiles(photos, [2, 0]).map(f => f.name), ['still-2023.png', 'autumn-2024.jpg']);

    await buildPhotoAtlases(photos);
    assert.deepEqual(
      photos.map(p => [p.capturedYear, p.capturedDate, p.dateSource, p.width, p.height]),
      [
        [2024, '2024-09-18', 'exif', 400, 280],
        [2021, '2021-04-03', 'exif', 280, 400],
        [2023, '2023-11-05', 'exif', 1, 1],
        [2019, '2019-07-15', 'mtime', 400, 280],
      ]
    );

    photos.push({ id: 'undated-demo', name: 'Undated', width: 400, height: 300 });
    const chapters = buildYearChapters(photos);
    assert.deepEqual(
      chapters.map(c => [c.key, c.label, c.count, c.firstPhotoIndex]),
      [
        ['2024', '2024', 1, 0],
        ['2023', '2023', 1, 2],
        ['2021', '2021', 1, 1],
        ['2019', '2019', 1, 3],
        ['undated', '未标年份', 1, 4],
      ]
    );
  } finally {
    releasePhotos(loadedPhotos);
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
    if (prevBitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = prevBitmap;
  }
});

test('SpatialSoundscape lazy-loads acoustic chamber stem only when unmuted and started', async () => {
  let fetchCalls = 0;
  const fetchImpl = async function boundWindowFetchGuard(url) {
    assert.equal(this, undefined, 'window.fetch must be invoked unbound to prevent Illegal invocation in browsers');
    fetchCalls++;
    assert.equal(url, '/audio/felt-chamber-stem.mp3');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(1024),
    };
  };

  const sound = new SpatialSoundscape({
    AudioContextClass: FakeAudioContext,
    stemUrl: '/audio/felt-chamber-stem.mp3',
    fetchImpl,
  });

  // Zero network fetches before user starts audio or while muted
  assert.equal(fetchCalls, 0);
  sound.setMuted(true);
  sound.ensureStarted();
  assert.equal(fetchCalls, 0, 'starting while muted must not fetch the stem');
  assert.equal(sound.stemLoaded, false);

  // Unmuting triggers lazy fetch + decode exactly once
  sound.setMuted(false);
  await sound._stemPromise;
  assert.equal(fetchCalls, 1);
  assert.equal(sound.stemLoaded, true);
  assert.equal(sound._stemSource.loop, true);
  assert.equal(sound._stemSource.started, true);

  sound.ensureStarted();
  assert.equal(fetchCalls, 1, 'subsequent ensureStarted calls reuse decoded stem');

  sound.update({ tunnelFactor: 1, twist: 3.8, breath: 0.9, morphImpulse: 0.4, focused: false, pan: 0.25 });
  assert.ok(sound._stemFilter.frequency.value > 2800, 'tunnel & breath open lowpass filter on chamber stem');
  assert.ok(sound._droneGain.gain.value < 0.04, 'synthetic sub-drone attenuates gracefully behind real stem');

  sound.update({ focused: true });
  assert.equal(sound._stemFilter.frequency.value, 1150, '3D photo gaze warms stem into intimate darkroom lowpass');

  sound.dispose();
  assert.equal(sound.stemLoaded, false);
});

test('PhotoUniverse scroll-driven 5-act scrollytelling traverses forward/backward reversibly with drag yaw/pitch and mid-tornado gaze', () => {
  const O = makeSceneHarness(1440, 900);
  const photos = Array.from({ length: 24 }, (_, i) => ({
    index: i,
    spectralKey: (i / 24) * 0.9,
    moodRgb: [0.7, 0.5, 0.35],
    width: 1200,
    height: 800,
  }));
  const atlases = [{
    canvas: { width: 2048, height: 2048 },
    photoIndices: Array.from({ length: 24 }, (_, i) => i),
  }];
  O.setPhotos(photos, atlases, 3000, { genesis: false });
  O.enableScrollTheatre(true);
  assert.equal(O.controls.enableZoom, false, 'wheel zoom yields to 5-act timeline scroll');

  const initialCard0 = O.instances[0].position.clone();
  let latestTimeline = -1;
  O.callbacks.onFilmProgress = (sec) => { latestTimeline = sec; };

  // 1) Scroll forward into Act I Square-Portal Tornado Implosion (6.48s)
  O.scrollByTimeline(6.48);
  let clock = 50;
  for (; clock <= 1500; clock += 50) O.animate(clock);
  assert.equal(O.scrollTimeline.region, 'implosion');
  assert.ok(Math.abs(O.scrollTimeline.currentTime - 6.48) < 1e-3);
  assert.equal(O.scrollTimeline.resting, true);
  assert.equal(O.instanceDirty, false, 'resting mid-tornado stops touching instanceMatrix');
  const tornadoCard0 = O.instances[0].position.clone();
  assert.ok(tornadoCard0.distanceTo(initialCard0) > 2.0, 'cards swirl mid-tornado at 6.48s');

  // Clicking a card mid-tornado freezes the tornado sculpture and flies into 3D Gaze
  assert.equal(O.focusPhoto(3, 3), true);
  assert.ok(O.instances[0].position.distanceTo(tornadoCard0) < 1e-4, 'mid-tornado focus preserves frozen vortex geometry');
  assert.equal(O.closeFocus(true), true);

  // 2) Scroll into Act II Spiral Corridor (14.0s) and drag pointer to pan look direction
  O.setScrollTimeline(14.0);
  for (; clock <= 3000; clock += 50) O.animate(clock);
  assert.equal(O.scrollTimeline.region, 'tunnel-cruise');
  assert.equal(O.mode, 'tunnel');
  assert.ok(O.tunnelTwist > 4.0);
  const centerTarget = O.controls.target.clone();

  O.beginPointer({ pointerId: 1, clientX: 600, clientY: 450, button: 0, pointerType: 'mouse' });
  O.movePointer({ pointerId: 1, clientX: 720, clientY: 390 });
  O.endPointer({ pointerId: 1, clientX: 720, clientY: 390 });
  for (; clock <= 3800; clock += 50) O.animate(clock);
  assert.ok(O.scrollTimeline.lookYaw > 0.3, 'dragging right yaws view along scroll timeline');
  assert.ok(O.scrollTimeline.lookPitch < -0.1, 'dragging up pitches view along scroll timeline');
  assert.ok(O.controls.target.distanceTo(centerTarget) > 0.5, 'tunnel camera pans look target smoothly');

  // 3) Scroll into Act III Crystalline Stellation Breath (27.28s)
  O.setScrollTimeline(27.28, { immediate: true });
  assert.equal(O.scrollTimeline.region, 'orbit-finale');
  assert.ok(O.stellationBreath > 0.95);
  assert.ok(Math.abs(latestTimeline - 27.28) < 1e-3);

  // 4) Rewind backward through tornado (6.48s) all the way back to 0.0s seamlessly
  O.scrollTimeline.targetYaw = 0;
  O.scrollTimeline.targetPitch = 0;
  O.scrollTimeline.lookYaw = 0;
  O.scrollTimeline.lookPitch = 0;
  O.setScrollTimeline(6.48, { immediate: true });
  assert.ok(O.instances[0].position.distanceTo(tornadoCard0) < 1e-3, '6.48s pose is 100% bijective regardless of scroll direction');

  O.setScrollTimeline(0, { immediate: true });
  assert.equal(O.scrollTimeline.region, 'orbit-intro');
  assert.ok(O.instances[0].position.distanceTo(initialCard0) < 1e-4, 'rewinding to 0s restores exact opening polyhedron');

  O.exitScrollTimeline(true);
  assert.equal(O.scrollTimeline, null);
  O.clearPhotos();
});

test('Extended 120-photo curated HD archive verifies every JPEG header, six-spectrum balance, and 100% dated Year Chapters', async () => {
  const pubRoot = new URL('../public/', import.meta.url);
  const origFetch = globalThis.fetch;
  const origLocation = globalThis.location;
  globalThis.location = { href: 'http://memoria.local/' };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://memoria.local/');
    const rel = url.pathname.replace(/^\//, '');
    const buf = await readFile(new URL(rel, pubRoot));
    return new Response(buf, { status: 200 });
  };
  try {
    const { photos } = await loadDemoPhotos(undefined, { extended: true });
    assert.equal(photos.length, 120, '24 editorial + 96 archive = 120 full-HD photographs');
    for (const p of photos) {
      assert.ok(p.width >= 720 && p.height >= 720 && Math.max(p.width, p.height) >= 1200, `${p.id} is full-HD (${p.width}x${p.height})`);
      assert.ok(p.author && p.author.length > 0, `${p.id} carries photographer credit`);
      assert.ok(p.title && p.title.length > 0, `${p.id} carries curatorial title`);
      assert.equal(p.license, 'Unsplash License');
      assert.ok(Number.isInteger(p.capturedYear) && p.capturedYear >= 2010 && p.capturedYear <= 2026, `${p.id} has valid archival year ${p.capturedYear}`);
    }
    const chapters = buildYearChapters(photos);
    assert.ok(chapters.length >= 10, 'rich multi-year chapter timeline');
    assert.equal(chapters.some(ch => ch.key === 'undated'), false, 'zero undated demo photographs');
    const totalInChapters = chapters.reduce((acc, ch) => acc + ch.count, 0);
    assert.equal(totalInChapters, 120);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.location = origLocation;
  }
});

test('PhotoUniverse supports Threshold Gate 1.8s optical rack-focus and in-stage GLSL liquid displacement crossfade', () => {
  const O = makeSceneHarness(1440, 900);
  const photos = Array.from({ length: 12 }, (_, i) => ({
    index: i,
    spectralKey: i / 12,
    width: i % 2 === 0 ? 1280 : 854,
    height: i % 2 === 0 ? 854 : 1280,
  }));
  const atlases = [{
    canvas: { width: 2048, height: 2048 },
    photoIndices: Array.from({ length: 12 }, (_, i) => i),
  }];

  O.setPhotos(photos, atlases, 300, { genesis: true, threshold: true });
  assert.ok(O.thresholdState && O.thresholdState.active === true);
  assert.equal(O.thresholdState.blur, 0.88);
  assert.equal(O.camera.fov, 36, 'telephoto close-up threshold framing');
  assert.equal(O.controls.enabled, false);

  let clock = 50;
  for (; clock <= 500; clock += 50) O.animate(clock);
  assert.equal(O.camera.fov, 36, 'resize/animate holds telephoto gate until user gesture');
  assert.equal(O.thresholdState.blur, 0.88);

  assert.equal(O.unlockThreshold(), true);
  assert.equal(O.unlockThreshold(), false, 'idempotent while already unlocking');
  for (; clock <= 950; clock += 50) O.animate(clock);
  assert.ok(O.thresholdState.blur > 0.05 && O.thresholdState.blur < 0.85, 'smooth mid-rack-focus bokeh melt');
  for (; clock <= 2500; clock += 50) O.animate(clock);
  assert.equal(O.thresholdState, null, 'threshold rack-focus completes cleanly at 1.8s');
  assert.equal(O.camera.fov, 54);
  assert.equal(O.controls.enabled, true);

  // Enter Monopo full-frame exhibition on landscape photo 0, then liquid-step to portrait photo 1
  assert.equal(O.focusPhoto(0, 0, { flowDir: 1 }), true);
  for (; clock <= 3600; clock += 50) O.animate(clock);
  assert.ok(1.08 * O.focusPlate.scale.x > 0.72 * O.focusPlate.scale.y, 'landscape print proportions');
  const stageHeroPos = O.focusState.heroPos.clone();

  assert.equal(O.focusPhoto(1, -1, { flowDir: -1 }), true);
  const lu = O.focusPlate.userData.liquidMat.uniforms;
  assert.equal(lu.uFlowDir.value, -1);
  assert.equal(lu.uMix.value, 0, 'liquid displacement crossfade starts at uMix = 0');
  assert.ok(O.focusState.heroPos.distanceTo(stageHeroPos) < 1e-5, 'stepping keeps exhibition stage anchored in front of viewer');

  O.animate((clock += 50));
  assert.ok(lu.uMix.value > 0 && lu.uMix.value < 1 && Math.abs(lu.uCurl.value) > 0.01, 'mid-step drives GLSL liquid mix & silk curl');
  for (; clock <= 4700; clock += 50) O.animate(clock);
  assert.equal(lu.uMix.value, 1);
  assert.ok(0.72 * O.focusPlate.scale.y > 1.08 * O.focusPlate.scale.x, 'spring-morphs smoothly into portrait proportions');

  // Closing contracts transient _closingPlate back into card slot and disposes cleanly
  assert.equal(O.closeFocus(false), true);
  assert.equal(O.focusState, null);
  assert.equal(O.focusPlate, null);
  assert.ok(O._closingPlate, 'transient silk contraction plate bridges exit');
  for (; clock <= 5400; clock += 50) O.animate(clock);
  assert.equal(O._closingPlate, null, 'closing plate disposes GPU resources upon settling');

  O.clearPhotos();
});
