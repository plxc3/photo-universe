/**
 * Trackpad-aware wheel gesture gate & Active Theory multi-state reactive cursor reticle.
 */

/**
 * Filters continuous MacBook trackpad momentum tails so a single two-finger flick
 * steps exactly 1 photograph in Focus Exhibition mode, while direction flips,
 * physical mouse wheel notches, or deliberate re-flicks respond without delay.
 */
export function createWheelStepGate() {
  let lastStepAt = -Infinity;
  let lastEventAt = -Infinity;
  let lastAbsPx = 0;
  let lastSign = 0;
  let lockedTail = false;

  return function evaluateWheelStep(rawPx, now, deltaMode = 0) {
    if (!Number.isFinite(rawPx) || Math.abs(rawPx) < 0.6) return 0;
    const sign = rawPx > 0 ? 1 : -1;
    const absPx = Math.abs(rawPx);
    const gap = now - lastEventAt;

    if (
      deltaMode === 1 ||
      deltaMode === 2 ||
      gap > 110 ||
      sign !== lastSign ||
      absPx < 5 ||
      (absPx > lastAbsPx * 1.32 && absPx >= 18 && now - lastStepAt > 150) ||
      now - lastStepAt > 680
    ) {
      lockedTail = false;
    }

    lastEventAt = now;
    lastAbsPx = absPx;
    lastSign = sign;

    if (!lockedTail && absPx >= 12 && now - lastStepAt > 160) {
      lastStepAt = now;
      lockedTail = deltaMode === 0;
      return sign;
    }
    return 0;
  };
}

/**
 * Desktop fine-pointer Active Theory multi-state optical reticle:
 * Dynamically transitions between `explore`, `photo`, `beacon`, `drag`, `warp`, and `ui`
 * with velocity-coupled ring dynamics and zero-jump initial placement.
 */
export function createReticleController({ reticleEl, numberEl, labelEl, finePointerQuery, reducedMotion }) {
  let targetX = -100;
  let targetY = -100;
  let currentX = -100;
  let currentY = -100;
  let active = false;
  let lastFrameTime = null;
  let hoveredPhoto = false;
  let hoveredBeacon = null;
  let overInteractiveUi = false;

  const syncModeState = (universe) => {
    if (!reticleEl) return;
    if (universe?.warpDriveActive || (universe?._warpIntensity || 0) > 0.08) {
      reticleEl.dataset.state = 'warp';
      reticleEl.style.setProperty('--reticle-accent', '#8ab4ff');
      reticleEl.style.setProperty('--warp-progress', (universe?._warpIntensity || 0).toFixed(3));
      if (numberEl) numberEl.textContent = 'WARP';
      if (labelEl) labelEl.textContent = '';
      return;
    }
    reticleEl.style.setProperty('--warp-progress', '0');
    if (universe?.dragging) {
      reticleEl.dataset.state = 'drag';
      reticleEl.style.setProperty('--reticle-accent', '#9ab4ff');
      if (numberEl) numberEl.textContent = '';
      if (labelEl) labelEl.textContent = '';
      return;
    }
    if (hoveredBeacon) {
      reticleEl.dataset.state = 'beacon';
      reticleEl.style.setProperty('--reticle-accent', hoveredBeacon.accent || '#e2c799');
      if (numberEl) numberEl.textContent = hoveredBeacon.code;
      if (labelEl) labelEl.textContent = hoveredBeacon.title + ' · 点击凝视';
      return;
    }
    if (hoveredPhoto) {
      reticleEl.dataset.state = 'photo';
      return;
    }
    if (overInteractiveUi) {
      reticleEl.dataset.state = 'ui';
      return;
    }
    delete reticleEl.dataset.state;
  };

  if (finePointerQuery?.matches && !reducedMotion?.matches && typeof window !== 'undefined') {
    window.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch') return;
      targetX = event.clientX;
      targetY = event.clientY;
      if (!active) {
        currentX = targetX;
        currentY = targetY;
        active = true;
        lastFrameTime = null;
        if (reticleEl) {
          reticleEl.style.transform = `translate3d(${currentX.toFixed(1)}px, ${currentY.toFixed(1)}px, 0)`;
          reticleEl.classList.add('visible');
        }
      }
      overInteractiveUi = event.target instanceof Element
        && Boolean(event.target.closest('button:not(.spatial-beacon), a, input, dialog, .timeline-scrub-zone'));
    }, { passive: true });

    document.addEventListener('pointerleave', () => {
      active = false;
      lastFrameTime = null;
      reticleEl?.classList.remove('visible');
    });
  }

  return {
    updateFrame(time, universe = null) {
      if (!active || !reticleEl) return;
      const dt = lastFrameTime !== null && Number.isFinite(time)
        ? Math.min(0.05, Math.max(0.001, (time - lastFrameTime) / 1000))
        : 1 / 60;
      lastFrameTime = Number.isFinite(time) ? time : null;
      const alpha = 1 - Math.exp(-dt * 24);
      const dx = targetX - currentX;
      const dy = targetY - currentY;
      currentX += dx * alpha;
      currentY += dy * alpha;
      const speed = Math.min(1, Math.hypot(dx, dy) / 64);
      reticleEl.style.transform = `translate3d(${currentX.toFixed(1)}px, ${currentY.toFixed(1)}px, 0)`;
      reticleEl.style.setProperty('--reticle-vel', speed.toFixed(3));
      if (currentX > window.innerWidth - 250) reticleEl.dataset.flip = 'left';
      else delete reticleEl.dataset.flip;
      syncModeState(universe);
    },

    setBeaconHover(beacon = null) {
      hoveredBeacon = beacon;
    },

    updateHoverState({ active: hovered, photoIndex }, photos, validPhotoIndices) {
      if (!reticleEl) return;
      if (hovered && photos[photoIndex]) {
        hoveredPhoto = true;
        const photo = photos[photoIndex];
        reticleEl.dataset.state = 'photo';
        reticleEl.style.setProperty('--reticle-accent', photo.accentHex || '#c8a27c');
        const pos = validPhotoIndices.indexOf(photoIndex);
        if (numberEl) {
          numberEl.textContent = pos >= 0 ? String(pos + 1).padStart(3, '0') + ' //' : '';
        }
        if (labelEl) {
          labelEl.textContent = photo.title || photo.author || photo.name;
        }
      } else {
        hoveredPhoto = false;
        if (reticleEl.dataset.state === 'photo') delete reticleEl.dataset.state;
      }
    },
  };
}
