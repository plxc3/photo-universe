/**
 * Trackpad-aware wheel gesture gate & dt-damped optical viewfinder reticle.
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
 * Desktop fine-pointer optical viewfinder reticle with instant entry positioning
 * (no corner fly-in) and frame-rate-independent exponential smoothing.
 */
export function createReticleController({ reticleEl, numberEl, labelEl, finePointerQuery, reducedMotion }) {
  let targetX = -100;
  let targetY = -100;
  let currentX = -100;
  let currentY = -100;
  let active = false;
  let lastFrameTime = null;

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
      const overInteractive = Boolean(event.target?.closest?.('button, a, input, dialog, .timeline-scrub-zone'));
      if (overInteractive && reticleEl?.dataset.state !== 'photo') {
        reticleEl.dataset.state = 'ui';
      } else if (!overInteractive && reticleEl?.dataset.state === 'ui') {
        delete reticleEl.dataset.state;
      }
    }, { passive: true });

    document.addEventListener('pointerleave', () => {
      active = false;
      lastFrameTime = null;
      reticleEl?.classList.remove('visible');
    });
  }

  return {
    updateFrame(time) {
      if (!active || !reticleEl) return;
      const dt = lastFrameTime !== null && Number.isFinite(time)
        ? Math.min(0.05, Math.max(0.001, (time - lastFrameTime) / 1000))
        : 1 / 60;
      lastFrameTime = Number.isFinite(time) ? time : null;
      const alpha = 1 - Math.exp(-dt * 22);
      currentX += (targetX - currentX) * alpha;
      currentY += (targetY - currentY) * alpha;
      reticleEl.style.transform = `translate3d(${currentX.toFixed(1)}px, ${currentY.toFixed(1)}px, 0)`;
      if (currentX > window.innerWidth - 240) reticleEl.dataset.flip = 'left';
      else delete reticleEl.dataset.flip;
    },

    updateHoverState({ active: hovered, photoIndex }, photos, validPhotoIndices) {
      if (!reticleEl) return;
      if (hovered && photos[photoIndex]) {
        const photo = photos[photoIndex];
        reticleEl.dataset.state = 'photo';
        reticleEl.style.setProperty('--reticle-accent', photo.accentHex || '#c8a27c');
        const pos = validPhotoIndices.indexOf(photoIndex);
        if (numberEl) {
          numberEl.textContent = pos >= 0 ? 'No. ' + String(pos + 1).padStart(3, '0') : '';
        }
        if (labelEl) {
          const baseName = photo.title || photo.author || photo.name;
          labelEl.textContent = photo.capturedYear ? baseName + ' · ' + photo.capturedYear : baseName;
        }
      } else if (reticleEl.dataset.state === 'photo') {
        delete reticleEl.dataset.state;
      }
    },
  };
}
