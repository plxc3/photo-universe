import { storyForPhoto } from './narrative-script.js';

/**
 * Full-Frame Exhibition HUD caption choreography & graceful HTML fallback modal
 * for environments where WebGL is unavailable.
 */

function padCount(n) {
  return n < 1000 ? String(n).padStart(4, '0') : n.toLocaleString();
}

function formatAspectTag(photo) {
  if (!photo?.width || !photo?.height) return '';
  const ratio = photo.width / photo.height;
  if (Math.abs(ratio - 1.5) < 0.08) return '3:2';
  if (Math.abs(ratio - 4 / 3) < 0.08) return '4:3';
  if (Math.abs(ratio - 1) < 0.08) return '1:1';
  if (Math.abs(ratio - 0.75) < 0.08) return '3:4';
  if (Math.abs(ratio - 2 / 3) < 0.08) return '2:3';
  return ratio >= 1 ? `${ratio.toFixed(1)}:1` : `1:${(1 / ratio).toFixed(1)}`;
}

export function createFocusUiController({
  $,
  reducedMotion,
  soundscape,
  closeDialogSmooth,
  getState,
  setSelectedPhoto,
  ensureThresholdDismissed,
  setChromeInert,
  syncPlaying,
  noteStageActivity,
  clearIdleTimer,
}) {
  let focusTrigger = null;
  let focusHudHideTimer;
  let focusCaptionSwapTimer;
  let previousPlaying = true;
  let activeStoryNote = '';
  let photoGeneration = 0;
  let photoRequest = null;
  let photoPointer = null;
  let photoFeedbackTimer;
  let photoTransitionTimer;
  const photoPointers = new Set();

  function renderFocusStrip(centerPosition) {
    const strip = $('focus-strip');
    const { photos, validPhotoIndices } = getState();
    if (!strip || !validPhotoIndices.length) return;
    const total = validPhotoIndices.length;
    const span = Math.min(17, total);
    const half = Math.floor(span / 2);
    strip.replaceChildren();
    for (let offset = -half; offset < span - half; offset++) {
      const pos = (centerPosition + offset + total) % total;
      const pIdx = validPhotoIndices[pos];
      const p = photos[pIdx];
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'focus-tick';
      if (p?.accentHex) tick.style.setProperty('--tick-color', p.accentHex);
      const isCurrent = offset === 0;
      if (isCurrent) tick.setAttribute('aria-current', 'true');
      tick.setAttribute('aria-label', '跳转至第 ' + (pos + 1) + ' 张照片');
      tick.title = (p?.title || p?.author || p?.name || '') + ' · #' + (pos + 1);
      tick.addEventListener('click', () => {
        if (!isCurrent) showPhoto(pIdx, -1, offset >= 0 ? 1 : -1);
      });
      strip.append(tick);
    }
  }

  function applyCaptionFields(photo, position, totalCount) {
    const accent = photo.accentHex || '#c8a27c';
    $('focus-hud').style.setProperty('--photo-accent', accent);
    const displayTitle = photo.title || photo.name || '';
    $('focus-title').textContent = displayTitle;
    const authorText = photo.author && photo.author !== displayTitle ? '— ' + photo.author : '';
    if ($('focus-author')) $('focus-author').textContent = authorText;
    const idxPad = String(position + 1).padStart(3, '0');
    $('focus-number').textContent = 'No. ' + idxPad + ' / ' + padCount(totalCount);
    const aspectTag = formatAspectTag(photo);
    const dateTag = photo.capturedDate || (photo.capturedYear ? String(photo.capturedYear) : '');
    const parts = [photo.toneLabel || '暗房 · ARCHIVE', aspectTag, dateTag].filter(Boolean);
    $('focus-tone').textContent = parts.join(' · ');
    const storyEl = $('focus-story');
    if (storyEl) {
      const note = activeStoryNote || storyForPhoto(photo);
      storyEl.textContent = note;
      storyEl.hidden = !note;
    }
  }

  function updateFocusCaption(photo, position, { stepping = false, flowDir = 1 } = {}) {
    const { validPhotoIndices } = getState();
    renderFocusStrip(position);
    const captionEl = $('focus-hud')?.querySelector('.focus-caption');
    clearTimeout(focusCaptionSwapTimer);
    if (stepping && captionEl && !reducedMotion.matches) {
      captionEl.style.setProperty('--step-dir', String(flowDir >= 0 ? 1 : -1));
      captionEl.classList.remove('is-stepping-prep');
      captionEl.classList.add('is-stepping-out');
      focusCaptionSwapTimer = setTimeout(() => {
        applyCaptionFields(photo, position, validPhotoIndices.length);
        captionEl.classList.remove('is-stepping-out');
        captionEl.classList.add('is-stepping-prep');
        void captionEl.offsetWidth;
        captionEl.classList.remove('is-stepping-prep');
      }, 135);
      return;
    }
    captionEl?.classList.remove('is-stepping-out', 'is-stepping-prep');
    applyCaptionFields(photo, position, validPhotoIndices.length);
  }

  function preloadFocusNeighbors(centerPosition) {
    const { universe, validPhotoIndices } = getState();
    if (!universe || !validPhotoIndices.length) return;
    const total = validPhotoIndices.length;
    universe.preloadFocusPhotos([
      validPhotoIndices[(centerPosition + 1) % total],
      validPhotoIndices[(centerPosition - 1 + total) % total],
      validPhotoIndices[(centerPosition + 2) % total],
      validPhotoIndices[(centerPosition - 2 + total) % total],
    ]);
  }

  function showPhoto(index, instanceIndex = -1, flowDir = 1, storyNote = '') {
    const { busy, universe, photos, validPhotoIndices } = getState();
    if (busy || (universe?.film && !universe.film.interactive)) return;
    ensureThresholdDismissed();
    const position = validPhotoIndices.indexOf(index);
    if (position < 0) return;
    activeStoryNote = storyNote || '';
    setSelectedPhoto(position);
    const photo = photos[index];

    if (universe) {
      const wasFocused = Boolean(universe.focusState);
      if ($('gallery-dialog').open) {
        closeDialogSmooth($('gallery-dialog'));
      }
      if (!wasFocused) {
        focusTrigger = document.activeElement;
      }
      if (universe.focusPhoto(index, instanceIndex, { flowDir })) {
        updateFocusCaption(photo, position, { stepping: wasFocused, flowDir });
        preloadFocusNeighbors(position);
        soundscape.playFocusPulse(true);
        return;
      }
    }

    // Fallback HTML modal when WebGL is unavailable.
    const generation = ++photoGeneration;
    clearTimeout(photoFeedbackTimer);
    if (photoRequest) photoRequest.src = '';
    const request = (photoRequest = new Image());
    const hasPhoto = !$('photo-preview').hidden && Boolean($('photo-preview').getAttribute('src'));
    $('photo-stage').setAttribute('aria-busy', 'true');
    $('photo-stage').dataset.state = 'loading';
    $('photo-stage').classList.toggle('has-photo', hasPhoto);
    $('photo-feedback').hidden = hasPhoto;
    if (hasPhoto) {
      photoFeedbackTimer = setTimeout(() => {
        if (generation === photoGeneration && $('photo-dialog').open) $('photo-feedback').hidden = false;
      }, 180);
    }
    $('photo-status').textContent = '正在打开照片';
    if (document.activeElement === $('photo-retry')) $('next-photo').focus({ preventScroll: true });
    $('photo-retry').hidden = true;
    const updateCaption = () => {
      $('photo-title').textContent = (photo.title || photo.name) + (photo.author ? ' — ' + photo.author : '');
      $('photo-number').textContent = (position + 1).toLocaleString() + ' / ' + validPhotoIndices.length.toLocaleString();
    };
    if (!hasPhoto) updateCaption();
    if (!$('photo-dialog').open) {
      previousPlaying = universe?.running ?? false;
      if (universe) universe.running = false;
      $('photo-dialog').showModal();
    }
    request.src = photo.url;
    request.decode().then(() => {
      if (generation !== photoGeneration || !$('photo-dialog').open) return;
      clearTimeout(photoFeedbackTimer);
      clearTimeout(photoTransitionTimer);
      $('photo-stage').querySelector('.photo-outgoing')?.remove();
      const previous = $('photo-preview');
      const interrupted = previous.getAnimations().some((animation) => animation.playState === 'running');
      request.id = 'photo-preview';
      request.alt = photo.title || photo.name;
      request.draggable = false;
      request.className = interrupted ? 'photo-image photo-swap-instant' : 'photo-image';
      previous.removeAttribute('id');
      previous.after(request);
      if (hasPhoto && !interrupted && !reducedMotion.matches) {
        previous.className = 'photo-outgoing';
        previous.setAttribute('aria-hidden', 'true');
        photoTransitionTimer = setTimeout(() => previous.remove(), 260);
      } else {
        previous.remove();
      }
      updateCaption();
      $('photo-feedback').hidden = true;
      $('photo-stage').dataset.state = 'ready';
      $('photo-stage').classList.add('has-photo');
      $('photo-stage').setAttribute('aria-busy', 'false');
      photoRequest = null;
    }).catch(() => {
      if (generation !== photoGeneration || !$('photo-dialog').open) return;
      clearTimeout(photoFeedbackTimer);
      $('photo-stage').dataset.state = 'error';
      $('photo-stage').setAttribute('aria-busy', 'false');
      $('photo-status').textContent = '这张照片暂时无法打开';
      $('photo-feedback').hidden = false;
      $('photo-retry').hidden = false;
      photoRequest = null;
    });
  }

  function nextPhoto(step) {
    const { busy, selectedPhoto, validPhotoIndices } = getState();
    if (!validPhotoIndices.length || busy) return;
    const position = (selectedPhoto + step + validPhotoIndices.length) % validPhotoIndices.length;
    showPhoto(validPhotoIndices[position], -1, step >= 0 ? 1 : -1);
  }

  function handleFocusChange({ active, photoIndex, step }) {
    if (step) {
      nextPhoto(step);
      return;
    }
    const { universe, photos, validPhotoIndices } = getState();
    const hud = $('focus-hud');
    const alreadyFocused = $('app').classList.contains('focus-active');
    if (active && Number.isInteger(photoIndex) && photos[photoIndex]) {
      const pos = validPhotoIndices.indexOf(photoIndex);
      if (pos >= 0) {
        setSelectedPhoto(pos);
        updateFocusCaption(photos[photoIndex], pos, { stepping: alreadyFocused });
      }
    }
    clearTimeout(focusHudHideTimer);
    if (active) {
      hud.hidden = false;
      hud.inert = false;
      requestAnimationFrame(() => {
        if (getState().universe?.focusState) $('app').classList.add('focus-active');
        setChromeInert();
      });
      clearIdleTimer();
      $('app').classList.remove('is-idle');
      if (focusTrigger && focusTrigger !== document.body && focusTrigger !== document.documentElement) {
        $('focus-close').focus({ preventScroll: true });
      }
    } else {
      $('app').classList.remove('focus-active');
      hud.inert = true;
      setChromeInert();
      if (reducedMotion.matches) {
        hud.hidden = true;
      } else {
        focusHudHideTimer = setTimeout(() => {
          if (!getState().universe?.focusState) hud.hidden = true;
        }, 260);
      }
      soundscape.playFocusPulse(false);
      syncPlaying();
      noteStageActivity();
      if (focusTrigger?.isConnected && !$('app').classList.contains('clean')) {
        focusTrigger.focus({ preventScroll: true });
      }
      focusTrigger = null;
    }
  }

  function bindFallbackModalEvents() {
    $('photo-dialog')?.addEventListener('close', () => {
      photoGeneration++;
      clearTimeout(photoFeedbackTimer);
      clearTimeout(photoTransitionTimer);
      $('photo-stage').querySelector('.photo-outgoing')?.remove();
      if (photoRequest) photoRequest.src = '';
      photoRequest = null;
      photoPointer = null;
      photoPointers.clear();
      const { universe } = getState();
      if (universe) universe.running = previousPlaying;
      $('photo-preview').removeAttribute('src');
      $('photo-preview').hidden = true;
      $('photo-stage').classList.remove('has-photo');
      syncPlaying();
      noteStageActivity();
    });

    $('previous-photo')?.addEventListener('click', () => nextPhoto(-1));
    $('next-photo')?.addEventListener('click', () => nextPhoto(1));
    $('focus-prev')?.addEventListener('click', () => nextPhoto(-1));
    $('focus-next')?.addEventListener('click', () => nextPhoto(1));
    $('focus-close')?.addEventListener('click', () => getState().universe?.closeFocus(false));
    $('photo-retry')?.addEventListener('click', () => {
      const { validPhotoIndices, selectedPhoto } = getState();
      showPhoto(validPhotoIndices[selectedPhoto]);
    });

    $('photo-stage')?.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch') return;
      photoPointers.add(event.pointerId);
      photoPointer = photoPointers.size === 1 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    });
    $('photo-stage')?.addEventListener('pointercancel', (event) => {
      photoPointers.delete(event.pointerId);
      photoPointer = null;
    });
    $('photo-stage')?.addEventListener('pointerup', (event) => {
      photoPointers.delete(event.pointerId);
      if (!photoPointer || photoPointer.id !== event.pointerId) return;
      const dx = event.clientX - photoPointer.x;
      const dy = event.clientY - photoPointer.y;
      photoPointer = null;
      if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) nextPhoto(dx < 0 ? 1 : -1);
    });
  }

  function dispose() {
    clearTimeout(focusHudHideTimer);
    clearTimeout(focusCaptionSwapTimer);
    clearTimeout(photoFeedbackTimer);
    clearTimeout(photoTransitionTimer);
  }

  return {
    showPhoto,
    nextPhoto,
    handleFocusChange,
    bindFallbackModalEvents,
    dispose,
  };
}
