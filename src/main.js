import './style.css';
import {
  createIcons,
  Plus,
  Info,
  Play,
  Pause,
  Download,
  Square,
  SlidersHorizontal,
  X,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Grid2x2,
} from 'lucide';
import { PhotoUniverse } from './scene.js';
import { FORMATIONS } from './formations.js';
import { loadDemoPhotos, loadLocalPhotos, buildPhotoAtlases, releasePhotos, getPhotoThumbnail } from './photos.js';
import { CanvasRecorder, CINEMA_VIDEO_BITS_PER_SECOND } from './recording.js';
import { FrameProfiler } from './performance.js';
import { SpatialSoundscape } from './audio.js';

const $ = id => document.getElementById(id);
const icons = {
  Plus,
  Info,
  Play,
  Pause,
  Download,
  Square,
  SlidersHorizontal,
  X,
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  RotateCcw,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Grid2x2,
};
const drawIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const params = new URLSearchParams(location.search);
const inspecting = params.has('inspect');
const debugEnabled = inspecting || params.has('debug');
const profiler = new FrameProfiler();
const soundscape = new SpatialSoundscape();
try {
  const savedMuted = localStorage.getItem('memoria:muted');
  if (savedMuted === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    soundscape.setMuted(true);
  }
} catch {}

let universe;
let photos = [];
let fallbackAtlases = [];
let pageDisposed = false;
let validPhotoIndices = [];
let selectedPhoto = 0;
let busy = false;
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
const PAGE_SIZE = 24;
const SCENE_POSITIONS = 3000;

drawIcons();

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4800);
}

function actLabelForTime(seconds) {
  if (seconds < 3.6) return '序幕 · 星环';
  if (seconds < 5.8) return '第一幕 · 漩涡坍缩';
  if (seconds < 21.8) return '第二幕 · 螺旋走廊';
  if (seconds < 25.4) return '第三幕 · 门廊重组';
  return '终章 · 晶格呼吸';
}

function syncFilmReadout(seconds) {
  $('film-time').textContent = '00:' + String(Math.floor(seconds)).padStart(2, '0') + ' / 00:30';
  $('film-act').textContent = actLabelForTime(seconds);
  $('film-progress').value = seconds;
  const pct = Math.max(0, Math.min(100, (seconds / 29.65) * 100)).toFixed(2) + '%';
  $('film-scrubber').style.setProperty('--scrub-pct', pct);
  if (!scrubbingFilm) {
    $('film-scrubber').value = String(Math.min(29.65, seconds));
  }
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
window.addEventListener('pointerdown', wakeAudio, { passive: true });
window.addEventListener('keydown', event => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) wakeAudio();
}, { passive: true });

function updateMode(mode) {
  $('app').classList.toggle('mode-tunnel', mode === 'tunnel');
  const index = FORMATIONS.findIndex(formation => formation.id === mode);
  if (index >= 0) $('mode-name').textContent = FORMATIONS[index].label;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
}

function syncPlaying() {
  const active = Boolean(universe?.running);
  $('play').innerHTML = '<i data-lucide="' + (active ? 'pause' : 'play') + '" aria-hidden="true"></i>';
  $('play').setAttribute('aria-label', active ? '暂停旋转' : '继续旋转');
  $('play').title = active ? '暂停旋转' : '继续旋转';
  drawIcons();
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
  const span = Math.min(15, total);
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
    tick.title = (p?.author || p?.name || '') + ' · #' + (pos + 1);
    tick.addEventListener('click', () => {
      if (!isCurrent) showPhoto(pIdx);
    });
    strip.append(tick);
  }
}

function updateFocusCaption(photo, position) {
  const accent = photo.accentHex || '#c8a27c';
  $('focus-hud').style.setProperty('--photo-accent', accent);
  $('focus-title').textContent = photo.source === 'demo' && photo.author ? photo.author : photo.name;
  const idxPad = String(position + 1).padStart(2, '0');
  $('focus-number').textContent = 'No. ' + idxPad + ' / ' + validPhotoIndices.length.toLocaleString();
  const aspectTag = formatAspectTag(photo);
  const tone = photo.toneLabel || '暗房 · ARCHIVE';
  $('focus-tone').textContent = aspectTag ? tone + ' · ' + aspectTag : tone;
  renderFocusStrip(position);
}

