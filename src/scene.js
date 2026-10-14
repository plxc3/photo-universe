import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createFormation } from './formations.js';
import { sampleFlight, orbitFraming, flightViewOffset, restingViewFractions, FILM } from './flight.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// Idle orbit oscillation: group.rotation.x = sin(elapsed * OMEGA) * AMP.
const OSC_AMP = 0.14;
const OSC_OMEGA = 0.16;

export class PhotoUniverse {
  constructor(container, { onPick, onFilmProgress, onFilmEnd, onModeChange, onContextLost } = {}) {
    this.container = container;
    this.callbacks = { onPick, onFilmProgress, onFilmEnd, onModeChange, onContextLost };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#050708');
    this.scene.fog = new THREE.FogExp2('#050708', 0.0026);
    this.camera = new THREE.PerspectiveCamera(54, 1, 0.08, 360);
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
    this.scene.add(this.group);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 150;
    this.controls.zoomSpeed = 0.6;
    this.controls.rotateSpeed = 0.45;
    // Track whether the camera still sits on the aspect-driven default framing
    // (so resize re-fits distance) versus a user-dragged view (leave it alone).
    this.defaultView = true;
    this._viewW = 0;
    this._viewH = 0;
    this._tmpVec = new THREE.Vector3();
    this.controls.addEventListener('start', () => { this.defaultView = false; });
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
    this.instanceDirty = false; // instances need per-frame matrix recomputation
    this.boundsDirty = false;   // instanced bounding spheres are stale after morph
    this.dummy = new THREE.Object3D();
    this.quaternion = new THREE.Quaternion();
    this.euler = new THREE.Euler();
    this.raycaster = new THREE.Raycaster();
    this.pointerDown = null;
    this.renderer.domElement.addEventListener('pointerdown', event => { this.pointerDown = [event.clientX, event.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', event => {
      if (!this.pointerDown || this.film) return;
      const distance = Math.hypot(event.clientX - this.pointerDown[0], event.clientY - this.pointerDown[1]);
      this.pointerDown = null;
      if (distance > 6) return;
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
    this.resetView(true);
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(time => this.animate(time));
  }

  resize() {
    const { width, height } = this.container.getBoundingClientRect();
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
    const framing = orbitFraming(this.camera.aspect, this.camera.fov > 60 ? 75 : 54);
    const dir = this._tmpVec.subVectors(this.camera.position, this.controls.target);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.multiplyScalar(framing.distance / len);
    this.camera.position.copy(this.controls.target).add(dir);
    this.camera.updateProjectionMatrix();
  }

  // Apply the projection view offset. During the film it follows the continuous
  // flight schedule (eases to 0 through the tunnel and back to rest at 30s);
  // at rest it uses the same resting fractions, so a natural end is
  // projection-matrix identical to a resize.
  applyViewOffset() {
    const w = this._viewW || 0;
    const h = this._viewH || 0;
    const { x, y } = restingViewFractions(this.camera.aspect, w > 900);
    let fx = x;
    let fy = y;
    if (this.film) {
      const off = flightViewOffset(this.film.elapsed || 0, x, y);
      fx = off.x;
      fy = off.y;
    } else if (this.mode === 'tunnel') {
      fx = 0;
      fy = 0;
    }
    const px = fx * w;
    const py = fy * h;
    if (px === 0 && py === 0) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, px, py, w, h);
  }

  // OrbitControls.update() does not clear residual damping on its own; toggling
  // damping off for a single update consumes sphericalDelta so the camera is not
  // shoved on the next interactive frame.
  flushDamping() {
    const wasEnabled = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = wasEnabled;
  }

  // Seed the idle oscillation clock so group.rotation.x continues from the
  // current tilt instead of snapping to sin(staleElapsed * OMEGA) * AMP.
  alignIdlePhase() {
    const ratio = clamp(this.group.rotation.x / OSC_AMP, -1, 1);
    this.elapsed = Math.asin(ratio) / OSC_OMEGA;
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
    this.atlasCanvases.clear();
    this.instanceDirty = false;
    this.boundsDirty = false;
  }

  setPhotos(photos, atlases, count = 3000) {
    const incomingCanvases = new Set(atlases.map(atlas => atlas.canvas));
    this.clearPhotos(incomingCanvases);
    this.atlasCanvases = incomingCanvases;
    this.photos = photos;
    this.count = count;
    const successful = atlases.flatMap((atlas, atlasIndex) => atlas.photoIndices.map((photoIndex, tile) => ({ atlasIndex, photoIndex, tile })));
    if (!successful.length) throw new Error('没有可以显示的照片。请导入 JPG、PNG 或 WebP 格式。');
    const batches = atlases.map(() => []);
    // A full permutation includes every photo, including albums divisible by 17.
    let seed = 0x6d656d6f;
    for (let index = successful.length - 1; index > 0; index--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const target = (seed >>> 0) % (index + 1);
      [successful[index], successful[target]] = [successful[target], successful[index]];
    }
    for (let index = 0; index < count; index++) {
      const entry = successful[index % successful.length];
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
      batch.forEach((entry, localIndex) => {
        const col = entry.tile % 16;
        const row = Math.floor(entry.tile / 16);
        rects.set([(col * rect.size + rect.x) / atlas.canvas.width, 1 - (row * rect.size + rect.y + rect.height) / atlas.canvas.height, rect.width / atlas.canvas.width, rect.height / atlas.canvas.height], localIndex * 4);
      });
      geometry.setAttribute('atlasRect', new THREE.InstancedBufferAttribute(rects, 4));
      const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, color: '#eef3ef' });
      material.onBeforeCompile = shader => {
        shader.vertexShader = 'attribute vec4 atlasRect;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = atlasRect.xy + vMapUv * atlasRect.zw;\n#endif');
      };
      material.customProgramCacheKey = () => 'memoria-atlas-v1';
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
    this.setFormation(this.mode, true);
    this.group.rotation.set(0, 0, 0);
    this.resetView(true);
  }

