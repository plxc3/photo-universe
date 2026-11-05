import './style.css';
import { PhotoUniverse } from './scene.js';
import { FORMATIONS } from './formations.js';
import {
  loadDemoPhotos,
  loadLocalPhotos,
  buildPhotoAtlases,
  releasePhotos,
  getPhotoThumbnail,
  extractLocalPhotoFiles,
  buildYearChapters,
} from './photos.js';
import { CanvasRecorder, CINEMA_VIDEO_BITS_PER_SECOND } from './recording.js';
import { FrameProfiler } from './performance.js';
import { SpatialSoundscape } from './audio.js';
import { AlbumVault } from './storage.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const inspecting = params.has('inspect');
const debugEnabled = inspecting || params.has('debug');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const profiler = new FrameProfiler();
const stemUrl = new URL(
  'audio/felt-chamber-stem.mp3',
  new URL(import.meta.env?.BASE_URL || '/', location.href),
).href;
const soundscape = new SpatialSoundscape({ stemUrl });
const albumVault = new AlbumVault();

try {
  const savedMuted = localStorage.getItem('memoria:muted');
  if (savedMuted === 'true' || reducedMotion.matches) {
    soundscape.setMuted(true);
  }
} catch {}

const SPEED_PRESETS = [
  { speed: 0.38, label: '速率：舒缓' },
  { speed: 0.7, label: '速率：适中' },
  { speed: 1.25, label: '速率：轻快' },
];
const ROMAN_ACTS = ['I', 'II', 'III', 'IV', 'V'];
const PAGE_SIZE = 40;
const SCENE_POSITIONS = 3000;
const IDLE_STAGE_MS = 2200;

let speedPresetIndex = 1;
let universe;
let photos = [];
let fallbackAtlases = [];
let pageDisposed = false;
let validPhotoIndices = [];
let yearChapters = [];
let activeChapterKey = 'all';
let selectedPhoto = 0;
let busy = false;
let thresholdDismissed = false;
let loaderHideTimer;
let idleStageTimer;
let hoveringStageUi = false;
let lastFocusWheelAt = 0;
let toastTimer;
let recorder;
let downloadUrl;
let previousPlaying = true;
let galleryPlaying = true;
let galleryPage = 0;
let dragging = 0;
let filmFocus;
let focusTrigger;
let profileTimer;
let lastProfileDisplay = 0;
let galleryGeneration = 0;
let galleryAbort;
let photoGeneration = 0;
let photoRequest;
let photoPointer;
let photoFeedbackTimer;
let photoTransitionTimer;
let scrubbingFilm = false;
let exportAspect = 'auto';
const photoPointers = new Set();
const galleryUrls = new Set();

function padCount(n) {
  return n < 1000 ? String(n).padStart(4, '0') : n.toLocaleString();
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

function noteStageActivity() {
  $('app').classList.remove('is-idle');
  clearTimeout(idleStageTimer);
  if (
    busy ||
    !thresholdDismissed ||
    hoveringStageUi ||
    universe?.focusState ||
    document.querySelector('dialog[open]')
  ) {
    return;
  }
  idleStageTimer = setTimeout(() => {
    if (
      !busy &&
      thresholdDismissed &&
      !hoveringStageUi &&
      !universe?.focusState &&
      !document.querySelector('dialog[open]')
    ) {
      $('app').classList.add('is-idle');
    }
  }, IDLE_STAGE_MS);
}

function actLabelForTime(seconds) {
  if (seconds < 3.6) return '序幕 · 星环';
  if (seconds < 7.8) return '坍缩 · 漩涡';
  if (seconds < 21.8) return '走廊 · 螺旋';
  if (seconds < 25.4) return '重组 · 门廊';
  return '终章 · 晶格';
}

function actIndexForTime(seconds) {
  if (seconds < 3.6) return 0;
  if (seconds < 7.8) return 1;
  if (seconds < 21.8) return 2;
  if (seconds < 25.4) return 3;
  return 4;
}

function syncFilmReadout(seconds) {
  const clamped = Math.max(0, Math.min(30, Number(seconds) || 0));
  const actIdx = actIndexForTime(clamped);
  if ($('act-roman')) $('act-roman').textContent = ROMAN_ACTS[actIdx];
  $('film-act').textContent = actLabelForTime(clamped);
  $('film-time').textContent = '00:' + String(Math.floor(clamped)).padStart(2, '0') + ' / 00:30';
  $('film-progress').value = clamped;
  const ratio = Math.max(0, Math.min(1, clamped / 29.65));
  $('app').style.setProperty('--timeline-progress', ratio.toFixed(4));
  $('timeline-scrub-zone')?.setAttribute('aria-valuenow', clamped.toFixed(1));
  document.querySelectorAll('[data-act-seek]').forEach((btn, idx) => {
    if (idx === actIdx) btn.setAttribute('aria-current', 'true');
    else btn.removeAttribute('aria-current');
  });
}

function resetStageReadout(mode = universe?.mode || 'orbit') {
  const found = FORMATIONS.findIndex(f => f.id === mode);
  const label = found >= 0 ? FORMATIONS[found].label : '星环';
  if ($('act-roman')) $('act-roman').textContent = ROMAN_ACTS[Math.max(0, found)] || 'I';
  $('film-act').textContent = mode === 'orbit' ? '序幕 · 星环' : '形态 · ' + label;
  $('film-time').textContent = '滚轮叙事 · 拖动环视';
  $('app').style.setProperty('--timeline-progress', '0');
}

function syncSoundUI() {
  const active = !soundscape.muted;
  const button = $('sound-toggle');
  if (!button) return;
  button.setAttribute('aria-pressed', String(active));
  const label = active ? '静音空间音效' : '开启空间音效';
  button.setAttribute('aria-label', label);
  button.title = label;
  try {
    localStorage.setItem('memoria:muted', String(soundscape.muted));
  } catch {}
}
syncSoundUI();

function wakeAudio() {
  if (!soundscape.muted) soundscape.ensureStarted();
}

function enterArchiveFromThreshold() {
  if (thresholdDismissed) return false;
  thresholdDismissed = true;
  wakeAudio();
  universe?.unlockThreshold();
  $('app').classList.remove('threshold-locked');
  const loader = $('loader');
  if (loader && !loader.hidden) {
    loader.dataset.phase = 'entering';
    clearTimeout(loaderHideTimer);
    loaderHideTimer = setTimeout(() => {
      if (!busy) loader.hidden = true;
    }, reducedMotion.matches ? 0 : 1080);
  }
  noteStageActivity();
  return true;
}

window.addEventListener('pointerdown', () => {
  wakeAudio();
  noteStageActivity();
}, { passive: true });
window.addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') return;
  noteStageActivity();
}, { passive: true });
window.addEventListener('touchstart', () => {
  wakeAudio();
  noteStageActivity();
}, { passive: true });
window.addEventListener('keydown', event => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) wakeAudio();
  noteStageActivity();
}, { passive: true });

