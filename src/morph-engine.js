import * as THREE from 'three';
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
  orbitFraming,
  orbitPosition,
  easeInOut,
  portraitAmount,
  restRotation,
} from './flight.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const RING_AXIS_VECTORS = RING_AXES.map((axis) => new THREE.Vector3(...axis));

/**
 * Instanced formation topology transitions, meridian shell-arc / vortex morphs,
 * and GPU instanceMatrix upload pipeline mixed onto PhotoUniverse.prototype.
 */
export const morphEngineMethods = {
  setFormation(mode, instant = false, resetCamera = true, durationOverride = null) {
    if (this.focusState) this.closeFocus(true);
    const portrait = mode === 'orbit' ? portraitAmount(this.camera.aspect) : 0;
    const layoutChanged = Math.abs(portrait - (this.formationPortrait || 0)) > 1e-6;
    if (this.mode === mode && !instant && !layoutChanged && !this.frozenFormation) {
      if (resetCamera) this.resetView(false);
      return;
    }
    const previousMode = this.mode;
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
    const shellArc = !instant && duration > 0 && !vortex && (
      mode === 'sphere' ||
      mode === 'helix' ||
      previousMode === 'sphere' ||
      previousMode === 'helix'
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
      } else if (shellArc) {
        const hash = instance.vortexHash || 0;
        const order = index / Math.max(1, targets.length - 1);
        instance.delay = (order * 0.16 + hash * 0.08) * duration;
        instance.morphSpan = duration - instance.delay;
      } else {
        instance.delay = (index / Math.max(1, targets.length - 1)) * Math.min(0.16, duration * 0.1);
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
      } else {
        instance.settled = false;
      }
    });
    this.tunnelLayers = [...layers.values()];
    if (instant) {
      this.writeInstanceMatrices();
    } else {
      this.instanceDirty = true;
      this.boundsDirty = true;
      this.morph = { elapsed: 0, duration, vortex, vortexDirection, shellArc };
    }
    if (resetCamera) {
      this.resetView(instant);
    }
    this.callbacks.onModeChange?.(mode);
  },

  writeInstanceMatrices() {
    this.uploadInstanceMatrices();
    this.instanceDirty = false;
    this.morph = null;
  },

  hasActiveRingSpin() {
    const angles = this.ringAngles;
    return Boolean(angles && (angles[0] || angles[1] || angles[2] || angles[3]));
  },

  ringSpinChanged() {
    const a = this.ringAngles || [0, 0, 0, 0];
    const b = this.appliedRingAngles || [0, 0, 0, 0];
    return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];
  },

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
      const weight = clamp(depthAhead / 138, 0, 1.35) ** 1.42;
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
        this.euler.set(0.14 * breath, 0.56 * breath, -0.22 * breath),
      );
      facetQuaternions = Array.from({ length: 24 }, (_, f) =>
        new THREE.Quaternion()
          .setFromEuler(this.euler.fromArray(stellatedFacetRotation(f, expandedA)))
          .premultiply(breathQuat),
      );
    }

    let ringQuaternions = null;
    const ringSpinActive = this.mode === 'orbit' && !this.instanceDirty && this.hasActiveRingSpin();
    if (ringSpinActive) {
      ringQuaternions = RING_AXIS_VECTORS.map((axis, r) =>
        new THREE.Quaternion().setFromAxisAngle(axis, this.ringAngles[r] || 0),
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
  },

  bakeTunnelPose(freeze = false) {
    const appliedRings = this.appliedRingAngles || [0, 0, 0, 0];
    const hasRingOffset = Boolean(appliedRings[0] || appliedRings[1] || appliedRings[2] || appliedRings[3]);
    const dynamic = Boolean(
      this.appliedTunnelTwist ||
      this.appliedTunnelConveyor ||
      this.appliedStellationBreath ||
      hasRingOffset,
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
  },

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
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...(this.mode === 'tunnel' ? [0, 0, 0] : restRotation(this.camera.aspect))),
    );
    if (instant || this.reducedMotion) {
      this.camera.position.fromArray(position);
      this.controls.target.fromArray(target);
      this.camera.up.set(0, 1, 0);
      this.group.quaternion.copy(rotation);
      this.alignIdlePhase();
      this.camera.fov = fov;
      this.viewTransition = null;
      this._zeroCameraVelocity();
    } else {
      this.viewTransition = {
        elapsed: 0,
        duration: 2.2,
        fromPosition: this.camera.position.clone(),
        position: new THREE.Vector3(...position),
        fromTarget: this.controls.target.clone(),
        target: new THREE.Vector3(...target),
        fromUp: this.camera.up.clone(),
        fromFov: this.camera.fov,
        fov,
        fromRotation: this.group.quaternion.clone(),
        rotation,
        fromOffset: this.camera.view?.enabled
          ? { x: this.camera.view.offsetX / this.camera.view.fullWidth, y: this.camera.view.offsetY / this.camera.view.fullHeight }
          : { x: 0, y: 0 },
        velPosition: this._camVel ? this._camVel.clone() : null,
        velTarget: this._targetVel ? this._targetVel.clone() : null,
        velFov: this._fovVel || 0,
      };
    }
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.defaultView = true;
    this.applyViewOffset();
  },

  updateInstanceTransforms(dt = 0) {
    const morphing = this.instanceDirty;
    if (morphing && this.instances.length) {
      const morph = this.morph;
      if (morph) {
        morph.elapsed = Math.min(morph.duration, this.film && Number.isFinite(morph.filmStart)
          ? Math.max(0, this.film.elapsed - morph.filmStart)
          : morph.scrollControlled
            ? clamp(morph.scrollElapsed ?? morph.elapsed, 0, morph.duration)
            : morph.elapsed + dt);
      }
      const done = this.reducedMotion || !morph || (!morph.scrollControlled && morph.elapsed >= morph.duration);
      const vortex = !done && Boolean(morph?.vortex);
      const shellArc = !done && !vortex && Boolean(morph?.shellArc);
      const direction = morph?.vortexDirection || 1;
      const swirlQuat = (vortex || shellArc) ? (this._swirlQuat ||= new THREE.Quaternion()) : null;

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
          } else if (shellArc) {
            // Sweeping meridian shell arc prevents Sphere/Helix morphs from crashing through (0, 0, 0)
            const p0 = instance.fromPosition;
            const p1 = instance.targetPosition;
            const arcEnv = Math.sin(Math.PI * progress);
            const linX = THREE.MathUtils.lerp(p0.x, p1.x, progress);
            const linY = THREE.MathUtils.lerp(p0.y, p1.y, progress);
            const linZ = THREE.MathUtils.lerp(p0.z, p1.z, progress);
            const rXz0 = Math.hypot(p0.x, p0.z);
            const rXz1 = Math.hypot(p1.x, p1.z);
            const shellWeight = clamp(Math.min(rXz0, rXz1) / 1.5, 0, 1);
            const hash = instance.vortexHash || 0;
            const theta0 = Math.atan2(p0.z, p0.x);
            const theta1 = Math.atan2(p1.z, p1.x);
            const dTheta = Math.atan2(Math.sin(theta1 - theta0), Math.cos(theta1 - theta0));
            const swirl = (0.52 + 0.36 * hash) * arcEnv;
            const theta = theta0 + dTheta * progress + swirl;
            const baseXz = THREE.MathUtils.lerp(rXz0, rXz1, progress) + (1.6 + 2.0 * hash) * arcEnv;
            instance.position.set(
              THREE.MathUtils.lerp(linX, Math.cos(theta) * baseXz, shellWeight),
              linY + (hash - 0.5) * 1.8 * arcEnv,
              THREE.MathUtils.lerp(linZ, Math.sin(theta) * baseXz, shellWeight),
            );
            instance.quaternion.slerpQuaternions(instance.fromQuaternion, instance.targetQuaternion, progress);
            const halfYaw = -swirl * 0.28 * shellWeight;
            swirlQuat.set(0, Math.sin(halfYaw), 0, Math.cos(halfYaw));
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
  },
};
