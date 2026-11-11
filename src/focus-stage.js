import * as THREE from 'three';
import { restingViewFractions } from './flight.js';
import { silkFlightEase, computeFacetSculptShade } from './pool.js';
import { createFocusLiquidMaterial } from './shaders.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const GAZE_FOV = 42;
const STAGE_DIST = 8.4;

/**
 * Full-frame borderless 3D FLIP exhibition stage methods mixed onto PhotoUniverse.prototype.
 * Handles background HD texture pre-decoding, camera-space 3D FLIP peel-off,
 * aspect-independent liquid crossfade stepping, and contraction handoff back to facet slots.
 */
export const focusStageMethods = {
  _getBlankFocusTexture() {
    if (!this._blankFocusTexture) {
      const data = new Uint8Array([6, 6, 10, 255]);
      const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this._blankFocusTexture = tex;
    }
    return this._blankFocusTexture;
  },

  _releaseOwnedFocusTexture(tex, keepA = null, keepB = null) {
    if (!tex || !this._focusOwnedTextures?.has(tex)) return;
    if (tex === keepA || tex === keepB) return;
    this._focusOwnedTextures.delete(tex);
    tex.dispose();
  },

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
  },

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
  },

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
  },

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
    const worldMat = (this._focusMat ||= new THREE.Matrix4());
    const pos = (this._focusTmpPos ||= new THREE.Vector3());
    const quat = (this._focusTmpQuat ||= new THREE.Quaternion());
    const scale = (this._focusTmpScale ||= new THREE.Vector3());
    const normal = (this._focusTmpNormal ||= new THREE.Vector3());
    const upVec = (this._focusTmpUp ||= new THREE.Vector3());
    const toCam = (this._focusTmpToCam ||= new THREE.Vector3());
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
  },

  focusPhoto(photoIndex, preferredInstanceIndex = -1, options = {}) {
    if (this.film || !this.instances.length) return false;
    const instanceIndex = this._findBestInstanceForPhoto(photoIndex, preferredInstanceIndex);
    if (instanceIndex < 0) return false;

    this._disposeClosingPlate();
    this.thresholdState = null;
    this.flushDamping();
    if (this.parallaxGroup) {
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
  },

  _mountFocusHeroPlate(photoIndex, inst, cardPos, heroPos, cardQuat, heroQuat, cardScale, heroScale, { stepping = false, flowDir = 1 } = {}) {
    this.focusGeneration = (this.focusGeneration || 0) + 1;
    const generation = this.focusGeneration;
    this._focusOwnedTextures ||= new Set();
    this.focusOverlayScene ||= new THREE.Scene();

    if (!this.focusPlate) {
      const geometry = new THREE.PlaneGeometry(1.08, 0.72, 48, 36);
      const blankTex = this._getBlankFocusTexture();
      const liquidMat = createFocusLiquidMaterial(blankTex);
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

    if (img.complete && img.naturalWidth > 0) {
      applyDecodedTexture();
    } else if (typeof img.decode === 'function') {
      img.decode().then(applyDecodedTexture).catch(() => {});
    } else {
      img.onload = applyDecodedTexture;
    }
  },

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
  },

  _updateFocusStage(time, dt) {
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
        const fTarget = (this.focusPointerTarget ||= new THREE.Vector2());
        const fCurr = (this.focusPointerCurrent ||= new THREE.Vector2());
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
  },
};