$('stage-hud')?.querySelectorAll('button').forEach(btn => {
  btn.addEventListener('pointerenter', () => {
    hoveringStageUi = true;
    $('app').classList.remove('is-idle');
    clearTimeout(idleStageTimer);
  });
  btn.addEventListener('pointerleave', () => {
    hoveringStageUi = false;
    noteStageActivity();
  });
});

$('loader')?.addEventListener('click', () => {
  if ($('loader')?.dataset.phase === 'threshold') {
    enterArchiveFromThreshold();
  }
});
$('threshold-enter')?.addEventListener('click', event => {
  event.stopPropagation();
  enterArchiveFromThreshold();
});

function updateMode(mode) {
  $('app').classList.toggle('mode-tunnel', mode === 'tunnel');
  const index = FORMATIONS.findIndex(formation => formation.id === mode);
  if (index >= 0) $('mode-name').textContent = FORMATIONS[index].label;
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  if (!universe?.film && !universe?.scrollTimeline) {
    resetStageReadout(mode);
  }
}

function syncPlaying() {
  const active = Boolean(universe?.running);
  const playBtn = $('play');
  if (!playBtn) return;
  playBtn.textContent = active ? '运镜：开启' : '运镜：静止';
  playBtn.setAttribute('aria-label', active ? '暂停旋转' : '继续旋转');
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

function renderFocusStrip(centerPosition) {
  const strip = $('focus-strip');
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

function updateFocusCaption(photo, position) {
  const accent = photo.accentHex || '#c8a27c';
  $('focus-hud').style.setProperty('--photo-accent', accent);
  const displayTitle = photo.title || photo.name || '';
  $('focus-title').textContent = displayTitle;
  const authorText = photo.author && photo.author !== displayTitle ? '— ' + photo.author : '';
  if ($('focus-author')) $('focus-author').textContent = authorText;
  const idxPad = String(position + 1).padStart(3, '0');
  $('focus-number').textContent = 'No. ' + idxPad + ' / ' + padCount(validPhotoIndices.length);
  const aspectTag = formatAspectTag(photo);
  const dateTag = photo.capturedDate || (photo.capturedYear ? String(photo.capturedYear) : '');
  const parts = [photo.toneLabel || '暗房 · ARCHIVE', aspectTag, dateTag].filter(Boolean);
  $('focus-tone').textContent = parts.join(' · ');
  renderFocusStrip(position);
}

function showPhoto(index, instanceIndex = -1, flowDir = 1) {
  if (busy || universe?.film) return;
  if (!thresholdDismissed) enterArchiveFromThreshold();
  const position = validPhotoIndices.indexOf(index);
  if (position < 0) return;
  selectedPhoto = position;
  const photo = photos[index];

  if (universe) {
    if ($('gallery-dialog').open) {
      $('gallery-dialog').close();
    }
    if (!universe.focusState) {
      focusTrigger = document.activeElement;
    }
    if (universe.focusPhoto(index, instanceIndex, { flowDir })) {
      updateFocusCaption(photo, position);
      soundscape.playFocusPulse(true);
      return;
    }
  }

  // Fallback HTML modal when WebGL is unavailable.
  const generation = ++photoGeneration;
  clearTimeout(photoFeedbackTimer);
  if (photoRequest) photoRequest.src = '';
  const request = photoRequest = new Image();
  const hasPhoto = !$('photo-preview').hidden && Boolean($('photo-preview').getAttribute('src'));
  $('photo-stage').setAttribute('aria-busy', 'true');
  $('photo-stage').dataset.state = 'loading';
  $('photo-stage').classList.toggle('has-photo', hasPhoto);
  $('photo-feedback').hidden = hasPhoto;
  if (hasPhoto) photoFeedbackTimer = setTimeout(() => {
    if (generation === photoGeneration && $('photo-dialog').open) $('photo-feedback').hidden = false;
  }, 180);
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
    const interrupted = previous.getAnimations().some(animation => animation.playState === 'running');
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
    } else previous.remove();
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
  if (!validPhotoIndices.length || busy) return;
  const position = (selectedPhoto + step + validPhotoIndices.length) % validPhotoIndices.length;
  showPhoto(validPhotoIndices[position], -1, step >= 0 ? 1 : -1);
}

function clearGalleryThumbnails() {
  galleryGeneration++;
  galleryAbort?.abort();
  galleryAbort = null;
  for (const url of galleryUrls) URL.revokeObjectURL(url);
  galleryUrls.clear();
  $('gallery-grid').replaceChildren();
}

function releaseAtlasCanvases(atlases) {
  for (const { canvas } of atlases || []) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function filteredGalleryIndices() {
  if (activeChapterKey === 'all') return validPhotoIndices;
  const chapter = yearChapters.find(ch => ch.key === activeChapterKey);
  return chapter ? chapter.photoIndices : validPhotoIndices;
}

function renderGalleryChapters() {
  const bar = $('gallery-chapters');
  if (!bar) return;
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
  const list = filteredGalleryIndices();
  const start = galleryPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, list.length);
  for (let position = start; position < end; position++) {
    const index = list[position];
    const photo = photos[index];
    const button = document.createElement('button');
    button.type = 'button';
    const yearSuffix = photo.capturedYear ? '（' + photo.capturedYear + '）' : '';
    const titleLabel = photo.title || photo.author || photo.name;
    button.setAttribute('aria-label', '查看照片 ' + (position + 1) + '，' + titleLabel + yearSuffix);

    const well = document.createElement('span');
    well.className = 'contact-well';
    const img = document.createElement('img');
    if (photo.source === 'demo') img.src = photo.thumbnailUrl || photo.url;
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
    button.addEventListener('click', () => showPhoto(index));
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
      };
      getPhotoThumbnail(photo).then(applyThumbnail).catch(() => {});
      getPhotoThumbnail(photo, 360, { quality: true, signal: galleryAbort.signal })
        .then(thumbnail => applyThumbnail(thumbnail, true)).catch(() => {});
    }
  }
  $('gallery-range').textContent = list.length
    ? String(start + 1).padStart(3, '0') + '–' + String(end).padStart(3, '0') + ' / ' + padCount(list.length)
    : '0';
  $('gallery-previous').disabled = start === 0;
  $('gallery-next').disabled = end >= list.length;
  $('gallery-dialog').scrollTop = 0;
}