  setFormation(mode, instant = false, resetCamera = true) {
    if (this.mode === mode && !instant) return;
    this.mode = mode;
    const targets = createFormation(mode, this.count || 0);
    targets.forEach((target, index) => {
      const instance = this.instances[index];
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
    else { this.instanceDirty = true; this.boundsDirty = true; }
    if (resetCamera) {
      this.group.rotation.set(0, 0, 0);
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
  }

  resetView(instant = false) {
    const framing = orbitFraming(this.camera.aspect, 54);
    const mobile = framing.mobile;
    const position = this.mode === 'tunnel'
      ? [0, 0, 57]
      : this.mode === 'helix'
        ? [0, 4, mobile ? 105 : 68]
        : this.mode === 'orbit'
          ? (mobile ? framingOrbitPosition(framing) : [34, 14, 50])
          : [0, 6, mobile ? 96 : 62];
    const target = this.mode === 'tunnel' ? [0, 0, -65] : [0, 0, 0];
    const fov = this.mode === 'tunnel' ? 75 : 54;
    this.controls.target.fromArray(target);
    this.camera.up.set(0, 1, 0);
    this.controls.minDistance = this.mode === 'tunnel' ? 3 : 8;
    if (instant || this.reducedMotion) {
      this.camera.position.fromArray(position);
      this.camera.fov = fov;
      this.viewTransition = null;
    } else this.viewTransition = { position: new THREE.Vector3(...position), fov };
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.defaultView = true;
    this.applyViewOffset();
  }

  startFilm() {
    // Flush residual damping before we take over the camera, and keep the
    // resting view offset (the film eases it out by 5.5s) so frame one does
    // not jump from an abrupt clearViewOffset.
    this.stopFilm(false, true);
    this.film = { start: performance.now(), phase: 'orbit', elapsed: 0 };
    this.viewTransition = null;
    this.flushDamping();
    this.controls.enabled = false;
    this.group.rotation.set(0, 0, 0);
    this.setFormation('orbit', true, false);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
  }

  stopFilm(notify = true, reset = true) {
    const active = Boolean(this.film);
    const natural = active && this.film.natural === true;
    this.film = null;
    this.controls.enabled = true;
    if (natural) {
      // Preserve the final establishing shot; sync OrbitControls to it so the
      // first interactive frame does not jump from a reset or leftover damping.
      this.controls.target.set(0, 0, 0);
      this.camera.up.set(0, 1, 0);
      this.camera.fov = 54;
      this.camera.lookAt(this.controls.target);
      this.camera.updateProjectionMatrix();
      this.defaultView = true;
      this.flushDamping();
      this.alignIdlePhase();
    } else {
      this.camera.up.set(0, 1, 0);
      this.group.rotation.set(0, 0, 0);
      this.alignIdlePhase();
      if (reset) this.resetView(true);
    }
    this.resize();
    if (active && notify) this.callbacks.onFilmEnd?.();
  }

  updateFilm(time) {
    const elapsed = clamp((time - this.film.start) / 1000, 0, FILM.total);
    this.film.elapsed = elapsed;
    const s = sampleFlight(elapsed, this.camera.aspect);
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

  animate(time) {
    const dt = Math.min((time - this.lastTime) / 1000, 0.05);
    this.lastTime = time;
    if (document.hidden && !this.film) return;
    if (this.film) this.updateFilm(time);
    else {
      if (this.viewTransition) {
        this.camera.position.lerp(this.viewTransition.position, 1 - Math.exp(-dt * 4));
        this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, this.viewTransition.fov, 1 - Math.exp(-dt * 4));
        this.camera.updateProjectionMatrix();
        if (this.camera.position.distanceTo(this.viewTransition.position) < 0.02) this.viewTransition = null;
      }
      if (this.running) {
        this.elapsed += dt * this.speed;
        if (this.mode === 'tunnel') this.group.rotation.z += dt * this.speed * 0.045;
        else {
          this.group.rotation.y += dt * this.speed * 0.11;
          this.group.rotation.x = Math.sin(this.elapsed * OSC_OMEGA) * OSC_AMP;
        }
      }
      this.controls.update();
    }
    // Only recompute instance matrices while a morph is in flight. Once every
    // card has settled we snap to exact targets, upload one last time, and stop.
    if (this.instanceDirty && this.instances.length) {
      const lerp = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.3);
      const posTolSq = 0.0015 * 0.0015;
      const rotTol = 1e-5;
      const scaleTol = 0.0015;
      let moving = 0;
      for (const instance of this.instances) {
        const withinPos = instance.position.distanceToSquared(instance.targetPosition) <= posTolSq;
        const withinRot = 1 - Math.abs(instance.quaternion.dot(instance.targetQuaternion)) <= rotTol;
        const withinScale = Math.abs(instance.scale - instance.targetScale) <= scaleTol;
        if (withinPos && withinRot && withinScale) {
          if (instance.settled) continue; // already exact and already uploaded
          instance.position.copy(instance.targetPosition);
          instance.quaternion.copy(instance.targetQuaternion);
          instance.scale = instance.targetScale;
          instance.settled = true;
        } else {
          instance.position.lerp(instance.targetPosition, lerp);
          instance.quaternion.slerp(instance.targetQuaternion, lerp);
          instance.scale = THREE.MathUtils.lerp(instance.scale, instance.targetScale, lerp);
        }
        this.dummy.position.copy(instance.position);
        this.dummy.quaternion.copy(instance.quaternion);
        this.dummy.scale.setScalar(instance.scale);
        this.dummy.updateMatrix();
        instance.mesh.setMatrixAt(instance.localIndex, this.dummy.matrix);
        moving++;
      }
      if (moving > 0) {
        for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
        this.boundsDirty = true;
      }
      if (moving === 0) this.instanceDirty = false;
    }
    this.renderer.render(this.scene, this.camera);
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

// Establishing-shot position for portrait, derived from the aspect-driven framing
// distance so the resting view, the reset button and the film end all agree.
function framingOrbitPosition(framing) {
  const x = 6;
  const y = 14;
  const z = Math.sqrt(Math.max(1, framing.distance * framing.distance - x * x - y * y));
  return [x, y, z];
}
