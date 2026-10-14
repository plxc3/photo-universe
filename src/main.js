import './style.css';
import { PhotoUniverse } from './scene.js';
import { FORMATIONS } from './formations.js';
import { loadDemoPhotos, loadLocalPhotos, buildPhotoAtlases, releasePhotos } from './photos.js';
import { CanvasRecorder } from './recording.js';

const $ = id => document.getElementById(id);
let universe;
let photos = [];
let validPhotoIndices = [];
let selectedPhoto = 0;
let busy = false;
let toastTimer;
let recorder;
let downloadUrl;
let previousPlaying = true;
let dragging = 0;

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}

function updateMode(mode) {
  $('app').classList.toggle('mode-tunnel', mode === 'tunnel');
  const index = FORMATIONS.findIndex(formation => formation.id === mode);
  $('mode-name').textContent = FORMATIONS[index].label;
  $('mode-index').textContent = `0${index + 1} / 04`;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
}

function showPhoto(index) {
  const position = validPhotoIndices.indexOf(index);
  if (position < 0) return;
  selectedPhoto = position;
  const photo = photos[index];
  $('photo-preview').src = photo.url;
  $('photo-preview').alt = photo.name;
  $('photo-title').textContent = photo.name;
  $('photo-number').textContent = `${position + 1} / ${validPhotoIndices.length}`;
  if (!$('photo-dialog').open) {
    previousPlaying = universe.running;
    universe.running = false;
    $('photo-dialog').showModal();
  }
}

function nextPhoto(step) {
  selectedPhoto = (selectedPhoto + step + validPhotoIndices.length) % validPhotoIndices.length;
  showPhoto(validPhotoIndices[selectedPhoto]);
}

function setBusy(value) {
  busy = value;
  $('loader').hidden = !value;
  for (const id of ['import', 'record', 'demo', 'film']) $(id).disabled = value;
}

async function importPhotos(files) {
  if (busy) return;
  if (universe.film) universe.stopFilm();
  if ($('photo-dialog').open) $('photo-dialog').close();
  setBusy(true);
  let pendingPhotos;
  try {
    $('loading-text').textContent = files ? '正在整理你的照片…' : '正在点亮示例宇宙…';
    $('loading-progress').value = 0;
    const result = files ? await loadLocalPhotos(files) : await loadDemoPhotos();
    pendingPhotos = result.photos;
    if (!pendingPhotos.length) {
      throw new Error('没有可以导入的照片。请选择 JPG、PNG、WebP 等图片；HEIC 请先转为 JPG。');
    }
    const atlases = await buildPhotoAtlases(pendingPhotos, ({ loaded, total }) => {
      $('loading-progress').value = loaded / total * 100;
      $('loading-text').textContent = `正在点亮照片 ${loaded.toLocaleString()} / ${total.toLocaleString()}`;
    });
    const indices = atlases.flatMap(atlas => atlas.photoIndices);
    if (!indices.length) throw new Error('这些照片无法解码。请转换为 JPG 或 PNG 后重新导入。');
    universe.setPhotos(pendingPhotos, atlases, 3000);
    const oldPhotos = photos;
    photos = pendingPhotos;
    pendingPhotos = null;
    validPhotoIndices = indices;
    releasePhotos(oldPhotos);
    $('photo-count').textContent = `${files ? '私人相册' : '示例相册'} · ${indices.length.toLocaleString()} 张照片`;
    $('particle-count').textContent = '3,000 个照片位置';
    const skipped = (result.skipped || 0) + (atlases.diagnostics?.skippedCount || 0);
    if (files) toast(`已点亮 ${indices.length.toLocaleString()} 张照片${skipped ? `，跳过 ${skipped} 个无法读取的文件` : ''}。照片留在当前浏览器里。`);
    else if (skipped) toast(`已载入 ${indices.length} 张示例照片，${skipped} 张暂时不可用。`);
  } catch (error) {
    if (pendingPhotos) releasePhotos(pendingPhotos);
    if (photos.length) toast(error.message);
    else showError(error.message);
  } finally {
    setBusy(false);
    $('file-input').value = '';
  }
}

function showError(message) {
  $('loader').hidden = true;
  $('error-message').textContent = message;
  $('error-card').hidden = false;
}

function showFilmChrome(active) {
  $('app').classList.toggle('film-active', active);
  $('film-status').hidden = !active;
}

function resetFilmButton() {
  $('film').innerHTML = '<span>▷</span> 30 秒漫游';
}

function playFilm() {
  if (busy || !photos.length) return;
  showFilmChrome(true);
  $('film').textContent = '重新漫游';
  $('film-description').textContent = recorder?.state === 'recording' ? '正在录制' : '镜头漫游';
  universe.startFilm();
}

function endFilm() {
  showFilmChrome(false);
  resetFilmButton();
  stopRecording();
}

function setRecordingUI(active) {
  $('record').classList.toggle('recording', active);
  $('record').setAttribute('aria-label', active ? '结束录制' : '录制 30 秒视频');
}

function stopRecording() {
  if (recorder?.state !== 'recording') return;
  recorder.stop();
  // The browser still has to flush and report the stop before a file exists.
  if (recorder?.state === 'stopping') $('record').setAttribute('aria-label', '正在保存视频');
}