function openGallery() {
  if (busy || !validPhotoIndices.length) return;
  if (!thresholdDismissed) enterArchiveFromThreshold();
  if (universe?.focusState) universe.closeFocus(true);
  clearTimeout(idleStageTimer);
  $('app').classList.remove('is-idle');
  activeChapterKey = 'all';
  galleryPage = Math.floor(selectedPhoto / PAGE_SIZE);
  renderGalleryChapters();
  renderGallery();
  syncVaultUI();
  galleryPlaying = universe?.running ?? false;
  if (universe) universe.running = false;
  $('gallery-dialog').showModal();
}

function setControlsDisabled(value) {
  for (const id of ['import', 'import-quick', 'record', 'demo', 'film', 'film-quick', 'collection', 'play', 'speed-cycle', 'reset']) {
    const el = $(id);
    if (el) el.disabled = value;
  }
  for (const id of ['record', 'film', 'film-quick', 'play', 'speed-cycle', 'reset']) {
    const el = $(id);
    if (el) el.disabled = value || !universe;
  }
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.disabled = value || !universe;
  });
  $('scene').setAttribute('aria-busy', String(value));
}

async function importPhotos(files, options = {}) {
  if (busy || pageDisposed) return;
  galleryAbort?.abort();
  if (universe?.focusState) universe.closeFocus(true);
  if (universe?.film) { universe.stopFilm(true, false); universe.setFormation('orbit'); }
  exitScrollMode(false);
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();

  busy = true;
  clearTimeout(loaderHideTimer);
  clearTimeout(idleStageTimer);
  $('app').classList.remove('is-idle');
  const loader = $('loader');
  loader.dataset.phase = 'loading';
  loader.hidden = false;
  setControlsDisabled(true);

  let pendingPhotos;
  let pendingAtlases;
  let enteredThresholdGate = false;
  try {
    $('loading-text').textContent = files ? '正在整理相册' : '正在凝聚馆藏';
    $('loading-progress').value = 0;
    if ($('loader-pct')) $('loader-pct').textContent = '00';
    loader.style.setProperty('--load-pct', '6%');

    const result = files ? await loadLocalPhotos(files) : await loadDemoPhotos(undefined, { extended: true });
    pendingPhotos = result.photos;
    if (pageDisposed) return;
    if (!pendingPhotos.length) throw new Error('没有可以导入的照片。请选择 JPG、PNG、WebP 等图片；HEIC 请先转为 JPG。');

    pendingAtlases = await buildPhotoAtlases(pendingPhotos, ({ loaded, total }) => {
      if (pageDisposed) return;
      const pctNum = total ? Math.round((loaded / total) * 100) : 0;
      $('loading-progress').value = pctNum;
      if ($('loader-pct')) $('loader-pct').textContent = String(pctNum).padStart(2, '0');
      loader.style.setProperty('--load-pct', Math.max(6, pctNum) + '%');
      $('loading-text').textContent = '正在显影 ' + loaded.toLocaleString() + ' / ' + total.toLocaleString();
    }, { maxTextureSize: universe?.renderer.capabilities.maxTextureSize, preserveAspect: true });

    if (pageDisposed) return;
    const indices = pendingAtlases.flatMap(atlas => atlas.photoIndices);
    if (!indices.length) throw new Error('这些照片无法解码。请转换为 JPG 或 PNG 后重新导入。');

    const skipped = (result.skipped || 0) + (pendingAtlases.diagnostics?.skippedCount || 0);
    const nextFallbackAtlases = universe ? [] : pendingAtlases;
    const shouldHoldAtThreshold = Boolean(
      universe && !thresholdDismissed && !files && !inspecting && !reducedMotion.matches
    );

    if (universe) {
      universe.setPhotos(pendingPhotos, pendingAtlases, Math.max(SCENE_POSITIONS, indices.length), {
        genesis: true,
        threshold: shouldHoldAtThreshold,
      });
    }

    clearGalleryThumbnails();
    $('photo-preview').removeAttribute('src');
    const oldPhotos = photos;
    const oldFallbackAtlases = fallbackAtlases;
    photos = pendingPhotos;
    fallbackAtlases = nextFallbackAtlases;
    pendingPhotos = null;
    pendingAtlases = null;
    validPhotoIndices = indices;
    yearChapters = buildYearChapters(photos, validPhotoIndices);
    activeChapterKey = 'all';
    selectedPhoto = 0;
    releasePhotos(oldPhotos);
    releaseAtlasCanvases(oldFallbackAtlases);

    const chapterCount = yearChapters.filter(ch => ch.year !== null).length;
    const formattedCount = padCount(indices.length);
    $('photo-count').textContent = formattedCount;
    if ($('threshold-count')) $('threshold-count').textContent = formattedCount;
    $('collection').setAttribute('aria-label', '打开暗房索引，共 ' + indices.length.toLocaleString() + ' 张照片');
    $('particle-count').textContent = Math.max(SCENE_POSITIONS, indices.length).toLocaleString() + ' 个照片位置';
    $('gallery-title').textContent = (files ? '私人底片' : '馆藏底片') + ' · ' + formattedCount;
    resetStageReadout('orbit');

    if (shouldHoldAtThreshold) {
      enteredThresholdGate = true;
      $('app').classList.add('threshold-locked');
      loader.dataset.phase = 'threshold';
    } else {
      thresholdDismissed = true;
      $('app').classList.remove('threshold-locked');
    }

    if (files && !options.restoredFromVault && albumVault.enabled) {
      const localBlobs = extractLocalPhotoFiles(photos, validPhotoIndices);
      albumVault.saveFiles(localBlobs).then(() => syncVaultUI()).catch(() => {});
    } else {
      syncVaultUI();
    }

    if (options.restoredFromVault) {
      toast('已从本机恢复 ' + indices.length.toLocaleString() + ' 张私人相册' + (chapterCount ? ' · ' + chapterCount + ' 个年份章节' : ''));
    } else if (files) {
      toast(
        '已显影 ' + indices.length.toLocaleString() + ' 张照片' +
        (chapterCount ? ' · ' + chapterCount + ' 个年份章节' : '') +
        (skipped ? '（跳过 ' + skipped + ' 个文件）' : '')
      );
    } else if (skipped) {
      toast(skipped + ' 张照片暂时无法读取');
    }
    syncPlaying();
  } catch (error) {
    if (pageDisposed) return;
    thresholdDismissed = true;
    $('app').classList.remove('threshold-locked');
    if (photos.length) toast(error.message);
    else showError(error.message);
  } finally {
    if (pendingPhotos) releasePhotos(pendingPhotos);
    releaseAtlasCanvases(pendingAtlases);
    if (!pageDisposed) {
      busy = false;
      setControlsDisabled(false);
      $('file-input').value = '';
      if (!enteredThresholdGate && !$('error-card').hidden) {
        loader.hidden = true;
      } else if (!enteredThresholdGate) {
        loader.dataset.phase = 'entering';
        loaderHideTimer = setTimeout(() => {
          if (!busy) loader.hidden = true;
        }, reducedMotion.matches ? 0 : 620);
        noteStageActivity();
      }
    }
  }
}

