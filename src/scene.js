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
const BACKGROUND = '#020204';
const DEFAULT_MOOD_PRIMARY = '#2b1e15';
const DEFAULT_MOOD_SECONDARY = '#121a2b';
const TUNNEL_MOOD_PRIMARY = '#101826';
const TUNNEL_MOOD_SECONDARY = '#1f1510';
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

// C2 soft-launch, long velvet-out glide: zero initial velocity shock (f'(0) = 0)
// and feathered zero-overshoot cushion landing (f'(1) = 0, max = 1.0).
function silkFlightEase(value) {
  const u = clamp(value, 0, 1);
  return 1 - Math.pow(1 - u * u, 2.8);
}

// Matches the 3-point gallery chiaroscuro in the InstancedMesh fragment shader
// so a clicked 3D crystal card never flashes in brightness on frame 0 of lift-off.
function computeFacetSculptShade(worldNormal, tunnelFactor = 0) {
  const nx = worldNormal?.x ?? 0;
  const ny = worldNormal?.y ?? 0;
  const nz = worldNormal?.z ?? 1;
  // normalize(-0.48, 0.60, 0.64) = (-0.4800, 0.6000, 0.6400)
  const keyLight = clamp(nx * -0.48 + ny * 0.60 + nz * 0.64, 0, 1);
  // normalize(0.70, 0.22, -0.68) = (0.6996, 0.2199, -0.6796)
  const rimLight = clamp(nx * 0.6996 + ny * 0.2199 + nz * -0.6796, 0, 1);
  const skyFill = clamp(ny * 0.5 + 0.5, 0, 1);
  const kPow = Math.pow(keyLight, 1.15);
  const rPow = Math.pow(rimLight, 1.6);
  const sx = 0.38 + 0.84 * kPow + 0.24 * rPow + 0.07 * skyFill;
  const sy = 0.40 + 0.81 * kPow + 0.27 * rPow + 0.08 * skyFill;
  const sz = 0.45 + 0.76 * kPow + 0.34 * rPow + 0.10 * skyFill;
  const tf = clamp(tunnelFactor, 0, 1);
  return new THREE.Vector3(
    clamp(THREE.MathUtils.lerp(sx, 1.03, tf), 0.35, 1.12),
    clamp(THREE.MathUtils.lerp(sy, 1.02, tf), 0.35, 1.12),
    clamp(THREE.MathUtils.lerp(sz, 1.00, tf), 0.35, 1.12),
  );
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
    this.focusPointerTarget = new THREE.Vector2();
    this.focusPointerCurrent = new THREE.Vector2();
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
      if (!this.pointerEnabled || this.dragging || this.film || event.buttons || event.pointerType === 'touch') return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const nx = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
      const ny = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
      if (this.focusState) {
        (this.focusPointerTarget ||= new THREE.Vector2()).set(nx, ny);
        return;
      }
      this.hoverPointer = [event.clientX, event.clientY];
      this.pointerTarget.set(nx, ny);
    });
    this.renderer.domElement.addEventListener('pointerleave', () => {
      this.pointerTarget.set(0, 0);
      this.focusPointerTarget?.set(0, 0);
      this.clearHover();
    });
    this.renderer.domElement.addEventListener('pointercancel', event => {
      this.endPointer(event, true);
      this.pointerTarget.set(0, 0);
      this.focusPointerTarget?.set(0, 0);
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
    u.uFocusSlotHide ||= { value: 0 };
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
    if (this.focusState?.computeStageHeroScale) {
      const st = this.focusState;
      const meta = this.photos?.[st.photoIndex];
      st.heroScale.copy(st.computeStageHeroScale(meta));
      if (this.focusPlate && st.scaleProgress >= 0.999) {
        this.focusPlate.scale.copy(st.heroScale);
      }
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
    if (this.film || this.focusState || (this.thresholdState && !this.thresholdState.unlocking) || !this.defaultView || this.mode !== 'orbit') return;
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
    } else if (this.mode === 'tunnel' || this.focusState || (this.thresholdState && !this.thresholdState.unlocking)) {
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
    const dy = event.clientY - previous[1];
    const moved = Math.hypot(dx, dy);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (pointers.size === 1 && !this.focusState && !this.reducedMotion) {
      this._dragBankTarget = clamp((this._dragBankTarget || 0) * 0.65 - dx * 0.00055, -0.028, 0.028);
    }
    if (pointers.size === 1 && !this.focusState && this.scrollTimeline && moved > 0.5) {
      this.scrollTimeline.targetYaw = clamp(this.scrollTimeline.targetYaw + dx * 0.0035, -0.85, 0.85);
      this.scrollTimeline.targetPitch = clamp(this.scrollTimeline.targetPitch + dy * 0.0026, -0.48, 0.48);
      this.scrollTimeline.resting = false;
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
    if (this.focusState && this.focusPlate) {
      this.focusOverlayScene?.updateMatrixWorld(true);
      const plateHit = this.raycaster.intersectObject(this.focusPlate, false)[0];
      if (!plateHit) {
        this.closeFocus(false);
      } else if (plateHit.uv && plateHit.uv.x < 0.24) {
        this.callbacks.onFocusChange?.({ active: true, step: -1 });
      } else if (plateHit.uv && plateHit.uv.x > 0.76) {
        this.callbacks.onFocusChange?.({ active: true, step: 1 });
      } else {
        this.closeFocus(false);
      }
      return;
    }
    if (this.boundsDirty) {
      for (const mesh of this.meshes) mesh.computeBoundingSphere();
      this.boundsDirty = false;
    }
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    if (hit?.instanceId !== undefined) {
      const photoIndex = hit.object.userData?.photoIndices?.[hit.instanceId];
      const instanceIndex = hit.object.userData?.instanceIndices?.[hit.instanceId];
      if (photoIndex !== undefined) this.callbacks.onPick?.(photoIndex, instanceIndex);
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

  _getBlankFocusTexture() {
    if (!this._blankFocusTexture) {
      const data = new Uint8Array([6, 6, 10, 255]);
      const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this._blankFocusTexture = tex;
    }
    return this._blankFocusTexture;
  }

  _releaseOwnedFocusTexture(tex, keepA = null, keepB = null) {
    if (!tex || !this._focusOwnedTextures?.has(tex)) return;
    if (tex === keepA || tex === keepB) return;
    this._focusOwnedTextures.delete(tex);
    tex.dispose();
  }

  _disposeClosingPlate() {
    if (!this._closingPlate) return;
    const { mesh } = this._closingPlate;
    this._closingPlate = null;
    if (mesh) {
      this.focusOverlayScene?.remove(mesh);
      this.scene.remove(mesh);
      mesh.material?.dispose?.();
      mesh.geometry?.dispose?.();
    }
    if (!this.focusPlate && this._focusOwnedTextures) {
      for (const tex of this._focusOwnedTextures) tex.dispose();
      this._focusOwnedTextures.clear();
    }
  }

  _disposeFocusPlate() {
    if (this.focusPlateOwnedTexture) {
      this._focusOwnedTextures?.delete(this.focusPlateOwnedTexture);
      this.focusPlateOwnedTexture.dispose();
      this.focusPlateOwnedTexture = null;
    }
    if (this._focusOwnedTextures && !this._closingPlate) {
      for (const tex of this._focusOwnedTextures) tex.dispose();
      this._focusOwnedTextures.clear();
    }
    if (!this.focusPlate) return;
    this.focusOverlayScene?.remove(this.focusPlate);
    this.scene.remove(this.focusPlate);
    for (const child of [...this.focusPlate.children]) {
      child.material?.dispose?.();
      child.geometry?.dispose?.();
    }
    this.focusPlate.clear();
    this.focusPlate.material.dispose();
    this.focusPlate.geometry.dispose();
    this.focusPlate = null;
  }

  _zeroCameraVelocity() {
    this._camVel?.set(0, 0, 0);
    this._targetVel?.set(0, 0, 0);
    this._fovVel = 0;
  }

  /**
   * Background pre-decoder for adjacent gallery prints so Next/Prev switching
   * binds full-HD textures synchronously on frame 0 with zero thumbnail pop.
   */
  preloadFocusPhotos(photoIndices = []) {
    if (typeof Image === 'undefined' || !Array.isArray(photoIndices)) return;
    const cache = (this._decodedPhotoImages ||= new Map());
    for (const idx of photoIndices) {
      const photo = this.photos?.[idx];
      if (!photo?.url || cache.has(photo.url)) continue;
      if (cache.size >= 18) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      const img = new Image();
      img.decoding = 'async';
      img.src = photo.url;
      cache.set(photo.url, img);
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {
          if (cache.get(photo.url) === img) cache.delete(photo.url);
        });
      }
    }
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
   * Monopo Full-Frame Borderless WebGL Liquid-Displacement Exhibition:
   * Blooms the clicked 3D photograph card out of its physical slot via a 32x24
   * subdivided shader mesh with second-order spring physics & silk paper curl,
   * and runs an optical liquid-displacement crossfade when stepping between prints.
   */
  focusPhoto(photoIndex, preferredInstanceIndex = -1, options = {}) {
    if (this.film || !this.instances.length) return false;
    const instanceIndex = this._findBestInstanceForPhoto(photoIndex, preferredInstanceIndex);
    if (instanceIndex < 0) return false;

    this._disposeClosingPlate();
    this.thresholdState = null;
    this.flushDamping();
    if (this.parallaxGroup) {
      // Smoothly relax pointer target to center without snapping parallaxGroup.rotation in 0ms
      this.pointerTarget?.set(0, 0);
    }
    if (this.instanceDirty) {
      if (this.morph?.scrollControlled) {
        if (this.scrollTimeline) {
          this.scrollTimeline.targetTime = this.scrollTimeline.currentTime;
          this.scrollTimeline.timeVel = 0;
          this.scrollTimeline.resting = true;
        }
        this.updateInstanceTransforms(0);
      } else {
        for (const instance of this.instances) {
          instance.position.copy(instance.targetPosition);
          instance.quaternion.copy(instance.targetQuaternion);
          instance.scale = instance.targetScale;
          instance.settled = true;
        }
        this.writeInstanceMatrices();
      }
    }

    const STAGE_DIST = 8.4;
    const computeStageHeroScale = (meta) => {
      const vSpan = 2 * STAGE_DIST * Math.tan(THREE.MathUtils.degToRad(GAZE_FOV * 0.5));
      const hSpan = vSpan * Math.max(0.35, this.camera.aspect);
      const maxH = vSpan * 0.76;
      const maxW = hSpan * 0.84;
      const nativeAspect = meta?.width > 0 && meta?.height > 0
        ? clamp(meta.width / meta.height, 0.56, 1.95)
        : 1.5;
      const fitH = Math.min(maxH, maxW / nativeAspect);
      const fitW = fitH * nativeAspect;
      return new THREE.Vector3(fitW / 1.08, fitH / 0.72, 1);
    };

    this.scene.updateMatrixWorld(true);
    const inst = this.instances[instanceIndex];
    const photoMeta = this.photos?.[photoIndex];
    const uniforms = this.ensurePhotoUniforms();

    // Seamless in-stage optical carriage transition when stepping while already in exhibition mode
    if (this.focusState && this.focusPlate) {
      const st = this.focusState;
      const heroScale = computeStageHeroScale(photoMeta);
      const flowDir = Number(options?.flowDir) >= 0 ? 1 : -1;

      inst.mesh.getMatrixAt(inst.localIndex, this.dummy.matrix);
      const stepWorld = (this._focusMat ||= new THREE.Matrix4()).multiplyMatrices(inst.mesh.matrixWorld, this.dummy.matrix);
      const nextCardPos = new THREE.Vector3();
      const nextCardQuat = new THREE.Quaternion();
      const nextCardScale = new THREE.Vector3();
      stepWorld.decompose(nextCardPos, nextCardQuat, nextCardScale);
      const stepNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(nextCardQuat).normalize();
      const stepToViewer = this.camera.position.clone().sub(nextCardPos);
      if (stepToViewer.lengthSq() > 1e-4 && stepNormal.dot(stepToViewer) < 0) {
        nextCardQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
        stepNormal.negate();
      }
      const stepCardUp = new THREE.Vector3(0, 1, 0).applyQuaternion(nextCardQuat).normalize();
      if (stepCardUp.y < -0.15) {
        nextCardQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
      }

      const nextStartAspect = (1.08 * Math.abs(nextCardScale.x)) / Math.max(1e-4, 0.72 * Math.abs(nextCardScale.y));
      const nextShade = computeFacetSculptShade(stepNormal, uniforms.uTunnelMode?.value || 0);

      st.photoIndex = photoIndex;
      st.instanceIndex = instanceIndex;
      st.cardPos = nextCardPos;
      st.cardQuat = nextCardQuat;
      st.cardScale = nextCardScale;
      st.normal = stepNormal;
      st.startAspect = nextStartAspect;
      st.startShade = nextShade;
      st.scaleFrom = this.focusPlate.scale.clone();
      st.heroScale = heroScale;
      st.scaleElapsed = 0;
      st.scaleDuration = this.reducedMotion ? 0.001 : 0.76;
      st.scaleProgress = this.reducedMotion ? 1 : 0;
      st.scaleVel = 0;
      st.transitionElapsed = 0;
      st.transitionDuration = this.reducedMotion ? 0.001 : 0.80;
      st.stepFlowDir = flowDir;
      st.curlBoost = this.reducedMotion ? 0 : 0.34 * flowDir;
      st.wasStepping = true;
      st.hdDecoded = false;
      st.plateReady = false;
      uniforms.uFocusWorld.value.copy(nextCardPos);
      uniforms.uFocusSlotHide.value = 1;

      if (this.reducedMotion) {
        this.focusPlate.scale.copy(heroScale);
      }
      this._mountFocusHeroPlate(photoIndex, inst, st.cardPos, st.heroPos, st.cardQuat, st.heroQuat, st.scaleFrom, heroScale, {
        stepping: true,
        flowDir,
      });
      this.callbacks.onFocusChange?.({ active: true, photoIndex, instanceIndex });
      return true;
    }

    const saved = {
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

    // Camera-Space 3D FLIP: keep camera horizon level & serene with a subtle 5.5%
    // optical dolly breath while the card peels smoothly off its facet to center stage.
    const levelUp = saved.up.lengthSq() > 0.25 ? saved.up.clone().normalize() : new THREE.Vector3(0, 1, 0);
    const camForward = this.controls.target.clone().sub(this.camera.position);
    const spanToTarget = camForward.length();
    if (spanToTarget > 1e-4) camForward.divideScalar(spanToTarget);
    else camForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();

    const dollyStep = Math.min(3.0, Math.max(4, spanToTarget) * 0.055);
    const camDest = this.camera.position.clone().addScaledVector(camForward, dollyStep);
    const heroPos = camDest.clone().addScaledVector(camForward, STAGE_DIST);
    const lookMat = new THREE.Matrix4().lookAt(camDest, heroPos, levelUp);
    const heroQuat = new THREE.Quaternion().setFromRotationMatrix(lookMat);
    const heroScale = computeStageHeroScale(photoMeta);
    const startAspect = (1.08 * Math.abs(cardScale.x)) / Math.max(1e-4, 0.72 * Math.abs(cardScale.y));
    const startShade = computeFacetSculptShade(normal, uniforms.uTunnelMode?.value || 0);

    // Leading-edge peel vector: corner closest to stage center leads the 3D silk lift
    const stageRight = new THREE.Vector3(1, 0, 0).applyQuaternion(heroQuat);
    const stageUp = new THREE.Vector3(0, 1, 0).applyQuaternion(heroQuat);
    const toStage = heroPos.clone().sub(cardPos);
    const peelDir = new THREE.Vector2(toStage.dot(stageRight), toStage.dot(stageUp));
    if (peelDir.lengthSq() > 1e-4) peelDir.normalize();
    else peelDir.set(0, 1);

    uniforms.uFocusWorld.value.copy(cardPos);
    uniforms.uFocusSlotHide.value = 1;
    (this.focusPointerTarget ||= new THREE.Vector2()).set(0, 0);
    (this.focusPointerCurrent ||= new THREE.Vector2()).set(0, 0);

    this.focusState = {
      photoIndex,
      instanceIndex,
      cardPos,
      heroPos,
      cardQuat,
      heroQuat,
      cardScale,
      scaleFrom: cardScale.clone(),
      heroScale,
      normal,
      cardUp: levelUp,
      peelDir,
      startAspect,
      startShade,
      hdDecoded: false,
      wasStepping: false,
      hdStartUv: new THREE.Vector4(0, 0, 1, 1),
      flightElapsed: this.reducedMotion ? 0.88 : 0,
      flightDuration: 0.88,
      springValue: this.reducedMotion ? 1 : 0,
      springVel: 0,
      scaleElapsed: this.reducedMotion ? 0.88 : 0,
      scaleDuration: 0.88,
      scaleProgress: this.reducedMotion ? 1 : 0,
      scaleVel: 0,
      transitionElapsed: 1,
      transitionDuration: 0.80,
      stepFlowDir: 1,
      curlBoost: 0,
      saved,
      plateReady: false,
      computeStageHeroScale,
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
      this.camera.up.copy(levelUp);
      this.camera.fov = GAZE_FOV;
      this.viewTransition = null;
      this._zeroCameraVelocity?.();
      uniforms.uFocusAmount.value = 1;
    } else {
      this.viewTransition = {
        elapsed: 0,
        duration: 0.92,
        fromPosition: this.camera.position.clone(),
        position: camDest,
        fromTarget: this.controls.target.clone(),
        target: heroPos.clone(),
        fromUp: this.camera.up.clone(),
        up: levelUp.clone(),
        fromFov: this.camera.fov,
        fov: GAZE_FOV,
        fromRotation: this.group.quaternion.clone(),
        rotation: this.group.quaternion.clone(),
        fromOffset,
        toOffset: { x: 0, y: 0 },
        velPosition: this._camVel ? this._camVel.clone() : null,
        velTarget: this._targetVel ? this._targetVel.clone() : null,
        velFov: this._fovVel || 0,
      };
    }
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();

    this._mountFocusHeroPlate(photoIndex, inst, cardPos, heroPos, cardQuat, heroQuat, cardScale, heroScale, {
      stepping: false,
      flowDir: 1,
    });
    this.callbacks.onFocusChange?.({ active: true, photoIndex, instanceIndex });
    return true;
  }

  _mountFocusHeroPlate(photoIndex, inst, cardPos, heroPos, cardQuat, heroQuat, cardScale, heroScale, { stepping = false, flowDir = 1 } = {}) {
    this.focusGeneration = (this.focusGeneration || 0) + 1;
    const generation = this.focusGeneration;
    this._focusOwnedTextures ||= new Set();
    this.focusOverlayScene ||= new THREE.Scene();

    if (!this.focusPlate) {
      const geometry = new THREE.PlaneGeometry(1.08, 0.72, 48, 36);
      const blankTex = this._getBlankFocusTexture();
      const liquidMat = new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
        uniforms: {
          uTexPrev: { value: blankTex },
          uTexCurr: { value: blankTex },
          uUvRectPrev: { value: new THREE.Vector4(0, 0, 1, 1) },
          uUvRectCurr: { value: new THREE.Vector4(0, 0, 1, 1) },
          uAspectPrev: { value: 1.5 },
          uAspectCurr: { value: 1.5 },
          uPlateAspect: { value: 1.5 },
          uLiftProgress: { value: 1 },
          uPeelDir: { value: new THREE.Vector2(0, 1) },
          uStartShade: { value: new THREE.Vector3(1, 1, 1) },
          uMix: { value: 1 },
          uFlowDir: { value: 1 },
          uCurl: { value: 0 },
          uTilt: { value: new THREE.Vector2(0, 0) },
          uOpacity: { value: 1 },
          uTime: { value: 0 },
        },
        vertexShader: `
          uniform float uCurl;
          uniform vec2 uTilt;
          uniform float uLiftProgress;
          uniform vec2 uPeelDir;
          varying vec2 vUv;
          varying float vSheen;
          void main() {
            vUv = uv;
            vec3 pos = position;
            vec2 centered = uv - vec2(0.5);

            // Organic Leading-Edge Paper Peel during 3D lift-off & return (0 at endpoints)
            float lp = clamp(uLiftProgress, 0.0, 1.0);
            float flightEnv = sin(lp * 3.14159265);
            float peelLead = dot(centered, uPeelDir) * flightEnv * 0.22;
            float silkCamber = (0.16 - (centered.x * centered.x * 0.82 + centered.y * centered.y * 0.54)) * flightEnv * 0.28;

            // Gentle ribbon flex during photo carriage step + optical hover tilt
            float archX = (centered.x * centered.x - 0.0833) * uCurl * 0.28;
            float waveY = sin(centered.y * 3.14159265) * uCurl * 0.075;
            float hoverZ = (centered.x * uTilt.x - centered.y * uTilt.y) * 0.065 * lp;

            pos.z += hoverZ + peelLead + silkCamber - archX + waveY;
            vSheen = clamp(
              0.5 + (centered.x * 0.85 + centered.y * 0.55)
              + (uTilt.x * 0.65 - uTilt.y * 0.45) * lp
              + uCurl * 0.30
              + peelLead * 1.15,
              0.0,
              1.0
            );
            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uTexPrev;
          uniform sampler2D uTexCurr;
          uniform vec4 uUvRectPrev;
          uniform vec4 uUvRectCurr;
          uniform float uAspectPrev;
          uniform float uAspectCurr;
          uniform float uPlateAspect;
          uniform float uLiftProgress;
          uniform vec3 uStartShade;
          uniform float uMix;
          uniform float uFlowDir;
          uniform float uOpacity;
          uniform float uTime;
          varying vec2 vUv;
          varying float vSheen;

          vec2 coverUv(vec2 uv, float imgAspect, float plateAspect) {
            float safeImg = max(0.05, imgAspect);
            float safePlate = max(0.05, plateAspect);
            vec2 c = uv - vec2(0.5);
            if (safePlate > safeImg) {
              c.y *= safeImg / safePlate;
            } else {
              c.x *= safePlate / safeImg;
            }
            return c + vec2(0.5);
          }

          vec2 mapRect(vec2 uv, vec4 rect) {
            return rect.xy + clamp(uv, 0.001, 0.999) * rect.zw;
          }

          void main() {
            float t = clamp(uMix, 0.0, 1.0);
            vec3 col;

            if (t >= 0.9995) {
              vec2 uvC = coverUv(vUv, uAspectCurr, uPlateAspect);
              col = texture2D(uTexCurr, mapRect(uvC, uUvRectCurr)).rgb;
            } else if (t <= 0.0005) {
              vec2 uvP = coverUv(vUv, uAspectPrev, uPlateAspect);
              col = texture2D(uTexPrev, mapRect(uvP, uUvRectPrev)).rgb;
            } else {
              // Counter-parallax optical film carriage + curved glass curtain (zero 50/50 ghosting & zero stretch)
              float p = t * t * (3.0 - 2.0 * t);
              float env = sin(p * 3.14159265);

              float coord = (uFlowDir > 0.0 ? (1.0 - vUv.x) : vUv.x) * 0.86 + (1.0 - vUv.y) * 0.14;
              float wave = sin(vUv.y * 3.14159265) * 0.045 * env;
              float w = 0.34;
              float threshold = p * (1.0 + 2.0 * w) - w;
              float mask = smoothstep(coord - w + wave, coord + w + wave, threshold);
              float frontEnv = 4.0 * mask * (1.0 - mask);

              // Zoom margin strictly bounds parallax + glass refraction so edges never clamp-streak
              float zoomPrev = 1.0 + 0.135 * p;
              float zoomCurr = 1.0 + 0.135 * (1.0 - p);
              float refractX = uFlowDir * 0.016 * frontEnv * env;
              float refractY = sin(vUv.y * 6.2831853 + uTime * 1.8) * 0.006 * frontEnv * env;

              vec2 basePrev = coverUv(vUv, uAspectPrev, uPlateAspect);
              vec2 baseCurr = coverUv(vUv, uAspectCurr, uPlateAspect);

              vec2 uvPrev = (basePrev - vec2(0.5)) / zoomPrev + vec2(0.5) + vec2(uFlowDir * 0.052 * p + refractX, refractY);
              vec2 uvCurr = (baseCurr - vec2(0.5)) / zoomCurr + vec2(0.5) + vec2(-uFlowDir * 0.052 * (1.0 - p) - refractX, -refractY);

              vec3 colPrev = texture2D(uTexPrev, mapRect(uvPrev, uUvRectPrev)).rgb * (1.0 - 0.22 * p);
              vec3 colCurr = texture2D(uTexCurr, mapRect(uvCurr, uUvRectCurr)).rgb;

              col = mix(colPrev, colCurr, mask);
              col += vec3(1.0, 0.97, 0.92) * (frontEnv * env * 0.038);
            }

            // Continuous lighting development from 3D crystal facet shade -> pure exhibition light
            float shadeBlend = smoothstep(0.0, 0.62, clamp(uLiftProgress, 0.0, 1.0));
            vec3 facetShade = mix(uStartShade, vec3(1.0), shadeBlend);
            col *= facetShade;

            float sheen = pow(clamp(1.0 - abs(vSheen - 0.52) * 2.1, 0.0, 1.0), 3.0) * 0.028;
            col += vec3(1.0, 0.97, 0.92) * sheen;

            vec2 edge = min(vUv, vec2(1.0) - vUv);
            float edgeDist = min(edge.x, edge.y);
            float aa = max(0.0018, fwidth(edgeDist));
            float alpha = smoothstep(0.0, aa, edgeDist) * uOpacity;
            if (alpha < 0.003) discard;
            gl_FragColor = vec4(col, alpha);
            #include <colorspace_fragment>
          }
        `,
      });
      this.focusPlate = new THREE.Mesh(geometry, liquidMat);
      this.focusPlate.frustumCulled = false;
      this.focusPlate.renderOrder = 8;
      this.focusPlate.userData.liquidMat = liquidMat;
      this.focusOverlayScene.add(this.focusPlate);
    }

    const st = this.focusState;
    const liquidMat = this.focusPlate.userData.liquidMat;
    const u = liquidMat.uniforms;
    const blankTex = this._getBlankFocusTexture();

    const atlasRectAttr = inst.mesh.geometry.getAttribute('atlasRect');
    const sharedMap = inst.mesh.material.map || null;
    let nextPreviewTex = blankTex;
    let rectX = 0, rectY = 0, rectW = 1, rectH = 1;
    if (atlasRectAttr && sharedMap) {
      const base = inst.localIndex * 4;
      nextPreviewTex = sharedMap;
      rectX = atlasRectAttr.array[base];
      rectY = atlasRectAttr.array[base + 1];
      rectW = atlasRectAttr.array[base + 2];
      rectH = atlasRectAttr.array[base + 3];
    }

    const tileAspect = st?.startAspect || 1.5;
    if (st?.startShade) u.uStartShade.value.copy(st.startShade);
    if (st?.peelDir) u.uPeelDir.value.copy(st.peelDir);

    const oldPrev = u.uTexPrev.value;
    if (stepping && !this.reducedMotion) {
      u.uTexPrev.value = u.uTexCurr.value || blankTex;
      u.uUvRectPrev.value.copy(u.uUvRectCurr.value);
      u.uAspectPrev.value = u.uAspectCurr.value || 1.5;
      u.uTexCurr.value = nextPreviewTex;
      u.uUvRectCurr.value.set(rectX, rectY, rectW, rectH);
      u.uAspectCurr.value = tileAspect;
      u.uLiftProgress.value = 1;
      u.uFlowDir.value = flowDir >= 0 ? 1 : -1;
      u.uMix.value = 0;
      u.uOpacity.value = 1;
      this._releaseOwnedFocusTexture(oldPrev, u.uTexPrev.value, u.uTexCurr.value);
    } else {
      const oldCurr = u.uTexCurr.value;
      u.uTexPrev.value = nextPreviewTex;
      u.uUvRectPrev.value.set(rectX, rectY, rectW, rectH);
      u.uAspectPrev.value = tileAspect;
      u.uTexCurr.value = nextPreviewTex;
      u.uUvRectCurr.value.set(rectX, rectY, rectW, rectH);
      u.uAspectCurr.value = tileAspect;
      u.uPlateAspect.value = tileAspect;
      u.uLiftProgress.value = this.reducedMotion ? 1 : 0;
      u.uMix.value = 1;
      u.uOpacity.value = sharedMap ? 1 : 0;
      u.uCurl.value = 0;
      u.uTilt.value.set(0, 0);
      this._releaseOwnedFocusTexture(oldPrev, u.uTexPrev.value, u.uTexCurr.value);
      this._releaseOwnedFocusTexture(oldCurr, u.uTexPrev.value, u.uTexCurr.value);
      this.focusPlate.position.copy(this.reducedMotion ? heroPos : cardPos);
      this.focusPlate.quaternion.copy(this.reducedMotion ? heroQuat : cardQuat);
      this.focusPlate.scale.copy(this.reducedMotion ? heroScale : cardScale);
    }

    const photo = this.photos?.[photoIndex];
    if (!photo?.url || typeof Image === 'undefined') return;
    const cache = (this._decodedPhotoImages ||= new Map());
    let img = cache.get(photo.url);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.src = photo.url;
      if (cache.size >= 18) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      cache.set(photo.url, img);
    }

    const applyDecodedTexture = () => {
      if (generation !== this.focusGeneration || !this.focusState || !this.focusPlate) return;
      const curSt = this.focusState;
      if (img.naturalWidth > 0 && img.naturalHeight > 0 && (!photo.width || !photo.height)) {
        photo.width = img.naturalWidth;
        photo.height = img.naturalHeight;
        curSt.scaleFrom = this.focusPlate.scale.clone();
        curSt.heroScale.copy(curSt.computeStageHeroScale(photo));
        curSt.scaleElapsed = this.reducedMotion ? curSt.scaleDuration : 0;
        curSt.scaleProgress = this.reducedMotion ? 1 : 0;
      }
      const nativeAspect = img.naturalWidth > 0 && img.naturalHeight > 0
        ? img.naturalWidth / img.naturalHeight
        : (photo.width > 0 && photo.height > 0 ? photo.width / photo.height : 1.5);
      curSt.hdDecoded = true;
      const texture = new THREE.Texture(img);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this._focusOwnedTextures.add(texture);
      this.focusPlateOwnedTexture = texture;
      const replacedCurr = u.uTexCurr.value;
      u.uTexCurr.value = texture;
      u.uUvRectCurr.value.set(0, 0, 1, 1);
      u.uAspectCurr.value = nativeAspect;
      if (!stepping) {
        u.uTexPrev.value = texture;
        u.uUvRectPrev.value.set(0, 0, 1, 1);
        u.uAspectPrev.value = nativeAspect;
      }
      u.uOpacity.value = 1;
      this._releaseOwnedFocusTexture(replacedCurr, u.uTexPrev.value, u.uTexCurr.value);
      curSt.plateReady = true;
    };

    // If preloaded/cached in browser memory, bind full-HD texture synchronously on Frame 0!
    if (img.complete && img.naturalWidth > 0) {
      applyDecodedTexture();
    } else if (typeof img.decode === 'function') {
      img.decode().then(applyDecodedTexture).catch(() => {});
    } else {
      img.onload = applyDecodedTexture;
    }
  }

  closeFocus(instant = false, notify = true) {
    if (!this.focusState) return false;
    const { saved, cardPos, cardQuat, cardScale, normal, startShade } = this.focusState;
    this.focusState = null;
    this.focusGeneration = (this.focusGeneration || 0) + 1;
    this.focusPointerTarget?.set(0, 0);
    this.focusPointerCurrent?.set(0, 0);

    const uniforms = this.ensurePhotoUniforms();

    if (!instant && !this.reducedMotion && this.focusPlate) {
      this._disposeClosingPlate();
      uniforms.uFocusWorld.value.copy(cardPos);
      uniforms.uFocusSlotHide.value = 1;
      const lu = this.focusPlate.userData?.liquidMat?.uniforms;
      if (lu && startShade) lu.uStartShade.value.copy(startShade);
      this._closingPlate = {
        mesh: this.focusPlate,
        fromPos: this.focusPlate.position.clone(),
        toPos: cardPos.clone(),
        fromQuat: this.focusPlate.quaternion.clone(),
        toQuat: (cardQuat || this.focusPlate.quaternion).clone(),
        fromScale: this.focusPlate.scale.clone(),
        toScale: cardScale.clone(),
        normal: normal ? normal.clone() : null,
        elapsed: 0,
        duration: 0.66,
      };
      this.focusPlate = null;
      this.focusPlateOwnedTexture = null;
    } else {
      uniforms.uFocusWorld.value.set(0, 0, 9999);
      uniforms.uFocusSlotHide.value = 0;
      this._disposeClosingPlate();
      this._disposeFocusPlate();
    }

    this.controls.enabled = !this.scrollTimeline;
    this.defaultView = saved.defaultView;
    this.heldViewOffset = saved.heldViewOffset;
    this.running = saved.running;

    if (instant || this.reducedMotion) {
      this.camera.position.copy(saved.position);
      this.controls.target.copy(saved.target);
      this.camera.up.copy(saved.up);
      this.camera.fov = saved.fov;
      this.group.quaternion.copy(saved.rotation);
      this.viewTransition = null;
      this._zeroCameraVelocity?.();
      uniforms.uFocusAmount.value = 0;
      this.alignIdlePhase();
    } else {
      this.viewTransition = {
        elapsed: 0,
        duration: 0.92,
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
        velPosition: this._camVel ? this._camVel.clone() : null,
        velTarget: this._targetVel ? this._targetVel.clone() : null,
        velFov: this._fovVel || 0,
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
    if (this.scrollTimeline) {
      this.scrollTimeline = null;
      if (this.controls) this.controls.enabled = true;
    }
    this.thresholdState = null;
    this._decodedPhotoImages?.clear();
    this._disposeClosingPlate();
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
        const varyings = 'varying vec2 vPaperUv;\nvarying vec3 vPhotoNormal;\nvarying vec3 vWorldNormal;\nvarying vec3 vViewDir;\nvarying float vPhotoDepth;\nvarying float vHoverLift;\nvarying float vFocusKeep;\n';
        const vertUniforms = 'uniform vec3 uHoverWorld;\nuniform float uHoverStrength;\nuniform float uFocusAmount;\nuniform float uFocusSlotHide;\nuniform vec3 uFocusWorld;\n';
        shader.vertexShader = 'attribute vec4 atlasRect;\n' + vertUniforms + varyings + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = atlasRect.xy + vMapUv * atlasRect.zw;\n#endif');
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 cardWorldCenter = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          #else
            vec3 cardWorldCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vWorldNormal = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
          #endif
          float hoverDist = length(cardWorldCenter - uHoverWorld);
          vHoverLift = uHoverStrength * exp(-(hoverDist * hoverDist) / 16.0);
          vFocusKeep = 1.0 - smoothstep(0.04, 0.20, length(cardWorldCenter - uFocusWorld));
          transformed *= mix(1.0, 1.0 - vFocusKeep, max(uFocusSlotHide, smoothstep(0.02, 0.28, uFocusAmount)));
          transformed.z += vHoverLift * 0.36 * (1.0 - uFocusAmount);
          transformed.xy *= 1.0 + vHoverLift * 0.052 * (1.0 - uFocusAmount);`);
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
          vPaperUv = uv;
          vPhotoNormal = normalize(normalMatrix * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          vViewDir = normalize(-mvPosition.xyz);
          vPhotoDepth = -mvPosition.z;`);
        shader.fragmentShader = varyings + 'uniform float uReveal;\nuniform float uDepthNear;\nuniform float uDepthFar;\nuniform float uTunnelMode;\nuniform float uFocusAmount;\nuniform vec3 uPaperBackground;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          vec3 n = normalize(vPhotoNormal);
          vec3 wn = normalize(vWorldNormal);
          if (!gl_FrontFacing) {
            n = -n;
            wn = -wn;
          }
          vec3 v = normalize(vViewDir);

          // 3-point gallery chiaroscuro gives the 24-facet stellated polyhedron razor-sharp 3D relief
          float keyLight = clamp(dot(wn, normalize(vec3(-0.48, 0.60, 0.64))), 0.0, 1.0);
          float rimLight = clamp(dot(wn, normalize(vec3(0.70, 0.22, -0.68))), 0.0, 1.0);
          float skyFill = clamp(wn.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 sculptShade = vec3(0.38, 0.40, 0.45)
            + vec3(0.84, 0.81, 0.76) * pow(keyLight, 1.15)
            + vec3(0.24, 0.27, 0.34) * pow(rimLight, 1.6)
            + vec3(0.07, 0.08, 0.10) * skyFill;
          vec3 activeShade = mix(sculptShade, vec3(1.03, 1.02, 1.00), uTunnelMode);

          vec3 halfVec = normalize(normalize(vec3(-0.30, 0.42, 0.86)) + v);
          float spec = pow(clamp(dot(n, halfVec), 0.0, 1.0), 42.0) * mix(0.38, 0.14, uTunnelMode);
          float fresnel = pow(1.0 - abs(dot(n, v)), 3.8) * 0.09;

          // Rich Kodachrome slide chroma & micro-contrast against deep obsidian void
          float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = clamp(mix(vec3(luma), diffuseColor.rgb, 1.28) * 1.08, 0.0, 1.15);

          float backShade = gl_FrontFacing ? 1.0 : mix(0.74, 0.88, uTunnelMode);
          float horizonFade = mix(
            mix(1.0, 0.84, smoothstep(uDepthNear, uDepthFar, vPhotoDepth)),
            1.0 - smoothstep(38.0, 148.0, vPhotoDepth),
            uTunnelMode
          );
          float focusDim = mix(1.0, mix(0.20, 1.0, vFocusKeep), uFocusAmount);
          vec2 edge = min(vPaperUv, vec2(1.0) - vPaperUv);
          float edgeDistance = min(edge.x, edge.y);
          float bevel = (1.0 - smoothstep(0.008, 0.030, edgeDistance)) * 0.06;
          diffuseColor.rgb = (diffuseColor.rgb * activeShade + vec3(spec + fresnel + bevel) * vec3(1.0, 0.96, 0.90)) * backShade * horizonFade;
          diffuseColor.rgb *= (1.0 + vHoverLift * 0.32 * (1.0 - uFocusAmount)) * focusDim;
          float aa = max(0.003, min(fwidth(edgeDistance), 0.014));
          diffuseColor.rgb *= smoothstep(0.0, aa, edgeDistance);
          diffuseColor.rgb = mix(uPaperBackground, diffuseColor.rgb, uReveal);`);
      };
      material.customProgramCacheKey = () => 'memoria-darkroom-v6';
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

    // Igloo / Resn Threshold Gate: hold the assembled six-spectrum crystal in
    // intimate telephoto bokeh (FOV 36, blur 0.88) until the user's first gesture.
    if (options?.threshold && !this.reducedMotion && this.instances.length && this.mode === 'orbit' && !this.film) {
      const restPos = new THREE.Vector3(...orbitPosition(this.camera.aspect));
      const gatePos = restPos.clone().multiplyScalar(0.74);
      this.thresholdState = {
        active: true,
        unlocking: false,
        blur: 0.88,
        elapsed: 0,
        duration: 1.8,
      };
      this.reveal = null;
      uniforms.uReveal.value = 1;
      this.camera.position.copy(gatePos);
      this.camera.fov = 36;
      this.controls.target.set(0, 0, 0);
      this.controls.enabled = false;
      this.viewTransition = null;
      this.camera.lookAt(this.controls.target);
      this.camera.updateProjectionMatrix();
      this.applyViewOffset();
      return;
    }

    // 2.25s Deep-Space Stardust Convergence ritual on album import / reset.
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
        instance.morphSpan = null;
        instance.settled = false;
      });
      this.morph = { elapsed: 0, duration: 2.25, vortex: true, vortexDirection: 1 };
      this.instanceDirty = true;
      this.boundsDirty = true;
      this.uploadInstanceMatrices();
      if (this.mode === 'orbit' && !this.film) {
        const restPos = new THREE.Vector3(...orbitPosition(this.camera.aspect));
        const restQuat = this.group.quaternion.clone();
        const restOff = restingViewFractions(this.camera.aspect);
        const farPos = restPos.clone().multiplyScalar(1.22);
        const startQuat = restQuat.clone().multiply(
          new THREE.Quaternion().setFromEuler(this.euler.set(-0.08, -0.32, 0.04))
        );
        this.camera.position.copy(farPos);
        this.group.quaternion.copy(startQuat);
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

  /**
   * Igloo / Resn Optical Rack-Focus Entry:
   * Smoothly pulls focus (blur 0.88 -> 0) and pulls camera back (FOV 36 -> 54)
   * over 1.8s on the user's first gentle wheel or click gesture.
   */
  unlockThreshold() {
    if (!this.thresholdState || this.thresholdState.unlocking) return false;
    if (this.reducedMotion) {
      this.thresholdState = null;
      if (this.controls) this.controls.enabled = !this.scrollTimeline && !this.film && !this.focusState;
      this.resetView(true);
      return true;
    }
    this.thresholdState.unlocking = true;
    this.thresholdState.elapsed = 0;
    this.thresholdState.duration = 1.8;
    const restPos = new THREE.Vector3(...orbitPosition(this.camera.aspect));
    const restQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...restRotation(this.camera.aspect))
    );
    const restOff = restingViewFractions(this.camera.aspect);
    const fromOff = this.camera.view?.enabled
      ? { x: this.camera.view.offsetX / this.camera.view.fullWidth, y: this.camera.view.offsetY / this.camera.view.fullHeight }
      : restOff;
    this.viewTransition = {
      elapsed: 0,
      duration: 1.8,
      fromPosition: this.camera.position.clone(),
      position: restPos,
      fromTarget: this.controls.target.clone(),
      target: new THREE.Vector3(0, 0, 0),
      fromUp: this.camera.up.clone(),
      up: new THREE.Vector3(0, 1, 0),
      fromFov: this.camera.fov,
      fov: 54,
      fromRotation: this.group.quaternion.clone(),
      rotation: restQuat,
      fromOffset: fromOff,
      toOffset: restOff,
      velPosition: this._camVel ? this._camVel.clone() : null,
      velTarget: this._targetVel ? this._targetVel.clone() : null,
      velFov: this._fovVel || 0,
      allowIdleSpin: true,
    };
    this.defaultView = true;
    return true;
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
      instance.morphSpan = null;
      if (!duration) {
        instance.delay = 0;
      } else if (vortex) {
        const hash = instance.vortexHash || 0;
        if (vortexDirection > 0) {
          // Outer square portal mouth & inner horizon eye lock early; mid-layers swirl as a 3D tornado funnel between them
          const tunnelMaxZ = TUNNEL_Z_MIN + TUNNEL_SPAN;
          const targetDepthNorm = clamp((tunnelMaxZ - target.position[2]) / TUNNEL_SPAN, 0, 1);
          if (targetDepthNorm < 0.14 || targetDepthNorm > 0.86) {
            instance.delay = hash * 0.04 * duration;
            instance.morphSpan = duration * 0.38;
          } else {
            const midNorm = (targetDepthNorm - 0.14) / 0.72;
            instance.delay = (0.06 + midNorm * 0.24 + hash * 0.06) * duration;
            instance.morphSpan = duration - instance.delay;
          }
        } else {
          const depthNorm = clamp((instance.fromPosition.z - TUNNEL_Z_MIN) / TUNNEL_SPAN, 0, 1);
          instance.delay = (depthNorm * 0.40 + hash * 0.06) * duration;
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
      this._zeroCameraVelocity();
    } else this.viewTransition = {
      elapsed: 0, duration: 2.2,
      fromPosition: this.camera.position.clone(), position: new THREE.Vector3(...position),
      fromTarget: this.controls.target.clone(), target: new THREE.Vector3(...target),
      fromUp: this.camera.up.clone(), fromFov: this.camera.fov, fov,
      fromRotation: this.group.quaternion.clone(), rotation,
      fromOffset: this.camera.view?.enabled ? { x: this.camera.view.offsetX / this.camera.view.fullWidth, y: this.camera.view.offsetY / this.camera.view.fullHeight } : { x: 0, y: 0 },
      velPosition: this._camVel ? this._camVel.clone() : null,
      velTarget: this._targetVel ? this._targetVel.clone() : null,
      velFov: this._fovVel || 0,
    };
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.defaultView = true;
    this.applyViewOffset();
  }

  startFilm() {
    if (this.film) return;
    if (this.focusState) this.closeFocus(true);
    if (this.scrollTimeline) this.exitScrollTimeline(false);
    this.thresholdState = null;
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

  /**
   * Enable homepage scroll-driven 5-act scrollytelling (wheel advances timeline
   * instead of OrbitControls zoom, while drag yaws/pitches around any act).
   */
  enableScrollTheatre(enabled = true) {
    this.scrollTheatreEnabled = Boolean(enabled);
    if (this.controls) {
      this.controls.enableZoom = !this.scrollTheatreEnabled;
    }
  }

  exitScrollTimeline(reset = false) {
    if (!this.scrollTimeline) {
      if (reset) this.resetView(false);
      return;
    }
    this.bakeTunnelPose(true);
    this.scrollTimeline = null;
    this.controls.enabled = !this.film && !this.focusState;
    if (this.controls) this.controls.enableZoom = !this.scrollTheatreEnabled;
    this.flushDamping();
    this.alignIdlePhase();
    if (reset) this.resetView(false);
  }

  setScrollTimeline(seconds, { immediate = false } = {}) {
    if (this.focusState) this.closeFocus(true);
    if (this.thresholdState && !this.thresholdState.unlocking) {
      this.thresholdState.unlocking = true;
      this.thresholdState.elapsed = 0;
    }
    if (this.film) {
      const filmTime = this.film.elapsed || 0;
      this.stopFilm(false, false);
      if (seconds === undefined) seconds = filmTime;
    }
    const clamped = clamp(Number(seconds) || 0, 0, FILM.total - 0.02);
    if (!this.scrollTimeline) {
      this.flushDamping();
      if (this.parallaxGroup) {
        this.group.quaternion.premultiply(this.parallaxGroup.quaternion);
        this.parallaxGroup.quaternion.identity();
        this.pointerCurrent?.set(0, 0);
      }
      if (this.photoUniforms) this.photoUniforms.uReveal.value = 1;
      this.reveal = null;
      this.viewTransition = null;
      this.heldViewOffset = null;
      this.controls.enabled = false;
      const aspect = this.camera.aspect;
      const startPose = {
        position: orbitPosition(aspect),
        target: [0, 0, 0],
        up: [0, 1, 0],
        fov: 54,
        rotation: restRotation(aspect),
      };
      this.scrollTimeline = {
        currentTime: clamped,
        targetTime: clamped,
        timeVel: 0,
        startPose,
        startRingAngles: [0, 0, 0, 0],
        lookYaw: 0,
        lookPitch: 0,
        targetYaw: 0,
        targetPitch: 0,
        region: null,
        resting: false,
      };
      this._applyScrollTimelinePose(clamped, 0);
      return clamped;
    }
    this.scrollTimeline.targetTime = clamped;
    this.scrollTimeline.resting = false;
    if (immediate || this.reducedMotion) {
      this.scrollTimeline.currentTime = clamped;
      this.scrollTimeline.timeVel = 0;
      this._applyScrollTimelinePose(clamped, 0);
    }
    return clamped;
  }

  scrollByTimeline(deltaSeconds) {
    const base = this.scrollTimeline
      ? this.scrollTimeline.targetTime
      : this.film
        ? (this.film.elapsed || 0)
        : 0;
    return this.setScrollTimeline(base + (Number(deltaSeconds) || 0));
  }

  _applyScrollTimelinePose(t, dt = 0) {
    const st = this.scrollTimeline;
    if (!st) return;
    const target = clamp(t, 0, FILM.total - 0.02);
    const implosionEnd = FILM.phase1 + 2.2;
    const region = target < FILM.phase1
      ? 'orbit-intro'
      : target < implosionEnd
        ? 'implosion'
        : target < FILM.reassemble
          ? 'tunnel-cruise'
          : target < FILM.exitEnd
            ? 'reassembly'
            : 'orbit-finale';

    if (st.region !== region) {
      st.region = region;
      if (region === 'orbit-intro' || region === 'orbit-finale') {
        this.setFormation('orbit', true, false);
      } else if (region === 'tunnel-cruise') {
        this.setFormation('tunnel', true, false);
      } else if (region === 'implosion') {
        this.setFormation('orbit', true, false);
        this.setFormation('tunnel', false, false, 2.2);
        if (this.morph) this.morph.scrollControlled = true;
      } else if (region === 'reassembly') {
        this.setFormation('tunnel', true, false);
        this.tunnelTwist = tunnelTwistAt(FILM.reassemble);
        this.tunnelConveyor = tunnelConveyorAt(FILM.reassemble);
        this.uploadInstanceMatrices();
        this.setFormation('orbit', false, false, FILM.exitEnd - FILM.reassemble);
        if (this.morph) this.morph.scrollControlled = true;
      }
    }

    if (region === 'implosion' && this.morph) {
      this.morph.scrollElapsed = Math.max(0, target - FILM.phase1);
      this.instanceDirty = true;
    } else if (region === 'reassembly' && this.morph) {
      this.morph.scrollElapsed = Math.max(0, target - FILM.reassemble);
      this.instanceDirty = true;
    }

    const s = sampleFlight(target, this.camera.aspect, st.startPose);
    this.camera.position.fromArray(s.position);
    this.camera.up.fromArray(s.up);
    this.camera.fov = s.fov;
    this.controls.target.fromArray(s.target);
    this.group.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);

    const blend = dt > 0 && !this.reducedMotion ? 1 - Math.exp(-dt * 12) : 1;
    st.lookYaw = THREE.MathUtils.lerp(st.lookYaw, st.targetYaw, blend);
    st.lookPitch = THREE.MathUtils.lerp(st.lookPitch, st.targetPitch, blend);

    if (Math.abs(st.lookYaw) > 1e-5 || Math.abs(st.lookPitch) > 1e-5) {
      const lookQuat = (this._scrollLookQuat ||= new THREE.Quaternion()).setFromEuler(
        (this._scrollLookEuler ||= new THREE.Euler()).set(st.lookPitch, st.lookYaw, 0, 'YXZ')
      );
      if (s.mode === 'tunnel') {
        const dir = (this._scrollLookDir ||= new THREE.Vector3())
          .subVectors(this.controls.target, this.camera.position)
          .applyQuaternion(lookQuat);
        this.controls.target.copy(this.camera.position).add(dir);
      } else {
        this.group.quaternion.premultiply(lookQuat);
      }
    }

    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();

    const startRings = st.startRingAngles;
    this.tunnelTwist = tunnelTwistAt(target);
    this.tunnelConveyor = tunnelConveyorAt(target);
    this.stellationBreath = stellationBreathAt(target);
    this.ringAngles = [
      armillarySpinAt(target, 0, startRings[0]),
      armillarySpinAt(target, 1, startRings[1]),
      armillarySpinAt(target, 2, startRings[2]),
      armillarySpinAt(target, 3, startRings[3]),
    ];
    if (dt === 0) {
      this.updateInstanceTransforms(0);
    }
    this.callbacks.onFilmProgress?.(target);
  }

  updateScrollTimeline(dt) {
    const st = this.scrollTimeline;
    if (!st || this.focusState || st.resting) return;
    if (this.reducedMotion) {
      st.currentTime = st.targetTime;
      st.timeVel = 0;
    } else {
      // Critically-damped 2nd-order inertia (zeta = 1.0, omega = 13.5):
      // eliminates discrete mouse-wheel step shock while preserving reversible precision.
      const omega = 13.5;
      const k = omega * omega;
      const c = 2 * omega;
      const substeps = Math.max(1, Math.ceil(dt / 0.008));
      const h = dt / substeps;
      let x = st.currentTime;
      let v = st.timeVel || 0;
      for (let i = 0; i < substeps; i++) {
        const acc = (st.targetTime - x) * k - v * c;
        v += acc * h;
        x += v * h;
      }
      st.currentTime = clamp(x, 0, FILM.total - 0.02);
      st.timeVel = v;
    }
    const timeDiff = Math.abs(st.targetTime - st.currentTime);
    const velSettled = Math.abs(st.timeVel || 0) < 1e-3;
    if (timeDiff < 1e-4 && velSettled) {
      st.currentTime = st.targetTime;
      st.timeVel = 0;
    }
    this._applyScrollTimelinePose(st.currentTime, dt);
    const yawDiff = Math.abs(st.targetYaw - st.lookYaw);
    const pitchDiff = Math.abs(st.targetPitch - st.lookPitch);
    if (timeDiff < 1e-4 && velSettled && yawDiff < 1e-4 && pitchDiff < 1e-4) {
      st.lookYaw = st.targetYaw;
      st.lookPitch = st.targetPitch;
      st.resting = true;
    }
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
          : morph.scrollControlled
            ? clamp(morph.scrollElapsed ?? morph.elapsed, 0, morph.duration)
            : morph.elapsed + dt);
      }
      const done = this.reducedMotion || !morph || (!morph.scrollControlled && morph.elapsed >= morph.duration);
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
          const span = instance.morphSpan || Math.max(1e-6, morph.duration - delay);
          const progress = easeInOut(clamp((morph.elapsed - delay) / Math.max(1e-6, span), 0, 1));
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
            const funnelDepth = clamp((34 - linZ) / 145, 0, 1);
            const swirl = direction * (2.45 + 1.55 * hash + funnelDepth * 0.9) * impulse;
            const phi = phi0 + dPhi * progress + swirl;
            const baseR = THREE.MathUtils.lerp(r0, r1, progress);
            const tornadoR = 5.4 + 9.2 * (1 - funnelDepth) + 2.4 * hash;
            const r = direction > 0
              ? Math.max(0.8, THREE.MathUtils.lerp(baseR, tornadoR, impulse * 0.84))
              : Math.max(0.8, baseR + (1.8 + 2.2 * hash) * impulse);
            instance.position.set(
              THREE.MathUtils.lerp(linX, Math.cos(phi) * r, cylWeight),
              THREE.MathUtils.lerp(linY, Math.sin(phi) * r, cylWeight),
              linZ,
            );
            instance.quaternion.slerpQuaternions(instance.fromQuaternion, instance.targetQuaternion, progress);
            const halfRoll = swirl * 0.34 * cylWeight;
            swirlQuat.set(0, 0, Math.sin(halfRoll), Math.cos(halfRoll));
            instance.quaternion.premultiply(swirlQuat);
          } else {
            instance.position.lerpVectors(instance.fromPosition, instance.targetPosition, progress);
            instance.quaternion.slerpQuaternions(instance.fromQuaternion, instance.targetQuaternion, progress);
          }
          instance.scale = THREE.MathUtils.lerp(instance.fromScale, instance.targetScale, progress);
        }
      }
      if (done) {
        this.instanceDirty = false;
        this.morph = null;
      } else if (morph?.scrollControlled) {
        this.instanceDirty = false;
      }
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
    const thresholdBlur = this.thresholdState ? (this.thresholdState.blur || 0) : 0;
    const focusBlur = clamp(Math.max(this.photoUniforms?.uFocusAmount?.value || 0, thresholdBlur), 0, 1);
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
    if (this.focusOverlayScene && ((this.focusPlate && this.focusState) || this._closingPlate)) {
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

    if (this.thresholdState) {
      if (this.thresholdState.unlocking) {
        this.thresholdState.elapsed = Math.min(
          this.thresholdState.duration,
          this.thresholdState.elapsed + dt,
        );
        const p = clamp(this.thresholdState.elapsed / Math.max(1e-6, this.thresholdState.duration), 0, 1);
        this.thresholdState.blur = 0.88 * Math.pow(1 - p, 2.8);
        if (this.thresholdState.elapsed >= this.thresholdState.duration) {
          this.thresholdState = null;
          if (this.controls && !this.film && !this.focusState && !this.scrollTimeline) {
            this.controls.enabled = true;
          }
        }
      } else {
        this.thresholdState.blur = 0.88;
      }
    }

    const camBefore = (this._camBefore ||= new THREE.Vector3()).copy(this.camera.position);
    const targetBefore = (this._targetBefore ||= new THREE.Vector3()).copy(this.controls.target);
    const fovBefore = this.camera.fov;

    if (this.film) {
      if (!this.film.manual) this.updateFilm(time);
      this._idleVelScale = 0;
    } else if (this.scrollTimeline && !this.focusState && !this.viewTransition) {
      this.updateScrollTimeline(dt);
      this._idleVelScale = 0;
    } else {
      let allowIdleDuringView = false;
      if (this.viewTransition) {
        const view = this.viewTransition;
        allowIdleDuringView = Boolean(view.allowIdleSpin);
        view.elapsed = Math.min(view.duration, view.elapsed + dt);
        const u = clamp(view.elapsed / Math.max(1e-6, view.duration), 0, 1);
        const progress = easeInOut(u);
        const hermiteH10 = u * (1 - u) * (1 - u) * view.duration;

        this.camera.position.lerpVectors(view.fromPosition, view.position, progress);
        if (view.velPosition) this.camera.position.addScaledVector(view.velPosition, hermiteH10);
        this.controls.target.lerpVectors(view.fromTarget, view.target, progress);
        if (view.velTarget) this.controls.target.addScaledVector(view.velTarget, hermiteH10);

        if (view.up) {
          this.camera.up.copy(view.fromUp).lerp(view.up, progress).normalize();
        } else {
          this.camera.up.copy(view.fromUp).multiplyScalar(1 - progress);
          this.camera.up.y += progress;
          this.camera.up.normalize();
        }
        if (!allowIdleDuringView) {
          this.group.quaternion.slerpQuaternions(view.fromRotation, view.rotation, progress);
        }
        this.camera.fov = THREE.MathUtils.lerp(view.fromFov, view.fov, progress) + (view.velFov || 0) * hermiteH10;
        this.camera.lookAt(this.controls.target);
        this.camera.updateProjectionMatrix();
        this.applyViewOffset();
        if (view.elapsed === view.duration) {
          this.viewTransition = null;
          if (!this.focusState && !allowIdleDuringView) this.alignIdlePhase();
        }
      }

      const canSpinIdle = this.running
        && !this.focusState
        && !this._closingPlate
        && (!this.viewTransition || allowIdleDuringView);
      const targetVelScale = canSpinIdle ? 1 : 0;
      this._idleVelScale = this.reducedMotion
        ? targetVelScale
        : THREE.MathUtils.lerp(
          this._idleVelScale ?? (canSpinIdle && !allowIdleDuringView ? 1 : 0),
          targetVelScale,
          1 - Math.exp(-dt * 2.8),
        );

      if (canSpinIdle && this._idleVelScale > 1e-4) {
        const dtSpin = dt * this.speed * this._idleVelScale;
        this.elapsed += dtSpin;
        if (this.mode === 'tunnel') {
          this.group.rotation.z += dtSpin * 0.035;
        } else {
          const portrait = this.mode === 'orbit' ? (this.formationPortrait || 0) : 0;
          this.idleYawElapsed = (this.idleYawElapsed || 0) + dtSpin;
          this.group.rotation.y += dtSpin * (0.085 * (1 - portrait) + 0.018 * portrait * Math.cos(this.idleYawElapsed * 0.2));
          this.idleTiltOffset = (this.idleTiltOffset || 0) * Math.exp(-dt * 1.5);
          this.group.rotation.x = (this.idleBaseTilt || 0) + Math.sin(this.elapsed * OSC_OMEGA) * OSC_AMP + this.idleTiltOffset;
          if (this.mode === 'orbit' && !this.instanceDirty && !this.reducedMotion && this.instances.length) {
            const current = this.ringAngles || [0, 0, 0, 0];
            this.ringAngles = current.map((angle, r) => angle + dtSpin * IDLE_RING_RATES[r]);
          }
        }
      }
      if (!this.focusState && !this.scrollTimeline) this.controls.update();
    }

    if (dt > 1e-4 && rawDeltaMs > 0) {
      const invDt = 1 / dt;
      const camVel = (this._camVel ||= new THREE.Vector3())
        .subVectors(this.camera.position, camBefore)
        .multiplyScalar(invDt);
      if (camVel.lengthSq() > 14400) camVel.setLength(120);
      const targetVel = (this._targetVel ||= new THREE.Vector3())
        .subVectors(this.controls.target, targetBefore)
        .multiplyScalar(invDt);
      if (targetVel.lengthSq() > 14400) targetVel.setLength(120);
      this._fovVel = clamp((this.camera.fov - fovBefore) * invDt, -90, 90);
    }

    if (this.parallaxGroup) {
      const allowed = this.pointerEnabled && !this.reducedMotion && !this.dragging && !this.film && !this.focusState;
      if (!allowed) this.pointerTarget.set(0, 0);
      if (this.reducedMotion || this.film) {
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
      const st = this.focusState;
      if (this.reducedMotion) {
        st.flightElapsed = st.flightDuration || 0.88;
        st.springValue = 1;
        st.springVel = 0;
        st.scaleElapsed = st.scaleDuration || 0.88;
        st.scaleProgress = 1;
        st.scaleVel = 0;
        st.transitionElapsed = st.transitionDuration || 0.80;
        st.curlBoost = 0;
        st.carriageShift = 0;
        st.carriageDepth = 0;
        st.carriageYaw = 0;
      } else {
        // C2 zero-jerk Silk Flight Ease: f(0)=0, f'(0)=0 (soft facet peel-off),
        // f(1)=1, f'(1)=0 (feathered museum landing, zero overshoot bounce).
        st.flightElapsed = Math.min(st.flightDuration || 0.88, (st.flightElapsed ?? 0) + dt);
        st.springValue = st.wasStepping
          ? 1
          : silkFlightEase(st.flightElapsed / Math.max(1e-6, st.flightDuration || 0.88));
        st.scaleElapsed = Math.min(st.scaleDuration || 0.88, (st.scaleElapsed ?? 0) + dt);
        st.scaleProgress = silkFlightEase(st.scaleElapsed / Math.max(1e-6, st.scaleDuration || 0.88));
        st.transitionElapsed = Math.min(st.transitionDuration || 0.80, (st.transitionElapsed ?? 1) + dt);
      }

      const p = clamp(st.springValue, 0, 1);
      const mixRaw = clamp((st.transitionElapsed ?? 1) / Math.max(1e-6, st.transitionDuration || 0.80), 0, 1);
      const mixEased = silkFlightEase(mixRaw);

      this.focusPlate.position.lerpVectors(st.cardPos, st.heroPos, p);
      if (st.normal && p > 0 && p < 1) {
        const liftSpan = Math.min(1.25, st.cardPos.distanceTo(st.heroPos) * 0.045);
        const liftArc = Math.sin(p * Math.PI) * (1 - p * 0.28) * liftSpan;
        this.focusPlate.position.addScaledVector(st.normal, liftArc);
      }
      if (st.cardQuat && st.heroQuat) {
        this.focusPlate.quaternion.slerpQuaternions(st.cardQuat, st.heroQuat, p);
      }

      // Subtle 3D optical carriage glide when stepping between prints in-stage
      const stepEnv = st.wasStepping && !this.reducedMotion ? Math.sin(mixEased * Math.PI) : 0;
      const flow = st.stepFlowDir || 1;
      const targetShift = -flow * 0.12 * stepEnv;
      const targetDepth = 0.22 * stepEnv;
      const targetYaw = -flow * 0.026 * stepEnv;
      const carriageAlpha = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 22);
      st.carriageShift = THREE.MathUtils.lerp(st.carriageShift || 0, targetShift, carriageAlpha);
      st.carriageDepth = THREE.MathUtils.lerp(st.carriageDepth || 0, targetDepth, carriageAlpha);
      st.carriageYaw = THREE.MathUtils.lerp(st.carriageYaw || 0, targetYaw, carriageAlpha);
      if (mixRaw >= 1 && Math.abs(st.carriageShift) < 4e-4 && Math.abs(st.carriageDepth) < 4e-4 && Math.abs(st.carriageYaw) < 4e-4) {
        st.carriageShift = 0;
        st.carriageDepth = 0;
        st.carriageYaw = 0;
      }
      if (Math.abs(st.carriageShift) > 0 || Math.abs(st.carriageDepth) > 0) {
        const stageRight = (this._stepRightVec ||= new THREE.Vector3()).set(1, 0, 0).applyQuaternion(st.heroQuat);
        const stageDepth = (this._stepDepthVec ||= new THREE.Vector3()).subVectors(st.heroPos, this.camera.position);
        if (stageDepth.lengthSq() > 1e-6) stageDepth.normalize();
        else stageDepth.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        this.focusPlate.position.addScaledVector(stageRight, st.carriageShift);
        this.focusPlate.position.addScaledVector(stageDepth, st.carriageDepth);
      }
      if (Math.abs(st.carriageYaw) > 0) {
        const yawQ = (this._stepYawQuat ||= new THREE.Quaternion()).setFromAxisAngle(
          st.cardUp || THREE.Object3D.DEFAULT_UP,
          st.carriageYaw,
        );
        this.focusPlate.quaternion.premultiply(yawQ);
      }

      this.focusPlate.scale.lerpVectors(st.scaleFrom || st.cardScale, st.heroScale, clamp(st.scaleProgress, 0, 1));

      const liquidMat = this.focusPlate.userData?.liquidMat;
      if (liquidMat) {
        const lu = liquidMat.uniforms;
        lu.uTime.value = time * 0.001;
        lu.uPlateAspect.value = (1.08 * Math.abs(this.focusPlate.scale.x))
          / Math.max(1e-4, 0.72 * Math.abs(this.focusPlate.scale.y));
        lu.uLiftProgress.value = st.wasStepping ? 1 : p;
        lu.uMix.value = st.wasStepping ? mixEased : 1;
        if (mixRaw >= 1 && lu.uTexPrev.value !== lu.uTexCurr.value) {
          const donePrev = lu.uTexPrev.value;
          lu.uTexPrev.value = lu.uTexCurr.value;
          lu.uUvRectPrev.value.copy(lu.uUvRectCurr.value);
          lu.uAspectPrev.value = lu.uAspectCurr.value;
          this._releaseOwnedFocusTexture(donePrev, lu.uTexPrev.value, lu.uTexCurr.value);
        }
        const fTarget = this.focusPointerTarget ||= new THREE.Vector2();
        const fCurr = this.focusPointerCurrent ||= new THREE.Vector2();
        if (this.reducedMotion) fCurr.set(0, 0);
        else fCurr.lerp(fTarget, 1 - Math.exp(-dt * 7.5));
        lu.uTilt.value.copy(fCurr);
        const flightCurl = !st.wasStepping ? Math.sin(p * Math.PI) * 0.18 : 0;
        const stepCurl = st.wasStepping ? (st.curlBoost || 0) * Math.sin(mixRaw * Math.PI) : 0;
        lu.uCurl.value = clamp(flightCurl + stepCurl, -0.72, 0.72);
      }
    }
    if (this._closingPlate) {
      const cp = this._closingPlate;
      cp.elapsed = Math.min(cp.duration, cp.elapsed + dt);
      const t = clamp(cp.elapsed / Math.max(1e-6, cp.duration), 0, 1);
      const ease = silkFlightEase(t);
      cp.mesh.position.lerpVectors(cp.fromPos, cp.toPos, ease);
      if (cp.normal && ease > 0 && ease < 1) {
        const returnArc = Math.sin((1 - ease) * Math.PI) * 0.42;
        cp.mesh.position.addScaledVector(cp.normal, returnArc);
      }
      if (cp.fromQuat && cp.toQuat) {
        cp.mesh.quaternion.slerpQuaternions(cp.fromQuat, cp.toQuat, ease);
      }
      cp.mesh.scale.lerpVectors(cp.fromScale, cp.toScale, ease);
      const lu = cp.mesh.userData?.liquidMat?.uniforms;
      if (lu) {
        lu.uTime.value = time * 0.001;
        lu.uPlateAspect.value = (1.08 * Math.abs(cp.mesh.scale.x))
          / Math.max(1e-4, 0.72 * Math.abs(cp.mesh.scale.y));
        lu.uLiftProgress.value = 1 - ease;
        lu.uOpacity.value = t < 0.84 ? 1 : clamp((1 - t) / 0.16, 0, 1);
        lu.uCurl.value = -Math.sin(ease * Math.PI) * 0.24;
      }
      if (t >= 0.86 && this.photoUniforms?.uFocusSlotHide) {
        this.photoUniforms.uFocusSlotHide.value = 0;
      }
      if (cp.elapsed >= cp.duration) {
        if (this.photoUniforms) {
          this.photoUniforms.uFocusSlotHide.value = 0;
          this.photoUniforms.uFocusWorld.value.set(0, 0, 9999);
        }
        this._disposeClosingPlate();
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
      au.uIntensity.value = (0.095 + focusFactor * 0.16) * reveal;

      const moodSourceIndex = this.focusState
        ? this.focusState.photoIndex
        : this.hoverActive
          ? (this._hoveredPhotoIndex ?? -1)
          : -1;
      const moodRgb = moodSourceIndex >= 0 ? this.photos?.[moodSourceIndex]?.moodRgb : null;
      this.moodPrimaryTarget ||= new THREE.Color(DEFAULT_MOOD_PRIMARY);
      this.moodSecondaryTarget ||= new THREE.Color(DEFAULT_MOOD_SECONDARY);
      if (Array.isArray(moodRgb)) {
        const scale = this.focusState ? 0.34 : 0.26;
        this.moodPrimaryTarget.setRGB(moodRgb[0] * scale, moodRgb[1] * scale, moodRgb[2] * scale, THREE.SRGBColorSpace);
        this.moodSecondaryTarget.setRGB(moodRgb[2] * 0.16, moodRgb[0] * 0.14, moodRgb[1] * 0.20, THREE.SRGBColorSpace);
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
    if (this._blankFocusTexture) {
      this._blankFocusTexture.dispose();
      this._blankFocusTexture = null;
    }
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
