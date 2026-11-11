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
import { SpatialSoundscape } from './audio.js';
import { AlbumVault } from './storage.js';
import { createDialogMotion, createGalleryController } from './gallery-ui.js';
import { createWheelStepGate, createReticleController } from './reticle.js';
import { createFocusUiController } from './focus-ui.js';
import { createCinemaExportController } from './cinema-export-ui.js';

/** @param {string} id @returns {any} */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const inspecting = params.has('inspect');
const debugEnabled = inspecting || params.has('debug');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
const finePointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
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
const SCENE_POSITIONS = 3000;
const IDLE_STAGE_MS = 2200;

let speedPresetIndex = 1;
let universe;
let photos = [];
let fallbackAtlases = [];
let pageDisposed = false;
let validPhotoIndices = [];
let yearChapters = [];
let selectedPhoto = 0;
let busy = false;
let thresholdDismissed = false;
let loaderHideTimer;
let idleStageTimer;
let hoveringStageUi = false;
let toastTimer;
let dragging = 0;

const { closeDialogSmooth, cancelDialogClosing } = createDialogMotion(reducedMotion);
const evaluateFocusWheelStep = createWheelStepGate();
const reticle = createReticleController({
  reticleEl: $('cursor-reticle'),
  numberEl: $('reticle-number'),
  labelEl: $('reticle-label'),
  finePointerQuery,
  reducedMotion,
});

