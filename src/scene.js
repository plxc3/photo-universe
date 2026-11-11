import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  orbitFraming,
  orbitPosition,
  flightViewOffset,
  restingViewFractions,
  easeInOut,
  portraitAmount,
  restRotation,
} from './flight.js';
import { DarkroomPipeline, createDustField, createAtmosphereField } from './post.js';
import {
  chromaticPhotoPool,
  repairNeighbourDuplicates,
  deterministicHash,
  aspectScaleFactors,
} from './pool.js';
import { createInstancedCardMaterial } from './shaders.js';
import { pointerPickingMethods } from './pointer-picking.js';
import { morphEngineMethods } from './morph-engine.js';
import { focusStageMethods } from './focus-stage.js';
import { scrollTheatreMethods } from './scroll-theatre.js';

export { chromaticPhotoPool };

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
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label', '三维照片宇宙');
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
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
      this.alignIdlePhase();
      this.renderer.domElement.style.cursor = this.film || this.focusState ? 'default' : 'grab';
    });
    this.meshes = [];
    this.textures = [];
    this.instances = [];
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
      uFocusSlotHide: { value: 0 },
      uFocusWorld: { value: new THREE.Vector3(0, 0, 9999) },
    };
    this.instanceDirty = false;
    this.boundsDirty = false;
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

    this.renderer.domElement.addEventListener('pointerdown', (event) => this.beginPointer(event));
    this.renderer.domElement.addEventListener('pointermove', (event) => {
      this.movePointer(event);
      if (!this.pointerEnabled || this.dragging || this.film || event.buttons || event.pointerType === 'touch') return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const nx = clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
      const ny = clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
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
    this.renderer.domElement.addEventListener('pointercancel', (event) => {
      this.endPointer(event, true);
      this.pointerTarget.set(0, 0);
      this.focusPointerTarget?.set(0, 0);
      this.clearHover();
    });
    this.renderer.domElement.addEventListener('pointerup', (event) => this.endPointer(event));
    this.renderer.domElement.addEventListener('wheel', (event) => {
      if (!this.film && !this.focusState && this.controls.enabled && event.deltaY) this.claimManualView();
    }, { passive: true });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.resetView(true);
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop((time) => this.animate(time));
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
    } else if (this.scrollTimeline && !this.focusState) {
      const off = flightViewOffset(
        this.scrollTimeline.currentTime || 0,
        x,
        y,
        this.scrollTimeline.startOffset,
      );
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
    } else if (!this.film && !this.focusState && !this.scrollTimeline && this.heldViewOffset) {
      fx = this.heldViewOffset.x;
      fy = this.heldViewOffset.y;
    }
    const px = fx * w;
    const py = fy * h;
    if (px === 0 && py === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, px, py, w, h);
  }

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

  _zeroCameraVelocity() {
    this._camVel?.set(0, 0, 0);
    this._targetVel?.set(0, 0, 0);
    this._fovVel = 0;
  }

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
    const successful = atlases.flatMap((atlas, atlasIndex) =>
      atlas.photoIndices.map((photoIndex, tile) => ({ atlasIndex, photoIndex, tile })),
    );
    if (!successful.length) throw new Error('没有可以显示的照片。请导入 JPG、PNG 或 WebP 格式。');
    const requested = Number.isSafeInteger(count) && count > 0 ? count : 1200;
    count = Math.max(requested, successful.length);
    const hadPhotos = this.instances.length > 0;
    const incomingCanvases = new Set(atlases.map((atlas) => atlas.canvas));
    this.clearPhotos(incomingCanvases);
    this.atlasCanvases = incomingCanvases;
    this.photos = photos;
    this.count = count;
    const uniforms = this.ensurePhotoUniforms();
    uniforms.uTunnelMode.value = this.mode === 'tunnel' ? 1 : 0;

    const batches = atlases.map(() => []);
    const rawPool = chromaticPhotoPool(successful, photos, count);
    const hasSpectral = Array.isArray(photos) && successful.some(
      (entry) => Number.isFinite(photos[entry.photoIndex]?.spectralKey),
    );
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
      const material = createInstancedCardMaterial(texture, uniforms);
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.userData.photoIndices = batch.map((entry) => entry.photoIndex);
      mesh.userData.instanceIndices = batch.map((entry) => entry.index);
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
          this.euler.set((h1 - 0.5) * 2.4, (h2 - 0.5) * 2.4, nebulaAngle),
        );
        instance.fromScale = instance.targetScale * 0.08;
        instance.position.copy(instance.fromPosition);
        instance.quaternion.copy(instance.fromQuaternion);
        instance.scale = instance.fromScale;
        instance.delay = h1 * 0.42;
        instance.morphSpan = null;
        instance.settled = false;
      });
      this.morph = { elapsed: 0, duration: 2.25, vortex: true, vortexDirection: 1, shellArc: false };
      this.instanceDirty = true;
      this.boundsDirty = true;
      this.uploadInstanceMatrices();
      if (this.mode === 'orbit' && !this.film) {
        const restPos = new THREE.Vector3(...orbitPosition(this.camera.aspect));
        const restQuat = this.group.quaternion.clone();
        const restOff = restingViewFractions(this.camera.aspect);
        const farPos = restPos.clone().multiplyScalar(1.22);
        const startQuat = restQuat.clone().multiply(
          new THREE.Quaternion().setFromEuler(this.euler.set(-0.08, -0.32, 0.04)),
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
      new THREE.Euler(...restRotation(this.camera.aspect)),
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

  animate(time) {
    const rawDeltaMs = time - this.lastTime;
    const dt = Math.min(rawDeltaMs / 1000, 0.05);
    this.lastTime = time;
    if (document.hidden && !this.film) return;

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

      // Yield idle spin smoothly while dragging so manual inspection never fights the gyroscope
      const canSpinIdle = this.running
        && !this.dragging
        && !this.focusState
        && !this._closingPlate
        && (!this.viewTransition || allowIdleDuringView);
      const targetVelScale = canSpinIdle ? 1 : 0;
      const idleRate = canSpinIdle ? 2.8 : 8.5;
      this._idleVelScale = this.reducedMotion
        ? targetVelScale
        : THREE.MathUtils.lerp(
          this._idleVelScale ?? (canSpinIdle && !allowIdleDuringView ? 1 : 0),
          targetVelScale,
          1 - Math.exp(-dt * idleRate),
        );

      const spinPermitted = this.running
        && !this.focusState
        && !this._closingPlate
        && (!this.viewTransition || allowIdleDuringView);
      if (spinPermitted && this._idleVelScale > 1e-4) {
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
        : THREE.MathUtils.lerp(uniforms.uHoverStrength.value, targetHover, 1 - Math.exp(-dt * 10));
      if (this.hoverActive && this.hoverTargetWorld) {
        uniforms.uHoverWorld.value.lerp(this.hoverTargetWorld, 1 - Math.exp(-dt * 18));
      }

      if (this.reveal) {
        this.reveal.elapsed = Math.min(this.reveal.duration, this.reveal.elapsed + dt);
        uniforms.uReveal.value = easeInOut(this.reveal.elapsed / this.reveal.duration);
        if (this.reveal.elapsed === this.reveal.duration) this.reveal = null;
      }
      const density = this.mode === 'tunnel' ? 0.0042 : 0.0010;
      this.scene.fog.density = THREE.MathUtils.lerp(this.scene.fog.density, density, 1 - Math.exp(-dt * 3));
    }

    this._updateFocusStage(time, dt);

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

Object.assign(
  PhotoUniverse.prototype,
  pointerPickingMethods,
  morphEngineMethods,
  focusStageMethods,
  scrollTheatreMethods,
);
