import {
  NARRATIVE_ACTS,
  actForSeconds,
  cipherScramble,
  buildMemoryBeacons,
  projectMemoryBeacons,
} from './narrative-script.js';

const BANNER_DECODE_MS = 520;
const BANNER_HOLD_MS = 4400;
const MODE_CODES = {
  orbit: 'ORBIT',
  tunnel: 'TUNNEL',
  sphere: 'SPHERE',
  helix: 'HELIX',
};

/**
 * Active Theory Diegetic Narrative HUD Controller:
 * - Kinetic cipher-scramble Chapter Story Banner (`#narrative-banner`)
 * - Real-time 3D-to-Screen Spatial Memory Beacons (`#beacon-layer`)
 * - Hold-to-Warp ("引力跃迁") pointer + keyboard propulsion (`#warp-hold` / `Space`)
 * - Live optical camera telemetry (`#hud-telemetry`) & audio-reactive spectrum bars
 */
export function createNarrativeHudController({
  $,
  getState,
  ensureThresholdDismissed,
  wakeAudio,
  showScrollChrome,
  onSelectBeacon,
  reticle,
  soundscape,
  reducedMotion,
  hasOpenDialog,
}) {
  const bannerEl = /** @type {HTMLElement | null} */ ($('narrative-banner'));
  const bannerCodeEl = /** @type {HTMLElement | null} */ ($('banner-code'));
  const bannerTitleEl = /** @type {HTMLElement | null} */ ($('banner-title'));
  const bannerVerseEl = /** @type {HTMLElement | null} */ ($('banner-verse'));
  const bannerDirectiveEl = /** @type {HTMLElement | null} */ ($('banner-directive'));
  const beaconLayerEl = /** @type {HTMLElement | null} */ ($('beacon-layer'));
  const warpBtn = /** @type {HTMLButtonElement | null} */ ($('warp-hold'));
  const telemetryEl = /** @type {HTMLElement | null} */ ($('hud-telemetry'));
  const eqBars = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll('#sound-toggle .sound-eq i'))
  );

  /** @type {ReturnType<typeof buildMemoryBeacons>} */
  let beacons = [];
  /** @type {HTMLButtonElement[]} */
  let beaconEls = [];
  let activeActIndex = -1;
  let bannerAnimStart = 0;
  let bannerTargetAct = NARRATIVE_ACTS[0];
  let bannerVisible = false;
  let bannerHoldTimer = 0;
  let pointerWarpHeld = false;
  let spaceWarpHeld = false;
  let lastTelemetryUpdate = 0;

  function syncWarpState() {
    const { universe, busy } = getState();
    const shouldEngage = Boolean((pointerWarpHeld || spaceWarpHeld) && universe && !busy && !universe.focusState);
    if (shouldEngage) {
      ensureThresholdDismissed();
      wakeAudio();
      if (!universe.film) showScrollChrome(true);
    }
    const wasActive = Boolean(universe?.warpDriveActive);
    const nowActive = Boolean(universe?.setWarpDrive?.(shouldEngage));
    $('app')?.classList.toggle('warp-active', nowActive);
    if (warpBtn) warpBtn.setAttribute('aria-pressed', String(nowActive));
    if (nowActive !== wasActive) {
      soundscape?.playPortalWarp?.(nowActive);
    }
  }

  function releaseAllWarp() {
    if (!pointerWarpHeld && !spaceWarpHeld && !getState().universe?.warpDriveActive) return;
    pointerWarpHeld = false;
    spaceWarpHeld = false;
    syncWarpState();
  }

  function revealAct(actIndex, { force = false } = {}) {
    const clampedIdx = Math.max(0, Math.min(NARRATIVE_ACTS.length - 1, Number(actIndex) || 0));
    if (!force && clampedIdx === activeActIndex) return;
    activeActIndex = clampedIdx;
    const act = NARRATIVE_ACTS[clampedIdx];
    bannerTargetAct = act;
    if (!bannerEl) return;

    bannerEl.style.setProperty('--act-accent', act.accent);
    bannerAnimStart = performance.now();
    bannerVisible = true;
    bannerEl.classList.add('is-visible');
    if (reducedMotion.matches) {
      if (bannerCodeEl) bannerCodeEl.textContent = act.code;
      if (bannerTitleEl) bannerTitleEl.textContent = act.title;
      if (bannerVerseEl) bannerVerseEl.textContent = act.verse;
      if (bannerDirectiveEl) bannerDirectiveEl.textContent = act.directive;
    }
    window.clearTimeout(bannerHoldTimer);
    bannerHoldTimer = window.setTimeout(() => {
      bannerVisible = false;
      bannerEl.classList.remove('is-visible');
    }, BANNER_HOLD_MS);
  }

  function rebuildBeacons() {
    const { universe } = getState();
    reticle?.setBeaconHover?.(null);
    if (!beaconLayerEl || !universe) {
      beacons = [];
      beaconEls = [];
      beaconLayerEl?.replaceChildren();
      return;
    }
    beacons = buildMemoryBeacons(universe);
    beaconLayerEl.replaceChildren();
    beaconEls = beacons.map((beacon) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'spatial-beacon';
      btn.style.setProperty('--beacon-accent', beacon.accent);
      btn.setAttribute('aria-label', `信标 ${beacon.title}，点击穿梭查看记忆`);
      btn.hidden = true;

      const diamond = document.createElement('span');
      diamond.className = 'beacon-diamond';
      diamond.setAttribute('aria-hidden', 'true');

      const meta = document.createElement('span');
      meta.className = 'beacon-meta';

      const code = document.createElement('span');
      code.className = 'beacon-code';
      code.textContent = beacon.year ? `${beacon.code} · ${beacon.year}` : beacon.code;

      const name = document.createElement('span');
      name.className = 'beacon-title';
      name.textContent = beacon.title;

      meta.append(code, name);
      btn.append(diamond, meta);

      btn.addEventListener('pointerenter', () => {
        soundscape?.playUiTick?.();
        reticle?.setBeaconHover?.(beacon);
        getState().universe?.preloadFocusPhotos?.([beacon.photoIndex]);
      });
      btn.addEventListener('pointerleave', () => {
        reticle?.setBeaconHover?.(null);
      });
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        reticle?.setBeaconHover?.(null);
        soundscape?.playPortalWarp?.(true);
        onSelectBeacon?.(beacon);
      });

      beaconLayerEl.append(btn);
      return btn;
    });
  }

  function bindEvents() {
    if (warpBtn) {
      warpBtn.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        event.preventDefault();
        pointerWarpHeld = true;
        warpBtn.setPointerCapture?.(event.pointerId);
        syncWarpState();
      });
      const endPointerWarp = () => {
        if (!pointerWarpHeld) return;
        pointerWarpHeld = false;
        syncWarpState();
      };
      warpBtn.addEventListener('pointerup', endPointerWarp);
      warpBtn.addEventListener('pointercancel', endPointerWarp);
      warpBtn.addEventListener('lostpointercapture', endPointerWarp);
    }

    window.addEventListener('blur', releaseAllWarp);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) releaseAllWarp();
    });

    // Attach crisp synthesized Active Theory UI micro-ticks across interactive stage portals,
    // and release pointer focus after mouse clicks so Spacebar Hold-to-Warp works immediately.
    const interactiveSelectors = '[data-act-seek], [data-mode], #warp-hold, #film-quick, #collection, #import-quick, #brand';
    document.querySelectorAll(interactiveSelectors).forEach((el) => {
      el.addEventListener('pointerenter', () => {
        soundscape?.playUiTick?.();
      });
      el.addEventListener('click', (event) => {
        if (event instanceof MouseEvent && event.detail > 0 && el instanceof HTMLElement && el.closest('#stage-hud')) {
          el.blur();
        }
      });
    });
  }

  function setSpaceWarp(active) {
    const next = Boolean(active);
    if (spaceWarpHeld === next) return;
    spaceWarpHeld = next;
    syncWarpState();
  }

  function updateFrame(nowMs) {
    const { universe, busy } = getState();
    const appEl = $('app');
    if (!universe || !appEl) return;

    if ((pointerWarpHeld || spaceWarpHeld) && (busy || universe.focusState || hasOpenDialog())) {
      releaseAllWarp();
    }

    // 1. Track timeline Act transitions & drive cipher-scramble typography decode
    const stageUnlocked = !appEl.classList.contains('threshold-locked') && !busy;
    if (stageUnlocked && (universe.film || universe.scrollTimeline)) {
      const timelineSec = universe.film
        ? (universe.film.elapsed || 0)
        : (universe.scrollTimeline?.currentTime ?? 0);
      const currentAct = actForSeconds(timelineSec);
      if (currentAct.index !== activeActIndex) {
        revealAct(currentAct.index);
      }
    }

    if (bannerVisible && bannerEl && !reducedMotion.matches) {
      const progress = Math.min(1, (nowMs - bannerAnimStart) / BANNER_DECODE_MS);
      if (bannerCodeEl) bannerCodeEl.textContent = cipherScramble(bannerTargetAct.code, Math.min(1, progress * 1.25));
      if (bannerTitleEl) bannerTitleEl.textContent = cipherScramble(bannerTargetAct.title, Math.min(1, progress * 1.15));
      if (bannerVerseEl) bannerVerseEl.textContent = cipherScramble(bannerTargetAct.verse, progress);
      if (bannerDirectiveEl) {
        bannerDirectiveEl.textContent = progress > 0.35
          ? cipherScramble(bannerTargetAct.directive, (progress - 0.35) / 0.65)
          : '';
      }
    }

    // 2. Project 3D Spatial Memory Beacons onto 2D viewport with anti-overlap culling
    const hideBeacons =
      !stageUnlocked ||
      universe.mode === 'tunnel' ||
      Boolean(universe.focusState) ||
      appEl.classList.contains('focus-active') ||
      appEl.classList.contains('clean') ||
      appEl.classList.contains('recording-active') ||
      hasOpenDialog();

    if (beaconEls.length) {
      if (hideBeacons) {
        for (let i = 0; i < beaconEls.length; i++) {
          if (!beaconEls[i].hidden) beaconEls[i].hidden = true;
        }
      } else {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 720;
        const projected = projectMemoryBeacons(universe, beacons, vw, vh);
        const maxVisible = vw < 700 ? 2 : 4;
        const minSepSq = vw < 700 ? 120 * 120 : 138 * 138;
        // Sort candidate indices by visibility descending so cleanest beacons win spacing
        const order = projected
          .map((p, idx) => ({ idx, vis: p.visibility }))
          .sort((a, b) => b.vis - a.vis);
        /** @type {Array<{x: number, y: number}>} */
        const placed = [];
        const accepted = new Set();
        const topSafe = vw < 1120 ? 128 : 88;
        const botSafe = vw < 1120 ? vh - 128 : vh - 108;
        for (const { idx, vis } of order) {
          if (vis < 0.12 || accepted.size >= maxVisible) continue;
          const cand = projected[idx];
          // Keep clear of top/bottom HUD bands
          if (cand.y < topSafe || cand.y > botSafe) continue;
          let collides = false;
          for (let j = 0; j < placed.length; j++) {
            const dx = cand.x - placed[j].x;
            const dy = cand.y - placed[j].y;
            if (dx * dx + dy * dy < minSepSq) {
              collides = true;
              break;
            }
          }
          if (!collides) {
            placed.push({ x: cand.x, y: cand.y });
            accepted.add(idx);
          }
        }

        const warpDim = 1 - Math.min(0.72, (universe._warpIntensity || 0) * 0.72);
        for (let i = 0; i < beaconEls.length; i++) {
          const el = beaconEls[i];
          const p = projected[i];
          if (!p || !accepted.has(i)) {
            if (!el.hidden) el.hidden = true;
            continue;
          }
          if (el.hidden) el.hidden = false;
          const flipLeft = p.x > vw - 152;
          el.dataset.side = flipLeft ? 'left' : 'right';
          const finalAlpha = Math.max(0, Math.min(1, p.visibility * warpDim));
          el.style.transform = flipLeft
            ? `translate3d(calc(${p.x.toFixed(1)}px - 100% + 22px), ${p.y.toFixed(1)}px, 0)`
            : `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
          el.style.opacity = finalAlpha.toFixed(3);
          el.style.pointerEvents = universe.dragging || finalAlpha < 0.22 ? 'none' : 'auto';
        }
      }
    }

    // 3. Modulate Audio-Reactive Spectrum Bars & Live Optical Camera Telemetry
    const audioEnergy = soundscape?.getEnergy ? soundscape.getEnergy(nowMs * 0.001) : null;
    universe.audioEnergy = audioEnergy?.level || 0;
    if (eqBars.length && audioEnergy?.active && !soundscape.muted) {
      const t = nowMs * 0.006;
      const weights = [
        0.34 + audioEnergy.bass * 0.85 + Math.sin(t) * 0.08,
        0.42 + audioEnergy.level * 0.95 + Math.cos(t * 1.3) * 0.1,
        0.36 + audioEnergy.high * 0.9 + Math.sin(t * 1.7 + 1) * 0.09,
        0.28 + (audioEnergy.bass + audioEnergy.high) * 0.52 + Math.cos(t * 0.9 + 2) * 0.08,
      ];
      for (let i = 0; i < eqBars.length; i++) {
        const s = Math.max(0.22, Math.min(1.32, weights[i % weights.length]));
        eqBars[i].style.transform = `scaleY(${s.toFixed(2)})`;
      }
    }

    if (telemetryEl && nowMs - lastTelemetryUpdate > 95) {
      lastTelemetryUpdate = nowMs;
      const modeCode = MODE_CODES[universe.mode] || 'ORBIT';
      const camZ = universe.camera?.position?.length?.() ?? 0;
      const fov = universe.camera?.fov ?? 54;
      const warpTag = universe._warpIntensity > 0.15 ? ' · WARP' : '';
      telemetryEl.textContent = `${modeCode} // R ${camZ.toFixed(1)} · ${Math.round(fov)}°${warpTag}`;
    }
  }

  function dispose() {
    window.clearTimeout(bannerHoldTimer);
    window.removeEventListener('blur', releaseAllWarp);
  }

  return {
    bindEvents,
    rebuildBeacons,
    revealAct,
    setSpaceWarp,
    releaseAllWarp,
    updateFrame,
    dispose,
  };
}