function padCount(n) {
  return n < 1000 ? String(n).padStart(4, '0') : n.toLocaleString();
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

const hasOpenDialog = () => Boolean(document.querySelector('dialog[open]:not([data-closing="true"])'));
const getAppState = () => ({
  busy,
  photos,
  validPhotoIndices,
  yearChapters,
  selectedPhoto,
  universe,
});

function noteStageActivity() {
  $('app').classList.remove('is-idle');
  clearTimeout(idleStageTimer);
  if (
    busy ||
    !thresholdDismissed ||
    hoveringStageUi ||
    universe?.focusState ||
    hasOpenDialog()
  ) {
    return;
  }
  idleStageTimer = setTimeout(() => {
    if (
      !busy &&
      thresholdDismissed &&
      !hoveringStageUi &&
      !universe?.focusState &&
      !hasOpenDialog()
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
  const timeText = '00:' + String(Math.floor(clamped)).padStart(2, '0') + ' / 00:30';
  const liveInteractive = Boolean(universe?.film?.interactive && !filmExport?.isRecording?.());
  $('film-time').textContent = liveInteractive
    ? timeText + (coarsePointerQuery.matches ? ' · 可拖动 · 点按' : ' · 拖拽环视 · 点按凝视')
    : timeText;
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
  const found = FORMATIONS.findIndex((f) => f.id === mode);
  const label = found >= 0 ? FORMATIONS[found].label : '星环';
  if ($('act-roman')) $('act-roman').textContent = ROMAN_ACTS[Math.max(0, found)] || 'I';
  $('film-act').textContent = mode === 'orbit' ? '序幕 · 星环' : '形态 · ' + label;
  $('film-time').textContent = coarsePointerQuery.matches ? '轻点漫游 · 拖动环视' : '滚轮叙事 · 拖动环视';
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

function setChromeInert() {
  const hidden =
    $('app').classList.contains('clean') ||
    $('app').classList.contains('focus-active') ||
    $('app').classList.contains('threshold-locked') ||
    $('app').classList.contains('recording-active');
  /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.chrome')).forEach((element) => { element.inert = hidden; });
}

function syncPlaying() {
  const active = Boolean(universe?.running);
  const playBtn = $('play');
  if (!playBtn) return;
  playBtn.textContent = active ? '运镜：开启' : '运镜：静止';
  playBtn.setAttribute('aria-label', active ? '暂停旋转' : '继续旋转');
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

const focusUi = createFocusUiController({
  $,
  reducedMotion,
  soundscape,
  closeDialogSmooth,
  getState: getAppState,
  setSelectedPhoto: (pos) => { selectedPhoto = pos; },
  ensureThresholdDismissed: () => { if (!thresholdDismissed) enterArchiveFromThreshold(); },
  setChromeInert,
  syncPlaying,
  noteStageActivity,
  clearIdleTimer: () => clearTimeout(idleStageTimer),
});

const gallery = createGalleryController({
  $,
  getState: getAppState,
  onSelectPhoto: (index) => focusUi.showPhoto(index),
  onBeforeOpen: () => {
    if (!thresholdDismissed) enterArchiveFromThreshold();
    if (universe?.focusState) universe.closeFocus(true);
    cancelDialogClosing($('gallery-dialog'));
    clearTimeout(idleStageTimer);
    $('app').classList.remove('is-idle');
  },
  getPhotoThumbnail,
  albumVault,
});

const filmExport = createCinemaExportController({
  $,
  inspecting,
  soundscape,
  closeDialogSmooth,
  toast,
  getState: getAppState,
  ensureThresholdDismissed: () => { if (!thresholdDismissed) enterArchiveFromThreshold(); },
  showScrollChrome,
  exitScrollMode,
  syncFilmReadout,
  resetStageReadout,
  setChromeInert,
  syncPlaying,
  noteStageActivity,
});

window.addEventListener('pointerdown', () => { wakeAudio(); noteStageActivity(); }, { passive: true });
window.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch') return;
  noteStageActivity();
}, { passive: true });
window.addEventListener('touchstart', () => { wakeAudio(); noteStageActivity(); }, { passive: true });
window.addEventListener('keydown', (event) => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) wakeAudio();
  noteStageActivity();
}, { passive: true });

$('stage-hud')?.querySelectorAll('button').forEach((btn) => {
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
  if ($('loader')?.dataset.phase === 'threshold') enterArchiveFromThreshold();
});
let loaderTouchStartY = null;
$('loader')?.addEventListener('touchstart', (event) => {
  if ($('loader')?.dataset.phase === 'threshold' && event.touches.length === 1) {
    loaderTouchStartY = event.touches[0].clientY;
  }
}, { passive: true });
$('loader')?.addEventListener('touchmove', (event) => {
  if (loaderTouchStartY !== null && $('loader')?.dataset.phase === 'threshold' && event.touches.length === 1) {
    if (Math.abs(event.touches[0].clientY - loaderTouchStartY) > 18) {
      loaderTouchStartY = null;
      enterArchiveFromThreshold();
    }
  }
}, { passive: true });
$('threshold-enter')?.addEventListener('click', (event) => {
  event.stopPropagation();
  enterArchiveFromThreshold();
});
if (coarsePointerQuery.matches) {
  const promptEl = document.querySelector('#threshold-enter .threshold-prompt');
  if (promptEl) promptEl.textContent = '轻触或上滑进入暗房';
}

function updateMode(mode) {
  $('app').classList.toggle('mode-tunnel', mode === 'tunnel');
  const index = FORMATIONS.findIndex((formation) => formation.id === mode);
  if (index >= 0) $('mode-name').textContent = FORMATIONS[index].label;
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-mode]')).forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  if (!universe?.film && !universe?.scrollTimeline) {
    resetStageReadout(mode);
  }
}

function releaseAtlasCanvases(atlases) {
  for (const { canvas } of atlases || []) {
    canvas.width = 0;
    canvas.height = 0;
  }
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
  /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-mode]')).forEach((button) => {
    button.disabled = value || !universe;
  });
  $('scene').setAttribute('aria-busy', String(value));
}

function showError(message) {
  $('loader').hidden = true;
  $('error-message').textContent = message;
  $('error-card').hidden = false;
}

