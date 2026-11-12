import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * 5-Act Active Theory Interactive Storytelling Script —《记忆的引力场 · Gravity of Memory》
 */
export const NARRATIVE_ACTS = [
  {
    index: 0,
    id: 'prologue',
    roman: 'I',
    code: 'ACT 01 // ORBITAL HALO',
    shortLabel: '序幕',
    stageLabel: '序幕 · 星环',
    title: '微尘星环',
    verse: '每一张快门，都是从时间洪流里截获的一粒光子。',
    directive: '滚轮推进叙事 · 按住跃迁穿梭 · 点选信标唤醒记忆',
    startSec: 0,
    endSec: 3.6,
    seekSec: 0,
    accent: '#e2c799',
  },
  {
    index: 1,
    id: 'implosion',
    roman: 'II',
    code: 'ACT 02 // GRAVITATIONAL VORTEX',
    shortLabel: '坍缩',
    stageLabel: '坍缩 · 漩涡',
    title: '引力坍缩',
    verse: '当三千次凝视彼此牵引，散落的瞬间开始向记忆深处旋转坍缩。',
    directive: '穿越色温风暴 · 按住鼠标或手指环视偏航',
    startSec: 3.6,
    endSec: 7.8,
    seekSec: 5.8,
    accent: '#d9a577',
  },
  {
    index: 2,
    id: 'corridor',
    roman: 'III',
    code: 'ACT 03 // ECHO CORRIDOR',
    shortLabel: '回廊',
    stageLabel: '走廊 · 螺旋',
    title: '回声长廊',
    verse: '穿过琥珀、苍翠与钴蓝的年轮，我们在光的隧道里与旧日重逢。',
    directive: '掠过底片聆听泛音 · 点击任意画面驻留凝视',
    startSec: 7.8,
    endSec: 21.8,
    seekSec: 13.5,
    accent: '#82b8d9',
  },
  {
    index: 3,
    id: 'reassembly',
    roman: 'IV',
    code: 'ACT 04 // SILVER REASSEMBLY',
    shortLabel: '显影',
    stageLabel: '重组 · 门廊',
    title: '暗房显影',
    verse: '冲出时间窄门，所有悲欢重新归位，凝结成不会褪色的立体银盐。',
    directive: '冲破门廊 · 见证三千帧记忆重新聚拢',
    startSec: 21.8,
    endSec: 25.4,
    seekSec: 22.8,
    accent: '#c4b1e0',
  },
  {
    index: 4,
    id: 'lattice',
    roman: 'V',
    code: 'ACT 05 // ETERNAL LATTICE',
    shortLabel: '晶格',
    stageLabel: '终章 · 晶格',
    title: '永恒晶格',
    verse: '遗忘不是终点；只要再次凝视，整座宇宙便为你重新显影。',
    directive: '自由环绕整座馆藏 · 导入属于你的私人底片',
    startSec: 25.4,
    endSec: 30.0,
    seekSec: 27.2,
    accent: '#e6d3b3',
  },
];

const BEACON_ARCHETYPES = [
  {
    code: 'NODE 01',
    title: '初见 · ORIGIN',
    story: '第一束琥珀色暖光落入暗房，开启时间星环的第一道刻度。',
    targetHue: 0.06,
    accent: '#e8b878',
  },
  {
    code: 'NODE 02',
    title: '生长 · BREATH',
    story: '林间与盛夏的苍翠切片，记录着生命向外舒展的呼吸频率。',
    targetHue: 0.22,
    accent: '#86cfa3',
  },
  {
    code: 'NODE 03',
    title: '远行 · HORIZON',
    story: '海平线与远方风声交汇之处，每一次出发都在拓宽记忆的边界。',
    targetHue: 0.38,
    accent: '#7cc7dc',
  },
  {
    code: 'NODE 04',
    title: '夜航 · NOCTURNE',
    story: '暮色沉入钴蓝深空，那些未曾说出口的心事在静谧里静静发光。',
    targetHue: 0.58,
    accent: '#8ca6eb',
  },
  {
    code: 'NODE 05',
    title: '余温 · EMBER',
    story: '在银盐与微红余烬之间，最珍贵的面孔跨越岁月依然滚烫。',
    targetHue: 0.88,
    accent: '#e0939b',
  },
];

const SCRAMBLE_GLYPHS = '01/+*#<>:=÷×·░▒';

/**
 * Returns the active narrative Act descriptor (`0..4`) for timeline `seconds`.
 */
export function actForSeconds(seconds) {
  const s = clamp(Number(seconds) || 0, 0, 30);
  for (let i = 0; i < NARRATIVE_ACTS.length - 1; i++) {
    if (s < NARRATIVE_ACTS[i].endSec) return NARRATIVE_ACTS[i];
  }
  return NARRATIVE_ACTS[NARRATIVE_ACTS.length - 1];
}

/**
 * Deterministic Active Theory cipher-scramble text decoder (`progress` in `[0..1]`).
 */
