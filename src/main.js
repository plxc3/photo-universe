import './style.css';
import { createIcons, Plus, Info, Play, Pause, Download, Square, SlidersHorizontal, X, Eye, EyeOff, Maximize, Minimize, RotateCcw, ArrowLeft, ArrowRight, ArrowUpRight, Grid2x2 } from 'lucide';
import { PhotoUniverse } from './scene.js';
import { FORMATIONS } from './formations.js';
import { loadDemoPhotos, loadLocalPhotos, buildPhotoAtlases, releasePhotos, getPhotoThumbnail } from './photos.js';
import { CanvasRecorder } from './recording.js';
import { FrameProfiler } from './performance.js';

const $ = id => document.getElementById(id);
const icons = { Plus, Info, Play, Pause, Download, Square, SlidersHorizontal, X, Eye, EyeOff, Maximize, Minimize, RotateCcw, ArrowLeft, ArrowRight, ArrowUpRight, Grid2x2 };
const drawIcons = () => createIcons({ icons, attrs: { 'aria-hidden': 'true' } });
const inspecting = new URLSearchParams(location.search).has('inspect');
const profiler = new FrameProfiler();
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
let profileTimer;
let lastProfileDisplay = 0;
let galleryGeneration = 0;
const galleryUrls = new Set();
const PAGE_SIZE = 24;

