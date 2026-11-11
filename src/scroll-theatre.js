import * as THREE from 'three';
import {
  sampleFlight,
  orbitPosition,
  restingViewFractions,
  easeInOut,
  restRotation,
  tunnelTwistAt,
  tunnelConveyorAt,
  stellationBreathAt,
  armillarySpinAt,
  FILM,
} from './flight.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function wrapSignedPi(angle) {
  return THREE.MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI;
}

/**
 * 30-second cinematic film & reversible 5-act scroll-theatre methods mixed onto PhotoUniverse.prototype.
 * Preserves live idle/orbit camera & ring poses on scroll entry (zero frame-0 snap),
 * blends look-around continuously across orbit <-> tunnel boundaries, and supports coasting drag inertia.
 */
export const scrollTheatreMethods = {
  startFilm({ fromCurrentScroll = false, interactive = false } = {}) {
    if (this.film) return;
    if (this.focusState) this.closeFocus(true);
    this.thresholdState = null;
    const allowInteract = Boolean(interactive && !this.exportResolution);
    if (
      fromCurrentScroll
      && this.scrollTimeline
      && this.scrollTimeline.currentTime > 0.15
      && this.scrollTimeline.currentTime < FILM.total - 1.0
    ) {
      const st = this.scrollTimeline;
      const startAt = st.currentTime;
      this.scrollTimeline = null;
      this.dragging = false;
      this.clearHover();
      this.activePointers?.clear();
      this.tapGesture = null;
      this.heldViewOffset = null;
      this.viewTransition = null;
      this.controls.enabled = false;
      this.pointerTarget?.set(0, 0);
      this.film = {
        start: performance.now() - startAt * 1000,
        phase: this.mode === 'tunnel' ? 'tunnel' : 'orbit',
        elapsed: startAt,
        interactive: allowInteract,
        startPose: st.startPose,
        startRingAngles: st.startRingAngles,
        startOffset: st.startOffset,
        lookYaw: st.lookYaw || 0,
        lookPitch: st.lookPitch || 0,
        targetYaw: st.targetYaw || 0,
        targetPitch: st.targetPitch || 0,
        yawVel: st.yawVel || 0,
        pitchVel: st.pitchVel || 0,
        lastUpdateTime: null,
        focusPaused: false,
      };
      if (this.morph?.scrollControlled) {
        this.morph.scrollControlled = false;
        this.morph.filmStart = startAt < FILM.reassemble ? FILM.phase1 : FILM.reassemble;
      }
      if (this.photoUniforms) this.photoUniforms.uReveal.value = 1;
      this.reveal = null;
      if (this.renderer?.domElement?.style) {
        this.renderer.domElement.style.cursor = allowInteract ? 'grab' : 'default';
      }
      this.callbacks.onFilmProgress?.(startAt);
      return;
    }
    if (this.scrollTimeline) this.exitScrollTimeline(false);
    this.flushDamping();
    if (this.parallaxGroup) {
      this.group.quaternion.premultiply(this.parallaxGroup.quaternion);
      this.parallaxGroup.quaternion.identity();
      this.pointerCurrent.set(0, 0);
    }
    const view = this.camera.view;
    const rotation = [this.group.rotation.x, this.group.rotation.y, this.group.rotation.z].map(wrapSignedPi);
    const startPose = {
      position: this.camera.position.toArray(),
      target: this.controls.target.toArray(),
      up: this.camera.up.toArray(),
      fov: this.camera.fov,
      rotation,
    };
    const startRingAngles = (this.ringAngles || [0, 0, 0, 0]).map(wrapSignedPi);
    this.film = {
      start: performance.now(),
      phase: 'orbit',
      elapsed: 0,
      interactive: allowInteract,
      startPose,
      startRingAngles,
      startOffset: {
        x: view?.enabled ? view.offsetX / view.fullWidth : 0,
        y: view?.enabled ? view.offsetY / view.fullHeight : 0,
      },
      lookYaw: 0,
      lookPitch: 0,
      targetYaw: 0,
      targetPitch: 0,
      yawVel: 0,
      pitchVel: 0,
      lastUpdateTime: null,
      focusPaused: false,
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
  },

  stopFilm(notify = true, reset = false) {
    const active = Boolean(this.film);
    if (!active) {
      if (reset) this.resetView(false);
      return;
    }
    if (this.focusState) this.closeFocus(true, notify);
    const natural = this.film.natural === true;
    const view = this.camera.view;
    const offset = {
      x: view?.enabled ? view.offsetX / view.fullWidth : 0,
      y: view?.enabled ? view.offsetY / view.fullHeight : 0,
    };
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
      this.heldViewOffset = offset;
      this.defaultView = false;
      if (reset) this.resetView(false);
    }
    if (notify) this.callbacks.onFilmEnd?.();
  },

  seekFilmLive(seconds, { paused = false } = {}) {
    if (this.focusState) this.closeFocus(true);
    const target = clamp(Number(seconds) || 0, 0, FILM.total - 0.001);
    if (!this.film) this.startFilm({ interactive: !this.exportResolution });
    const now = performance.now();
    this.film.start = now - target * 1000;
    this.film.elapsed = target;
    this.film.scrubPaused = Boolean(paused);
    this.film.focusPaused = false;
    this.film.lastUpdateTime = null;
    this.film.manual = false;

    const sample = sampleFlight(target, this.camera.aspect, this.film.startPose);
    this.camera.position.fromArray(sample.position);
    this.camera.up.fromArray(sample.up);
    this.camera.fov = sample.fov;
    this.controls.target.fromArray(sample.target);
    this.group.rotation.set(sample.rotation[0], sample.rotation[1], sample.rotation[2]);
    this._applyTheatreLookOffset(this.film, target, 0, false);
    this.camera.lookAt(this.controls.target);

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
  },

  enableScrollTheatre(enabled = true) {
    this.scrollTheatreEnabled = Boolean(enabled);
    if (this.controls) {
      this.controls.enableZoom = !this.scrollTheatreEnabled;
    }
  },

  exitScrollTimeline(reset = false) {
    if (!this.scrollTimeline) {
      if (reset) this.resetView(false);
      return;
    }
    this.bakeTunnelPose(true);
    this.scrollTimeline = null;
    this.dragging = false;
    this.controls.enabled = !this.film && !this.focusState;
    if (this.controls) this.controls.enableZoom = !this.scrollTheatreEnabled;
    this.flushDamping();
    this.alignIdlePhase();
    if (reset) this.resetView(false);
  },

  setScrollTimeline(seconds, { immediate = false } = {}) {
    if (this.focusState) this.closeFocus(true);
    if (this.thresholdState && !this.thresholdState.unlocking) {
      this.thresholdState.unlocking = true;
      this.thresholdState.elapsed = 0;
    }
    let handedStartPose = null;
    let handedRingAngles = null;
    let handedOffset = null;
    let handedLook = null;
    if (this.film) {
      const filmTime = this.film.elapsed || 0;
      handedStartPose = this.film.startPose;
      handedRingAngles = this.film.startRingAngles;
      handedOffset = this.film.startOffset;
      handedLook = {
        lookYaw: this.film.lookYaw || 0,
        lookPitch: this.film.lookPitch || 0,
        targetYaw: this.film.targetYaw || 0,
        targetPitch: this.film.targetPitch || 0,
        yawVel: this.film.yawVel || 0,
        pitchVel: this.film.pitchVel || 0,
      };
      this.stopFilm(false, false);
      if (seconds === undefined) seconds = filmTime;
    }
    const clamped = clamp(Number(seconds) || 0, 0, FILM.total - 0.02);
    if (!this.scrollTimeline) {
      const entryMode = this.mode;
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
      const view = this.camera.view;
      const captureLive = !immediate && !handedStartPose && entryMode === 'orbit';
      const liveRotation = [this.group.rotation.x, this.group.rotation.y, this.group.rotation.z].map(wrapSignedPi);
      const startPose = handedStartPose || (captureLive
        ? {
            position: this.camera.position.toArray(),
            target: this.controls.target.toArray(),
            up: this.camera.up.toArray(),
            fov: this.camera.fov,
            rotation: liveRotation,
          }
        : {
            position: orbitPosition(aspect),
            target: [0, 0, 0],
            up: [0, 1, 0],
            fov: 54,
            rotation: restRotation(aspect),
          });
      const startRingAngles = handedRingAngles || (captureLive
        ? (this.ringAngles || [0, 0, 0, 0]).map(wrapSignedPi)
        : [0, 0, 0, 0]);
      const startOffset = handedOffset || (view?.enabled
        ? { x: view.offsetX / view.fullWidth, y: view.offsetY / view.fullHeight }
        : restingViewFractions(aspect));
      const initialTime = immediate || this.reducedMotion ? clamped : 0;

      this.scrollTimeline = {
        currentTime: initialTime,
        targetTime: clamped,
        timeVel: 0,
        startPose,
        startRingAngles,
        startOffset,
        entryMode,
        lookYaw: handedLook ? handedLook.lookYaw : 0,
        lookPitch: handedLook ? handedLook.lookPitch : 0,
        targetYaw: handedLook ? handedLook.targetYaw : 0,
        targetPitch: handedLook ? handedLook.targetPitch : 0,
        yawVel: handedLook ? handedLook.yawVel : 0,
        pitchVel: handedLook ? handedLook.pitchVel : 0,
        region: null,
        resting: false,
      };
      this._applyScrollTimelinePose(initialTime, 0, !immediate);
      return clamped;
    }

    const deltaSec = clamped - this.scrollTimeline.targetTime;
    // Gently center wide orbit look-around when scrolling into the tunnel corridor
    if (!immediate && Math.abs(deltaSec) > 1e-4 && clamped > 4.2 && clamped < 24.4) {
      const centerDecay = Math.exp(-Math.abs(deltaSec) * 0.45);
      this.scrollTimeline.targetYaw = clamp(this.scrollTimeline.targetYaw * centerDecay, -0.95, 0.95);
      this.scrollTimeline.targetPitch *= Math.exp(-Math.abs(deltaSec) * 0.28);
    }

    this.scrollTimeline.targetTime = clamped;
    this.scrollTimeline.resting = false;
    if (immediate || this.reducedMotion) {
      this.scrollTimeline.currentTime = clamped;
      this.scrollTimeline.timeVel = 0;
      this._applyScrollTimelinePose(clamped, 0, false);
    }
    return clamped;
  },

  scrollByTimeline(deltaSeconds) {
    const base = this.scrollTimeline
      ? this.scrollTimeline.targetTime
      : this.film
        ? (this.film.elapsed || 0)
        : 0;
    return this.setScrollTimeline(base + (Number(deltaSeconds) || 0));
  },

  _applyScrollTimelinePose(t, dt = 0, gentleEntry = false) {
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
      const firstEntry = st.region === null;
      st.region = region;
      if (region === 'orbit-intro' || region === 'orbit-finale') {
        const smoothFromAltShape = firstEntry && gentleEntry && (st.entryMode === 'sphere' || st.entryMode === 'helix');
        this.setFormation('orbit', !smoothFromAltShape, false, smoothFromAltShape ? 1.15 : null);
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

    this._applyTheatreLookOffset(st, target, dt, false);

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
  },

  updateScrollTimeline(dt) {
    const st = this.scrollTimeline;
    if (!st || this.focusState || st.resting) return;
    if (this.reducedMotion) {
      st.currentTime = st.targetTime;
      st.timeVel = 0;
    } else {
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
    this._applyScrollTimelinePose(st.currentTime, dt, false);
    const yawDiff = Math.abs(st.targetYaw - st.lookYaw);
    const pitchDiff = Math.abs(st.targetPitch - st.lookPitch);
    const lookVelSettled = Math.abs(st.yawVel || 0) < 1e-3 && Math.abs(st.pitchVel || 0) < 1e-3;
    if (timeDiff < 1e-4 && velSettled && lookVelSettled && yawDiff < 1e-4 && pitchDiff < 1e-4) {
      st.lookYaw = st.targetYaw;
      st.lookPitch = st.targetPitch;
      st.resting = true;
    }
  },

  _applyTheatreLookOffset(state, target, dt = 0, autoRecenter = false) {
    if (!state) return;
    const hasActivity = Math.abs(state.lookYaw || 0) > 1e-5
      || Math.abs(state.lookPitch || 0) > 1e-5
      || Math.abs(state.targetYaw || 0) > 1e-5
      || Math.abs(state.targetPitch || 0) > 1e-5
      || Math.abs(state.yawVel || 0) > 1e-5
      || Math.abs(state.pitchVel || 0) > 1e-5;
    if (!hasActivity) return;

    if (dt > 0 && !this.reducedMotion && !this.dragging) {
      const inCorridor = target >= 4.8 && target <= 23.6;
      if (Math.abs(state.yawVel || 0) > 1e-4 || Math.abs(state.pitchVel || 0) > 1e-4) {
        state.targetYaw += (state.yawVel || 0) * dt;
        if (inCorridor) state.targetYaw = clamp(state.targetYaw, -1.05, 1.05);
        state.targetPitch = clamp(state.targetPitch + (state.pitchVel || 0) * dt, -0.52, 0.52);
        const dragDecay = Math.exp(-dt * 7.5);
        state.yawVel *= dragDecay;
        state.pitchVel *= dragDecay;
        if (Math.abs(state.yawVel) < 1e-3) state.yawVel = 0;
        if (Math.abs(state.pitchVel) < 1e-3) state.pitchVel = 0;
      }
      if (autoRecenter && Math.abs(state.yawVel || 0) < 0.08 && Math.abs(state.pitchVel || 0) < 0.08) {
        const settleRate = target >= FILM.total - 1.8 ? 4.2 : 0.55;
        state.targetPitch *= Math.exp(-dt * settleRate);
        if (target > 4.2 && target < 24.4) {
          state.targetYaw *= Math.exp(-dt * 0.48);
        } else if (target >= FILM.total - 1.8) {
          state.targetYaw *= Math.exp(-dt * 4.2);
        }
        if (Math.abs(state.targetPitch) < 1e-4) state.targetPitch = 0;
        if (Math.abs(state.targetYaw) < 1e-4) state.targetYaw = 0;
      }
    }

    const blend = dt > 0 && !this.reducedMotion ? 1 - Math.exp(-dt * 12) : 1;
    state.lookYaw = THREE.MathUtils.lerp(state.lookYaw || 0, state.targetYaw || 0, blend);
    state.lookPitch = THREE.MathUtils.lerp(state.lookPitch || 0, state.targetPitch || 0, blend);

    // Smoothly blend look-around between crystal orbit rotation and corridor camera pan
    // so crossing t = 5.5s or t = 22.7s never jumps the viewport.
    if (Math.abs(state.lookYaw) > 1e-5 || Math.abs(state.lookPitch) > 1e-5) {
      const enterTunnel = easeInOut(clamp((target - 4.6) / 1.8, 0, 1));
      const exitTunnel = easeInOut(clamp((target - 22.0) / 1.8, 0, 1));
      const tunnelWeight = enterTunnel * (1 - exitTunnel);
      const orbitWeight = 1 - tunnelWeight;

      if (orbitWeight > 1e-4) {
        const orbitLook = (this._scrollOrbitLookQuat ||= new THREE.Quaternion()).setFromEuler(
          (this._scrollLookEuler ||= new THREE.Euler()).set(
            state.lookPitch * orbitWeight,
            state.lookYaw * orbitWeight,
            0,
            'YXZ',
          ),
        );
        this.group.quaternion.premultiply(orbitLook);
      }
      if (tunnelWeight > 1e-4) {
        const tunnelYaw = clamp(state.lookYaw, -1.05, 1.05) * tunnelWeight;
        const tunnelPitch = state.lookPitch * tunnelWeight;
        const tunnelLook = (this._scrollLookQuat ||= new THREE.Quaternion()).setFromEuler(
          (this._scrollTunnelEuler ||= new THREE.Euler()).set(tunnelPitch, tunnelYaw, 0, 'YXZ'),
        );
        const dir = (this._scrollLookDir ||= new THREE.Vector3())
          .subVectors(this.controls.target, this.camera.position)
          .applyQuaternion(tunnelLook);
        this.controls.target.copy(this.camera.position).add(dir);
      }
    }
  },

  updateFilm(time) {
    if (this.film.scrubPaused || this.film.focusPaused) {
      this.film.start = time - (this.film.elapsed || 0) * 1000;
      this.film.lastUpdateTime = time;
      return;
    }
    const prevTime = this.film.lastUpdateTime;
    const dt = prevTime !== null && prevTime !== undefined && Number.isFinite(time - prevTime)
      ? clamp((time - prevTime) / 1000, 0, 0.05)
      : 0;
    this.film.lastUpdateTime = time;
    const elapsed = clamp((time - this.film.start) / 1000, 0, FILM.total);
    this.film.elapsed = elapsed;
    const s = sampleFlight(elapsed, this.camera.aspect, this.film.startPose);
    this.camera.position.fromArray(s.position);
    this.camera.up.fromArray(s.up);
    this.camera.fov = s.fov;
    this.controls.target.fromArray(s.target);
    this.group.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
    this._applyTheatreLookOffset(this.film, elapsed, dt, true);
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.applyViewOffset();
    if (this.film.phase !== s.mode) {
      this.film.phase = s.mode;
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
    if (elapsed >= FILM.total) {
      this.film.natural = true;
      this.stopFilm(true, false);
    }
  },

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
  },
};