export function cipherScramble(targetText, progress) {
  const str = String(targetText || '');
  const p = clamp(Number(progress) || 0, 0, 1);
  if (p >= 0.999 || !str.length) return str;
  const chars = Array.from(str);
  const resolvedCount = Math.floor(chars.length * Math.pow(p, 0.82));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '·' || ch === '/' || i < resolvedCount) {
      out += ch;
    } else if (i < resolvedCount + 4) {
      const seed = (i * 17 + Math.floor(p * 37)) % SCRAMBLE_GLYPHS.length;
      out += SCRAMBLE_GLYPHS[seed];
    } else {
      out += ' ';
    }
  }
  return out.trimEnd();
}

/**
 * Selects 5 real 3D photograph instances spanning the chromatic spectrum and spatial rings
 * to serve as live-tracked 3D Spatial Memory Beacons.
 */
export function buildMemoryBeacons(universe) {
  const instances = universe?.instances || [];
  const photos = universe?.photos || [];
  if (!instances.length || !photos.length) return [];

  const usedPhotos = new Set();
  const usedInstances = new Set();

  return BEACON_ARCHETYPES.map((arch, slotIdx) => {
    // Pick best matching photo by spectralKey
    let bestPhotoIdx = -1;
    let bestPhotoScore = Infinity;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (!p || usedPhotos.has(i)) continue;
      const key = Number.isFinite(p.spectralKey) ? p.spectralKey : slotIdx / 5;
      const hueDist = Math.abs((key > 1 ? 0.92 : key) - arch.targetHue);
      if (hueDist < bestPhotoScore) {
        bestPhotoScore = hueDist;
        bestPhotoIdx = i;
      }
    }
    if (bestPhotoIdx < 0) bestPhotoIdx = slotIdx % photos.length;
    usedPhotos.add(bestPhotoIdx);

    // Pick a well-spaced outer/mid instance displaying bestPhotoIdx (or fallback stride)
    let chosenInstIdx = -1;
    let bestInstScore = -Infinity;
    const strideStart = Math.floor((slotIdx / BEACON_ARCHETYPES.length) * instances.length);
    for (let step = 0; step < instances.length; step++) {
      const idx = (strideStart + step) % instances.length;
      if (usedInstances.has(idx)) continue;
      const inst = instances[idx];
      if (!inst?.mesh) continue;
      const pIdx = inst.mesh.userData?.photoIndices?.[inst.localIndex];
      const matchesPhoto = pIdx === bestPhotoIdx ? 10 : 0;
      const radial = Math.hypot(inst.targetPosition.x, inst.targetPosition.y);
      const score = matchesPhoto + clamp(radial / 28, 0, 1.4) - (step / instances.length) * 0.25;
      if (score > bestInstScore) {
        bestInstScore = score;
        chosenInstIdx = idx;
        if (matchesPhoto > 0 && radial > 10) break;
      }
    }
    if (chosenInstIdx < 0) chosenInstIdx = Math.min(instances.length - 1, slotIdx);
    usedInstances.add(chosenInstIdx);

    const actualInst = instances[chosenInstIdx];
    const actualPhotoIdx = actualInst?.mesh?.userData?.photoIndices?.[actualInst.localIndex] ?? bestPhotoIdx;
    const photoMeta = photos[actualPhotoIdx] || {};

    return {
      index: slotIdx,
      code: arch.code,
      title: arch.title,
      story: arch.story,
      accent: photoMeta.accentHex || arch.accent,
      photoIndex: actualPhotoIdx,
      instanceIndex: chosenInstIdx,
      year: photoMeta.capturedYear || null,
    };
  });
}

const _projMat = new THREE.Matrix4();
const _worldMat = new THREE.Matrix4();
const _worldPos = new THREE.Vector3();
const _ndcPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _toBeacon = new THREE.Vector3();

/**
 * Projects live 3D world coordinates of each Memory Beacon onto 2D screen space (`px`)
 * with frustum, behind-camera, and distance-occlusion visibility weights (`0..1`).
 */
export function projectMemoryBeacons(universe, beacons, width, height) {
  if (!universe?.camera || !beacons?.length || width <= 0 || height <= 0) return [];
  universe.camera.updateMatrixWorld();
  universe.camera.getWorldDirection(_camDir);
  const camPos = universe.camera.position;

  return beacons.map((beacon) => {
    const inst = universe.instances?.[beacon.instanceIndex];
    if (!inst?.mesh) return { ...beacon, x: -999, y: -999, visibility: 0, distance: 999 };

    inst.mesh.updateWorldMatrix(true, false);
    inst.mesh.getMatrixAt(inst.localIndex, _projMat);
    _worldMat.multiplyMatrices(inst.mesh.matrixWorld, _projMat);
    _worldPos.setFromMatrixPosition(_worldMat);

    const forwardDepth = _toBeacon.subVectors(_worldPos, camPos).dot(_camDir);
    const dist = camPos.distanceTo(_worldPos);
    if (forwardDepth <= 2.0) {
      return { ...beacon, x: -999, y: -999, visibility: 0, distance: dist };
    }

    _ndcPos.copy(_worldPos).project(universe.camera);

    // Cull outside comfortable viewport frame (WebGL NDC z lies in [-1, 1])
    if (_ndcPos.z < -1 || _ndcPos.z > 1 || Math.abs(_ndcPos.x) > 0.90 || Math.abs(_ndcPos.y) > 0.84) {
      return { ...beacon, x: -999, y: -999, visibility: 0, distance: dist };
    }

    const edgeFadeX = clamp((0.90 - Math.abs(_ndcPos.x)) / 0.16, 0, 1);
    const edgeFadeY = clamp((0.84 - Math.abs(_ndcPos.y)) / 0.16, 0, 1);
    const nearFade = clamp((dist - 5.5) / 7.5, 0, 1);
    const farFade = 1 - clamp((dist - 108) / 56, 0, 1);
    const visibility = edgeFadeX * edgeFadeY * nearFade * farFade;

    const x = (_ndcPos.x * 0.5 + 0.5) * width;
    const y = (-_ndcPos.y * 0.5 + 0.5) * height;

    return {
      ...beacon,
      x,
      y,
      distance: dist,
      visibility,
    };
  });
}