function downloadRecording({ blob, extension }) {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = `memoria-${Date.now()}.${extension}`;
  link.click();
  toast('漫游视频已生成并开始下载。');
}

function recordingFailed(message) {
  recorder = null;
  setRecordingUI(false);
  if (universe.film) universe.stopFilm();
  else { showFilmChrome(false); resetFilmButton(); }
  toast(message);
}

function recordFilm() {
  if (recorder) {
    universe.stopFilm();
    return;
  }
  if (busy || !photos.length) {
    toast('先导入照片，再录制漫游。');
    return;
  }
  const canvas = universe.renderer.domElement;
  if (!CanvasRecorder.isSupported() || typeof canvas.captureStream !== 'function') {
    toast('当前浏览器不支持录制。请用新版 Chrome、Edge 或 Safari 打开。');
    return;
  }
  if (!CanvasRecorder.pickMimeType()) {
    toast('当前浏览器没有可用的视频编码器。');
    return;
  }
  let started = false;
  recorder = new CanvasRecorder(canvas, {
    onStart: () => { started = true; setRecordingUI(true); playFilm(); },
    onStop: video => { recorder = null; setRecordingUI(false); downloadRecording(video); },
    onError: error => recordingFailed(started ? '视频录制失败，请重新尝试。' : `无法启动录制：${error.message}`),
  });
  recorder.start();
}

function togglePlaying() {
  universe.running = !universe.running;
  $('play').textContent = universe.running ? 'Ⅱ' : '▷';
  $('play').setAttribute('aria-label', universe.running ? '暂停旋转' : '继续旋转');
}

function toggleClean() {
  const clean = $('app').classList.toggle('clean');
  $('restore-ui').hidden = !clean;
}

try {
  universe = new PhotoUniverse($('scene'), {
    onPick: showPhoto,
    onModeChange: updateMode,
    onFilmProgress: seconds => {
      $('film-time').textContent = `00:${String(Math.floor(seconds)).padStart(2, '0')} / 00:30`;
      $('film-progress').value = seconds;
    },
    onFilmEnd: endFilm,
    onContextLost: () => showError('浏览器的三维渲染已中断。请关闭其他占用显存的页面后重新打开。'),
  });
  if (!universe.running) {
    $('play').textContent = '▷';
    $('play').setAttribute('aria-label', '继续旋转');
  }
  importPhotos();
} catch {
  showError('浏览器无法启动 WebGL。请开启硬件加速，或用新版 Chrome / Edge 打开。');
}

$('import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => importPhotos(event.target.files));
$('retry').addEventListener('click', () => location.reload());
$('help').addEventListener('click', () => $('help-dialog').showModal());
$('demo').addEventListener('click', () => { $('help-dialog').close(); importPhotos(); });
document.querySelectorAll('.dialog-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('photo-dialog').addEventListener('close', () => {
  universe.running = previousPlaying;
  $('photo-preview').removeAttribute('src');
});
$('previous-photo').addEventListener('click', () => nextPhoto(-1));
$('next-photo').addEventListener('click', () => nextPhoto(1));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (!universe || busy) return;
  if (universe.film) universe.stopFilm();
  universe.setFormation(button.dataset.mode);
}));
$('play').addEventListener('click', () => { if (universe?.film) universe.stopFilm(); if (universe) togglePlaying(); });
$('speed').addEventListener('input', event => { if (universe) universe.speed = Number(event.target.value); });
$('reset').addEventListener('click', () => { if (universe?.film) universe.stopFilm(); universe?.resetView(); });
$('film').addEventListener('click', () => { if (universe) playFilm(); });
$('stop-film').addEventListener('click', () => universe?.stopFilm());
$('record').addEventListener('click', () => { if (universe) recordFilm(); });
$('clean').addEventListener('click', toggleClean);
$('restore-ui').addEventListener('click', toggleClean);
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else toast('当前浏览器不支持全屏，可以先隐藏界面。');
  } catch { toast('无法进入全屏，可以先隐藏界面。'); }
});
document.addEventListener('fullscreenchange', () => $('fullscreen').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏'));
document.addEventListener('keydown', event => {
  if ($('photo-dialog').open) {
    if (event.key === 'ArrowLeft') nextPhoto(-1);
    if (event.key === 'ArrowRight') nextPhoto(1);
    return;
  }
  if (['INPUT','TEXTAREA'].includes(event.target.tagName)) return;
  if ($('help-dialog').open || !universe) return;
  if (event.code === 'Space' && event.target.tagName !== 'BUTTON') { event.preventDefault(); if (universe.film) universe.stopFilm(); togglePlaying(); }
  if (event.key.toLowerCase() === 'h') toggleClean();
  if (event.key === 'Escape' && universe.film) universe.stopFilm();
});
document.addEventListener('dragenter', event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragging++; $('drop-target').classList.add('visible'); });
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', event => { event.preventDefault(); dragging = Math.max(0, dragging - 1); if (!dragging) $('drop-target').classList.remove('visible'); });
document.addEventListener('drop', event => {
  event.preventDefault(); dragging = 0; $('drop-target').classList.remove('visible');
  if (event.dataTransfer.files.length && universe) importPhotos(event.dataTransfer.files);
});
window.addEventListener('pagehide', () => { recorder?.dispose(); recorder = null; releasePhotos(photos); universe?.dispose(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); });