function showError(message) {
  $('loader').hidden = true;
  $('error-message').textContent = message;
  $('error-card').hidden = false;
}

function setChromeInert() {
  const hidden =
    $('app').classList.contains('clean') ||
    $('app').classList.contains('focus-active') ||
    $('app').classList.contains('threshold-locked') ||
    $('app').classList.contains('recording-active');
  document.querySelectorAll('.chrome').forEach(element => { element.inert = hidden; });
}

function showScrollChrome(active) {
  $('app').classList.toggle('scroll-active', active);
  if (!universe?.film) {
    $('timeline-scrub-zone').hidden = !active;
    $('stop-film').hidden = !active;
    if (active) {
      $('stop-film').textContent = '归位';
      $('stop-film').setAttribute('aria-label', '重置回序幕星环');
    } else {
      resetStageReadout();
    }
  }
}

function exitScrollMode(reset = false) {
  showScrollChrome(false);
  universe?.exitScrollTimeline(reset);
}

function showFilmChrome(active) {
  if (active) {
    $('app').classList.remove('scroll-active');
    filmFocus = document.activeElement;
    $('stop-film').textContent = recorder?.state === 'recording' ? '结束录制' : '结束漫游';
    $('stop-film').setAttribute('aria-label', recorder?.state === 'recording' ? '结束录制' : '结束漫游');
  }
  $('app').classList.toggle('film-active', active);
  $('stop-film').hidden = !active && !$('app').classList.contains('scroll-active');
  $('timeline-scrub-zone').hidden = (!active && !$('app').classList.contains('scroll-active')) || Boolean(recorder);
  setChromeInert();
  if (!active) {
    if (!$('app').classList.contains('scroll-active')) resetStageReadout();
    if (filmFocus?.isConnected && !$('app').classList.contains('clean')) {
      filmFocus.focus({ preventScroll: true });
    }
  }
  noteStageActivity();
}

function applyExportFraming() {
  if (!universe) return;
  if (exportAspect === '16:9') {
    $('app').classList.add('export-locked');
    universe.setExportResolution(1920, 1080);
  } else if (exportAspect === '9:16') {
    $('app').classList.add('export-locked');
    universe.setExportResolution(1080, 1920);
  }
}

function restoreExportFraming() {
  $('app').classList.remove('export-locked');
  universe?.clearExportResolution();
}

