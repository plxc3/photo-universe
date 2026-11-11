/**
 * Darkroom Contact-Sheet Index (#gallery-dialog), smooth dialog curtain transitions,
 * descending EXIF year chapter tabs, staggered print reveal, and AlbumVault UI sync.
 */

const PAGE_SIZE = 40;

function padCount(n) {
  return n < 1000 ? String(n).padStart(4, '0') : n.toLocaleString();
}

export function createDialogMotion(reducedMotion) {
  const closeTimers = new WeakMap();

  function closeDialogSmooth(dialog, { instant = false } = {}) {
    if (!dialog?.open) return;
    const existing = closeTimers.get(dialog);
    if (instant || reducedMotion.matches) {
      if (existing) {
        clearTimeout(existing);
        closeTimers.delete(dialog);
      }
      delete dialog.dataset.closing;
      dialog.close();
      return;
    }
    if (dialog.dataset.closing === 'true') return;
    dialog.dataset.closing = 'true';
    const timer = setTimeout(() => {
      closeTimers.delete(dialog);
      delete dialog.dataset.closing;
      if (dialog.open) dialog.close();
    }, 220);
    closeTimers.set(dialog, timer);
  }

  function cancelDialogClosing(dialog) {
    if (!dialog) return;
    const existing = closeTimers.get(dialog);
    if (existing) {
      clearTimeout(existing);
      closeTimers.delete(dialog);
    }
    delete dialog.dataset.closing;
  }

  return { closeDialogSmooth, cancelDialogClosing };
}

