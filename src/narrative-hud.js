import {
  NARRATIVE_ACTS,
  actForSeconds,
  cipherScramble,
} from './narrative-script.js';

const WHISPER_DECODE_MS = 440;
const WHISPER_HOLD_MS = 3100;

/**
 * Active Theory v6 Minimalist Narrative Console Controller:
 * - Single-line ephemeral cipher-scramble whisper (`#narrative-banner`)
 * - Bottom-center obsidian glass capsule (`#at-console`) with 5 micro-segment portals
 * - Tactile Hold-to-Warp (`#warp-hold` / `Space`) propulsion
 * - Live Web Audio spectrum equalizer modulation
 */
export function createNarrativeHudController({
  $,
  getState,
  ensureThresholdDismissed,
  wakeAudio,
  showScrollChrome,
  soundscape,
  reducedMotion,
  hasOpenDialog,
}) {
  const bannerEl = /** @type {HTMLElement | null} */ ($('narrative-banner'));
  const bannerCodeEl = /** @type {HTMLElement | null} */ ($('banner-code'));
  const bannerVerseEl = /** @type {HTMLElement | null} */ ($('banner-verse'));
  const warpBtn = /** @type {HTMLButtonElement | null} */ ($('warp-hold'));
  const eqBars = /** @type {HTMLElement[]} */ (
    Array.from(document.querySelectorAll('#sound-toggle .sound-eq i'))
  );

  let activeActIndex = -1;
  let bannerAnimStart = 0;
  let bannerTargetAct = NARRATIVE_ACTS[0];
  let bannerVisible = false;
  let bannerHoldTimer = 0;
  let pointerWarpHeld = false;
  let spaceWarpHeld = false;

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
    const numStr = String(clampedIdx + 1).padStart(2, '0');
    if (bannerCodeEl) bannerCodeEl.textContent = `${numStr} //`;
    if (reducedMotion.matches && bannerVerseEl) {
      bannerVerseEl.textContent = act.verse;
    }
    window.clearTimeout(bannerHoldTimer);
    bannerHoldTimer = window.setTimeout(() => {
      bannerVisible = false;
      bannerEl.classList.remove('is-visible');
    }, WHISPER_HOLD_MS);
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

    const interactiveSelectors = '[data-act-seek], [data-mode], #warp-hold, #film-quick, #collection, #import-quick, #brand, #threshold-enter';
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

    if (bannerVisible && bannerEl && bannerVerseEl && !reducedMotion.matches) {
      const progress = Math.min(1, (nowMs - bannerAnimStart) / WHISPER_DECODE_MS);
      bannerVerseEl.textContent = cipherScramble(bannerTargetAct.verse, progress);
    }

    const audioEnergy = soundscape?.getEnergy ? soundscape.getEnergy(nowMs * 0.001) : null;
    universe.audioEnergy = audioEnergy?.level || 0;
    if (eqBars.length && audioEnergy?.active && !soundscape.muted) {
      const t = nowMs * 0.006;
      const weights = [
        0.32 + audioEnergy.bass * 0.88 + Math.sin(t) * 0.08,
        0.40 + audioEnergy.level * 0.96 + Math.cos(t * 1.3) * 0.1,
        0.34 + audioEnergy.high * 0.92 + Math.sin(t * 1.7 + 1) * 0.09,
        0.26 + (audioEnergy.bass + audioEnergy.high) * 0.54 + Math.cos(t * 0.9 + 2) * 0.08,
      ];
      for (let i = 0; i < eqBars.length; i++) {
        const s = Math.max(0.22, Math.min(1.34, weights[i % weights.length]));
        eqBars[i].style.transform = `scaleY(${s.toFixed(2)})`;
      }
    }
  }

  function dispose() {
    window.clearTimeout(bannerHoldTimer);
    window.removeEventListener('blur', releaseAllWarp);
  }

  return {
    bindEvents,
    rebuildBeacons() {},
    revealAct,
    setSpaceWarp,
    releaseAllWarp,
    updateFrame,
    dispose,
  };
}