function playFilm() {
  if (busy || !photos.length || !universe) return;
  if (!thresholdDismissed) enterArchiveFromThreshold();
  if ($('gallery-dialog').open) $('gallery-dialog').close();
  if (universe.focusState) universe.closeFocus(true);
  scrubbingFilm = false;
  syncFilmReadout(0);
  showFilmChrome(true);
  if (inspecting) startProfile();
  universe.startFilm();
}

function endFilm() {
  scrubbingFilm = false;
  showFilmChrome(false);
  stopRecording();
  if (!recorder) restoreExportFraming();
  if (inspecting && profiler.active) finishProfile();
  syncPlaying();
}

function leaveFilm(returnToOrbit = true) {
  if (!universe?.film) return;
  universe.stopFilm(true, false);
  if (returnToOrbit) universe.setFormation('orbit');
}

function setRecordingUI(active) {
  $('record').classList.toggle('recording', active);
  $('app').classList.toggle('recording-active', active);
  $('timeline-scrub-zone').hidden = active || (!universe?.film && !$('app').classList.contains('scroll-active'));
  const label = active ? '结束录制' : '录制音画';
  $('record').textContent = label;
  $('record').setAttribute('aria-label', label);
  setChromeInert();
}

function stopRecording() {
  if (recorder?.state !== 'recording') return;
  recorder.stop();
  if (recorder?.state === 'stopping') $('record').setAttribute('aria-label', '正在保存视频');
}

function downloadRecording({ blob, extension }) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  const suffix = exportAspect === 'auto' ? '' : '-' + exportAspect.replace(':', 'x');
  link.download = 'memoria' + suffix + '-' + Date.now() + '.' + extension;
  link.click();
  toast('18 Mbps 影院级音画视频已开始下载');
}

function recordingFailed(message) {
  recorder = null;
  setRecordingUI(false);
  restoreExportFraming();
  if (universe?.film) { universe.stopFilm(false, false); universe.setFormation('orbit'); }
  showFilmChrome(false);
  if (inspecting && profiler.active) finishProfile();
  toast(message);
}

function recordFilm() {
  if (recorder) { leaveFilm(); return; }
  if (busy || !photos.length || !universe) return;
  if (!thresholdDismissed) enterArchiveFromThreshold();
  if ($('gallery-dialog').open) $('gallery-dialog').close();
  const canvas = universe.renderer.domElement;
  if (!CanvasRecorder.isSupported() || typeof canvas.captureStream !== 'function' || !CanvasRecorder.pickMimeType()) {
    toast('当前浏览器无法录制，请使用新版 Chrome、Edge 或 Safari');
    return;
  }
  applyExportFraming();
  const audioTrack = soundscape.createRecordingTrack();
  let started = false;
  recorder = new CanvasRecorder(canvas, {
    audioTrack,
    videoBitsPerSecond: CINEMA_VIDEO_BITS_PER_SECOND,
    onStart: () => { started = true; setRecordingUI(true); playFilm(); },
    onStop: video => { recorder = null; setRecordingUI(false); restoreExportFraming(); downloadRecording(video); },
    onError: error => recordingFailed(started ? '录制失败，请重新尝试' : '无法启动录制：' + error.message),
  });
  recorder.start();
}

function togglePlaying() {
  if (!universe || busy) return;
  if (universe.focusState) { universe.closeFocus(false); return; }
  if (universe.film) leaveFilm();
  if (universe.scrollTimeline) exitScrollMode(false);
  universe.running = !universe.running;
  syncPlaying();
}

function toggleClean() {
  if (universe?.film || universe?.focusState) return;
  if ($('gallery-dialog').open) $('gallery-dialog').close();
  const clean = $('app').classList.toggle('clean');
  $('restore-ui').hidden = !clean;
  setChromeInert();
  if (clean) $('restore-ui').focus({ preventScroll: true });
  else noteStageActivity();
}

function startProfile() {
  clearTimeout(profileTimer);
  profiler.start();
  $('performance-output').textContent = '正在采样';
  $('performance-output').removeAttribute('data-report');
  lastProfileDisplay = 0;
  profileTimer = setTimeout(finishProfile, 30500);
}

function finishProfile() {
  clearTimeout(profileTimer);
  const result = profiler.finish();
  $('performance-output').textContent = result.frames + ' 帧 · ' + result.durationSeconds.toFixed(2) + ' 秒\n中位 ' + result.medianFps.toFixed(1) + ' fps\np95 ' + result.p95FrameMs.toFixed(2) + ' ms · 最长 ' + result.maxFrameMs.toFixed(2) + ' ms\n>50ms ' + result.over50ms + ' · >250ms ' + result.over250ms;
  $('performance-output').dataset.report = JSON.stringify(result);
}

function profileFrame(time) {
  if (!profiler.active) return;
  profiler.push(time);
  if (time - lastProfileDisplay > 1000) {
    $('performance-output').textContent = '采样中 · ' + profiler.frameCount + ' 帧';
    lastProfileDisplay = time;
  }
}

function handleFocusChange({ active, photoIndex, step }) {
  if (step) {
    nextPhoto(step);
    return;
  }
  if (active && Number.isInteger(photoIndex) && photos[photoIndex]) {
    const pos = validPhotoIndices.indexOf(photoIndex);
    if (pos >= 0) {
      selectedPhoto = pos;
      updateFocusCaption(photos[photoIndex], pos);
    }
  }
  $('app').classList.toggle('focus-active', Boolean(active));
  $('focus-hud').hidden = !active;
  setChromeInert();
  if (active) {
    clearTimeout(idleStageTimer);
    $('app').classList.remove('is-idle');
    $('focus-close').focus({ preventScroll: true });
  } else {
    soundscape.playFocusPulse(false);
    syncPlaying();
    noteStageActivity();
    if (focusTrigger?.isConnected && !$('app').classList.contains('clean')) {
      focusTrigger.focus({ preventScroll: true });
    }
    focusTrigger = null;
  }
}