export function createGalleryController({
  $,
  getState,
  onSelectPhoto,
  onBeforeOpen,
  getPhotoThumbnail,
  albumVault,
}) {
  let activeChapterKey = 'all';
  let galleryPage = 0;
  let galleryPlaying = true;
  let galleryGeneration = 0;
  let galleryAbort = null;
  const galleryUrls = new Set();

  function clearGalleryThumbnails() {
    galleryGeneration++;
    galleryAbort?.abort();
    galleryAbort = null;
    for (const url of galleryUrls) URL.revokeObjectURL(url);
    galleryUrls.clear();
    $('gallery-grid')?.replaceChildren();
  }

  function filteredGalleryIndices() {
    const { validPhotoIndices, yearChapters } = getState();
    if (activeChapterKey === 'all') return validPhotoIndices;
    const chapter = yearChapters.find((ch) => ch.key === activeChapterKey);
    return chapter ? chapter.photoIndices : validPhotoIndices;
  }

  function renderGalleryChapters() {
    const bar = $('gallery-chapters');
    if (!bar) return;
    const { validPhotoIndices, yearChapters } = getState();
    bar.replaceChildren();
    if (!yearChapters.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const createTab = (key, text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.setAttribute('aria-pressed', String(activeChapterKey === key));
      btn.addEventListener('click', () => {
        if (activeChapterKey === key) return;
        activeChapterKey = key;
        galleryPage = 0;
        renderGalleryChapters();
        renderGallery();
      });
      return btn;
    };
    bar.append(createTab('all', '全部 · ' + validPhotoIndices.length));
    for (const ch of yearChapters) {
      bar.append(createTab(ch.key, ch.label + ' · ' + ch.count));
    }
  }

  async function syncVaultUI() {
    const supported = albumVault.isSupported();
    const enabled = albumVault.enabled;
    const checkbox = $('gallery-remember');
    if (checkbox) {
      checkbox.checked = enabled;
      checkbox.disabled = !supported;
    }
    const statusEl = $('vault-status');
    const clearBtn = $('clear-vault');
    if (!supported) {
      if (statusEl) statusEl.textContent = '本机记忆：当前浏览器不支持';
      if (clearBtn) clearBtn.hidden = true;
      return;
    }
    const { count, totalBytes } = await albumVault.getStats();
    if (statusEl) {
      if (enabled && count > 0) {
        const mb = (totalBytes / (1024 * 1024)).toFixed(1);
        statusEl.textContent = '本机已记忆 ' + count.toLocaleString() + ' 张 · ' + mb + ' MB';
      } else if (enabled) {
        statusEl.textContent = '本机记忆：已开启（纯本地存储）';
      } else {
        statusEl.textContent = '本机记忆：默认关闭';
      }
    }
    if (clearBtn) clearBtn.hidden = count === 0;
  }

  function renderGallery() {
    clearGalleryThumbnails();
    galleryAbort = new AbortController();
    const generation = galleryGeneration;
    const grid = $('gallery-grid');
    const { photos } = getState();
    const list = filteredGalleryIndices();
    const start = galleryPage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, list.length);

    for (let position = start; position < end; position++) {
      const slotOffset = position - start;
      const index = list[position];
      const photo = photos[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.style.setProperty('--card-stagger', `${Math.min(slotOffset, 19) * 16}ms`);
      const yearSuffix = photo.capturedYear ? '（' + photo.capturedYear + '）' : '';
      const titleLabel = photo.title || photo.author || photo.name;
      button.setAttribute('aria-label', '查看照片 ' + (position + 1) + '，' + titleLabel + yearSuffix);

      const well = document.createElement('span');
      well.className = 'contact-well';
      const img = document.createElement('img');
      const markLoaded = () => img.classList.add('is-loaded');
      img.addEventListener('load', markLoaded, { once: true });
      if (photo.source === 'demo') {
        img.src = photo.thumbnailUrl || photo.url;
        if (img.complete) markLoaded();
      }
      img.alt = photo.title || photo.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      well.append(img);

      const meta = document.createElement('span');
      meta.className = 'contact-meta';
      const idxSpan = document.createElement('span');
      idxSpan.className = 'contact-idx';
      idxSpan.textContent = String(position + 1).padStart(3, '0');
      const labelSpan = document.createElement('span');
      labelSpan.className = 'contact-label';
      const shortAuthor = photo.author || photo.name;
      labelSpan.textContent = photo.capturedYear ? photo.capturedYear + ' · ' + shortAuthor : shortAuthor;
      meta.append(idxSpan, labelSpan);

      button.append(well, meta);
      button.addEventListener('click', () => onSelectPhoto(index));
      grid.append(button);

      if (photo.source !== 'demo') {
        const applyThumbnail = ({ url, owned }, quality = false) => {
          if (generation !== galleryGeneration || !button.isConnected || (!quality && img.dataset.quality === 'ready')) {
            if (owned) URL.revokeObjectURL(url);
            return;
          }
          if (owned) galleryUrls.add(url);
          if (quality) img.dataset.quality = 'ready';
          img.src = url;
          if (img.complete) markLoaded();
        };
        getPhotoThumbnail(photo).then(applyThumbnail).catch(() => {});
        getPhotoThumbnail(photo, 360, { quality: true, signal: galleryAbort.signal })
          .then((thumbnail) => applyThumbnail(thumbnail, true))
          .catch(() => {});
      }
    }

    $('gallery-range').textContent = list.length
      ? String(start + 1).padStart(3, '0') + '–' + String(end).padStart(3, '0') + ' / ' + padCount(list.length)
      : '0';
    $('gallery-previous').disabled = start === 0;
    $('gallery-next').disabled = end >= list.length;
    $('gallery-dialog').scrollTo?.({ top: 0, behavior: 'instant' });
    $('gallery-dialog').scrollTop = 0;
  }

  function openGallery() {
    const { busy, validPhotoIndices, selectedPhoto, universe } = getState();
    if (busy || !validPhotoIndices.length) return;
    onBeforeOpen?.();
    activeChapterKey = 'all';
    galleryPage = Math.floor(selectedPhoto / PAGE_SIZE);
    renderGalleryChapters();
    renderGallery();
    syncVaultUI();
    const dialog = $('gallery-dialog');
    if (!dialog.open) {
      galleryPlaying = universe?.running ?? false;
      if (universe) universe.running = false;
      dialog.showModal();
    }
  }

  function stepPage(delta) {
    galleryPage = Math.max(0, galleryPage + delta);
    renderGallery();
  }

  function resetChapter() {
    activeChapterKey = 'all';
  }

  function abortPending() {
    galleryAbort?.abort();
  }

  return {
    clearGalleryThumbnails,
    renderGalleryChapters,
    renderGallery,
    syncVaultUI,
    openGallery,
    stepPage,
    resetChapter,
    abortPending,
    get wasPlaying() {
      return galleryPlaying;
    },
  };
}