async function importPhotos(files, options = {}) {
  if (busy || pageDisposed) return;
  gallery.abortPending();
  if (universe?.focusState) universe.closeFocus(true);
  if (universe?.film) filmExport.leaveFilm();
  exitScrollMode(false);
  for (const dialog of /** @type {NodeListOf<HTMLDialogElement>} */ (document.querySelectorAll('dialog[open]'))) dialog.close();

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
  const bootStart = performance.now();
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
    const indices = pendingAtlases.flatMap((atlas) => atlas.photoIndices);
    if (!indices.length) throw new Error('这些照片无法解码。请转换为 JPG 或 PNG 后重新导入。');

    const skipped = (result.skipped || 0) + (pendingAtlases.diagnostics?.skippedCount || 0);
    const nextFallbackAtlases = universe ? [] : pendingAtlases;
    const shouldHoldAtThreshold = Boolean(
      universe && !thresholdDismissed && !files && !inspecting && !reducedMotion.matches,
    );

    if (universe) {
      universe.setPhotos(pendingPhotos, pendingAtlases, Math.max(SCENE_POSITIONS, indices.length), {
        genesis: true,
        threshold: shouldHoldAtThreshold,
      });
    }

    gallery.clearGalleryThumbnails();
    $('photo-preview').removeAttribute('src');
    const oldPhotos = photos;
    const oldFallbackAtlases = fallbackAtlases;
    photos = pendingPhotos;
    fallbackAtlases = nextFallbackAtlases;
    pendingPhotos = null;
    pendingAtlases = null;
    validPhotoIndices = indices;
    yearChapters = buildYearChapters(photos, validPhotoIndices);
    gallery.resetChapter();
    selectedPhoto = 0;
    releasePhotos(oldPhotos);
    releaseAtlasCanvases(oldFallbackAtlases);

    const chapterCount = yearChapters.filter((ch) => ch.year !== null).length;
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
      const minBootMs = debugEnabled ? 0 : 420;
      const waitMs = minBootMs - (performance.now() - bootStart);
      if (waitMs > 16) await new Promise((resolve) => setTimeout(resolve, waitMs));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (pageDisposed) return;
      loader.dataset.phase = 'threshold';
    } else {
      thresholdDismissed = true;
      $('app').classList.remove('threshold-locked');
    }

    if (files && !options.restoredFromVault && albumVault.enabled) {
      const localBlobs = extractLocalPhotoFiles(photos, validPhotoIndices);
      albumVault.saveFiles(localBlobs).then(() => gallery.syncVaultUI()).catch(() => {});
    } else {
      gallery.syncVaultUI();
    }

    if (options.restoredFromVault) {
      toast('已从本机恢复 ' + indices.length.toLocaleString() + ' 张私人相册' + (chapterCount ? ' · ' + chapterCount + ' 个年份章节' : ''));
    } else if (files) {
      toast(
        '已显影 ' + indices.length.toLocaleString() + ' 张照片' +
        (chapterCount ? ' · ' + chapterCount + ' 个年份章节' : '') +
        (skipped ? '（跳过 ' + skipped + ' 个文件）' : ''),
      );
    } else if (skipped) {
      toast(skipped + ' 张照片暂时无法读取');
    }
    syncPlaying();
    if (universe && validPhotoIndices.length) {
      setTimeout(() => {
        if (!pageDisposed) universe?.preloadFocusPhotos(validPhotoIndices.slice(0, 12));
      }, 180);
    }
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

function togglePlaying() {
  if (!universe || busy) return;
  if (universe.focusState) { universe.closeFocus(false); return; }
  if (universe.film) filmExport.leaveFilm();
  if (universe.scrollTimeline) exitScrollMode(false);
  universe.running = !universe.running;
  syncPlaying();
}

function toggleClean() {
  if (filmExport.isRecording() || universe?.focusState) return;
  if ($('gallery-dialog').open) closeDialogSmooth($('gallery-dialog'));
  const clean = $('app').classList.toggle('clean');
  $('restore-ui').hidden = !clean;
  setChromeInert();
  if (clean) $('restore-ui').focus({ preventScroll: true });
  else noteStageActivity();
}

function contextLost() {
  filmExport.resetFromContextLoss();
  $('app').classList.remove('focus-active', 'threshold-locked');
  $('focus-hud').hidden = true;
  universe?.dispose();
  universe = null;
  busy = false;
  setControlsDisabled(false);
  showError('三维渲染已中断。你仍可浏览接触印相，或重新开启暗房空间。');
}

