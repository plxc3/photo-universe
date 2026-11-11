import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Pointer gesture tracking, 360° scroll-theatre drag inertia, raycast card picking,
 * and instant-entry hover wave synchronization mixed onto PhotoUniverse.prototype.
 */
export const pointerPickingMethods = {
  beginPointer(event) {
    if (this.film) return;
    const pointers = (this.activePointers ||= new Map());
    pointers.set(event.pointerId, [event.clientX, event.clientY]);
    if (this.scrollTimeline && pointers.size === 1) {
      this.scrollTimeline.yawVel = 0;
      this.scrollTimeline.pitchVel = 0;
      this.scrollTimeline._lastDragAt = Number.isFinite(event.timeStamp) ? event.timeStamp : null;
    }
    if (pointers.size === 1 && event.isPrimary !== false && (event.pointerType === 'touch' || event.button === 0)) {
      this.tapGesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        maxDistance: 0,
        blocked: false,
      };
    } else if (this.tapGesture) {
      this.tapGesture.blocked = true;
    }
  },

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
    const tap = this.tapGesture;
    if (tap?.pointerId === event.pointerId) {
      tap.maxDistance = Math.max(tap.maxDistance, Math.hypot(event.clientX - tap.x, event.clientY - tap.y));
    }
    if (pointers.size === 1 && !this.focusState && this.scrollTimeline && moved > 0.5) {
      const st = this.scrollTimeline;
      const inCorridor = st.currentTime >= 4.8 && st.currentTime <= 23.6;
      const dYaw = dx * 0.0035;
      const dPitch = dy * 0.0026;
      st.targetYaw = inCorridor ? clamp(st.targetYaw + dYaw, -1.05, 1.05) : st.targetYaw + dYaw;
      st.targetPitch = clamp(st.targetPitch + dPitch, -0.52, 0.52);
      if (Number.isFinite(event.timeStamp) && st._lastDragAt !== null && st._lastDragAt !== undefined) {
        const dtMs = event.timeStamp - st._lastDragAt;
        if (dtMs >= 4 && dtMs <= 80) {
          const dtSec = dtMs / 1000;
          st.yawVel = THREE.MathUtils.lerp(st.yawVel || 0, clamp(dYaw / dtSec, -4.5, 4.5), 0.45);
          st.pitchVel = THREE.MathUtils.lerp(st.pitchVel || 0, clamp(dPitch / dtSec, -3.2, 3.2), 0.45);
        }
      }
      if (Number.isFinite(event.timeStamp)) st._lastDragAt = event.timeStamp;
      st.resting = false;
      if ((tap?.maxDistance || 0) > 6 || moved > 4) {
        this.dragging = true;
        if (this.renderer?.domElement?.style) this.renderer.domElement.style.cursor = 'grabbing';
      }
    }
    if (!this.focusState && ((tap?.maxDistance > 6) || (pointers.size > 1 && moved > 0.5))) {
      this.claimManualView();
    }
  },

  endPointer(event, cancelled = false) {
    const pointers = this.activePointers;
    if (!pointers?.has(event.pointerId)) return false;
    const tap = this.tapGesture;
    const dx = tap?.pointerId === event.pointerId ? event.clientX - tap.x : 0;
    const dy = tap?.pointerId === event.pointerId ? event.clientY - tap.y : 0;
    if (tap?.pointerId === event.pointerId) {
      tap.maxDistance = Math.max(tap.maxDistance, Math.hypot(dx, dy));
    }
    const picked = !cancelled && !this.film && pointers.size === 1 && tap?.pointerId === event.pointerId && !tap.blocked && tap.maxDistance <= 6;
    const swipedInFocus = !cancelled && !this.film && Boolean(this.focusState) && pointers.size === 1 && tap?.pointerId === event.pointerId && Math.abs(dx) >= 44 && Math.abs(dx) > Math.abs(dy) * 1.4;
    pointers.delete(event.pointerId);
    if (cancelled && tap) tap.blocked = true;
    if (!pointers.size) {
      this.tapGesture = null;
      if (this.scrollTimeline && this.dragging) {
        this.dragging = false;
        if (this.renderer?.domElement?.style) {
          this.renderer.domElement.style.cursor = this.film || this.focusState ? 'default' : 'grab';
        }
      }
    }
    if (swipedInFocus) {
      this.callbacks.onFocusChange?.({ active: true, step: dx < 0 ? 1 : -1 });
      return true;
    }
    if (picked) this.pickPhoto(event.clientX, event.clientY);
    return picked;
  },

  pickPhoto(clientX, clientY) {
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.hoverNdc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
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
  },

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
  },

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
    this.hoverNdc.set(
      ((this.hoverPointer[0] - rect.left) / rect.width) * 2 - 1,
      -((this.hoverPointer[1] - rect.top) / rect.height) * 2 + 1,
    );
    this.scene.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    if (this.boundsDirty) {
      for (const mesh of this.meshes) mesh.computeBoundingSphere();
      this.boundsDirty = false;
    }
    this.raycaster.setFromCamera(this.hoverNdc, this.camera);
    const hit = this.raycaster.intersectObjects(this.meshes, false)[0];
    if (hit?.instanceId !== undefined) {
      const wasActive = Boolean(this.hoverActive);
      this.renderer.domElement.style.cursor = 'pointer';
      this.hoverActive = true;
      this.hoverTargetWorld ||= new THREE.Vector3();
      this.hoverTargetWorld.copy(hit.point);
      const uniforms = this.photoUniforms;
      // Sync uHoverWorld immediately on fresh hover entry or cross-sculpture jumps
      // so the wave never drags in from (0, 0, 9999) across unrelated foreground cards.
      if (
        uniforms?.uHoverWorld?.value &&
        (!wasActive || (uniforms.uHoverStrength?.value ?? 0) < 0.08 || uniforms.uHoverWorld.value.distanceTo(hit.point) > 24)
      ) {
        uniforms.uHoverWorld.value.copy(hit.point);
      }
      const photoIndex = hit.object.userData?.photoIndices?.[hit.instanceId];
      const key = `${hit.object.uuid}:${hit.instanceId}`;
      if (key !== this.hoveredInstanceKey) {
        this.hoveredInstanceKey = key;
        this._hoveredPhotoIndex = photoIndex ?? -1;
        if (photoIndex !== undefined) {
          this.callbacks?.onHoverPhoto?.(photoIndex);
          this.callbacks?.onHoverStateChange?.({
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
  },
};