function contextLost() {
  recorder?.dispose();
  recorder = null;
  setRecordingUI(false);
  restoreExportFraming();
  universe?.stopFilm(false, false);
  showFilmChrome(false);
  $('app').classList.remove('focus-active', 'threshold-locked');
  $('focus-hud').hidden = true;
  if (profiler.active) finishProfile();
  universe?.dispose();
  universe = null;
  busy = false;
  setControlsDisabled(false);
  showError('三维渲染已中断。你仍可浏览接触印相，或重新开启暗房空间。');
}

// Borderless Optical Viewfinder Reticle (desktop fine pointer only)
const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
const reticleEl = $('cursor-reticle');
let reticleTargetX = -100;
let reticleTargetY = -100;
let reticleX = -100;
let reticleY = -100;
let reticleActive = false;

if (finePointerQuery.matches && !reducedMotion.matches) {
  window.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    reticleTargetX = event.clientX;
    reticleTargetY = event.clientY;
    if (!reticleActive) {
      reticleX = reticleTargetX;
      reticleY = reticleTargetY;
      reticleActive = true;
      reticleEl?.classList.add('visible');
    }
    const overInteractive = Boolean(event.target?.closest?.('button, a, input, dialog, .timeline-scrub-zone'));
    if (overInteractive && reticleEl?.dataset.state !== 'photo') {
      reticleEl.dataset.state = 'ui';
    } else if (!overInteractive && reticleEl?.dataset.state === 'ui') {
      delete reticleEl.dataset.state;
    }
  }, { passive: true });

  document.addEventListener('pointerleave', () => {
    reticleActive = false;
    reticleEl?.classList.remove('visible');
  });
}

function updateReticleFrame() {
  if (!reticleActive || !reticleEl) return;
  reticleX += (reticleTargetX - reticleX) * 0.28;
  reticleY += (reticleTargetY - reticleY) * 0.28;
  reticleEl.style.transform = `translate3d(${reticleX.toFixed(1)}px, ${reticleY.toFixed(1)}px, 0)`;
  if (reticleX > window.innerWidth - 240) reticleEl.dataset.flip = 'left';
  else delete reticleEl.dataset.flip;
}

try {
  universe = new PhotoUniverse($('scene'), {
    onPick: (idx, instIdx) => showPhoto(idx, instIdx, 1),
    onHoverPhoto: photoIndex => {
      const key = photos[photoIndex]?.spectralKey ?? 0.5;
      soundscape.playHoverTick(key);
    },
    onHoverStateChange: ({ active, photoIndex }) => {
      if (!reticleEl) return;
      if (active && photos[photoIndex]) {
        const photo = photos[photoIndex];
        reticleEl.dataset.state = 'photo';
        reticleEl.style.setProperty('--reticle-accent', photo.accentHex || '#c8a27c');
        const pos = validPhotoIndices.indexOf(photoIndex);
        if ($('reticle-number')) {
          $('reticle-number').textContent = pos >= 0 ? 'No. ' + String(pos + 1).padStart(3, '0') : '';
        }
        if ($('reticle-label')) {
          const baseName = photo.title || photo.author || photo.name;
          $('reticle-label').textContent = photo.capturedYear ? baseName + ' · ' + photo.capturedYear : baseName;
        }
      } else if (reticleEl.dataset.state === 'photo') {
        delete reticleEl.dataset.state;
      }
    },
    onFocusChange: handleFocusChange,
    onModeChange: updateMode,
    onFilmProgress: syncFilmReadout,
    onFilmEnd: endFilm,
    onContextLost: contextLost,
    onFrame: time => {
      updateReticleFrame();
      if (inspecting) profileFrame(time);
      if (universe) soundscape.update(universe.getAudioModulation());
    },
  });
  universe.enableScrollTheatre(true);
  universe.speed = SPEED_PRESETS[speedPresetIndex].speed;
  syncPlaying();
  if (debugEnabled) {
    window.__memoria = {
      universe,
      soundscape,
      albumVault,
      enterArchive: enterArchiveFromThreshold,
      openGallery,
      showPhoto,
    };
  }
} catch {
  showError('浏览器无法启动三维空间。请开启硬件加速，或使用新版 Chrome / Edge。接触印相仍可浏览。');
}

async function bootstrapAlbum() {
  await syncVaultUI();
  if (albumVault.enabled) {
    try {
      const saved = await albumVault.loadFiles();
      if (saved.length) {
        await importPhotos(saved, { restoredFromVault: true });
        return;
      }
    } catch {}
  }
  await importPhotos();
}
bootstrapAlbum();

async function handleRememberToggle(checked) {
  const active = await albumVault.setEnabled(checked);
  if (active && photos.length && photos[0]?.source === 'local') {
    try {
      const filesToSave = extractLocalPhotoFiles(photos, validPhotoIndices);
      const { saved } = await albumVault.saveFiles(filesToSave);
      if (saved > 0) toast('已将当前 ' + saved.toLocaleString() + ' 张相册安全保存在本机');
    } catch (err) {
      toast(err?.message || '本机缓存保存失败，请检查浏览器存储空间');
    }
  } else if (!active) {
    toast('已关闭本机相册记忆并清除缓存');
  }
  await syncVaultUI();
}

$('gallery-remember')?.addEventListener('change', event => handleRememberToggle(event.target.checked));
$('clear-vault')?.addEventListener('click', async () => {
  await albumVault.clear().catch(() => {});
  await syncVaultUI();
  toast('已清除本机缓存相册');
});