/**
 * Active Theory Hold-to-Warp ("引力跃迁"), Spatial Portal Jump, and Screen-Space Fluid
 * velocity field methods mixed onto `PhotoUniverse.prototype`.
 */
export const narrativeStageMethods = {
  setWarpDrive(active) {
    const next = Boolean(active && !this.exportResolution && !this.focusState);
    if (this.warpDriveActive === next) return next;
    this.warpDriveActive = next;
    if (next && !this.film && !this.scrollTimeline && this.instances?.length) {
      if (this.thresholdState && !this.thresholdState.unlocking) {
        this.unlockThreshold();
      }
      this.scrollByTimeline(0.01);
    }
    return next;
  },

  portalToAct(targetSeconds) {
    if (this.exportResolution) return false;
    if (this.focusState) this.closeFocus(true);
    if (this.thresholdState && !this.thresholdState.unlocking) {
      this.unlockThreshold();
    }
    this._portalPulse = Math.max(this._portalPulse || 0, 0.92);
    const sec = clamp(Number(targetSeconds) || 0, 0, 29.65);
    if (this.film) {
      this.seekFilmLive(sec, { paused: false });
    } else {
      this.setScrollTimeline(sec, { immediate: false });
    }
    return true;
  },

  _recordFluidPointer(nx, ny) {
    const uvX = nx * 0.5 + 0.5;
    const uvY = 0.5 - ny * 0.5;
    const prev = (this._fluidUv ||= new THREE.Vector2(uvX, uvY));
    const vel = (this._fluidVel ||= new THREE.Vector2(0, 0));
    const dx = clamp(uvX - prev.x, -0.18, 0.18);
    const dy = clamp(uvY - prev.y, -0.18, 0.18);
    prev.set(uvX, uvY);
    vel.lerp(this._fluidTmpVel?.set(dx * 16, dy * 16) || (this._fluidTmpVel = new THREE.Vector2(dx * 16, dy * 16)), 0.55);
    const speed = Math.hypot(dx, dy);
    this._fluidEnergy = clamp((this._fluidEnergy || 0) + speed * 9.5, 0, 1.0);
  },

  _stepNarrativeField(dt) {
    const targetWarp = this.warpDriveActive && !this.focusState && !this.exportResolution ? 1 : 0;
    const rate = targetWarp > (this._warpIntensity || 0) ? 5.8 : 4.6;
    this._warpIntensity = this.reducedMotion
      ? targetWarp
      : THREE.MathUtils.lerp(this._warpIntensity || 0, targetWarp, 1 - Math.exp(-dt * rate));
    if (this._warpIntensity < 1e-3 && !targetWarp) this._warpIntensity = 0;

    if (this._portalPulse > 0) {
      this._portalPulse = this.reducedMotion ? 0 : this._portalPulse * Math.exp(-dt * 3.4);
      if (this._portalPulse < 1e-3) this._portalPulse = 0;
    }

    if (this._fluidEnergy > 0) {
      this._fluidEnergy = this.reducedMotion ? 0 : this._fluidEnergy * Math.exp(-dt * 4.2);
      if (this._fluidEnergy < 1e-3) this._fluidEnergy = 0;
    }
    if (this._fluidVel) {
      this._fluidVel.multiplyScalar(Math.exp(-dt * 8.0));
    }

    // Advance timeline smoothly while Hold-to-Warp is engaged
    if (this._warpIntensity > 0.01 && !this.focusState && !this.exportResolution && dt > 0) {
      if (this.film && this.film.interactive && !this.film.manual) {
        // Accelerate guided voyage smoothly by shifting start timestamp back
        this.film.start -= dt * 1350 * this._warpIntensity;
      } else if (this.scrollTimeline) {
        const nextTarget = this.scrollTimeline.targetTime + dt * 3.1 * this._warpIntensity;
        if (nextTarget >= 29.62) {
          this.setScrollTimeline(0.05, { immediate: true });
          this._portalPulse = 0.85;
        } else {
          this.setScrollTimeline(nextTarget, { immediate: false });
        }
      }
    }
  },
};