drawIcons();
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4800);
}
function updateMode(mode) {
  $('app').classList.toggle('mode-tunnel', mode === 'tunnel');
  const index = FORMATIONS.findIndex(formation => formation.id === mode);
  $('mode-name').textContent = FORMATIONS[index].label;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
}
function syncPlaying() {
  const active = Boolean(universe?.running);
  $('play').innerHTML = '<i data-lucide="' + (active ? 'pause' : 'play') + '" aria-hidden="true"></i>';
  $('play').setAttribute('aria-label', active ? '暂停旋转' : '继续旋转');
  $('play').title = active ? '暂停旋转' : '继续旋转';
  drawIcons();
}
function showPhoto(index) {
  if (busy || universe?.film) return;
  const position = validPhotoIndices.indexOf(index);
  if (position < 0) return;
  selectedPhoto = position;
  const photo = photos[index];
  $('photo-preview').src = photo.url;
  $('photo-preview').alt = photo.name;
  $('photo-title').textContent = photo.source === 'demo' && photo.author ? photo.author : photo.name;
  $('photo-number').textContent = (position + 1).toLocaleString() + ' / ' + validPhotoIndices.length.toLocaleString();
  if (!$('photo-dialog').open) {
    previousPlaying = universe?.running ?? false;
    if (universe) universe.running = false;
    $('photo-dialog').showModal();
  }
}
function nextPhoto(step) {
  if (!validPhotoIndices.length || busy) return;
  const position = (selectedPhoto + step + validPhotoIndices.length) % validPhotoIndices.length;
  showPhoto(validPhotoIndices[position]);
}
function clearGalleryThumbnails() {
  galleryGeneration++;
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
    if (photo.source !== 'demo') getPhotoThumbnail(photo).then(({ url, owned }) => {
      if (generation !== galleryGeneration || !button.isConnected) {
        if (owned) URL.revokeObjectURL(url);
        return;
      }
      if (owned) galleryUrls.add(url);
      img.src = url;
    }).catch(() => {
      if (generation === galleryGeneration && button.isConnected) img.src = photo.url;
    });
  }
  $('gallery-range').textContent = validPhotoIndices.length ? (start + 1).toLocaleString() + '–' + end.toLocaleString() + ' / ' + validPhotoIndices.length.toLocaleString() : '0';
  $('gallery-previous').disabled = start === 0;
  $('gallery-next').disabled = end >= validPhotoIndices.length;
  $('gallery-dialog').scrollTop = 0;
}
function openGallery() {
  if (busy || !validPhotoIndices.length) return;
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
  if (universe?.film) { universe.stopFilm(true, false); universe.setFormation('orbit'); }
  // Close the inner lightbox before its album so the original play state wins.
  if ($('photo-dialog').open) $('photo-dialog').close();
  if ($('gallery-dialog').open) $('gallery-dialog').close();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  setBusy(true);
  let pendingPhotos;
  let pendingAtlases;
  try {
    $('loading-text').textContent = files ? '正在整理照片' : '正在打开相册';
    $('loading-progress').value = 0;
    const result = files ? await loadLocalPhotos(files) : await loadDemoPhotos();
    pendingPhotos = result.photos;
    if (pageDisposed) return;
    if (!pendingPhotos.length) throw new Error('没有可以导入的照片。请选择 JPG、PNG、WebP 等图片；HEIC 请先转为 JPG。');
    // The CPU-only gallery uses the same decoder, limits and thumbnail budget.
    pendingAtlases = await buildPhotoAtlases(pendingPhotos, ({ loaded, total }) => {
      if (pageDisposed) return;
      $('loading-progress').value = total ? loaded / total * 100 : 0;
      $('loading-text').textContent = '正在整理 ' + loaded.toLocaleString() + ' / ' + total.toLocaleString();
    }, { maxTextureSize: universe?.renderer.capabilities.maxTextureSize });
    if (pageDisposed) return;
    const indices = pendingAtlases.flatMap(atlas => atlas.photoIndices);
    if (!indices.length) throw new Error('这些照片无法解码。请转换为 JPG 或 PNG 后重新导入。');
    const skipped = (result.skipped || 0) + (pendingAtlases.diagnostics?.skippedCount || 0);
    const nextFallbackAtlases = universe ? [] : pendingAtlases;
    if (universe) universe.setPhotos(pendingPhotos, pendingAtlases, Math.max(1200, indices.length));
    // No dialog can retain a blob from the album we are about to release.
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    clearGalleryThumbnails();
    $('photo-preview').removeAttribute('src');
    const oldPhotos = photos;
    const oldFallbackAtlases = fallbackAtlases;
    photos = pendingPhotos;
    fallbackAtlases = nextFallbackAtlases;
    pendingPhotos = null;
    pendingAtlases = null; // Ownership now belongs to the renderer or fallback album.
    validPhotoIndices = indices;
    selectedPhoto = 0;
    releasePhotos(oldPhotos);
    releaseAtlasCanvases(oldFallbackAtlases);
    $('photo-count').textContent = indices.length.toLocaleString() + ' 张照片';
    $('collection').setAttribute('aria-label', '浏览相册，' + indices.length.toLocaleString() + ' 张照片');
    $('particle-count').textContent = Math.max(1200, indices.length).toLocaleString() + ' 个照片位置';
    $('gallery-title').textContent = files ? '我的相册' : '精选相册';
    if (files) toast('已导入 ' + indices.length.toLocaleString() + ' 张' + (skipped ? '，跳过 ' + skipped + ' 个无法读取的文件' : '') + '。照片保留在本地。');
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
  const hidden = $('app').classList.contains('clean') || $('app').classList.contains('film-active');
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
function playFilm() {
  if (busy || !photos.length || !universe) return;
  showFilmChrome(true);
  $('film-description').textContent = recorder?.state === 'recording' ? '录制中' : '漫游';
  if (inspecting) startProfile();
  universe.startFilm();
}
function endFilm() {
  showFilmChrome(false);
  stopRecording();
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
  const label = active ? '结束录制' : '录制 30 秒视频';
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
  link.download = 'memoria-' + Date.now() + '.' + extension;
  link.click();
  toast('视频已开始下载。');
}
function recordingFailed(message) {
  recorder = null;
  setRecordingUI(false);
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
  let started = false;
  recorder = new CanvasRecorder(canvas, {
    onStart: () => { started = true; setRecordingUI(true); playFilm(); },
    onStop: video => { recorder = null; setRecordingUI(false); downloadRecording(video); },
    onError: error => recordingFailed(started ? '录制失败，请重新尝试。' : '无法启动录制：' + error.message),
  });
  recorder.start();
}
function togglePlaying() {
  if (!universe || busy) return;
  if (universe.film) leaveFilm();
  universe.running = !universe.running;
  syncPlaying();
}
function toggleClean() {
  if (universe?.film) return;
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
function contextLost() {
  recorder?.dispose();
  recorder = null;
  setRecordingUI(false);
  universe?.stopFilm(false, false);
  showFilmChrome(false);
  if (profiler.active) finishProfile();
  universe?.dispose();
  universe = null;
  setBusy(false);
  showError('三维渲染已中断。你仍可浏览相册，或重新打开空间。');
}
try {
  universe = new PhotoUniverse($('scene'), {
    onPick: showPhoto,
    onModeChange: updateMode,
    onFilmProgress: seconds => {
      $('film-time').textContent = '00:' + String(Math.floor(seconds)).padStart(2, '0') + ' / 00:30';
      $('film-progress').value = seconds;
    },
    onFilmEnd: endFilm,
    onContextLost: contextLost,
    onFrame: inspecting ? profileFrame : undefined,
  });
  universe.speed = Number($('speed').value);
  syncPlaying();
} catch { showError('浏览器无法启动三维空间。请开启硬件加速，或使用新版 Chrome / Edge。相册仍可浏览。'); }
importPhotos();

$('import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { if (event.target.files.length) importPhotos(event.target.files); });
$('retry').addEventListener('click', () => location.reload());
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('settings').addEventListener('click', () => $('settings-dialog').showModal());
$('collection').addEventListener('click', openGallery);
$('browse-fallback').addEventListener('click', openGallery);
$('demo').addEventListener('click', () => { $('help-dialog').close(); importPhotos(); });
$('brand').addEventListener('click', () => { leaveFilm(); if (universe?.mode !== 'orbit') universe?.setFormation('orbit'); else universe?.resetView(false); });
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('gallery-dialog').addEventListener('close', () => {
  if (universe) universe.running = galleryPlaying;
  clearGalleryThumbnails();
  syncPlaying();
});
$('photo-dialog').addEventListener('close', () => {
  if (universe) universe.running = previousPlaying;
  $('photo-preview').removeAttribute('src');
  syncPlaying();
});
$('gallery-previous').addEventListener('click', () => { galleryPage--; renderGallery(); });
$('gallery-next').addEventListener('click', () => { galleryPage++; renderGallery(); });
$('previous-photo').addEventListener('click', () => nextPhoto(-1));
$('next-photo').addEventListener('click', () => nextPhoto(1));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (!universe || busy) return;
  leaveFilm(false);
  universe.setFormation(button.dataset.mode);
}));
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
  // Dispose suppresses onStop, so navigating away cannot download a partial clip.
  recorder?.dispose(); recorder = null;
  setRecordingUI(false);
  if (universe?.film) {
    universe.stopFilm(false, false);
    showFilmChrome(false);
  }
  if (profiler.active) finishProfile();
  // BFCache restores this same document and its live renderer/Blob URLs.
  if (event.persisted) return;
  pageDisposed = true;
  clearGalleryThumbnails();
  releasePhotos(photos);
  releaseAtlasCanvases(fallbackAtlases);
  fallbackAtlases = [];
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
}