const triggerFilePicker = () => $('file-input').click();
$('import').addEventListener('click', triggerFilePicker);
$('import-quick').addEventListener('click', triggerFilePicker);
$('file-input').addEventListener('change', event => {
  if (event.target.files.length) importPhotos(event.target.files);
});

$('sound-toggle').addEventListener('click', () => {
  soundscape.toggleMuted();
  syncSoundUI();
});
$('retry').addEventListener('click', () => location.reload());
$('collection').addEventListener('click', openGallery);
$('browse-fallback').addEventListener('click', openGallery);
$('demo').addEventListener('click', () => {
  $('gallery-dialog').close();
  importPhotos();
});
$('brand').addEventListener('click', () => {
  if (universe?.focusState) { universe.closeFocus(false); return; }
  leaveFilm();
  exitScrollMode(false);
  if (universe?.mode !== 'orbit') universe?.setFormation('orbit');
  else universe?.resetView(false);
});

document.querySelectorAll('.dialog-close').forEach(button => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      dialog.close();
    }
  });
});

$('gallery-dialog').addEventListener('close', () => {
  if (universe && !universe.focusState && !universe.film) universe.running = galleryPlaying;
  clearGalleryThumbnails();
  syncPlaying();
  noteStageActivity();
});
$('photo-dialog').addEventListener('close', () => {
  photoGeneration++;
  clearTimeout(photoFeedbackTimer);
  clearTimeout(photoTransitionTimer);
  $('photo-stage').querySelector('.photo-outgoing')?.remove();
  if (photoRequest) photoRequest.src = '';
  photoRequest = null;
  photoPointer = null;
  photoPointers.clear();
  if (universe) universe.running = previousPlaying;
  $('photo-preview').removeAttribute('src');
  $('photo-preview').hidden = true;
  $('photo-stage').classList.remove('has-photo');
  syncPlaying();
  noteStageActivity();
});

$('gallery-previous').addEventListener('click', () => { galleryPage--; renderGallery(); });
$('gallery-next').addEventListener('click', () => { galleryPage++; renderGallery(); });
$('previous-photo').addEventListener('click', () => nextPhoto(-1));
$('next-photo').addEventListener('click', () => nextPhoto(1));
$('focus-prev').addEventListener('click', () => nextPhoto(-1));
$('focus-next').addEventListener('click', () => nextPhoto(1));
$('focus-close').addEventListener('click', () => universe?.closeFocus(false));
$('photo-retry').addEventListener('click', () => showPhoto(validPhotoIndices[selectedPhoto]));

$('photo-stage').addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return;
  photoPointers.add(event.pointerId);
  photoPointer = photoPointers.size === 1 ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
});
$('photo-stage').addEventListener('pointercancel', event => { photoPointers.delete(event.pointerId); photoPointer = null; });
$('photo-stage').addEventListener('pointerup', event => {
  photoPointers.delete(event.pointerId);
  if (!photoPointer || photoPointer.id !== event.pointerId) return;
  const dx = event.clientX - photoPointer.x;
  const dy = event.clientY - photoPointer.y;
  photoPointer = null;
  if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) nextPhoto(dx < 0 ? 1 : -1);
});

document.querySelectorAll('[data-mode]').forEach(button => {
  button.addEventListener('click', () => {
    if (!universe || busy) return;
    if ($('gallery-dialog').open) $('gallery-dialog').close();
    leaveFilm(false);
    exitScrollMode(false);
    soundscape.playFocusPulse(true);
    universe.setFormation(button.dataset.mode);
  });
});

document.querySelectorAll('[data-aspect]').forEach(button => {
  button.addEventListener('click', () => {
    exportAspect = button.dataset.aspect;
    document.querySelectorAll('[data-aspect]').forEach(link => {
      link.setAttribute('aria-pressed', String(link.dataset.aspect === exportAspect));
    });
  });
});

$('speed-cycle').addEventListener('click', () => {
  speedPresetIndex = (speedPresetIndex + 1) % SPEED_PRESETS.length;
  const preset = SPEED_PRESETS[speedPresetIndex];
  $('speed-cycle').textContent = preset.label;
  if (universe) universe.speed = preset.speed;
});

// Edge-Hairline Drag Scrubbing (replaces native browser range slider)
const scrubZone = $('timeline-scrub-zone');
const scrubAtClientX = (clientX, paused) => {
  if ((!universe?.film && !universe?.scrollTimeline) || recorder) return;
  const ratio = Math.max(0, Math.min(1, clientX / Math.max(1, window.innerWidth)));
  const seconds = ratio * 29.65;
  if (universe.film) universe.seekFilmLive(seconds, { paused });
  else universe.setScrollTimeline(seconds, { immediate: true });
};
scrubZone?.addEventListener('pointerdown', event => {
  if ((!universe?.film && !universe?.scrollTimeline) || recorder) return;
  scrubbingFilm = true;
  scrubZone.setPointerCapture?.(event.pointerId);
  scrubAtClientX(event.clientX, true);
});
scrubZone?.addEventListener('pointermove', event => {
  if (!scrubbingFilm) return;
  scrubAtClientX(event.clientX, true);
});
const endEdgeScrub = event => {
  if (!scrubbingFilm) return;
  scrubbingFilm = false;
  if (universe?.film && !recorder) {
    const ratio = Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth)));
    universe.seekFilmLive(ratio * 29.65, { paused: false });
  }
};
scrubZone?.addEventListener('pointerup', endEdgeScrub);
scrubZone?.addEventListener('pointercancel', endEdgeScrub);

document.querySelectorAll('[data-act-seek]').forEach(button => {
  button.addEventListener('click', () => {
    if (!universe || busy || recorder) return;
    if ($('gallery-dialog').open) $('gallery-dialog').close();
    const targetSec = Number(button.dataset.actSeek) || 0;
    soundscape.playFocusPulse(true);
    if (universe.film) {
      universe.seekFilmLive(targetSec, { paused: false });
    } else {
      showScrollChrome(true);
      universe.setScrollTimeline(targetSec);
    }
  });
});

