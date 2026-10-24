import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFormation } from './formations.js';
import { sampleFlight, orbitFraming, orbitPosition, flightViewOffset, restingViewFractions, easeInOut, portraitAmount, restRotation, FILM } from './flight.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// Idle orbit oscillation: group.rotation.x = sin(elapsed * OMEGA) * AMP.
const OSC_AMP = 0.055;
const OSC_OMEGA = 0.13;
const BACKGROUND = '#11100f';

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

export class PhotoUniverse {
  constructor(container, { onPick, onFilmProgress, onFilmEnd, onModeChange, onContextLost, onFrame } = {}) {
    this.container = container;
    this.callbacks = { onPick, onFilmProgress, onFilmEnd, onModeChange, onContextLost, onFrame };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    this.scene.fog = new THREE.FogExp2(BACKGROUND, 0.0024);
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
      this.defaultView = false;
      this.dragging = true;
      this.viewTransition = null;
      this.pointerTarget.set(0, 0);
    });
    this.controls.addEventListener('end', () => { this.dragging = false; });
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
      uPaperBackground: { value: new THREE.Color(BACKGROUND) },
    };
    this.instanceDirty = false; // instances need per-frame matrix recomputation
    this.boundsDirty = false;   // instanced bounding spheres are stale after morph
    this.dummy = new THREE.Object3D();
    this.quaternion = new THREE.Quaternion();
    this.euler = new THREE.Euler();
    this.raycaster = new THREE.Raycaster();
    this.pointerDown = null;
    this.renderer.domElement.addEventListener('pointerdown', event => { this.pointerDown = [event.clientX, event.clientY]; });
    this.renderer.domElement.addEventListener('pointermove', event => {
      if (!this.pointerEnabled || this.dragging || this.film || event.buttons || event.pointerType === 'touch') return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointerTarget.set(clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1), clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1));
    });
    this.renderer.domElement.addEventListener('pointerleave', () => this.pointerTarget.set(0, 0));
    this.renderer.domElement.addEventListener('pointerup', event => {
      if (!this.pointerDown || this.film) return;
      const distance = Math.hypot(event.clientX - this.pointerDown[0], event.clientY - this.pointerDown[1]);
      this.pointerDown = null;
      if (distance > 6) return;
      this.scene.updateMatrixWorld(true);
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
      // Recompute instance bounding spheres only when a morph has moved them,
      // not on every pick while the scene is settled.
      if (this.boundsDirty) {
        for (const mesh of this.meshes) mesh.computeBoundingSphere();
        this.boundsDirty = false;
      }
      const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
      if (hit?.instanceId !== undefined) this.callbacks.onPick?.(hit.object.userData.photoIndices[hit.instanceId]);
    });
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
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
      this.textures.push(texture);
      const geometry = new THREE.PlaneGeometry(1.08, 0.72);
      const rects = new Float32Array(batch.length * 4);
      const rect = atlas.cellRect || { x: 2, y: 22, width: 124, height: 84, size: 128 };
      const columns = atlas.columns || 16;
      batch.forEach((entry, localIndex) => {
        const col = entry.tile % columns;
        const row = Math.floor(entry.tile / columns);
        rects.set([(col * rect.size + rect.x) / atlas.canvas.width, 1 - (row * rect.size + rect.y + rect.height) / atlas.canvas.height, rect.width / atlas.canvas.width, rect.height / atlas.canvas.height], localIndex * 4);
      });
      geometry.setAttribute('atlasRect', new THREE.InstancedBufferAttribute(rects, 4));
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, color: '#ffffff' });
      material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, this.photoUniforms);
        const varyings = 'varying vec2 vPaperUv;\nvarying vec3 vPhotoNormal;\nvarying float vPhotoDepth;\n';
        shader.vertexShader = 'attribute vec4 atlasRect;\n' + varyings + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = atlasRect.xy + vMapUv * atlasRect.zw;\n#endif');
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
          vPaperUv = uv;
          vPhotoNormal = normalize(normalMatrix * mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
          vPhotoDepth = -mvPosition.z;`);
        shader.fragmentShader = varyings + 'uniform float uReveal;\nuniform float uDepthNear;\nuniform float uDepthFar;\nuniform vec3 uPaperBackground;\n' + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          float facing = abs(normalize(vPhotoNormal).z);
          float directional = 0.78 + 0.22 * clamp(dot(normalize(vPhotoNormal), normalize(vec3(-0.35, 0.45, 0.82))), 0.0, 1.0);
          float depthShade = mix(1.0, 0.90, smoothstep(uDepthNear, uDepthFar, vPhotoDepth));
          float faceShade = mix(0.88, 1.0, smoothstep(0.15, 0.88, facing)) * directional;
          float backShade = gl_FrontFacing ? 1.0 : 0.78;
          diffuseColor.rgb *= depthShade * faceShade * backShade;
          vec2 edge = min(vPaperUv, vec2(1.0) - vPaperUv);
          float edgeDistance = min(edge.x, edge.y);
          float aa = min(fwidth(edgeDistance), 0.008);
          float paper = 1.0 - smoothstep(0.006 - aa, 0.006 + aa, edgeDistance);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.90, 0.86) * depthShade * backShade, paper * 0.62);
          diffuseColor.rgb = mix(uPaperBackground, diffuseColor.rgb, uReveal);`);
      };
      material.customProgramCacheKey = () => 'memoria-paper-v2';
      const mesh = new THREE.InstancedMesh(geometry, material, batch.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.userData.photoIndices = batch.map(entry => entry.photoIndex);
      this.meshes.push(mesh);
      this.group.add(mesh);
      batch.forEach((entry, localIndex) => {
        this.instances[entry.index] = { mesh, localIndex, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: 1, targetPosition: new THREE.Vector3(), targetQuaternion: new THREE.Quaternion(), targetScale: 1, settled: false };
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
    if (this.mode === mode && !instant && !layoutChanged) {
      if (resetCamera) this.resetView(false);
      return;
    }
    this.mode = mode;
    this.formationPortrait = portrait;
    this.layoutAspect = this.camera.aspect;
    const targets = createFormation(mode, this.count || 0, portrait);
    const duration = this.reducedMotion ? 0 : (durationOverride ?? 2.2);
    targets.forEach((target, index) => {
      const instance = this.instances[index];
      instance.fromPosition = instance.position.clone();
      instance.fromQuaternion = instance.quaternion.clone();
      instance.fromScale = instance.scale;
      instance.delay = duration ? index / Math.max(1, targets.length - 1) * Math.min(0.16, duration * 0.1) : 0;
      instance.targetPosition.fromArray(target.position);
      instance.targetQuaternion.setFromEuler(this.euler.fromArray(target.rotation));
      instance.targetScale = target.scale;
      if (instant) {
        instance.position.copy(instance.targetPosition);
        instance.quaternion.copy(instance.targetQuaternion);
        instance.scale = target.scale;
        instance.settled = true;
      } else instance.settled = false;
    });
    if (instant) this.writeInstanceMatrices();
    else { this.instanceDirty = true; this.boundsDirty = true; this.morph = { elapsed: 0, duration }; }
    if (resetCamera) {
      this.resetView(instant);
    }
    this.callbacks.onModeChange?.(mode);
  }

  // Write every instance matrix once (used by instant paths / first frame),
  // then clear the dirty flag so steady state performs no per-frame work.
  writeInstanceMatrices() {
    for (const instance of this.instances) {
      this.dummy.position.copy(instance.position);
      this.dummy.quaternion.copy(instance.quaternion);
      this.dummy.scale.setScalar(instance.scale);
      this.dummy.updateMatrix();
      instance.mesh.setMatrixAt(instance.localIndex, this.dummy.matrix);
    }
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
    this.boundsDirty = true;
    this.instanceDirty = false;
    this.morph = null;
  }

  resetView(instant = false) {
    if (this.mode === 'orbit' && this.instances.length && Math.abs(portraitAmount(this.camera.aspect) - (this.formationPortrait || 0)) > 1e-6) {
      this.setFormation('orbit', instant, false);
    }
    this.flushDamping();
    const mobile = orbitFraming(this.camera.aspect, 54).mobile;
    const position = this.mode === 'tunnel'
      ? [0, 0, 57]
      : this.mode === 'helix'
        ? [0, 4, mobile ? 105 : 68]
        : this.mode === 'orbit'
          ? orbitPosition(this.camera.aspect)
          : [0, 6, mobile ? 96 : 62];
    const target = this.mode === 'tunnel' ? [0, 0, -65] : [0, 0, 0];
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
    const startPose = { position: this.camera.position.toArray(), target: this.controls.target.toArray(), up: this.camera.up.toArray(), fov: this.camera.fov, rotation: [this.group.rotation.x, this.group.rotation.y, this.group.rotation.z] };
    this.film = { start: performance.now(), phase: 'orbit', elapsed: 0, startPose, startOffset: { x: view?.enabled ? view.offsetX / view.fullWidth : 0, y: view?.enabled ? view.offsetY / view.fullHeight : 0 } };
    this.heldViewOffset = null;
    this.viewTransition = null;
    this.controls.enabled = false;
    this.pointerTarget?.set(0, 0);
    this.setFormation('orbit', false, false);
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
    this.film = null;
    this.controls.enabled = true;
    this.flushDamping();
    this.alignIdlePhase();
    if (natural) {
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
      this.setFormation(s.mode, false, false);
    }
    this.callbacks.onFilmProgress?.(elapsed);
    if (elapsed >= FILM.total) { this.film.natural = true; this.stopFilm(true, false); }
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
    this.setFormation(sample.mode, true, false);
    this.film.phase = sample.mode;
    this.film.manual = true;
    this.film.elapsed = target;
    this.camera.position.fromArray(sample.position);
    this.camera.up.fromArray(sample.up);
    this.camera.fov = sample.fov;
    this.controls.target.fromArray(sample.target);
    this.camera.lookAt(this.controls.target);
    this.group.rotation.set(sample.rotation[0], sample.rotation[1], sample.rotation[2]);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
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
        if (this.mode === 'tunnel') this.group.rotation.z += dt * this.speed * 0.035;
        else {
          const portrait = this.mode === 'orbit' ? (this.formationPortrait || 0) : 0;
          this.idleYawElapsed = (this.idleYawElapsed || 0) + dt * this.speed;
          this.group.rotation.y += dt * this.speed * (0.055 * (1 - portrait) + 0.012 * portrait * Math.cos(this.idleYawElapsed * 0.2));
          this.idleTiltOffset = (this.idleTiltOffset || 0) * Math.exp(-dt * 1.5);
          this.group.rotation.x = (this.idleBaseTilt || 0) + Math.sin(this.elapsed * OSC_OMEGA) * OSC_AMP + this.idleTiltOffset;
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
      if (this.reveal) {
        this.reveal.elapsed = Math.min(this.reveal.duration, this.reveal.elapsed + dt);
        this.photoUniforms.uReveal.value = easeInOut(this.reveal.elapsed / this.reveal.duration);
        if (this.reveal.elapsed === this.reveal.duration) this.reveal = null;
      }
      const density = this.mode === 'tunnel' ? 0.0045 : 0.0012;
      this.scene.fog.density = THREE.MathUtils.lerp(this.scene.fog.density, density, 1 - Math.exp(-dt * 3));
    }
    // A fixed 2.2s eased morph has zero starting/ending velocity, remains active
    // while rotation is paused, and performs its final GPU upload exactly once.
    if (this.instanceDirty && this.instances.length) {
      const morph = this.morph;
      if (morph) morph.elapsed = Math.min(morph.duration, morph.elapsed + dt);
      const done = this.reducedMotion || !morph || morph.elapsed >= morph.duration;
      for (const instance of this.instances) {
        if (done) {
          instance.position.copy(instance.targetPosition);
          instance.quaternion.copy(instance.targetQuaternion);
          instance.scale = instance.targetScale;
          instance.settled = true;
        } else {
          const progress = easeInOut((morph.elapsed - instance.delay) / (morph.duration - instance.delay));
          instance.position.lerpVectors(instance.fromPosition, instance.targetPosition, progress);
          instance.quaternion.slerpQuaternions(instance.fromQuaternion, instance.targetQuaternion, progress);
          instance.scale = THREE.MathUtils.lerp(instance.fromScale, instance.targetScale, progress);
        }
        this.dummy.position.copy(instance.position);
        this.dummy.quaternion.copy(instance.quaternion);
        this.dummy.scale.setScalar(instance.scale);
        this.dummy.updateMatrix();
        instance.mesh.setMatrixAt(instance.localIndex, this.dummy.matrix);
      }
      for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
      this.boundsDirty = true;
      if (done) { this.instanceDirty = false; this.morph = null; }
    }
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
