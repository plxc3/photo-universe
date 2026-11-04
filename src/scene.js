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

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// Idle orbit oscillation: group.rotation.x = sin(elapsed * OMEGA) * AMP.
const OSC_AMP = 0.055;
const OSC_OMEGA = 0.13;
const BACKGROUND = '#000000';
const IDLE_RING_RATES = [0.22, -0.17, 0.26, -0.14];
const RING_AXIS_VECTORS = RING_AXES.map((axis) => new THREE.Vector3(...axis));

function shuffledPhotoPool(photos, count) {
  const pool = Array.from({ length: count }, (_, index) => photos[index % photos.length]);
  let seed = (0x6d656d6f ^ count ^ photos.length) >>> 0;
  for (let index = pool.length - 1; index > 0; index--) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const target = (seed >>> 0) % (index + 1);
    [pool[index], pool[target]] = [pool[target], pool[index]];
  }
  // Repair neighbours after shuffling the entire repeated pool. Counts and
  // photo identities stay intact, including when a scene uses all 3000 photos.
  if (photos.length > 1) {
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
  }
  return pool;
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
  constructor(container, { onPick, onFilmProgress, onFilmEnd, onModeChange, onContextLost, onFrame } = {}) {
    this.container = container;
    this.callbacks = { onPick, onFilmProgress, onFilmEnd, onModeChange, onContextLost, onFrame };
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
    this.pointerTarget = new THREE.Vector2();
    this.pointerCurrent = new THREE.Vector2();
    this.hoverNdc = new THREE.Vector2();
    this.hoverPointer = null;
    this.lastHoverTime = -Infinity;
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
    this.controls.addEventListener('end', () => { this.dragging = false; this.renderer.domElement.style.cursor = this.film ? 'default' : 'grab'; });
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
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.pointerEnabled = !this.reducedMotion && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    this.photoUniforms = {
      uReveal: { value: 1 },
      uDepthNear: { value: 36 },
      uDepthFar: { value: 110 },
      uTunnelMode: { value: 0 },
      uPaperBackground: { value: new THREE.Color(BACKGROUND) },
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
      if (!this.film && this.controls.enabled && event.deltaY) this.claimManualView();
    }, { passive: true });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.resetView(true);
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(time => this.animate(time));
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this._viewW = width;
    this._viewH = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    // Aspect can flip between portrait/landscape: re-fit the default orbit
    // distance (never recursing back through resetView) and refresh the offset.
    this.reframeDefaultView();
    this.applyViewOffset();
  }

  // Re-fit the resting orbit camera distance from the new aspect along the
  // current viewing direction. Only for the default view; user-dragged views
  // and the cinematic/tunnel framings are left untouched.
  reframeDefaultView() {
    if (this.film || !this.defaultView || this.mode !== 'orbit') return;
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
    } else if (this.mode === 'tunnel') {
      fx = 0;
      fy = 0;
    }
    if (this.viewTransition && !this.film) {
      const progress = easeInOut(this.viewTransition.elapsed / this.viewTransition.duration);
      const from = this.viewTransition.fromOffset;
      fx = THREE.MathUtils.lerp(from.x, fx, progress);
      fy = THREE.MathUtils.lerp(from.y, fy, progress);
    } else if (!this.film && this.heldViewOffset) {
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
    const moved = Math.hypot(event.clientX - previous[0], event.clientY - previous[1]);
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    const tap = this.tapGesture;
    if (tap?.pointerId === event.pointerId) tap.maxDistance = Math.max(tap.maxDistance, Math.hypot(event.clientX - tap.x, event.clientY - tap.y));
    if ((tap?.maxDistance > 6) || (pointers.size > 1 && moved > 0.5)) this.claimManualView();
  }

  endPointer(event, cancelled = false) {
    const pointers = this.activePointers;
    if (!pointers?.has(event.pointerId)) return false;
    const tap = this.tapGesture;
    if (tap?.pointerId === event.pointerId) tap.maxDistance = Math.max(tap.maxDistance, Math.hypot(event.clientX - tap.x, event.clientY - tap.y));
    const picked = !cancelled && !this.film && pointers.size === 1 && tap?.pointerId === event.pointerId && !tap.blocked && tap.maxDistance <= 6;
    pointers.delete(event.pointerId);
    if (cancelled && tap) tap.blocked = true;
    if (!pointers.size) this.tapGesture = null;
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
    if (hit?.instanceId !== undefined) this.callbacks.onPick?.(hit.object.userData.photoIndices[hit.instanceId]);
  }

  clearHover() {
    this.hoverPointer = null;
    if (this.renderer.domElement) this.renderer.domElement.style.cursor = this.film ? 'default' : this.dragging ? 'grabbing' : 'grab';
  }

  updateHover(time) {
    if (!this.renderer.domElement) return;
    if (!this.pointerEnabled || this.film || this.dragging || this.instanceDirty || !this.hoverPointer) {
      this.renderer.domElement.style.cursor = this.film ? 'default' : this.dragging ? 'grabbing' : 'grab';
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
    this.renderer.domElement.style.cursor = hit?.instanceId !== undefined ? 'pointer' : 'grab';
  }

  // Dispose meshes/geometry/material/texture. With no `keepCanvases` (a direct
  // call) every backing CPU canvas is released too; when a set is supplied the
  // reused canvases are preserved so the next textures are not built on a
  // canvas we just zeroed.
  clearPhotos(keepCanvases = null) {
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

  setPhotos(photos, atlases, count = 1200) {
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
    if (this.photoUniforms && !this.photoUniforms.uTunnelMode) {
      this.photoUniforms.uTunnelMode = { value: this.mode === 'tunnel' ? 1 : 0 };
    }
    const batches = atlases.map(() => []);
    const pool = shuffledPhotoPool(successful, count);
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
        Object.assign(shader.uniforms, this.photoUniforms);
        const varyings = 'varying vec2 vPaperUv;\nvarying vec3 vPhotoNormal;\nvarying vec3 vViewDir;\nvarying float vPhotoDepth;\n';
        shader.vertexShader = 'attribute vec4 atlasRect;\n' + varyings + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = atlasRect.xy + vMapUv * atlasRect.zw;\n#endif');
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
          vPaperUv = uv;
          vPhotoNormal = normalize(normalMatrix * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          vViewDir = normalize(-mvPosition.xyz);
          vPhotoDepth = -mvPosition.z;`);
        shader.fragmentShader = varyings + 'uniform float uReveal;\nuniform float uDepthNear;\nuniform float uDepthFar;\nuniform float uTunnelMode;\nuniform vec3 uPaperBackground;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          vec3 n = normalize(vPhotoNormal);
          if (!gl_FrontFacing) n = -n;
          vec3 v = normalize(vViewDir);
          float key = clamp(dot(n, normalize(vec3(-0.36, 0.48, 0.80))), 0.0, 1.0);
          float fill = clamp(dot(n, normalize(vec3(0.46, -0.32, 0.83))), 0.0, 1.0);
          vec3 halfVec = normalize(normalize(vec3(-0.24, 0.36, 0.90)) + v);
          float spec = pow(clamp(dot(n, halfVec), 0.0, 1.0), 28.0) * 0.14;
          float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb = clamp(mix(vec3(luma), diffuseColor.rgb, 1.18) * 1.06, 0.0, 1.0);
          float shade = 0.76 + 0.24 * key + 0.10 * fill;
          float backShade = gl_FrontFacing ? 1.0 : 0.82;
          float horizonFade = mix(
            mix(1.0, 0.88, smoothstep(uDepthNear, uDepthFar, vPhotoDepth)),
            1.0 - smoothstep(42.0, 152.0, vPhotoDepth),
            uTunnelMode
          );
          diffuseColor.rgb = (diffuseColor.rgb * shade + vec3(spec)) * backShade * horizonFade;
          vec2 edge = min(vPaperUv, vec2(1.0) - vPaperUv);
          float edgeDistance = min(edge.x, edge.y);
          float aa = max(0.003, min(fwidth(edgeDistance), 0.014));
          diffuseColor.rgb *= smoothstep(0.0, aa, edgeDistance);
          diffuseColor.rgb = mix(uPaperBackground, diffuseColor.rgb, uReveal);`);
      };
      material.customProgramCacheKey = () => 'memoria-darkroom-v3';
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.userData.photoIndices = batch.map(entry => entry.photoIndex);
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
    this.photoUniforms.uReveal.value = this.reducedMotion ? 1 : 0;
    this.reveal = this.reducedMotion ? null : { elapsed: 0, duration: 1.35 };
    this.resetView(!hadPhotos);
  }

  setFormation(mode, instant = false, resetCamera = true, durationOverride = null) {
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

  updateFilm(time) {
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
    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.(now);
  }

  animate(time) {
    const dt = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    if (document.hidden && !this.film) return;
    if (this.film) {
      if (!this.film.manual) this.updateFilm(time);
    } else {
      if (this.viewTransition) {
        const view = this.viewTransition;
        view.elapsed = Math.min(view.duration, view.elapsed + dt);
        const progress = easeInOut(view.elapsed / view.duration);
        this.camera.position.lerpVectors(view.fromPosition, view.position, progress);
        this.controls.target.lerpVectors(view.fromTarget, view.target, progress);
        this.camera.up.copy(view.fromUp).multiplyScalar(1 - progress);
        this.camera.up.y += progress;
        this.camera.up.normalize();
        this.group.quaternion.slerpQuaternions(view.fromRotation, view.rotation, progress);
        this.camera.fov = THREE.MathUtils.lerp(view.fromFov, view.fov, progress);
        this.camera.lookAt(this.controls.target);
        this.camera.updateProjectionMatrix();
        this.applyViewOffset();
        if (view.elapsed === view.duration) { this.viewTransition = null; this.alignIdlePhase(); }
      }
      else if (this.running) {
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
      this.controls.update();
    }
    if (this.parallaxGroup) {
      const allowed = this.pointerEnabled && !this.reducedMotion && !this.dragging && !this.film;
      if (!allowed) this.pointerTarget.set(0, 0);
      if (this.reducedMotion || this.film) this.pointerCurrent.set(0, 0);
      else this.pointerCurrent.lerp(this.pointerTarget, 1 - Math.exp(-dt * 5));
      const strength = this.camera.aspect < 0.85 ? 0.005 : 0.016;
      this.parallaxGroup.rotation.set(this.pointerCurrent.y * strength, this.pointerCurrent.x * strength, 0);
    }
    if (this.photoUniforms) {
      const distance = this.camera.position.distanceTo(this.controls.target);
      this.photoUniforms.uDepthNear.value = distance * 0.70;
      this.photoUniforms.uDepthFar.value = distance * 1.30;
      if (this.photoUniforms.uTunnelMode) {
        const targetTunnel = this.mode === 'tunnel' ? 1 : 0;
        this.photoUniforms.uTunnelMode.value = this.reducedMotion
          ? targetTunnel
          : THREE.MathUtils.lerp(this.photoUniforms.uTunnelMode.value, targetTunnel, 1 - Math.exp(-dt * 4));
      }
      if (this.reveal) {
        this.reveal.elapsed = Math.min(this.reveal.duration, this.reveal.elapsed + dt);
        this.photoUniforms.uReveal.value = easeInOut(this.reveal.elapsed / this.reveal.duration);
        if (this.reveal.elapsed === this.reveal.duration) this.reveal = null;
      }
      const density = this.mode === 'tunnel' ? 0.0042 : 0.0010;
      this.scene.fog.density = THREE.MathUtils.lerp(this.scene.fog.density, density, 1 - Math.exp(-dt * 3));
    }
    // Group/camera motion needs no instance uploads once a morph/effect settles.
    this.updateInstanceTransforms(dt);
    this.updateHover(time);
    this.renderer.render(this.scene, this.camera);
    this.callbacks.onFrame?.(time);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.clearPhotos();
    this.controls.dispose();
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