// Unified Wheel Choreography:
// 1. Threshold Gate -> First gentle scroll unlocks soundscape + 1.8s optical rack-focus
// 2. Focus Exhibition -> Wheel liquid-morphs between adjacent full-HD photographs
// 3. Main Stage -> Pure 5-Act Scrollytelling
window.addEventListener('wheel', event => {
  if (!universe || busy || recorder || document.querySelector('dialog[open]') || event.ctrlKey) {
    return;
  }
  const unitScale = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? 360 : 1;
  const rawPx = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unitScale;
  if (Math.abs(rawPx) < 0.6) return;

  if (!thresholdDismissed) {
    event.preventDefault();
    enterArchiveFromThreshold();
    return;
  }

  if (universe.focusState) {
    event.preventDefault();
    const now = performance.now();
    if (Math.abs(rawPx) >= 14 && now - lastFocusWheelAt > 280) {
      lastFocusWheelAt = now;
      nextPhoto(rawPx > 0 ? 1 : -1);
    }
    return;
  }

  event.preventDefault();
  wakeAudio();
  noteStageActivity();
  const clampedPx = Math.max(-180, Math.min(180, rawPx));
  if (universe.film) {
    const handedTime = universe.film.elapsed || 0;
    universe.stopFilm(false, false);
    $('app').classList.remove('film-active');
    setChromeInert();
    universe.setScrollTimeline(handedTime, { immediate: true });
  }
  showScrollChrome(true);
  universe.scrollByTimeline(clampedPx * 0.011);
}, { passive: false });

$('play').addEventListener('click', togglePlaying);
$('reset').addEventListener('click', () => {
  if ($('gallery-dialog').open) $('gallery-dialog').close();
  leaveFilm(false);
  exitScrollMode(false);
  universe?.resetView(false);
});
$('film').addEventListener('click', playFilm);
$('film-quick').addEventListener('click', playFilm);
$('stop-film').addEventListener('click', () => {
  if (universe?.film) leaveFilm();
  else exitScrollMode(true);
});
$('record').addEventListener('click', recordFilm);
$('restore-ui').addEventListener('click', toggleClean);
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('当前浏览器不支持全屏，可按 H 隐藏字标');
  } catch {
    toast('无法切换全屏，可按 H 隐藏字标');
  }
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  $('fullscreen').textContent = active ? '退出全屏' : '进入全屏';
  $('fullscreen').setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
});

document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!thresholdDismissed && (event.key === 'Enter' || event.code === 'Space')) {
    event.preventDefault();
    enterArchiveFromThreshold();
    return;
  }
  if ($('photo-dialog').open) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); nextPhoto(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); nextPhoto(1); }
    return;
  }
  if (document.querySelector('dialog[open]') || !universe) return;
  if (universe.focusState) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); nextPhoto(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); nextPhoto(1); return; }
    if (event.key === 'Escape') { event.preventDefault(); universe.closeFocus(false); return; }
  }
  if (event.key === 'Escape' && (universe.film || universe.scrollTimeline)) {
    event.preventDefault();
    if (universe.film) leaveFilm();
    else exitScrollMode(true);
    return;
  }
  if (event.target.closest('input,textarea,select')) return;
  if (event.code === 'Space' && !event.target.closest('button,a')) { event.preventDefault(); togglePlaying(); }
  if (event.key.toLowerCase() === 'h') toggleClean();
});

document.addEventListener('dragenter', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragging++;
  $('drop-target').classList.add('visible');
});
document.addEventListener('dragover', event => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('dragleave', event => {
  event.preventDefault();
  dragging = Math.max(0, dragging - 1);
  if (!dragging) $('drop-target').classList.remove('visible');
});
document.addEventListener('drop', event => {
  event.preventDefault();
  dragging = 0;
  $('drop-target').classList.remove('visible');
  if (event.dataTransfer.files.length) importPhotos(event.dataTransfer.files);
});

window.addEventListener('pagehide', event => {
  clearTimeout(profileTimer);
  clearTimeout(toastTimer);
  clearTimeout(loaderHideTimer);
  clearTimeout(idleStageTimer);
  recorder?.dispose();
  recorder = null;
  setRecordingUI(false);
  restoreExportFraming();
  if (universe?.film) {
    universe.stopFilm(false, false);
    showFilmChrome(false);
  }
  if (profiler.active) finishProfile();
  if (event.persisted) return;
  pageDisposed = true;
  clearGalleryThumbnails();
  releasePhotos(photos);
  releaseAtlasCanvases(fallbackAtlases);
  fallbackAtlases = [];
  albumVault.dispose();
  soundscape.dispose();
  universe?.dispose();
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});

reducedMotion.addEventListener('change', event => {
  if (!universe) return;
  universe.reducedMotion = event.matches;
  universe.pointerEnabled = !event.matches && finePointerQuery.matches;
  if (event.matches) {
    if (!thresholdDismissed) enterArchiveFromThreshold();
    leaveFilm();
    universe.running = false;
  }
  syncPlaying();
});

if (inspecting) {
  $('inspection-panel').hidden = false;
  $('sample-performance').addEventListener('click', startProfile);
  $('stop-performance').addEventListener('click', finishProfile);
  document.querySelectorAll('[data-inspect-seek]').forEach(button => {
    button.addEventListener('click', () => {
      if (busy || !universe || !photos.length) return;
      const seconds = Number(button.dataset.inspectSeek);
      showFilmChrome(true);
      universe.debugSeekFilm(seconds);
      syncFilmReadout(seconds);
    });
  });
}