try {
  universe = new PhotoUniverse($('scene'), {
    onPick: (idx, instIdx) => focusUi.showPhoto(idx, instIdx, 1),
    onHoverPhoto: (photoIndex) => {
      const key = photos[photoIndex]?.spectralKey ?? 0.5;
      soundscape.playHoverTick(key);
      universe?.preloadFocusPhotos([photoIndex]);
    },
    onHoverStateChange: (state) => {
      reticle.updateHoverState(state, photos, validPhotoIndices);
    },
    onFocusChange: focusUi.handleFocusChange,
    onModeChange: updateMode,
    onFilmProgress: syncFilmReadout,
    onFilmEnd: filmExport.endFilm,
    onContextLost: contextLost,
    onFrame: (time) => {
      reticle.updateFrame(time);
      filmExport.onFrame(time);
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
      openGallery: gallery.openGallery,
      showPhoto: focusUi.showPhoto,
    };
  }
} catch {
  showError('浏览器无法启动三维空间。请开启硬件加速，或使用新版 Chrome / Edge。接触印相仍可浏览。');
}

async function bootstrapAlbum() {
  await gallery.syncVaultUI();
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
  await gallery.syncVaultUI();
}

$('gallery-remember')?.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement) handleRememberToggle(event.target.checked);
});
$('clear-vault')?.addEventListener('click', async () => {
  await albumVault.clear().catch(() => {});
  await gallery.syncVaultUI();
  toast('已清除本机缓存相册');
});

const triggerFilePicker = () => $('file-input').click();
$('import').addEventListener('click', triggerFilePicker);
$('import-quick').addEventListener('click', triggerFilePicker);
$('file-input').addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.files?.length) {
    importPhotos(event.target.files);
  }
});

$('sound-toggle').addEventListener('click', () => {
  soundscape.toggleMuted();
  syncSoundUI();
});
$('retry').addEventListener('click', () => location.reload());
$('collection').addEventListener('click', gallery.openGallery);
$('browse-fallback').addEventListener('click', gallery.openGallery);
$('demo').addEventListener('click', () => {
  closeDialogSmooth($('gallery-dialog'), { instant: true });
  importPhotos();
});
$('brand').addEventListener('click', () => {
  if (universe?.focusState) { universe.closeFocus(false); return; }
  filmExport.leaveFilm();
  exitScrollMode(false);
  if (universe?.mode !== 'orbit') universe?.setFormation('orbit');
  else universe?.resetView(false);
});

document.querySelectorAll('.dialog-close').forEach((button) => {
  button.addEventListener('click', () => closeDialogSmooth(button.closest('dialog')));
});
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialogSmooth(dialog);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      closeDialogSmooth(dialog);
    }
  });
});

$('gallery-dialog').addEventListener('close', () => {
  if (universe && !universe.focusState && !universe.film) universe.running = gallery.wasPlaying;
  gallery.clearGalleryThumbnails();
  syncPlaying();
  noteStageActivity();
});
$('gallery-previous').addEventListener('click', () => gallery.stepPage(-1));
$('gallery-next').addEventListener('click', () => gallery.stepPage(1));

focusUi.bindFallbackModalEvents();
filmExport.bindFilmAndExportEvents();

/** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('[data-mode]')).forEach((button) => {
  button.addEventListener('click', () => {
    if (!universe || busy) return;
    if ($('gallery-dialog').open) closeDialogSmooth($('gallery-dialog'));
    filmExport.leaveFilm(false);
    exitScrollMode(false);
    soundscape.playFocusPulse(true);
    universe.setFormation(/** @type {'orbit'|'tunnel'|'sphere'|'helix'} */ (button.dataset.mode));
  });
});

$('speed-cycle').addEventListener('click', () => {
  speedPresetIndex = (speedPresetIndex + 1) % SPEED_PRESETS.length;
  const preset = SPEED_PRESETS[speedPresetIndex];
  $('speed-cycle').textContent = preset.label;
  if (universe) universe.speed = preset.speed;
});

// Unified Wheel Choreography:
// 1. Threshold Gate -> First gentle scroll unlocks soundscape + 1.8s optical rack-focus
// 2. Focus Exhibition -> Momentum-aware wheel gate steps cleanly 1 print per trackpad flick
// 3. Main Stage -> Pure 5-Act Scrollytelling with live-pose handoff
window.addEventListener('wheel', (event) => {
  if (!universe || busy || filmExport.isRecording() || hasOpenDialog() || event.ctrlKey) {
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
    const step = evaluateFocusWheelStep(rawPx, performance.now(), event.deltaMode);
    if (step !== 0) focusUi.nextPhoto(step);
    return;
  }

  event.preventDefault();
  wakeAudio();
  noteStageActivity();
  const clampedPx = Math.max(-180, Math.min(180, rawPx));
  if (universe.film) {
    const handedTime = universe.film.elapsed || 0;
    $('app').classList.remove('film-active');
    setChromeInert();
    universe.setScrollTimeline(handedTime, { immediate: true });
  }
  showScrollChrome(true);
  universe.scrollByTimeline(clampedPx * 0.011);
}, { passive: false });