function showPhoto(index, instanceIndex = -1) {
  if (busy || universe?.film) return;
  const position = validPhotoIndices.indexOf(index);
  if (position < 0) return;
  selectedPhoto = position;
  const photo = photos[index];

  // Primary 3D In-Situ Gaze: fly camera directly to the physical photograph card.
  if (universe) {
    if ($('gallery-dialog').open) {
      $('gallery-dialog').close();
    }
    if (!universe.focusState) {
      focusTrigger = document.activeElement;
    }
    if (universe.focusPhoto(index, instanceIndex)) {
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
    $('photo-title').textContent = photo.source === 'demo' && photo.author ? photo.author : photo.name;
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
    request.alt = photo.name;
    request.draggable = false;
    request.className = interrupted ? 'photo-image photo-swap-instant' : 'photo-image';
    previous.removeAttribute('id');
    previous.after(request);
    if (hasPhoto && !interrupted && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
  showPhoto(validPhotoIndices[position]);
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

function renderGallery() {
  clearGalleryThumbnails();
  galleryAbort = new AbortController();
  const generation = galleryGeneration;
  const grid = $('gallery-grid');
  const start = galleryPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, validPhotoIndices.length);
  for (let position = start; position < end; position++) {
    const index = validPhotoIndices[position];
    const photo = photos[index];
    const button = document.createElement('button');
    button.setAttribute('aria-label', '查看照片 ' + (position + 1) + '，' + (photo.author || photo.name));
    const img = document.createElement('img');
    if (photo.source === 'demo') img.src = photo.thumbnailUrl || photo.url;
    img.alt = photo.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    button.append(img);
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
  $('gallery-range').textContent = validPhotoIndices.length ? (start + 1).toLocaleString() + '–' + end.toLocaleString() + ' / ' + validPhotoIndices.length.toLocaleString() : '0';
  $('gallery-previous').disabled = start === 0;
  $('gallery-next').disabled = end >= validPhotoIndices.length;
  $('gallery-dialog').scrollTop = 0;
}

function openGallery() {
  if (busy || !validPhotoIndices.length) return;
  if (universe?.focusState) universe.closeFocus(true);
  galleryPage = Math.floor(selectedPhoto / PAGE_SIZE);
  renderGallery();
  galleryPlaying = universe?.running ?? false;
  if (universe) universe.running = false;
  $('gallery-dialog').showModal();
}

function setBusy(value) {
  busy = value;
  $('loader').hidden = !value;
  for (const id of ['import', 'record', 'demo', 'film', 'collection', 'play', 'settings']) $(id).disabled = value;
  for (const id of ['record', 'film', 'play', 'settings']) $(id).disabled = value || !universe;
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = value || !universe; });
  $('scene').setAttribute('aria-busy', String(value));
}

async function importPhotos(files) {
  if (busy || pageDisposed) return;
  galleryAbort?.abort();
  if (universe?.focusState) universe.closeFocus(true);
  if (universe?.film) { universe.stopFilm(true, false); universe.setFormation('orbit'); }
  if ($('photo-dialog').open) $('photo-dialog').close();
  if ($('gallery-dialog').open) $('gallery-dialog').close();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  setBusy(true);
  let pendingPhotos;
  let pendingAtlases;
  try {
    $('loading-text').textContent = files ? '正在整理照片' : '正在凝聚相册';
    $('loading-progress').value = 0;
    const result = files ? await loadLocalPhotos(files) : await loadDemoPhotos(undefined, { extended: true });
    pendingPhotos = result.photos;
    if (pageDisposed) return;
    if (!pendingPhotos.length) throw new Error('没有可以导入的照片。请选择 JPG、PNG、WebP 等图片；HEIC 请先转为 JPG。');
    pendingAtlases = await buildPhotoAtlases(pendingPhotos, ({ loaded, total }) => {
      if (pageDisposed) return;
      $('loading-progress').value = total ? loaded / total * 100 : 0;
      $('loading-text').textContent = '正在显影 ' + loaded.toLocaleString() + ' / ' + total.toLocaleString();
    }, { maxTextureSize: universe?.renderer.capabilities.maxTextureSize, preserveAspect: true });
    if (pageDisposed) return;
    const indices = pendingAtlases.flatMap(atlas => atlas.photoIndices);
    if (!indices.length) throw new Error('这些照片无法解码。请转换为 JPG 或 PNG 后重新导入。');
    const skipped = (result.skipped || 0) + (pendingAtlases.diagnostics?.skippedCount || 0);
    const nextFallbackAtlases = universe ? [] : pendingAtlases;
    if (universe) {
      universe.setPhotos(pendingPhotos, pendingAtlases, Math.max(SCENE_POSITIONS, indices.length), { genesis: true });
    }
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    clearGalleryThumbnails();
    $('photo-preview').removeAttribute('src');
    const oldPhotos = photos;
    const oldFallbackAtlases = fallbackAtlases;
    photos = pendingPhotos;
    fallbackAtlases = nextFallbackAtlases;
    pendingPhotos = null;
    pendingAtlases = null;
    validPhotoIndices = indices;
    selectedPhoto = 0;
    releasePhotos(oldPhotos);
    releaseAtlasCanvases(oldFallbackAtlases);
    $('photo-count').textContent = indices.length.toLocaleString() + ' 张照片';
    $('collection').setAttribute('aria-label', '浏览相册，' + indices.length.toLocaleString() + ' 张照片');
    $('particle-count').textContent = Math.max(SCENE_POSITIONS, indices.length).toLocaleString() + ' 个照片位置';
    $('gallery-title').textContent = files ? '我的相册' : '精选相册';
    if (files) toast('已导入 ' + indices.length.toLocaleString() + ' 张' + (skipped ? '，跳过 ' + skipped + ' 个无法读取的文件' : '') + '。色温光谱已编排。');
    else if (skipped) toast(skipped + ' 张照片暂时无法读取。');
    syncPlaying();
  } catch (error) {
    if (pageDisposed) return;
    if (photos.length) toast(error.message);
    else showError(error.message);
  } finally {
    if (pendingPhotos) releasePhotos(pendingPhotos);
    releaseAtlasCanvases(pendingAtlases);
    if (!pageDisposed) {
      setBusy(false);
      $('file-input').value = '';
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
    $('app').classList.contains('film-active') ||
    $('app').classList.contains('focus-active');
  document.querySelectorAll('.chrome').forEach(element => { element.inert = hidden; });
}

function showFilmChrome(active) {
  if (active) filmFocus = document.activeElement;
  $('app').classList.toggle('film-active', active);
  $('film-status').hidden = !active;
  setChromeInert();
  if (active) $('stop-film').focus({ preventScroll: true });
  else if (filmFocus?.isConnected && !$('app').classList.contains('clean')) filmFocus.focus({ preventScroll: true });
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
  if (universe.focusState) universe.closeFocus(true);
  scrubbingFilm = false;
  syncFilmReadout(0);
  showFilmChrome(true);
  $('film-description').textContent = recorder?.state === 'recording' ? '录制中' : '漫游';
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
  $('film-scrubber').disabled = active;
  const label = active ? '结束录制' : '录制 30 秒音画视频';
  $('record').setAttribute('aria-label', label);
  $('record').title = label;
  $('record').innerHTML = '<i data-lucide="' + (active ? 'square' : 'download') + '" aria-hidden="true"></i>';
  drawIcons();
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
  toast('影院级音画视频已开始下载。');
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
  const canvas = universe.renderer.domElement;
  if (!CanvasRecorder.isSupported() || typeof canvas.captureStream !== 'function' || !CanvasRecorder.pickMimeType()) {
    toast('当前浏览器无法录制，请使用新版 Chrome、Edge 或 Safari。');
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
    onError: error => recordingFailed(started ? '录制失败，请重新尝试。' : '无法启动录制：' + error.message),
  });
  recorder.start();
}

function togglePlaying() {
  if (!universe || busy) return;
  if (universe.focusState) { universe.closeFocus(false); return; }
  if (universe.film) leaveFilm();
  universe.running = !universe.running;
  syncPlaying();
}

function toggleClean() {
  if (universe?.film || universe?.focusState) return;
  $('settings-dialog').close();
  const clean = $('app').classList.toggle('clean');
  $('restore-ui').hidden = !clean;
  setChromeInert();
  if (clean) $('restore-ui').focus({ preventScroll: true });
  else $('settings').focus({ preventScroll: true });
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
    $('focus-close').focus({ preventScroll: true });
  } else {
    soundscape.playFocusPulse(false);
    syncPlaying();
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
  $('app').classList.remove('focus-active');
  $('focus-hud').hidden = true;
  if (profiler.active) finishProfile();
  universe?.dispose();
  universe = null;
  setBusy(false);
  showError('三维渲染已中断。你仍可浏览相册，或重新打开空间。');
}

// Precision Optical Viewfinder Reticle & Tactile Magnetic Micro-Interactions (desktop fine pointer only)
const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
const reticleEl = $('cursor-reticle');
let reticleTargetX = -100;
let reticleTargetY = -100;
let reticleX = -100;
let reticleY = -100;
let reticleActive = false;

if (finePointerQuery.matches && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
    const overInteractive = Boolean(event.target?.closest?.('button, a, input, dialog'));
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

  document.querySelectorAll('.magnetic').forEach(btn => {
    btn.addEventListener('pointerenter', () => {
      btn.style.willChange = 'transform';
    });
    btn.addEventListener('pointermove', event => {
      if (btn.disabled) return;
      const rect = btn.getBoundingClientRect();
      const dx = Math.max(-5, Math.min(5, (event.clientX - (rect.left + rect.width / 2)) * 0.22));
      const dy = Math.max(-5, Math.min(5, (event.clientY - (rect.top + rect.height / 2)) * 0.22));
      btn.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
    });
    btn.addEventListener('pointerleave', () => {
      btn.style.transform = '';
      btn.style.willChange = 'auto';
    });
  });
}

function updateReticleFrame() {
  if (!reticleActive || !reticleEl) return;
  reticleX += (reticleTargetX - reticleX) * 0.28;
  reticleY += (reticleTargetY - reticleY) * 0.28;
  reticleEl.style.transform = `translate3d(${reticleX.toFixed(1)}px, ${reticleY.toFixed(1)}px, 0)`;
}

try {
  universe = new PhotoUniverse($('scene'), {
    onPick: showPhoto,
    onHoverPhoto: photoIndex => {
      const key = photos[photoIndex]?.spectralKey ?? 0.5;
      soundscape.playHoverTick(key);
    },
    onHoverStateChange: ({ active, photoIndex }) => {
      if (!reticleEl) return;
      if (active && photos[photoIndex]) {
        reticleEl.dataset.state = 'photo';
        reticleEl.style.setProperty('--reticle-accent', photos[photoIndex].accentHex || '#c8a27c');
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
  universe.speed = Number($('speed').value);
  syncPlaying();
  if (debugEnabled) {
    window.__memoria = { universe, soundscape };
  }
} catch {
  showError('浏览器无法启动三维空间。请开启硬件加速，或使用新版 Chrome / Edge。相册仍可浏览。');
}
importPhotos();

$('import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { if (event.target.files.length) importPhotos(event.target.files); });
$('sound-toggle').addEventListener('click', () => {
  soundscape.toggleMuted();
  syncSoundUI();
});
$('retry').addEventListener('click', () => location.reload());
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('settings').addEventListener('click', () => $('settings-dialog').showModal());
$('collection').addEventListener('click', openGallery);
$('browse-fallback').addEventListener('click', openGallery);
$('demo').addEventListener('click', () => { $('help-dialog').close(); importPhotos(); });
$('brand').addEventListener('click', () => {
  if (universe?.focusState) { universe.closeFocus(false); return; }
  leaveFilm();
  if (universe?.mode !== 'orbit') universe?.setFormation('orbit');
  else universe?.resetView(false);
});
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('gallery-dialog').addEventListener('close', () => {
  if (universe && !universe.focusState) universe.running = galleryPlaying;
  clearGalleryThumbnails();
  syncPlaying();
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
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (!universe || busy) return;
  leaveFilm(false);
  soundscape.playFocusPulse(true);
  universe.setFormation(button.dataset.mode);
}));
document.querySelectorAll('[data-aspect]').forEach(button => button.addEventListener('click', () => {
  exportAspect = button.dataset.aspect;
  document.querySelectorAll('[data-aspect]').forEach(pill => {
    pill.setAttribute('aria-pressed', String(pill.dataset.aspect === exportAspect));
  });
}));
$('film-scrubber').addEventListener('pointerdown', () => {
  if (!universe?.film || recorder) return;
  scrubbingFilm = true;
  universe.seekFilmLive(Number($('film-scrubber').value), { paused: true });
});
$('film-scrubber').addEventListener('input', () => {
  if (!universe?.film || recorder) return;
  scrubbingFilm = true;
  const seconds = Number($('film-scrubber').value);
  universe.seekFilmLive(seconds, { paused: true });
  $('film-scrubber').value = String(seconds);
});
const finishScrub = () => {
  if (!scrubbingFilm) return;
  scrubbingFilm = false;
  if (universe?.film && !recorder) {
    universe.seekFilmLive(Number($('film-scrubber').value), { paused: false });
  }
};
$('film-scrubber').addEventListener('pointerup', finishScrub);
$('film-scrubber').addEventListener('pointercancel', finishScrub);
$('film-scrubber').addEventListener('change', finishScrub);

$('play').addEventListener('click', togglePlaying);
$('speed').addEventListener('input', event => { if (universe) universe.speed = Number(event.target.value); });
$('reset').addEventListener('click', () => { leaveFilm(false); universe?.resetView(false); $('settings-dialog').close(); });
$('film').addEventListener('click', playFilm);
$('stop-film').addEventListener('click', () => leaveFilm());
$('record').addEventListener('click', recordFilm);
$('clean').addEventListener('click', toggleClean);
$('restore-ui').addEventListener('click', toggleClean);
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('当前浏览器不支持全屏，可以先隐藏界面。');
  } catch { toast('无法进入全屏，可以先隐藏界面。'); }
});
document.addEventListener('fullscreenchange', () => {
  const active = Boolean(document.fullscreenElement);
  $('fullscreen').setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
  $('fullscreen').innerHTML = '<i data-lucide="' + (active ? 'minimize' : 'maximize') + '" aria-hidden="true"></i><span>' + (active ? '退出全屏' : '进入全屏') + '</span>';
  drawIcons();
});
document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
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
  if (event.key === 'Escape' && universe.film) { event.preventDefault(); leaveFilm(); return; }
  if (event.target.closest('input,textarea,select')) return;
  if (event.code === 'Space' && !event.target.closest('button,a')) { event.preventDefault(); togglePlaying(); }
  if (event.key.toLowerCase() === 'h') toggleClean();
});
document.addEventListener('dragenter', event => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); dragging++; $('drop-target').classList.add('visible'); });
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', event => { event.preventDefault(); dragging = Math.max(0, dragging - 1); if (!dragging) $('drop-target').classList.remove('visible'); });
document.addEventListener('drop', event => {
  event.preventDefault(); dragging = 0; $('drop-target').classList.remove('visible');
  if (event.dataTransfer.files.length) importPhotos(event.dataTransfer.files);
});
window.addEventListener('pagehide', event => {
  clearTimeout(profileTimer);
  clearTimeout(toastTimer);
  recorder?.dispose(); recorder = null;
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
  soundscape.dispose();
  universe?.dispose();
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
reducedMotion.addEventListener('change', event => {
  if (!universe) return;
  universe.reducedMotion = event.matches;
  universe.pointerEnabled = !event.matches && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (event.matches) { leaveFilm(); universe.running = false; }
  syncPlaying();
});
if (inspecting) {
  $('inspection-panel').hidden = false;
  $('sample-performance').addEventListener('click', startProfile);
  $('stop-performance').addEventListener('click', finishProfile);
  document.querySelectorAll('[data-inspect-seek]').forEach(button => button.addEventListener('click', () => {
    if (busy || !universe || !photos.length) return;
    const seconds = Number(button.dataset.inspectSeek);
    showFilmChrome(true);
    $('film-description').textContent = '镜头预览';
    universe.debugSeekFilm(seconds);
    syncFilmReadout(seconds);
  }));
}
