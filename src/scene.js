import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  createFormation,
  RING_AXES,
  STAR_CORE_A,
  STAR_EXPANDED_A,
  TUNNEL_Z_MIN,
  TUNNEL_SPAN,
  stellatedFacetRotation,
} from './formations.js';
import {
  sampleFlight,
  orbitFraming,
  orbitPosition,
  flightViewOffset,
  restingViewFractions,
  easeInOut,
  portraitAmount,
  restRotation,
  tunnelTwistAt,
  tunnelConveyorAt,
  stellationBreathAt,
  armillarySpinAt,
  FILM,
} from './flight.js';
import { DarkroomPipeline, createDustField, createAtmosphereField } from './post.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// Idle orbit oscillation: group.rotation.x = sin(elapsed * OMEGA) * AMP.
const OSC_AMP = 0.055;
const OSC_OMEGA = 0.13;
const BACKGROUND = '#040407';
const DEFAULT_MOOD_PRIMARY = '#2c2119';
const DEFAULT_MOOD_SECONDARY = '#141c2b';
const TUNNEL_MOOD_PRIMARY = '#1c2638';
const TUNNEL_MOOD_SECONDARY = '#302019';
const IDLE_RING_RATES = [0.22, -0.17, 0.26, -0.14];
const RING_AXIS_VECTORS = RING_AXES.map((axis) => new THREE.Vector3(...axis));
const GAZE_FOV = 42;