$('play').addEventListener('click', togglePlaying);
$('reset').addEventListener('click', () => {
  if ($('gallery-dialog').open) closeDialogSmooth($('gallery-dialog'));
  filmExport.leaveFilm(false);
  exitScrollMode(false);
  universe?.resetView(false);
});
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

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!thresholdDismissed && (event.key === 'Enter' || event.code === 'Space')) {
    event.preventDefault();
    enterArchiveFromThreshold();
    return;
  }
  if ($('photo-dialog').open && $('photo-dialog').dataset.closing !== 'true') {
    if (event.key === 'ArrowLeft') { event.preventDefault(); focusUi.nextPhoto(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); focusUi.nextPhoto(1); }
    return;
  }
  const targetEl = event.target instanceof Element ? event.target : null;
  if ($('gallery-dialog').open && $('gallery-dialog').dataset.closing !== 'true') {
    if (event.key.toLowerCase() === 'i' && !targetEl?.closest('input,textarea,select')) {
      event.preventDefault();
      closeDialogSmooth($('gallery-dialog'));
    }
    return;
  }
  if (hasOpenDialog() || !universe) return;
  if (universe.focusState) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); focusUi.nextPhoto(-1); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); focusUi.nextPhoto(1); return; }
    if (event.key === 'Escape') { event.preventDefault(); universe.closeFocus(false); return; }
  }
  if (event.key === 'Escape' && (universe.film || universe.scrollTimeline)) {
    event.preventDefault();
    if (universe.film) filmExport.leaveFilm();
    else exitScrollMode(true);
    return;
  }
  if (targetEl?.closest('input,textarea,select,[role="slider"]')) return;
  if (event.code === 'Space' && !targetEl?.closest('button,a')) { event.preventDefault(); togglePlaying(); return; }
  const lowerKey = event.key.toLowerCase();
  if (lowerKey === 'h') { toggleClean(); return; }
  if (lowerKey === 'm') { $('sound-toggle')?.click(); return; }
  if (lowerKey === 'i' && !busy && !filmExport.isRecording()) { gallery.openGallery(); return; }
  if (!busy && !filmExport.isRecording() && !universe.focusState && ['1', '2', '3', '4'].includes(event.key)) {
    const targetMode = FORMATIONS[Number(event.key) - 1]?.id;
    if (targetMode) {
      filmExport.leaveFilm(false);
      exitScrollMode(false);
      soundscape.playFocusPulse(true);
      universe.setFormation(/** @type {'orbit'|'tunnel'|'sphere'|'helix'} */ (targetMode));
    }
  }
});

document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragging++;
  $('drop-target').classList.add('visible');
});
document.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragging = Math.max(0, dragging - 1);
  if (!dragging) $('drop-target').classList.remove('visible');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  dragging = 0;
  $('drop-target').classList.remove('visible');
  if (event.dataTransfer.files.length) importPhotos(event.dataTransfer.files);
});

window.addEventListener('pagehide', (event) => {
  clearTimeout(toastTimer);
  clearTimeout(loaderHideTimer);
  clearTimeout(idleStageTimer);
  focusUi.dispose();
  filmExport.dispose(event.persisted);
  if (event.persisted) return;
  pageDisposed = true;
  gallery.clearGalleryThumbnails();
  releasePhotos(photos);
  releaseAtlasCanvases(fallbackAtlases);
  fallbackAtlases = [];
  albumVault.dispose();
  soundscape.dispose();
  universe?.dispose();
});

reducedMotion.addEventListener('change', (event) => {
  if (!universe) return;
  universe.reducedMotion = event.matches;
  universe.pointerEnabled = !event.matches && finePointerQuery.matches;
  if (event.matches) {
    if (!thresholdDismissed) enterArchiveFromThreshold();
    filmExport.leaveFilm();
    universe.running = false;
  }
  syncPlaying();
});