function repairNeighbourDuplicates(pool, uniqueCount) {
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

function shuffledPhotoPool(photos, count) {
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
    (entry) => Number.isFinite(photos[entry.photoIndex]?.spectralKey)
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

function deterministicHash(index) {
  let x = ((index + 1) * 0x9e3779b1) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 0xffffffff;
}

function aspectScaleFactors(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) return [1, 1];
  const ratio = clamp(aspect, 0.68, 1.55) / 1.5;
  const root = Math.sqrt(ratio);
  return [clamp(root, 0.70, 1.04), clamp(1 / root, 0.96, 1.32)];
}

export class PhotoUniverse {
  constructor(container, {
    onPick,
    onHoverPhoto,
    onHoverStateChange,
    onFocusChange,
    onFilmProgress,
    onFilmEnd,
    onModeChange,
    onContextLost,
    onFrame,
  } = {}) {
    this.container = container;
    this.callbacks = {
      onPick,
      onHoverPhoto,
      onHoverStateChange,
      onFocusChange,
      onFilmProgress,
      onFilmEnd,
      onModeChange,
      onContextLost,
      onFrame,
    };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.fog = new THREE.FogExp2(BACKGROUND, 0.0022);
    this.camera = new THREE.PerspectiveCamera(54, 1, 0.08, 600);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '三维照片宇宙');
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.callbacks.onContextLost?.();
    });
    this.group = new THREE.Group();
    this.parallaxGroup = new THREE.Group();
    this.parallaxGroup.add(this.group);
    this.scene.add(this.parallaxGroup);

    this.atmosphere = createAtmosphereField();
    this.scene.add(this.atmosphere.mesh);
    this.moodPrimaryTarget = new THREE.Color(DEFAULT_MOOD_PRIMARY);
    this.moodSecondaryTarget = new THREE.Color(DEFAULT_MOOD_SECONDARY);
    this._hoveredPhotoIndex = -1;
    this._dragBankTarget = 0;
    this._dragBankCurrent = 0;

    this.dustField = createDustField(260);
    this.scene.add(this.dustField.points);

    this.pointerTarget = new THREE.Vector2();
    this.pointerCurrent = new THREE.Vector2();
    this.hoverNdc = new THREE.Vector2();
    this.hoverPointer = null;
    this.lastHoverTime = -Infinity;
    this.hoveredInstanceKey = null;
    this.hoverTargetWorld = new THREE.Vector3(0, 0, 9999);
    this.hoverActive = false;
    this.renderer.domElement.style.cursor = 'grab';
    this.dragging = false;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 360;
    this.controls.zoomSpeed = 0.6;
    this.controls.rotateSpeed = 0.45;
    // Track whether the camera still sits on the aspect-driven default framing
    // (so resize re-fits distance) versus a user-dragged view (leave it alone).
    this.defaultView = true;
    this._viewW = 0;
    this._viewH = 0;
    this._tmpVec = new THREE.Vector3();
    this.controls.addEventListener('start', () => {
      this.dragging = true;
      this.pointerTarget.set(0, 0);
      this.renderer.domElement.style.cursor = 'grabbing';
    });
    this.controls.addEventListener('end', () => {
      this.dragging = false;
      this.renderer.domElement.style.cursor = this.film || this.focusState ? 'default' : 'grab';
    });
    this.meshes = [];
    this.textures = [];
    this.instances = [];
    // Atlas canvases currently backing our textures. Guarded on the next
    // setPhotos so a reused canvas is never cleared out from under the camera.
    this.atlasCanvases = new Set();
    this.mode = 'orbit';
    this.running = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.speed = 0.7;
    this.elapsed = 0;
    this.film = null;
    this.focusState = null;
    this.focusPlate = null;
    this.focusGeneration = 0;
    this.exportResolution = null;
    this._slowFrames = 0;
    this._postDegraded = false;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pointerEnabled = !this.reducedMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

    const lowMemory = (globalThis.navigator?.deviceMemory || 8) <= 4;
    if (!this.reducedMotion && !lowMemory) {
      try {
        this.darkroomPipeline = new DarkroomPipeline(this.renderer);
      } catch {
        this.darkroomPipeline = null;
      }
    }

    this.photoUniforms = {
      uReveal: { value: 1 },
      uDepthNear: { value: 36 },
      uDepthFar: { value: 110 },
      uTunnelMode: { value: 0 },
      uPaperBackground: { value: new THREE.Color(BACKGROUND) },
      uHoverWorld: { value: new THREE.Vector3(0, 0, 9999) },
      uHoverStrength: { value: 0 },
      uFocusAmount: { value: 0 },
      uFocusWorld: { value: new THREE.Vector3(0, 0, 9999) },
    };
    this.instanceDirty = false; // instances need per-frame matrix recomputation
    this.boundsDirty = false;   // instanced bounding spheres are stale after morph
    this.tunnelTwist = 0;
    this.appliedTunnelTwist = 0;
    this.tunnelConveyor = 0;
    this.appliedTunnelConveyor = 0;
    this.stellationBreath = 0;
    this.appliedStellationBreath = 0;
    this.ringAngles = [0, 0, 0, 0];
    this.appliedRingAngles = [0, 0, 0, 0];
    this.tunnelLayers = [];
    this.frozenFormation = false;
    this.dummy = new THREE.Object3D();
    this.quaternion = new THREE.Quaternion();
    this.euler = new THREE.Euler();
    this.raycaster = new THREE.Raycaster();
    this.activePointers = new Map();
    this.tapGesture = null;
    this.renderer.domElement.addEventListener('pointerdown', event => this.beginPointer(event));
    this.renderer.domElement.addEventListener('pointermove', event => {
      this.movePointer(event);
      if (!this.pointerEnabled || this.dragging || this.film || this.focusState || event.buttons || event.pointerType === 'touch') return;
      this.hoverPointer = [event.clientX, event.clientY];
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerTarget.set(clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1), clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1));
    });
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.pointerTarget.set(0, 0);
      this.clearHover();
    });
    this.renderer.domElement.addEventListener('pointercancel', event => {
      this.endPointer(event, true);
      this.pointerTarget.set(0, 0);
      this.clearHover();
    });
    this.renderer.domElement.addEventListener('pointerup', event => this.endPointer(event));
    this.renderer.domElement.addEventListener('wheel', event => {
      if (!this.film && !this.focusState && this.controls.enabled && event.deltaY) this.claimManualView();
    }, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.resetView(true);
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(time => this.animate(time));
  }

  ensurePhotoUniforms() {
    const u = (this.photoUniforms ||= {});
    u.uReveal ||= { value: 1 };
    u.uDepthNear ||= { value: 36 };
    u.uDepthFar ||= { value: 110 };
    u.uTunnelMode ||= { value: this.mode === 'tunnel' ? 1 : 0 };
    u.uPaperBackground ||= { value: new THREE.Color(BACKGROUND) };
    u.uHoverWorld ||= { value: new THREE.Vector3(0, 0, 9999) };
    u.uHoverStrength ||= { value: 0 };
    u.uFocusAmount ||= { value: 0 };
    u.uFocusWorld ||= { value: new THREE.Vector3(0, 0, 9999) };
    return u;
  }

  resize() {
    const locked = this.exportResolution;
    const rect = locked ? null : this.container.getBoundingClientRect();
    const width = Math.max(1, locked ? locked.width : rect.width);
    const height = Math.max(1, locked ? locked.height : rect.height);
    this._viewW = width;
    this._viewH = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (locked) {
      this.renderer.setSize(width, height, false);
    } else {
      this.renderer.setSize(width, height);
    }
    const pixelRatio = this.renderer.getPixelRatio?.() || 1;
    if (this.dustField) this.dustField.uniforms.uPixelRatio.value = pixelRatio;
    if (this.darkroomPipeline) {
      const mobile = orbitFraming(this.camera.aspect, 54).mobile;
      this.darkroomPipeline.enabled = (!mobile || Boolean(locked)) && !this.reducedMotion && !this._postDegraded;
      this.darkroomPipeline.setSize(width, height, pixelRatio);
    }
    // Aspect can flip between portrait/landscape: re-fit the default orbit
    // distance (never recursing back through resetView) and refresh the offset.
    this.reframeDefaultView();
    this.applyViewOffset();
  }

  setExportResolution(width, height) {
    if (!width || !height) {
      this.clearExportResolution();
      return;
    }
    if (this.focusState) this.closeFocus(true);
    this.exportResolution = { width: Math.round(width), height: Math.round(height) };
    this.renderer.setPixelRatio?.(1);
    this.resize();
    this.resetView(true);
  }

  clearExportResolution() {
    if (!this.exportResolution) return;
    this.exportResolution = null;
    if (typeof window !== 'undefined') {
      this.renderer.setPixelRatio?.(Math.min(window.devicePixelRatio || 1, 1.8));
    }
    this.resize();
  }

  // Re-fit the resting orbit camera distance from the new aspect along the
  // current viewing direction. Only for the default view; user-dragged views
  // and the cinematic/tunnel framings are left untouched.
  reframeDefaultView() {
    if (this.film || this.focusState || !this.defaultView || this.mode !== 'orbit') return;
    const amount = portraitAmount(this.camera.aspect);
    if (this.instances.length && Math.abs(amount - (this.formationPortrait || 0)) > 1e-6) {
      this.setFormation('orbit', false, true);
      return;
    }
    const framing = orbitFraming(this.camera.aspect, this.camera.fov);
    const dir = this._tmpVec.subVectors(this.camera.position, this.controls.target);
    const len = dir.length();
    if (len < 1e-4) return;
    if (this.instances.length && Math.abs(framing.distance - len) > 0.02) {
      // A second resize must retain an in-flight pose's destination, rather
      // than freezing the sculpture at its partly rotated current quaternion.
      const rotation = (this.viewTransition?.rotation || this.group.quaternion).clone();
      this.resetView(false);
      if (this.viewTransition) this.viewTransition.rotation.copy(rotation);
      return;
    }
    dir.multiplyScalar(framing.distance / len);
    this.camera.position.copy(this.controls.target).add(dir);
    if (this.viewTransition) {
      const view = this.viewTransition;
      view.position.fromArray(orbitPosition(this.camera.aspect));
      view.fromPosition.copy(this.camera.position);
      view.fromTarget.copy(this.controls.target);
      view.fromUp.copy(this.camera.up);
      view.fromFov = this.camera.fov;
      view.fromRotation.copy(this.group.quaternion);
      view.duration = Math.max(0.12, view.duration - view.elapsed);
      view.elapsed = 0;
    }
    this.camera.updateProjectionMatrix();
  }

  // Apply the projection view offset. During the film it follows the continuous
  // flight schedule (eases to 0 through the tunnel and back to rest at 30s);
  // at rest it uses the same resting fractions, so a natural end is
  // projection-matrix identical to a resize.
  applyViewOffset() {
    const w = this._viewW || 0;
    const h = this._viewH || 0;
    const { x, y } = restingViewFractions(this.camera.aspect);
    let fx = x;
    let fy = y;
    if (this.film) {
      const off = flightViewOffset(this.film.elapsed || 0, x, y, this.film.startOffset);
      fx = off.x;
      fy = off.y;
    } else if (this.mode === 'tunnel' || this.focusState) {
      fx = 0;
      fy = 0;
    }
    if (this.viewTransition && !this.film) {
      const progress = easeInOut(this.viewTransition.elapsed / this.viewTransition.duration);
      const from = this.viewTransition.fromOffset;
      const to = this.viewTransition.toOffset;
      const destX = to ? to.x : fx;
      const destY = to ? to.y : fy;
      fx = THREE.MathUtils.lerp(from.x, destX, progress);
      fy = THREE.MathUtils.lerp(from.y, destY, progress);
    } else if (!this.film && !this.focusState && this.heldViewOffset) {
      fx = this.heldViewOffset.x;
      fy = this.heldViewOffset.y;
    }
    const px = fx * w;
    const py = fy * h;
    if (px === 0 && py === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, px, py, w, h);
  }

  // Consume OrbitControls' pending deltas, then restore the visible pose. A
  // damping flush must never itself move the first frame of the film.
  flushDamping() {
    const position = this.camera.position.clone();
    const up = this.camera.up.clone();
    const quaternion = this.camera.quaternion.clone();
    const target = this.controls.target.clone();
    const wasEnabled = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(position);
    this.camera.up.copy(up);
    this.camera.quaternion.copy(quaternion);
    this.controls.target.copy(target);
    this.controls.enableDamping = wasEnabled;
  }

  // Seed the idle oscillation clock so group.rotation.x continues from the
  // current tilt instead of snapping to sin(staleElapsed * OMEGA) * AMP.
  alignIdlePhase() {
    this.idleBaseTilt = this.mode === 'orbit' ? restRotation(this.layoutAspect ?? this.camera.aspect)[0] : 0;
    const ratio = clamp((this.group.rotation.x - this.idleBaseTilt) / OSC_AMP, -1, 1);
    this.elapsed = Math.asin(ratio) / OSC_OMEGA;
    this.idleTiltOffset = this.group.rotation.x - this.idleBaseTilt - ratio * OSC_AMP;
    this.idleYawElapsed = 0;
  }

  claimManualView() {
    if (this.focusState) return;
    this.defaultView = false;
    this.viewTransition = null;
  }

  beginPointer(event) {
    if (this.film) return;
    const pointers = this.activePointers ||= new Map();
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1 && event.isPrimary !== false && (event.pointerType === 'touch' || event.button === 0)) {
      this.tapGesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, maxDistance: 0, blocked: false };
    } else if (this.tapGesture) this.tapGesture.blocked = true;
  }

  movePointer(event) {
    const pointers = this.activePointers;
    if (!pointers?.has(event.pointerId) || this.film) return;
    const previous = pointers.get(event.pointerId);
    const dx = event.clientX - previous[0];
    const moved = Math.hypot(dx, event.clientY - previous[1]);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1 && !this.focusState && !this.reducedMotion) {
      this._dragBankTarget = clamp((this._dragBankTarget || 0) * 0.65 - dx * 0.00055, -0.028, 0.028);
    }
    const tap = this.tapGesture;
    if (tap?.pointerId === event.pointerId) tap.maxDistance = Math.max(tap.maxDistance, Math.hypot(event.clientX - tap.x, event.clientY - tap.y));
    if (!this.focusState && ((tap?.maxDistance > 6) || (pointers.size > 1 && moved > 0.5))) this.claimManualView();
  }

  endPointer(event, cancelled = false) {
    const pointers = this.activePointers;
    if (!pointers?.has(event.pointerId)) return false;
    const tap = this.tapGesture;
    const dx = tap?.pointerId === event.pointerId ? event.clientX - tap.x : 0;
    const dy = tap?.pointerId === event.pointerId ? event.clientY - tap.y : 0;
    if (tap?.pointerId === event.pointerId) tap.maxDistance = Math.max(tap.maxDistance, Math.hypot(dx, dy));
    const picked = !cancelled && !this.film && pointers.size === 1 && tap?.pointerId === event.pointerId && !tap.blocked && tap.maxDistance <= 6;
    const swipedInFocus = !cancelled && !this.film && Boolean(this.focusState) && pointers.size === 1 && tap?.pointerId === event.pointerId && Math.abs(dx) >= 44 && Math.abs(dx) > Math.abs(dy) * 1.4;
    pointers.delete(event.pointerId);
    if (cancelled && tap) tap.blocked = true;
    if (!pointers.size) this.tapGesture = null;
    if (swipedInFocus) {
      this.callbacks.onFocusChange?.({ active: true, step: dx < 0 ? 1 : -1 });
      return true;
    }
    if (picked) this.pickPhoto(event.clientX, event.clientY);
    return picked;
  }

  pickPhoto(clientX, clientY) {
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverNdc.set((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.hoverNdc, this.camera);
    if (this.boundsDirty) {
      for (const mesh of this.meshes) mesh.computeBoundingSphere();
      this.boundsDirty = false;
    }
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    if (hit?.instanceId !== undefined) {
      const photoIndex = hit.object.userData?.photoIndices?.[hit.instanceId];
      const instanceIndex = hit.object.userData?.instanceIndices?.[hit.instanceId];
      if (this.focusState && instanceIndex !== undefined && this.focusState.instanceIndex === instanceIndex) return;
      if (photoIndex !== undefined) this.callbacks.onPick?.(photoIndex, instanceIndex);
    } else if (this.focusState) {
      this.closeFocus(false);
    }
  }

  clearHover() {
    const wasActive = Boolean(this.hoverActive);
    this.hoverPointer = null;
    this.hoverActive = false;
    this.hoveredInstanceKey = null;
    this._hoveredPhotoIndex = -1;
    if (this.renderer?.domElement) {
      this.renderer.domElement.style.cursor = this.film || this.focusState ? 'default' : this.dragging ? 'grabbing' : 'grab';
    }
    if (wasActive) this.callbacks?.onHoverStateChange?.({ active: false, photoIndex: -1 });
  }

  updateHover(time) {
    if (!this.renderer?.domElement) return;
    if (!this.pointerEnabled || this.film || this.focusState || this.dragging || this.instanceDirty || !this.hoverPointer) {
      const wasActive = Boolean(this.hoverActive);
      this.hoverActive = false;
      this.hoveredInstanceKey = null;
      this._hoveredPhotoIndex = -1;
      this.renderer.domElement.style.cursor = this.film || this.focusState ? 'default' : this.dragging ? 'grabbing' : 'grab';
      if (wasActive) this.callbacks?.onHoverStateChange?.({ active: false, photoIndex: -1 });
      return;
    }
    if (time - this.lastHoverTime < 100) return;
    this.lastHoverTime = time;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverNdc.set((this.hoverPointer[0] - rect.left) / rect.width * 2 - 1, -(this.hoverPointer[1] - rect.top) / rect.height * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    if (this.boundsDirty) {
      for (const mesh of this.meshes) mesh.computeBoundingSphere();
      this.boundsDirty = false;
    }
    this.raycaster.setFromCamera(this.hoverNdc, this.camera);
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    if (hit?.instanceId !== undefined) {
      this.renderer.domElement.style.cursor = 'pointer';
      this.hoverActive = true;
      this.hoverTargetWorld ||= new THREE.Vector3();
      this.hoverTargetWorld.copy(hit.point);
      const photoIndex = hit.object.userData?.photoIndices?.[hit.instanceId];
      const key = `${hit.object.uuid}:${hit.instanceId}`;
      if (key !== this.hoveredInstanceKey) {
        this.hoveredInstanceKey = key;
        this._hoveredPhotoIndex = photoIndex ?? -1;
        if (photoIndex !== undefined) {
          this.callbacks.onHoverPhoto?.(photoIndex);
          this.callbacks.onHoverStateChange?.({
            active: true,
            photoIndex,
            x: this.hoverPointer[0],
            y: this.hoverPointer[1],
          });
        }
      }
    } else {
      const wasActive = Boolean(this.hoverActive);
      this.renderer.domElement.style.cursor = 'grab';
      this.hoverActive = false;
      this.hoveredInstanceKey = null;
      this._hoveredPhotoIndex = -1;
      if (wasActive) this.callbacks?.onHoverStateChange?.({ active: false, photoIndex: -1 });
    }
  }

  _disposeFocusPlate() {
    if (this.focusPlateOwnedTexture) {
      this.focusPlateOwnedTexture.dispose();
      this.focusPlateOwnedTexture = null;
    }
    if (!this.focusPlate) return;
    this.focusOverlayScene?.remove(this.focusPlate);
    this.scene.remove(this.focusPlate);
    for (const child of [...this.focusPlate.children]) {
      child.material?.dispose?.();
      child.geometry?.dispose?.();
    }
    this.focusPlate.clear();
    this.focusPlate.material.map = null;
    this.focusPlate.material.dispose();
    this.focusPlate.geometry.dispose();
    this.focusPlate = null;
  }

  _findBestInstanceForPhoto(photoIndex, preferredInstanceIndex = -1) {
    if (
      Number.isInteger(preferredInstanceIndex) &&
      preferredInstanceIndex >= 0 &&
      preferredInstanceIndex < this.instances.length
    ) {
      const candidate = this.instances[preferredInstanceIndex];
      if (candidate?.mesh?.userData?.photoIndices?.[candidate.localIndex] === photoIndex) {
        return preferredInstanceIndex;
      }
    }
    const camPos = this.camera.position;
    const refCamPos = this.focusState?.saved?.position || camPos;
    const worldMat = this._focusMat ||= new THREE.Matrix4();
    const pos = this._focusTmpPos ||= new THREE.Vector3();
    const quat = this._focusTmpQuat ||= new THREE.Quaternion();
    const scale = this._focusTmpScale ||= new THREE.Vector3();
    const normal = this._focusTmpNormal ||= new THREE.Vector3();
    const upVec = this._focusTmpUp ||= new THREE.Vector3();
    const toCam = this._focusTmpToCam ||= new THREE.Vector3();
    const refCamDir = (this._focusTmpRefDir ||= new THREE.Vector3()).copy(refCamPos);
    refCamDir.divideScalar(Math.max(1, refCamDir.length()));

    this.scene.updateMatrixWorld(true);
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i];
      if (!inst || inst.mesh.userData.photoIndices[inst.localIndex] !== photoIndex) continue;
      inst.mesh.getMatrixAt(inst.localIndex, this.dummy.matrix);
      worldMat.multiplyMatrices(inst.mesh.matrixWorld, this.dummy.matrix);
      worldMat.decompose(pos, quat, scale);
      normal.set(0, 0, 1).applyQuaternion(quat).normalize();
      upVec.set(0, 1, 0).applyQuaternion(quat).normalize();
      toCam.subVectors(refCamPos, pos);
      const refDist = Math.max(1, toCam.length());
      toCam.divideScalar(refDist);
      const facing = normal.dot(toCam);
      const hemisphere = pos.dot(refCamDir) / Math.max(1, pos.length());
      const glideDist = camPos.distanceTo(pos);
      const score = facing * 3.4 + upVec.y * 3.2 + hemisphere * 2.6 - glideDist * 0.025;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  /**
   * Fly the camera smoothly to gaze at a physical 3D photograph card in situ,
   * dimming the surrounding 2,999 prints and mounting a full-resolution hero plate.
   */
  focusPhoto(photoIndex, preferredInstanceIndex = -1) {
    if (this.film || !this.instances.length) return false;
    const instanceIndex = this._findBestInstanceForPhoto(photoIndex, preferredInstanceIndex);
    if (instanceIndex < 0) return false;

    this.flushDamping();
    if (this.parallaxGroup) {
      this.pointerTarget?.set(0, 0);
      this.pointerCurrent?.set(0, 0);
      this.parallaxGroup.rotation.set(0, 0, 0);
    }
    // Settle any active morph so the card sits on a stable world pose.
    if (this.instanceDirty) {
      for (const instance of this.instances) {
        instance.position.copy(instance.targetPosition);
        instance.quaternion.copy(instance.targetQuaternion);
        instance.scale = instance.targetScale;
        instance.settled = true;
      }
      this.writeInstanceMatrices();
    }

    const saved = this.focusState?.saved || {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      up: this.camera.up.clone(),
      fov: this.camera.fov,
      rotation: this.group.quaternion.clone(),
      defaultView: this.defaultView,
      running: this.running,
      heldViewOffset: this.heldViewOffset ? { ...this.heldViewOffset } : null,
      offset: this.camera.view?.enabled
        ? { x: this.camera.view.offsetX / this.camera.view.fullWidth, y: this.camera.view.offsetY / this.camera.view.fullHeight }
        : restingViewFractions(this.camera.aspect),
    };

    this.scene.updateMatrixWorld(true);
    const inst = this.instances[instanceIndex];
    inst.mesh.getMatrixAt(inst.localIndex, this.dummy.matrix);
    const worldMat = (this._focusMat ||= new THREE.Matrix4()).multiplyMatrices(inst.mesh.matrixWorld, this.dummy.matrix);
    const cardPos = new THREE.Vector3();
    const cardQuat = new THREE.Quaternion();
    const cardScale = new THREE.Vector3();
    worldMat.decompose(cardPos, cardQuat, cardScale);

    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(cardQuat).normalize();
    const toViewer = this.camera.position.clone().sub(cardPos);
    if (toViewer.lengthSq() > 1e-4 && normal.dot(toViewer) < 0) {
      cardQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      normal.negate();
    }
    const cardUp = new THREE.Vector3(0, 1, 0).applyQuaternion(cardQuat).normalize();
    if (cardUp.y < -0.15) {
      cardQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
      cardUp.negate();
    }
    const photoMeta = this.photos?.[photoIndex];
    let heroScale;
    if (photoMeta?.width > 0 && photoMeta?.height > 0) {
      const nativeAspect = clamp(photoMeta.width / photoMeta.height, 0.62, 1.85);
      const baseMag = (Math.hypot(cardScale.x, cardScale.y) / Math.SQRT2) * 1.48;
      const root = Math.sqrt(nativeAspect / 1.5);
      heroScale = new THREE.Vector3(baseMag * root, baseMag / root, Math.abs(cardScale.z || 1) * 1.45);
    } else {
      heroScale = cardScale.clone().multiplyScalar(1.45);
    }
    const heroPos = cardPos.clone().addScaledVector(normal, 2.1);
    const cardW = 1.12 * Math.abs(heroScale.x);
    const cardH = 0.76 * Math.abs(heroScale.y);
    const vHalfTan = Math.tan(THREE.MathUtils.degToRad(GAZE_FOV * 0.5));
    const hHalfTan = Math.max(0.24, vHalfTan * this.camera.aspect);
    const gazeDist = Math.max(1.85, (cardH * 0.5) / (vHalfTan * 0.64), (cardW * 0.5) / (hHalfTan * 0.70));
    const camDest = heroPos.clone().addScaledVector(normal, gazeDist);

    const uniforms = this.ensurePhotoUniforms();
    uniforms.uFocusWorld.value.copy(cardPos);

    this.focusState = {
      photoIndex,
      instanceIndex,
      cardPos,
      heroPos,
      cardQuat,
      cardScale,
      heroScale,
      elapsed: this.reducedMotion ? 0.85 : 0,
      duration: 0.85,
      saved,
      plateReady: false,
    };
    this.running = false;
    this.controls.enabled = false;
    this.clearHover();

    const fromOffset = this.camera.view?.enabled
      ? { x: this.camera.view.offsetX / this.camera.view.fullWidth, y: this.camera.view.offsetY / this.camera.view.fullHeight }
      : { x: 0, y: 0 };

    if (this.reducedMotion) {
      this.camera.position.copy(camDest);
      this.controls.target.copy(heroPos);
      this.camera.up.copy(cardUp);
      this.camera.fov = GAZE_FOV;
      this.viewTransition = null;
      uniforms.uFocusAmount.value = 1;
    } else {
      this.viewTransition = {
        elapsed: 0,
        duration: 1.05,
        fromPosition: this.camera.position.clone(),
        position: camDest,
        fromTarget: this.controls.target.clone(),
        target: heroPos.clone(),
        fromUp: this.camera.up.clone(),
        up: cardUp,
        fromFov: this.camera.fov,
        fov: GAZE_FOV,
        fromRotation: this.group.quaternion.clone(),
        rotation: this.group.quaternion.clone(),
        fromOffset,
        toOffset: { x: 0, y: 0 },
      };
    }
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();

    // Mount levitating hero plate starting seamlessly from the physical print's slot.
    this._mountFocusHeroPlate(photoIndex, inst, cardPos, heroPos, cardQuat, cardScale, heroScale);
    this.callbacks.onFocusChange?.({ active: true, photoIndex, instanceIndex });
    return true;
  }

  _setFocusPlateUvRect(u0, v0, uw, vh) {
    const uv = this.focusPlate?.geometry?.getAttribute('uv');
    if (!uv) return;
    uv.setXY(0, u0, v0 + vh);
    uv.setXY(1, u0 + uw, v0 + vh);
    uv.setXY(2, u0, v0);
    uv.setXY(3, u0 + uw, v0);
    uv.needsUpdate = true;
  }

  _mountFocusHeroPlate(photoIndex, inst, cardPos, heroPos, cardQuat, cardScale, heroScale) {
    const generation = ++this.focusGeneration;
    if (this.focusPlateOwnedTexture) {
      this.focusPlateOwnedTexture.dispose();
      this.focusPlateOwnedTexture = null;
    }
    this.focusOverlayScene ||= new THREE.Scene();
    if (!this.focusPlate) {
      const geometry = new THREE.PlaneGeometry(1.08, 0.72);
      const material = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      this.focusPlate = new THREE.Mesh(geometry, material);
      this.focusPlate.frustumCulled = false;
      this.focusPlate.renderOrder = 8;

      // Museum archival paper mat + soft darkroom ambient halo behind the levitating print
      const frameGeo = new THREE.PlaneGeometry(1.48, 1.08);
      const frameMat = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uLift: { value: this.reducedMotion ? 1 : 0 },
          uAspectScale: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform float uLift;
          uniform vec2 uAspectScale;
          varying vec2 vUv;
          void main() {
            vec2 p = (vUv - vec2(0.5)) * vec2(1.48, 1.08) * uAspectScale;
            vec2 halfPrint = vec2(0.54, 0.36) * uAspectScale;
            vec2 d = abs(p) - halfPrint;
            float boxDist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
            float minScale = min(uAspectScale.x, uAspectScale.y);
            float borderThickness = 0.013 * minScale;
            float matMask = 1.0 - smoothstep(borderThickness - 0.002, borderThickness + 0.002, boxDist);
            float shadowDist = max(0.0, boxDist - borderThickness);
            float maxHalo = 0.165 * minScale;
            float edgeFade = 1.0 - smoothstep(maxHalo * 0.42, maxHalo * 0.95, shadowDist);
            float halo = exp(-shadowDist * 13.0) * 0.64 * edgeFade;
            vec3 matColor = vec3(0.952, 0.936, 0.904);
            vec3 shadowColor = vec3(0.01, 0.01, 0.016);
            vec3 col = mix(shadowColor, matColor, matMask);
            float alpha = max(matMask * 0.96, halo) * uLift;
            if (alpha < 0.003) discard;
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const frameMesh = new THREE.Mesh(frameGeo, frameMat);
      frameMesh.position.z = -0.004;
      frameMesh.frustumCulled = false;
      frameMesh.renderOrder = 7;
      this.focusPlate.add(frameMesh);
      this.focusPlate.userData.frameMat = frameMat;
      this.focusOverlayScene.add(this.focusPlate);
    }

    const frameMat = this.focusPlate.userData?.frameMat;
    if (frameMat) {
      frameMat.uniforms.uLift.value = this.reducedMotion ? 1 : 0;
      frameMat.uniforms.uAspectScale.value.set(Math.abs(heroScale.x), Math.abs(heroScale.y));
    }

    // Frame-0 seamless atlas preview while full-resolution print decodes.
    const atlasRectAttr = inst.mesh.geometry.getAttribute('atlasRect');
    const sharedMap = inst.mesh.material.map || null;
    if (atlasRectAttr && sharedMap) {
      const base = inst.localIndex * 4;
      this._setFocusPlateUvRect(
        atlasRectAttr.array[base],
        atlasRectAttr.array[base + 1],
        atlasRectAttr.array[base + 2],
        atlasRectAttr.array[base + 3],
      );
      this.focusPlate.material.map = sharedMap;
      this.focusPlate.material.opacity = 1;
      this.focusPlate.material.needsUpdate = true;
    } else {
      this._setFocusPlateUvRect(0, 0, 1, 1);
      this.focusPlate.material.map = null;
      this.focusPlate.material.opacity = 0;
    }

    this.focusPlate.position.copy(this.reducedMotion ? heroPos : cardPos);
    this.focusPlate.quaternion.copy(cardQuat);
    this.focusPlate.scale.copy(this.reducedMotion ? heroScale : cardScale);

    const photo = this.photos?.[photoIndex];
    if (!photo?.url || typeof Image === 'undefined') return;
    const img = new Image();
    img.decoding = 'async';
    img.src = photo.url;
    const finishDecode = () => {
      if (generation !== this.focusGeneration || !this.focusState || !this.focusPlate) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0 && (!photo.width || !photo.height)) {
        photo.width = img.naturalWidth;
        photo.height = img.naturalHeight;
        const nativeAspect = clamp(img.naturalWidth / img.naturalHeight, 0.62, 1.85);
        const baseMag = (Math.hypot(cardScale.x, cardScale.y) / Math.SQRT2) * 1.48;
        const root = Math.sqrt(nativeAspect / 1.5);
        this.focusState.heroScale.set(baseMag * root, baseMag / root, Math.abs(cardScale.z || 1) * 1.45);
        frameMat?.uniforms.uAspectScale.value.set(
          Math.abs(this.focusState.heroScale.x),
          Math.abs(this.focusState.heroScale.y),
        );
      }
      const texture = new THREE.Texture(img);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      if (this.focusPlateOwnedTexture) this.focusPlateOwnedTexture.dispose();
      this.focusPlateOwnedTexture = texture;
      this._setFocusPlateUvRect(0, 0, 1, 1);
      this.focusPlate.material.map = texture;
      this.focusPlate.material.opacity = 1;
      this.focusPlate.material.needsUpdate = true;
      this.focusState.plateReady = true;
    };
    if (typeof img.decode === 'function') {
      img.decode().then(finishDecode).catch(() => {});
    } else {
      img.onload = finishDecode;
    }
  }

  closeFocus(instant = false, notify = true) {
    if (!this.focusState) return false;
    const { saved } = this.focusState;
    this.focusState = null;
    this.focusGeneration++;
    this._disposeFocusPlate();
    this.controls.enabled = true;
    this.defaultView = saved.defaultView;
    this.heldViewOffset = saved.heldViewOffset;
    this.running = saved.running;

    const uniforms = this.ensurePhotoUniforms();
    if (instant || this.reducedMotion) {
      this.camera.position.copy(saved.position);
      this.controls.target.copy(saved.target);
      this.camera.up.copy(saved.up);
      this.camera.fov = saved.fov;
      this.group.quaternion.copy(saved.rotation);
      this.viewTransition = null;
      uniforms.uFocusAmount.value = 0;
      this.alignIdlePhase();
    } else {
      this.viewTransition = {
        elapsed: 0,
        duration: 0.95,
        fromPosition: this.camera.position.clone(),
        position: saved.position.clone(),
        fromTarget: this.controls.target.clone(),
        target: saved.target.clone(),
        fromUp: this.camera.up.clone(),
        up: saved.up.clone(),
        fromFov: this.camera.fov,
        fov: saved.fov,
        fromRotation: this.group.quaternion.clone(),
        rotation: saved.rotation.clone(),
        fromOffset: { x: 0, y: 0 },
        toOffset: saved.offset,
      };
    }
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    if (notify) this.callbacks.onFocusChange?.({ active: false });
    return true;
  }

  // Dispose meshes/geometry/material/texture. With no `keepCanvases` (a direct
  // call) every backing CPU canvas is released too; when a set is supplied the
  // reused canvases are preserved so the next textures are not built on a
  // canvas we just zeroed.
  clearPhotos(keepCanvases = null) {
    if (this.focusState) this.closeFocus(true, false);
    this._disposeFocusPlate();
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const texture of this.textures) texture.dispose();
    for (const canvas of this.atlasCanvases) {
      if (canvas && !(keepCanvases && keepCanvases.has(canvas))) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    this.meshes = [];
    this.textures = [];
    this.instances = [];
    this.photos = [];
    this.count = 0;
    this.atlasCanvases.clear();
    this.instanceDirty = false;
    this.boundsDirty = false;
    this.morph = null;
    this.reveal = null;
    this.tunnelTwist = 0;
    this.appliedTunnelTwist = 0;
    this.tunnelConveyor = 0;
    this.appliedTunnelConveyor = 0;
    this.stellationBreath = 0;
    this.appliedStellationBreath = 0;
    this.ringAngles = [0, 0, 0, 0];
    this.appliedRingAngles = [0, 0, 0, 0];
    this.tunnelLayers = [];
    this.frozenFormation = false;
    this.clearHover();
  }

  setPhotos(photos, atlases, count = 1200, options = {}) {
    const successful = atlases.flatMap((atlas, atlasIndex) => atlas.photoIndices.map((photoIndex, tile) => ({ atlasIndex, photoIndex, tile })));
    if (!successful.length) throw new Error('没有可以显示的照片。请导入 JPG、PNG 或 WebP 格式。');
    // Demo repetition may use 1200 cards; every successfully imported photo
    // must still appear even when the caller omits or understates the count.
    const requested = Number.isSafeInteger(count) && count > 0 ? count : 1200;
    count = Math.max(requested, successful.length);
    const hadPhotos = this.instances.length > 0;
    const incomingCanvases = new Set(atlases.map(atlas => atlas.canvas));
    this.clearPhotos(incomingCanvases);
    this.atlasCanvases = incomingCanvases;
    this.photos = photos;
    this.count = count;
    const uniforms = this.ensurePhotoUniforms();
    uniforms.uTunnelMode.value = this.mode === 'tunnel' ? 1 : 0;

    const batches = atlases.map(() => []);
    const rawPool = chromaticPhotoPool(successful, photos, count);
    const hasSpectral = Array.isArray(photos) && successful.some(
      (entry) => Number.isFinite(photos[entry.photoIndex]?.spectralKey)
    );
    // Weave 3 continuous spectral waves across the 3,000 slots so both the stellated
    // core, all 4 orbital rings, and the deep spiral corridor radiate full-spectrum hues.
    const pool = hasSpectral && count >= 18
      ? repairNeighbourDuplicates(
          [0, 1, 2].flatMap((wave) => rawPool.filter((_, idx) => idx % 3 === wave)),
          successful.length,
        )
      : rawPool;
    for (let index = 0; index < count; index++) {
      const entry = pool[index];
      batches[entry.atlasIndex].push({ ...entry, index });
    }
    atlases.forEach((atlas, atlasIndex) => {
      const batch = batches[atlasIndex];
      if (!batch.length) return;
      const texture = new THREE.CanvasTexture(atlas.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      this.textures.push(texture);
      const geometry = new THREE.PlaneGeometry(1.08, 0.72);
      const rects = new Float32Array(batch.length * 4);
      const fallbackRect = atlas.sampleRect || atlas.cellRect || { x: 2, y: 22, width: 124, height: 84, size: 128 };
      const columns = atlas.columns || 16;
      batch.forEach((entry, localIndex) => {
        const rect = atlas.slotSampleRects?.[entry.tile] || fallbackRect;
        const col = entry.tile % columns;
        const row = Math.floor(entry.tile / columns);
        rects.set([
          (col * rect.size + rect.x) / atlas.canvas.width,
          1 - (row * rect.size + rect.y + rect.height) / atlas.canvas.height,
          rect.width / atlas.canvas.width,
          rect.height / atlas.canvas.height,
        ], localIndex * 4);
      });
      geometry.setAttribute('atlasRect', new THREE.InstancedBufferAttribute(rects, 4));
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, color: '#ffffff' });
      material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        const varyings = 'varying vec2 vPaperUv;\nvarying vec3 vPhotoNormal;\nvarying vec3 vViewDir;\nvarying float vPhotoDepth;\nvarying float vHoverLift;\nvarying float vFocusKeep;\n';
        const vertUniforms = 'uniform vec3 uHoverWorld;\nuniform float uHoverStrength;\nuniform float uFocusAmount;\nuniform vec3 uFocusWorld;\n';
        shader.vertexShader = 'attribute vec4 atlasRect;\n' + vertUniforms + varyings + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = atlasRect.xy + vMapUv * atlasRect.zw;\n#endif');
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 cardWorldCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #else
            vec3 cardWorldCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          #endif
          float hoverDist = length(cardWorldCenter - uHoverWorld);
          vHoverLift = uHoverStrength * exp(-(hoverDist * hoverDist) / 16.0);
          vFocusKeep = 1.0 - smoothstep(0.04, 0.20, length(cardWorldCenter - uFocusWorld));
          transformed *= mix(1.0, 1.0 - vFocusKeep, smoothstep(0.02, 0.28, uFocusAmount));
          transformed.z += vHoverLift * 0.34 * (1.0 - uFocusAmount);
          transformed.xy *= 1.0 + vHoverLift * 0.045 * (1.0 - uFocusAmount);`);
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
          vPaperUv = uv;
          vPhotoNormal = normalize(normalMatrix * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          vViewDir = normalize(-mvPosition.xyz);
          vPhotoDepth = -mvPosition.z;`);
        shader.fragmentShader = varyings + 'uniform float uReveal;\nuniform float uDepthNear;\nuniform float uDepthFar;\nuniform float uTunnelMode;\nuniform float uFocusAmount;\nuniform vec3 uPaperBackground;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          vec3 n = normalize(vPhotoNormal);
          if (!gl_FrontFacing) n = -n;
          vec3 v = normalize(vViewDir);
          float key = clamp(dot(n, normalize(vec3(-0.36, 0.48, 0.80))), 0.0, 1.0);
          float fill = clamp(dot(n, normalize(vec3(0.46, -0.32, 0.83))), 0.0, 1.0);
          vec3 halfVec = normalize(normalize(vec3(-0.24, 0.36, 0.90)) + v);
          float spec = pow(clamp(dot(n, halfVec), 0.0, 1.0), 30.0) * 0.14;
          float fresnel = pow(1.0 - abs(dot(n, v)), 3.6) * 0.085;
          float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = clamp(mix(vec3(luma), diffuseColor.rgb, 1.18) * 1.06, 0.0, 1.0);
          float shade = 0.76 + 0.24 * key + 0.10 * fill;
          float backShade = gl_FrontFacing ? 1.0 : 0.82;
          float horizonFade = mix(
            mix(1.0, 0.88, smoothstep(uDepthNear, uDepthFar, vPhotoDepth)),
            1.0 - smoothstep(42.0, 152.0, vPhotoDepth),
            uTunnelMode
          );
          float focusDim = mix(1.0, mix(0.22, 1.0, vFocusKeep), uFocusAmount);
          vec2 edge = min(vPaperUv, vec2(1.0) - vPaperUv);
          float edgeDistance = min(edge.x, edge.y);
          float bevel = (1.0 - smoothstep(0.008, 0.032, edgeDistance)) * 0.055;
          diffuseColor.rgb = (diffuseColor.rgb * shade + vec3(spec + fresnel + bevel) * vec3(1.0, 0.97, 0.92)) * backShade * horizonFade;
          diffuseColor.rgb *= (1.0 + vHoverLift * 0.26 * (1.0 - uFocusAmount)) * focusDim;
          float aa = max(0.003, min(fwidth(edgeDistance), 0.014));
          diffuseColor.rgb *= smoothstep(0.0, aa, edgeDistance);
          diffuseColor.rgb = mix(uPaperBackground, diffuseColor.rgb, uReveal);`);
      };
      material.customProgramCacheKey = () => 'memoria-darkroom-v5';
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.userData.photoIndices = batch.map(entry => entry.photoIndex);
      mesh.userData.instanceIndices = batch.map(entry => entry.index);
      this.meshes.push(mesh);
      this.group.add(mesh);
      batch.forEach((entry, localIndex) => {
        const slotAspect = atlas.slotAspects?.[entry.tile];
        const [aspectX, aspectY] = aspectScaleFactors(slotAspect);
        this.instances[entry.index] = {
          mesh,
          localIndex,
          aspectX,
          aspectY,
          vortexHash: deterministicHash(entry.index),
          position: new THREE.Vector3(),
          quaternion: new THREE.Quaternion(),
          scale: 1,
          targetPosition: new THREE.Vector3(),
          targetQuaternion: new THREE.Quaternion(),
          targetScale: 1,
          ring: -1,
          facet: -1,
          breathDelta: null,
          settled: false,
        };
      });
    });
    this.setFormation(this.mode, true, false);
    uniforms.uReveal.value = this.reducedMotion ? 1 : 0;
    this.reveal = this.reducedMotion ? null : { elapsed: 0, duration: options?.genesis ? 1.55 : 1.35 };
    this.resetView(!hadPhotos);
    if (!this.reducedMotion && typeof this.renderer?.compile === 'function') {
      try { this.renderer.compile(this.scene, this.camera); } catch {}
    }

    // 2.25s Deep-Space Stardust Convergence ritual on initial load / album import.
    if (options?.genesis && !this.reducedMotion && this.instances.length) {
      this.euler ||= new THREE.Euler();
      this.instances.forEach((instance, index) => {
        const h1 = instance.vortexHash || deterministicHash(index);
        const h2 = deterministicHash(index + 9973);
        const h3 = deterministicHash(index + 4099);
        const targetAngle = Math.atan2(instance.targetPosition.y, instance.targetPosition.x);
        const nebulaRadius = 30 + 54 * h1;
        const nebulaAngle = targetAngle - (2.1 + 1.5 * h2);
        const nebulaZ = (h3 - 0.5) * 116;
        instance.fromPosition = new THREE.Vector3(
          Math.cos(nebulaAngle) * nebulaRadius,
          Math.sin(nebulaAngle) * nebulaRadius,
          nebulaZ,
        );
        instance.fromQuaternion = new THREE.Quaternion().setFromEuler(
          this.euler.set((h1 - 0.5) * 2.4, (h2 - 0.5) * 2.4, nebulaAngle)
        );
        instance.fromScale = instance.targetScale * 0.08;
        instance.position.copy(instance.fromPosition);
        instance.quaternion.copy(instance.fromQuaternion);
        instance.scale = instance.fromScale;
        instance.delay = h1 * 0.42;
        instance.settled = false;
      });
      this.morph = { elapsed: 0, duration: 2.25, vortex: true, vortexDirection: 1 };
      this.instanceDirty = true;
      this.boundsDirty = true;
      this.uploadInstanceMatrices();
      if (this.mode === 'orbit' && !this.film) {
        const restPos = new THREE.Vector3(...orbitPosition(this.camera.aspect));
        const farPos = restPos.clone().multiplyScalar(1.22);
        const restQuat = this.group.quaternion.clone();
        const startQuat = restQuat.clone().multiply(
          new THREE.Quaternion().setFromEuler(this.euler.set(-0.08, -0.32, 0.04))
        );
        this.camera.position.copy(farPos);
        this.group.quaternion.copy(startQuat);
        const restOff = restingViewFractions(this.camera.aspect);
        this.viewTransition = {
          elapsed: 0,
          duration: 2.25,
          fromPosition: farPos,
          position: restPos,
          fromTarget: new THREE.Vector3(0, 0, 0),
          target: new THREE.Vector3(0, 0, 0),
          fromUp: new THREE.Vector3(0, 1, 0),
          fromFov: this.camera.fov,
          fov: 54,
          fromRotation: startQuat,
          rotation: restQuat,
          fromOffset: restOff,
          toOffset: restOff,
        };
      }
    }
  }

  setFormation(mode, instant = false, resetCamera = true, durationOverride = null) {
    if (this.focusState) this.closeFocus(true);
    const portrait = mode === 'orbit' ? portraitAmount(this.camera.aspect) : 0;
    const layoutChanged = Math.abs(portrait - (this.formationPortrait || 0)) > 1e-6;
    if (this.mode === mode && !instant && !layoutChanged && !this.frozenFormation) {
      if (resetCamera) this.resetView(false);
      return;
    }
    const previousMode = this.mode;
    // Dynamic film geometry is in the matrices used by both rendering and
    // raycasting. Start the next morph from that exact visible geometry.
    this.bakeTunnelPose();
    this.mode = mode;
    this.frozenFormation = false;
    this.formationPortrait = portrait;
    this.layoutAspect = this.camera.aspect;
    const targets = createFormation(mode, this.count || 0, portrait);
    const duration = this.reducedMotion ? 0 : (durationOverride ?? 2.2);
    const vortex = !instant && duration > 0 && (
      (previousMode === 'orbit' && mode === 'tunnel') ||
      (previousMode === 'tunnel' && mode === 'orbit')
    );
    const vortexDirection = mode === 'tunnel' ? 1 : -1;
    const layers = new Map();

    targets.forEach((target, index) => {
      const instance = this.instances[index];
      instance.fromPosition = instance.position.clone();
      instance.fromQuaternion = instance.quaternion.clone();
      instance.fromScale = instance.scale;
      if (!duration) {
        instance.delay = 0;
      } else if (vortex) {
        const hash = instance.vortexHash || 0;
        if (vortexDirection > 0) {
          const radialNorm = clamp(Math.hypot(instance.fromPosition.x, instance.fromPosition.y) / 23.5, 0, 1);
          instance.delay = ((1 - radialNorm) * 0.16 + hash * 0.06) * duration;
        } else {
          const depthNorm = clamp((instance.fromPosition.z - TUNNEL_Z_MIN) / TUNNEL_SPAN, 0, 1);
          instance.delay = (depthNorm * 0.42 + hash * 0.06) * duration;
        }
      } else {
        instance.delay = index / Math.max(1, targets.length - 1) * Math.min(0.16, duration * 0.1);
      }
      instance.targetPosition.fromArray(target.position);
      instance.targetQuaternion.setFromEuler(this.euler.fromArray(target.rotation));
      instance.targetScale = target.scale;
      instance.ring = Number.isInteger(target.ring) ? target.ring : -1;
      instance.facet = Number.isInteger(target.facet) ? target.facet : -1;
      instance.breathDelta = target.breathDelta || null;
      instance.tunnelLayer = null;
      if (mode === 'tunnel') {
        const z = target.position[2];
        if (!layers.has(z)) {
          layers.set(z, { baseZ: z, liveZ: z, cos: 1, sin: 0, quaternion: new THREE.Quaternion() });
        }
        instance.tunnelLayer = layers.get(z);
      }
      if (instant) {
        instance.position.copy(instance.targetPosition);
        instance.quaternion.copy(instance.targetQuaternion);
        instance.scale = target.scale;
        instance.settled = true;
      } else instance.settled = false;
    });
    this.tunnelLayers = [...layers.values()];
    if (instant) this.writeInstanceMatrices();
    else {
      this.instanceDirty = true;
      this.boundsDirty = true;
      this.morph = { elapsed: 0, duration, vortex, vortexDirection };
    }
    if (resetCamera) {
      this.resetView(instant);
    }
    this.callbacks.onModeChange?.(mode);
  }

  // Write every instance matrix once (used by instant paths / first frame),
  // then clear the dirty flag so steady state performs no per-frame work.
  writeInstanceMatrices() {
    this.uploadInstanceMatrices();
    this.instanceDirty = false;
    this.morph = null;
  }

  hasActiveRingSpin() {
    const angles = this.ringAngles;
    return Boolean(angles && (angles[0] || angles[1] || angles[2] || angles[3]));
  }

  ringSpinChanged() {
    const a = this.ringAngles || [0, 0, 0, 0];
    const b = this.appliedRingAngles || [0, 0, 0, 0];
    return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];
  }

  // Shared layer/facet/ring evaluations keep per-frame uploads sub-millisecond
  // for all 3000 prints while preserving exact raycastable instance matrices.
  uploadInstanceMatrices() {
    const twist = this.tunnelTwist || 0;
    const conveyor = this.tunnelConveyor || 0;
    const breath = this.stellationBreath || 0;
    const cameraZ = this.camera?.position?.z ?? 57;
    const portraitScale = 1 + (this.formationPortrait || 0) * 0.33;

    for (const layer of this.tunnelLayers || []) {
      const wrappedZ = conveyor
        ? TUNNEL_Z_MIN + THREE.MathUtils.euclideanModulo(layer.baseZ - TUNNEL_Z_MIN + conveyor, TUNNEL_SPAN)
        : layer.baseZ;
      layer.liveZ = wrappedZ;
      const depthAhead = Math.max(0, cameraZ - wrappedZ);
      const weight = (clamp(depthAhead / 138, 0, 1.35)) ** 1.42;
      const angle = twist * weight;
      layer.cos = Math.cos(angle);
      layer.sin = Math.sin(angle);
      layer.quaternion.set(0, 0, Math.sin(angle * 0.5), Math.cos(angle * 0.5));
    }

    let facetQuaternions = null;
    let breathQuat = null;
    if (breath && this.mode === 'orbit' && !this.instanceDirty) {
      const expandedA = STAR_CORE_A + (STAR_EXPANDED_A - STAR_CORE_A) * breath;
      this.euler ||= new THREE.Euler();
      breathQuat = new THREE.Quaternion().setFromEuler(
        this.euler.set(0.14 * breath, 0.56 * breath, -0.22 * breath)
      );
      facetQuaternions = Array.from({ length: 24 }, (_, f) =>
        new THREE.Quaternion()
          .setFromEuler(this.euler.fromArray(stellatedFacetRotation(f, expandedA)))
          .premultiply(breathQuat)
      );
    }

    let ringQuaternions = null;
    const ringSpinActive = this.mode === 'orbit' && !this.instanceDirty && this.hasActiveRingSpin();
    if (ringSpinActive) {
      ringQuaternions = RING_AXIS_VECTORS.map((axis, r) =>
        new THREE.Quaternion().setFromAxisAngle(axis, this.ringAngles[r] || 0)
      );
    }

    for (const instance of this.instances) {
      this.dummy.position.copy(instance.position);
      this.dummy.quaternion.copy(instance.quaternion);

      if ((twist || conveyor) && instance.tunnelLayer) {
        const { liveZ, cos, sin, quaternion } = instance.tunnelLayer;
        const { x, y } = this.dummy.position;
        this.dummy.position.x = x * cos - y * sin;
        this.dummy.position.y = x * sin + y * cos;
        if (conveyor && !this.instanceDirty) this.dummy.position.z = liveZ;
        if (twist) this.dummy.quaternion.premultiply(quaternion);
      } else if (facetQuaternions && instance.facet >= 0 && instance.breathDelta) {
        this.dummy.position.x += instance.breathDelta[0] * breath;
        this.dummy.position.y += instance.breathDelta[1] * breath;
        this.dummy.position.z += instance.breathDelta[2] * breath * portraitScale;
        this.dummy.position.applyQuaternion(breathQuat);
        this.dummy.quaternion.copy(facetQuaternions[instance.facet]);
      } else if (ringQuaternions && instance.ring >= 0) {
        const rq = ringQuaternions[instance.ring];
        this.dummy.position.applyQuaternion(rq);
        this.dummy.quaternion.premultiply(rq);
      }

      const s = instance.scale;
      this.dummy.scale.set(s * (instance.aspectX || 1), s * (instance.aspectY || 1), s);
      this.dummy.updateMatrix();
      instance.mesh.setMatrixAt(instance.localIndex, this.dummy.matrix);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.boundsDirty = true;
    this.appliedTunnelTwist = twist;
    this.appliedTunnelConveyor = conveyor;
    this.appliedStellationBreath = breath;
    const ra = this.ringAngles || [0, 0, 0, 0];
    this.appliedRingAngles = [ra[0], ra[1], ra[2], ra[3]];
  }

  // Read the last displayed matrices rather than re-evaluating the effect at
  // a newer clock time. Cancelling, resetting or choosing another formation
  // therefore starts exactly where the user last saw the photographs.
  bakeTunnelPose(freeze = false) {
    const appliedRings = this.appliedRingAngles || [0, 0, 0, 0];
    const hasRingOffset = Boolean(appliedRings[0] || appliedRings[1] || appliedRings[2] || appliedRings[3]);
    const dynamic = Boolean(
      this.appliedTunnelTwist ||
      this.appliedTunnelConveyor ||
      this.appliedStellationBreath ||
      hasRingOffset
    );
    const wasMorphing = this.instanceDirty;
    if (dynamic) {
      for (const instance of this.instances) {
        instance.mesh.getMatrixAt(instance.localIndex, this.dummy.matrix);
        this.dummy.matrix.decompose(instance.position, instance.quaternion, this.dummy.scale);
        instance.scale = this.dummy.scale.x / (instance.aspectX || 1);
      }
    }
    this.tunnelTwist = 0;
    this.appliedTunnelTwist = 0;
    this.tunnelConveyor = 0;
    this.appliedTunnelConveyor = 0;
    this.stellationBreath = 0;
    this.appliedStellationBreath = 0;
    this.ringAngles = [0, 0, 0, 0];
    this.appliedRingAngles = [0, 0, 0, 0];
    if (freeze && (dynamic || wasMorphing)) {
      for (const instance of this.instances) {
        instance.targetPosition.copy(instance.position);
        instance.targetQuaternion.copy(instance.quaternion);
        instance.targetScale = instance.scale;
        instance.settled = true;
      }
      this.instanceDirty = false;
      this.morph = null;
      this.frozenFormation = true;
    }
  }

  resetView(instant = false) {
    if (this.focusState) this.closeFocus(true);
    if (this.frozenFormation) this.setFormation(this.mode, instant, false);
    if (this.mode === 'orbit' && this.instances.length && Math.abs(portraitAmount(this.camera.aspect) - (this.formationPortrait || 0)) > 1e-6) {
      this.setFormation('orbit', instant, false);
    }
    this.flushDamping();
    const mobile = orbitFraming(this.camera.aspect, 54).mobile;
    const position = this.mode === 'tunnel'
      ? [0, 0, 48]
      : this.mode === 'helix'
        ? [0, 4, mobile ? 105 : 68]
        : this.mode === 'orbit'
          ? orbitPosition(this.camera.aspect)
          : [0, 6, mobile ? 96 : 62];
    const target = this.mode === 'tunnel' ? [0, 0, -90] : [0, 0, 0];
    const fov = this.mode === 'tunnel' ? 72 : 54;
    this.controls.minDistance = this.mode === 'tunnel' ? 3 : 8;
    this.heldViewOffset = null;
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...(this.mode === 'tunnel' ? [0, 0, 0] : restRotation(this.camera.aspect))));
    if (instant || this.reducedMotion) {
      this.camera.position.fromArray(position);
      this.controls.target.fromArray(target);
      this.camera.up.set(0, 1, 0);
      this.group.quaternion.copy(rotation);
      this.alignIdlePhase();
      this.camera.fov = fov;
      this.viewTransition = null;
    } else this.viewTransition = {
      elapsed: 0, duration: 2.2,
      fromPosition: this.camera.position.clone(), position: new THREE.Vector3(...position),
      fromTarget: this.controls.target.clone(), target: new THREE.Vector3(...target),
      fromUp: this.camera.up.clone(), fromFov: this.camera.fov, fov,
      fromRotation: this.group.quaternion.clone(), rotation,
      fromOffset: this.camera.view?.enabled ? { x: this.camera.view.offsetX / this.camera.view.fullWidth, y: this.camera.view.offsetY / this.camera.view.fullHeight } : { x: 0, y: 0 },
    };
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.defaultView = true;
    this.applyViewOffset();
  }

  startFilm() {
    if (this.film) return;
    if (this.focusState) this.closeFocus(true);
    this.flushDamping();
    // Bake the tiny interactive parent tilt into the sculpture before removing
    // parallax, preserving exactly the same world pose on the capture's first frame.
    if (this.parallaxGroup) {
      this.group.quaternion.premultiply(this.parallaxGroup.quaternion);
      this.parallaxGroup.quaternion.identity();
      this.pointerCurrent.set(0, 0);
    }
    const view = this.camera.view;
    const rotation = [this.group.rotation.x, this.group.rotation.y, this.group.rotation.z]
      .map(angle => THREE.MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI);
    const startPose = { position: this.camera.position.toArray(), target: this.controls.target.toArray(), up: this.camera.up.toArray(), fov: this.camera.fov, rotation };
    const startRingAngles = (this.ringAngles || [0, 0, 0, 0]).map(
      angle => THREE.MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI
    );
    this.film = {
      start: performance.now(),
      phase: 'orbit',
      elapsed: 0,
      startPose,
      startRingAngles,
      startOffset: { x: view?.enabled ? view.offsetX / view.fullWidth : 0, y: view?.enabled ? view.offsetY / view.fullHeight : 0 },
    };
    this.clearHover();
    this.activePointers?.clear();
    this.tapGesture = null;
    this.heldViewOffset = null;
    this.viewTransition = null;
    this.controls.enabled = false;
    this.pointerTarget?.set(0, 0);
    this.setFormation('orbit', false, false);
    if (this.morph) this.morph.filmStart = 0;
    if (this.photoUniforms) this.photoUniforms.uReveal.value = 1;
    this.reveal = null;
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
  }

  stopFilm(notify = true, reset = false) {
    const active = Boolean(this.film);
    if (!active) {
      if (reset) this.resetView(false);
      return;
    }
    const natural = this.film.natural === true;
    const view = this.camera.view;
    const offset = { x: view?.enabled ? view.offsetX / view.fullWidth : 0, y: view?.enabled ? view.offsetY / view.fullHeight : 0 };
    if (!natural) this.bakeTunnelPose(true);
    this.film = null;
    this.clearHover();
    this.controls.enabled = true;
    this.flushDamping();
    this.alignIdlePhase();
    if (natural) {
      this.ringAngles = [0, 0, 0, 0];
      this.stellationBreath = 0;
      this.tunnelConveyor = 0;
      this.tunnelTwist = 0;
      this.heldViewOffset = null;
      this.defaultView = true;
      this.resize();
    } else {
      // Cancellation freezes the shot, including its off-centre projection.
      // The next explicit reset or formation request owns the smooth way home.
      this.heldViewOffset = offset;
      this.defaultView = false;
      if (reset) this.resetView(false);
    }
    if (notify) this.callbacks.onFilmEnd?.();
  }

  /**
   * Live interactive timeline scrubbing across all 5 acts of the 30-second tour
   * without ending or resetting the active film session.
   */
  seekFilmLive(seconds, { paused = false } = {}) {
    const target = clamp(Number(seconds) || 0, 0, FILM.total - 0.001);
    if (!this.film) this.startFilm();
    const now = performance.now();
    this.film.start = now - target * 1000;
    this.film.elapsed = target;
    this.film.scrubPaused = Boolean(paused);
    this.film.manual = false;

    const sample = sampleFlight(target, this.camera.aspect, this.film.startPose);
    this.camera.position.fromArray(sample.position);
    this.camera.up.fromArray(sample.up);
    this.camera.fov = sample.fov;
    this.controls.target.fromArray(sample.target);
    this.camera.lookAt(this.controls.target);
    this.group.rotation.set(sample.rotation[0], sample.rotation[1], sample.rotation[2]);

    let formationStart = null;
    let duration = 2.2;
    if (target >= FILM.phase1 && target < FILM.phase1 + duration) {
      formationStart = FILM.phase1;
      this.setFormation('orbit', true, false);
    } else if (target >= FILM.reassemble && target < FILM.exitEnd) {
      formationStart = FILM.reassemble;
      duration = FILM.exitEnd - FILM.reassemble;
      this.setFormation('tunnel', true, false);
    }
    this.setFormation(sample.mode, formationStart === null, false, duration);
    if (this.morph) this.morph.filmStart = formationStart;
    this.film.phase = sample.mode;

    const startRings = this.film.startRingAngles || [0, 0, 0, 0];
    this.tunnelTwist = tunnelTwistAt(target);
    this.tunnelConveyor = tunnelConveyorAt(target);
    this.stellationBreath = stellationBreathAt(target);
    this.ringAngles = [
      armillarySpinAt(target, 0, startRings[0]),
      armillarySpinAt(target, 1, startRings[1]),
      armillarySpinAt(target, 2, startRings[2]),
      armillarySpinAt(target, 3, startRings[3]),
    ];
    this.updateInstanceTransforms(0);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    this.callbacks.onFilmProgress?.(target);
  }

  updateFilm(time) {
    if (this.film.scrubPaused) {
      this.film.start = time - (this.film.elapsed || 0) * 1000;
      return;
    }
    const elapsed = clamp((time - this.film.start) / 1000, 0, FILM.total);
    this.film.elapsed = elapsed;
    const s = sampleFlight(elapsed, this.camera.aspect, this.film.startPose);
    this.camera.position.fromArray(s.position);
    this.camera.up.fromArray(s.up);
    this.camera.fov = s.fov;
    this.controls.target.fromArray(s.target);
    this.camera.lookAt(this.controls.target);
    this.group.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    if (this.film.phase !== s.mode) {
      this.film.phase = s.mode;
      // Morph to the new formation without disturbing the cinematic camera.
      const start = s.mode === 'tunnel' ? FILM.phase1 : FILM.reassemble;
      const duration = s.mode === 'tunnel' ? 2.2 : FILM.exitEnd - FILM.reassemble;
      this.setFormation(s.mode, false, false, duration);
      if (this.morph) this.morph.filmStart = start;
    }
    this.tunnelTwist = tunnelTwistAt(elapsed);
    this.tunnelConveyor = tunnelConveyorAt(elapsed);
    this.stellationBreath = stellationBreathAt(elapsed);
    const startRings = this.film.startRingAngles || [0, 0, 0, 0];
    this.ringAngles = [
      armillarySpinAt(elapsed, 0, startRings[0]),
      armillarySpinAt(elapsed, 1, startRings[1]),
      armillarySpinAt(elapsed, 2, startRings[2]),
      armillarySpinAt(elapsed, 3, startRings[3]),
    ];
    this.callbacks.onFilmProgress?.(elapsed);
    if (elapsed >= FILM.total) { this.film.natural = true; this.stopFilm(true, false); }
  }

  updateInstanceTransforms(dt = 0) {
    const morphing = this.instanceDirty;
    if (morphing && this.instances.length) {
      const morph = this.morph;
      if (morph) {
        // Camera and formation use the same film clock, so a slow frame does
        // not leave the geometry behind the already-completed camera move.
        morph.elapsed = Math.min(morph.duration, this.film && Number.isFinite(morph.filmStart)
          ? Math.max(0, this.film.elapsed - morph.filmStart)
          : morph.elapsed + dt);
      }
      const done = this.reducedMotion || !morph || morph.elapsed >= morph.duration;
      const vortex = !done && Boolean(morph?.vortex);
      const direction = morph?.vortexDirection || 1;
      const swirlQuat = vortex ? (this._swirlQuat ||= new THREE.Quaternion()) : null;

      for (const instance of this.instances) {
        if (done) {
          instance.position.copy(instance.targetPosition);
          instance.quaternion.copy(instance.targetQuaternion);
          instance.scale = instance.targetScale;
          instance.settled = true;
        } else {
          const delay = instance.delay || 0;
          const progress = easeInOut((morph.elapsed - delay) / Math.max(1e-6, morph.duration - delay));
          if (vortex) {
            const p0 = instance.fromPosition;
            const p1 = instance.targetPosition;
            const impulse = Math.sin(Math.PI * progress) ** 2;
            const linX = THREE.MathUtils.lerp(p0.x, p1.x, progress);
            const linY = THREE.MathUtils.lerp(p0.y, p1.y, progress);
            const linZ = THREE.MathUtils.lerp(p0.z, p1.z, progress);
            const r0 = Math.hypot(p0.x, p0.y);
            const r1 = Math.hypot(p1.x, p1.y);
            const cylWeight = clamp(Math.min(r0, r1) / 1.2, 0, 1);
            const hash = instance.vortexHash || 0;
            const phi0 = Math.atan2(p0.y, p0.x);
            const phi1 = Math.atan2(p1.y, p1.x);
            const dPhi = Math.atan2(Math.sin(phi1 - phi0), Math.cos(phi1 - phi0));
            const swirl = direction * (1.75 + 0.90 * hash) * impulse;
            const phi = phi0 + dPhi * progress + swirl;
            const flare = (2.2 + 3.0 * hash) * impulse;
            const r = THREE.MathUtils.lerp(r0, r1, progress) + flare;
            instance.position.set(
              THREE.MathUtils.lerp(linX, Math.cos(phi) * r, cylWeight),
              THREE.MathUtils.lerp(linY, Math.sin(phi) * r, cylWeight),
              linZ,
            );
            instance.quaternion.slerpQuaternions(instance.fromQuaternion, instance.targetQuaternion, progress);
            const halfRoll = swirl * 0.275 * cylWeight;
            swirlQuat.set(0, 0, Math.sin(halfRoll), Math.cos(halfRoll));
            instance.quaternion.premultiply(swirlQuat);
          } else {
            instance.position.lerpVectors(instance.fromPosition, instance.targetPosition, progress);
            instance.quaternion.slerpQuaternions(instance.fromQuaternion, instance.targetQuaternion, progress);
          }
          instance.scale = THREE.MathUtils.lerp(instance.fromScale, instance.targetScale, progress);
        }
      }
      if (done) { this.instanceDirty = false; this.morph = null; }
    }
    const dynamicDirty =
      (this.tunnelTwist || 0) !== (this.appliedTunnelTwist || 0) ||
      (this.tunnelConveyor || 0) !== (this.appliedTunnelConveyor || 0) ||
      (this.stellationBreath || 0) !== (this.appliedStellationBreath || 0) ||
      this.ringSpinChanged();
    if (this.instances.length && (morphing || dynamicDirty)) this.uploadInstanceMatrices();
  }

  getAudioModulation() {
    const morphImpulse = this.morph
      ? Math.sin(Math.PI * clamp(this.morph.elapsed / Math.max(0.01, this.morph.duration), 0, 1))
      : 0;
    const tunnelFactor = this.photoUniforms?.uTunnelMode?.value || (this.mode === 'tunnel' ? 1 : 0);
    const pan = this.film
      ? clamp((this.camera.position.x || 0) / 8, -0.75, 0.75)
      : clamp(this.pointerCurrent?.x || 0, -0.65, 0.65);
    return {
      tunnelFactor,
      twist: this.tunnelTwist || 0,
      breath: this.stellationBreath || 0,
      morphImpulse,
      focused: Boolean(this.focusState),
      pan,
    };
  }

  _renderFrame(timeSeconds) {
    const focusBlur = clamp(this.photoUniforms?.uFocusAmount?.value || 0, 0, 1);
    if (this.darkroomPipeline?.enabled) {
      const morphImpulse = this.morph
        ? Math.sin(Math.PI * clamp(this.morph.elapsed / Math.max(0.01, this.morph.duration), 0, 1))
        : 0;
      const tunnelFactor = this.photoUniforms?.uTunnelMode?.value || 0;
      const warp = clamp(
        tunnelFactor * (0.26 + (this.tunnelTwist || 0) / 7.5) + morphImpulse * 0.62,
        0,
        1.15,
      );
      this.darkroomPipeline.render(this.scene, this.camera, { time: timeSeconds, warp, focusBlur });
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    if (this.focusPlate && this.focusOverlayScene && this.focusState) {
      const prevAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.render(this.focusOverlayScene, this.camera);
      this.renderer.autoClear = prevAutoClear ?? true;
    }
  }

  // Deterministic inspection hook for visual QA; main.js exposes it only with ?debug=1.
  debugSeekFilm(seconds) {
    const target = Math.max(0, Math.min(FILM.total, Number(seconds) || 0));
    this.stopFilm(false, true);
    this.resetView(true);
    this.startFilm();
    const now = performance.now();
    this.film.start = now - target * 1000;
    const sample = sampleFlight(target, this.camera.aspect, this.film.startPose);
    this.camera.position.fromArray(sample.position);
    this.camera.up.fromArray(sample.up);
    this.camera.fov = sample.fov;
    this.controls.target.fromArray(sample.target);
    this.camera.lookAt(this.controls.target);
    this.group.rotation.set(sample.rotation[0], sample.rotation[1], sample.rotation[2]);
    let formationStart = null;
    let duration = 2.2;
    if (target >= FILM.phase1 && target < FILM.phase1 + duration) {
      formationStart = FILM.phase1;
      this.setFormation('orbit', true, false);
    } else if (target >= FILM.reassemble && target < FILM.exitEnd) {
      formationStart = FILM.reassemble;
      duration = FILM.exitEnd - FILM.reassemble;
      this.setFormation('tunnel', true, false);
    }
    this.setFormation(sample.mode, formationStart === null, false, duration);
    if (this.morph) this.morph.filmStart = formationStart;
    this.film.phase = sample.mode;
    this.film.manual = true;
    this.film.elapsed = target;
    this.tunnelTwist = tunnelTwistAt(target);
    this.tunnelConveyor = tunnelConveyorAt(target);
    this.stellationBreath = stellationBreathAt(target);
    this.ringAngles = [
      armillarySpinAt(target, 0, 0),
      armillarySpinAt(target, 1, 0),
      armillarySpinAt(target, 2, 0),
      armillarySpinAt(target, 3, 0),
    ];
    this.updateInstanceTransforms(0);
    if (formationStart !== null) {
      this.instanceDirty = false;
      this.morph = null;
      this.frozenFormation = true;
    }
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    if (this.photoUniforms?.uTunnelMode) {
      this.photoUniforms.uTunnelMode.value = this.mode === 'tunnel' ? 1 : 0;
    }
    this._renderFrame(target);
    this.callbacks.onFrame?.(now);
  }

  animate(time) {
    const rawDeltaMs = time - this.lastTime;
    const dt = Math.min(rawDeltaMs / 1000, 0.05);
    this.lastTime = time;
    if (document.hidden && !this.film) return;

    // Adaptive optical fallback for slower GPUs during interactive exploration.
    if (this.darkroomPipeline?.enabled && !this.exportResolution && !this.film && rawDeltaMs > 0 && rawDeltaMs < 250) {
      if (rawDeltaMs > 40) {
        this._slowFrames = (this._slowFrames || 0) + 1;
        if (this._slowFrames >= 45) {
          this._postDegraded = true;
          this.darkroomPipeline.enabled = false;
        }
      } else {
        this._slowFrames = Math.max(0, (this._slowFrames || 0) - 1);
      }
    }

    if (this.film) {
      if (!this.film.manual) this.updateFilm(time);
    } else {
      if (this.viewTransition) {
        const view = this.viewTransition;
        view.elapsed = Math.min(view.duration, view.elapsed + dt);
        const progress = easeInOut(view.elapsed / view.duration);
        this.camera.position.lerpVectors(view.fromPosition, view.position, progress);
        this.controls.target.lerpVectors(view.fromTarget, view.target, progress);
        if (view.up) {
          this.camera.up.copy(view.fromUp).lerp(view.up, progress).normalize();
        } else {
          this.camera.up.copy(view.fromUp).multiplyScalar(1 - progress);
          this.camera.up.y += progress;
          this.camera.up.normalize();
        }
        this.group.quaternion.slerpQuaternions(view.fromRotation, view.rotation, progress);
        this.camera.fov = THREE.MathUtils.lerp(view.fromFov, view.fov, progress);
        this.camera.lookAt(this.controls.target);
        this.camera.updateProjectionMatrix();
        this.applyViewOffset();
        if (view.elapsed === view.duration) {
          this.viewTransition = null;
          if (!this.focusState) this.alignIdlePhase();
        }
      }
      else if (this.running && !this.focusState) {
        this.elapsed += dt * this.speed;
        if (this.mode === 'tunnel') {
          this.group.rotation.z += dt * this.speed * 0.035;
        } else {
          const portrait = this.mode === 'orbit' ? (this.formationPortrait || 0) : 0;
          this.idleYawElapsed = (this.idleYawElapsed || 0) + dt * this.speed;
          this.group.rotation.y += dt * this.speed * (0.085 * (1 - portrait) + 0.018 * portrait * Math.cos(this.idleYawElapsed * 0.2));
          this.idleTiltOffset = (this.idleTiltOffset || 0) * Math.exp(-dt * 1.5);
          this.group.rotation.x = (this.idleBaseTilt || 0) + Math.sin(this.elapsed * OSC_OMEGA) * OSC_AMP + this.idleTiltOffset;
          if (this.mode === 'orbit' && !this.instanceDirty && !this.reducedMotion && this.instances.length) {
            const current = this.ringAngles || [0, 0, 0, 0];
            this.ringAngles = current.map((angle, r) => angle + dt * this.speed * IDLE_RING_RATES[r]);
          }
        }
      }
      if (!this.focusState) this.controls.update();
    }
    if (this.parallaxGroup) {
      const allowed = this.pointerEnabled && !this.reducedMotion && !this.dragging && !this.film && !this.focusState;
      if (!allowed) this.pointerTarget.set(0, 0);
      if (this.reducedMotion || this.film || this.focusState) {
        this.pointerCurrent.set(0, 0);
        this._dragBankTarget = 0;
        this._dragBankCurrent = 0;
      } else {
        this.pointerCurrent.lerp(this.pointerTarget, 1 - Math.exp(-dt * 5));
        this._dragBankTarget = (this._dragBankTarget || 0) * Math.exp(-dt * 7.5);
        this._dragBankCurrent = THREE.MathUtils.lerp(
          this._dragBankCurrent || 0,
          this._dragBankTarget,
          1 - Math.exp(-dt * 9),
        );
      }
      const strength = this.camera.aspect < 0.85 ? 0.005 : 0.016;
      this.parallaxGroup.rotation.set(
        this.pointerCurrent.y * strength,
        this.pointerCurrent.x * strength,
        this._dragBankCurrent || 0,
      );
    }
    if (this.photoUniforms) {
      const uniforms = this.ensurePhotoUniforms();
      const distance = this.camera.position.distanceTo(this.controls.target);
      uniforms.uDepthNear.value = distance * 0.70;
      uniforms.uDepthFar.value = distance * 1.30;
      const targetTunnel = this.mode === 'tunnel' ? 1 : 0;
      uniforms.uTunnelMode.value = this.reducedMotion
        ? targetTunnel
        : THREE.MathUtils.lerp(uniforms.uTunnelMode.value, targetTunnel, 1 - Math.exp(-dt * 4));

      const targetFocus = this.focusState ? 1 : 0;
      uniforms.uFocusAmount.value = this.reducedMotion
        ? targetFocus
        : THREE.MathUtils.lerp(uniforms.uFocusAmount.value, targetFocus, 1 - Math.exp(-dt * 5.5));

      const targetHover = this.hoverActive && !this.focusState && !this.film ? 1 : 0;
      uniforms.uHoverStrength.value = this.reducedMotion
        ? 0
        : THREE.MathUtils.lerp(uniforms.uHoverStrength.value, targetHover, 1 - Math.exp(-dt * 9));
      if (this.hoverActive && this.hoverTargetWorld) {
        uniforms.uHoverWorld.value.lerp(this.hoverTargetWorld, 1 - Math.exp(-dt * 14));
      }

      if (this.reveal) {
        this.reveal.elapsed = Math.min(this.reveal.duration, this.reveal.elapsed + dt);
        uniforms.uReveal.value = easeInOut(this.reveal.elapsed / this.reveal.duration);
        if (this.reveal.elapsed === this.reveal.duration) this.reveal = null;
      }
      const density = this.mode === 'tunnel' ? 0.0042 : 0.0010;
      this.scene.fog.density = THREE.MathUtils.lerp(this.scene.fog.density, density, 1 - Math.exp(-dt * 3));
    }
    if (this.focusPlate && this.focusState) {
      this.focusState.elapsed = Math.min(this.focusState.duration, this.focusState.elapsed + dt);
      const lift = easeInOut(this.focusState.elapsed / Math.max(1e-6, this.focusState.duration));
      this.focusPlate.position.lerpVectors(this.focusState.cardPos, this.focusState.heroPos, lift);
      this.focusPlate.scale.lerpVectors(this.focusState.cardScale, this.focusState.heroScale, lift);
      const frameMat = this.focusPlate.userData?.frameMat;
      if (frameMat) {
        frameMat.uniforms.uLift.value = lift;
        frameMat.uniforms.uAspectScale.value.set(
          Math.abs(this.focusPlate.scale.x),
          Math.abs(this.focusPlate.scale.y),
        );
      }
    }
    if (this.atmosphere) {
      const au = this.atmosphere.uniforms;
      au.uTime.value = time * 0.001;
      const tunnelFactor = this.photoUniforms?.uTunnelMode?.value || 0;
      const focusFactor = this.photoUniforms?.uFocusAmount?.value || 0;
      const reveal = this.photoUniforms?.uReveal?.value ?? 1;
      au.uTunnelFactor.value = tunnelFactor;
      au.uFocusFactor.value = focusFactor;
      au.uIntensity.value = (0.38 + focusFactor * 0.24 + tunnelFactor * 0.14) * reveal;

      const moodSourceIndex = this.focusState
        ? this.focusState.photoIndex
        : this.hoverActive
          ? (this._hoveredPhotoIndex ?? -1)
          : -1;
      const moodRgb = moodSourceIndex >= 0 ? this.photos?.[moodSourceIndex]?.moodRgb : null;
      this.moodPrimaryTarget ||= new THREE.Color(DEFAULT_MOOD_PRIMARY);
      this.moodSecondaryTarget ||= new THREE.Color(DEFAULT_MOOD_SECONDARY);
      if (Array.isArray(moodRgb)) {
        const scale = this.focusState ? 0.28 : 0.20;
        this.moodPrimaryTarget.setRGB(moodRgb[0] * scale, moodRgb[1] * scale, moodRgb[2] * scale);
        this.moodSecondaryTarget.setRGB(moodRgb[2] * 0.12, moodRgb[0] * 0.11, moodRgb[1] * 0.16);
      } else if (this.mode === 'tunnel') {
        this.moodPrimaryTarget.set(TUNNEL_MOOD_PRIMARY);
        this.moodSecondaryTarget.set(TUNNEL_MOOD_SECONDARY);
      } else {
        this.moodPrimaryTarget.set(DEFAULT_MOOD_PRIMARY);
        this.moodSecondaryTarget.set(DEFAULT_MOOD_SECONDARY);
      }
      const moodAlpha = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 2.8);
      au.uPrimaryColor.value.lerp(this.moodPrimaryTarget, moodAlpha);
      au.uSecondaryColor.value.lerp(this.moodSecondaryTarget, moodAlpha);
    }
    if (this.dustField) {
      this.dustField.uniforms.uTime.value = time * 0.001;
      this.dustField.uniforms.uConveyor.value = this.tunnelConveyor || 0;
      this.dustField.uniforms.uOpacity.value = (this.focusState ? 0.11 : 0.24) * (this.photoUniforms?.uReveal?.value ?? 1);
    }
    // Group/camera motion needs no instance uploads once a morph/effect settles.
    this.updateInstanceTransforms(dt);
    this.updateHover(time);
    this._renderFrame(time * 0.001);
    this.callbacks.onFrame?.(time);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.clearPhotos();
    if (this.atmosphere) {
      this.scene.remove(this.atmosphere.mesh);
      this.atmosphere.dispose();
      this.atmosphere = null;
    }
    if (this.dustField) {
      this.scene.remove(this.dustField.points);
      this.dustField.dispose();
      this.dustField = null;
    }
    if (this.darkroomPipeline) {
      this.darkroomPipeline.dispose();
      this.darkroomPipeline = null;
    }
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
