import { CanvasRecorder, CINEMA_VIDEO_BITS_PER_SECOND } from './recording.js';
import { FrameProfiler } from './performance.js';

/**
 * 30-second autonomous film playback, 18 Mbps 16:9 / 9:16 cinema recording,
 * edge-hairline timeline scrubbing, and frame-rate diagnostic profiler UI.
 */
export function createCinemaExportController({
  $,
  inspecting,
  soundscape,
  closeDialogSmooth,
  toast,
  getState,
  ensureThresholdDismissed,
  showScrollChrome,
  exitScrollMode,
  syncFilmReadout,
  resetStageReadout,
  setChromeInert,
  syncPlaying,
  noteStageActivity,
}) {
  const profiler = new FrameProfiler();
  let recorder = null;
  let downloadUrl = null;
  let filmFocus = null;
  let profileTimer;
  let lastProfileDisplay = 0;
  let scrubbingFilm = false;
  let exportAspect = 'auto';

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
    $('performance-output').textContent =
      result.frames + ' 帧 · ' + result.durationSeconds.toFixed(2) + ' 秒\n' +
      '中位 ' + result.medianFps.toFixed(1) + ' fps\n' +
      'p95 ' + result.p95FrameMs.toFixed(2) + ' ms · 最长 ' + result.maxFrameMs.toFixed(2) + ' ms\n' +
      '>50ms ' + result.over50ms + ' · >250ms ' + result.over250ms;
    $('performance-output').dataset.report = JSON.stringify(result);
  }

  function onFrame(time) {
    if (!inspecting || !profiler.active) return;
    profiler.push(time);
    if (time - lastProfileDisplay > 1000) {
      $('performance-output').textContent = '采样中 · ' + profiler.frameCount + ' 帧';
      lastProfileDisplay = time;
    }
  }

  function applyExportFraming() {
    const { universe } = getState();
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
    getState().universe?.clearExportResolution();
  }

  function setRecordingUI(active) {
    const { universe } = getState();
    $('record').classList.toggle('recording', active);
    $('app').classList.toggle('recording-active', active);
    $('timeline-scrub-zone').hidden = active || (!universe?.film && !$('app').classList.contains('scroll-active'));
    const label = active ? '结束录制' : '录制音画';
    $('record').textContent = label;
    $('record').setAttribute('aria-label', label);
    setChromeInert();
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

  function playFilm() {
    const { busy, photos, universe } = getState();
    if (busy || !photos.length || !universe) return;
    ensureThresholdDismissed();
    if ($('gallery-dialog').open) closeDialogSmooth($('gallery-dialog'));
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
    const { universe } = getState();
    if (!universe?.film) return;
    universe.stopFilm(true, false);
    if (returnToOrbit) universe.setFormation('orbit');
  }

  function recordingFailed(message) {
    const { universe } = getState();
    recorder = null;
    setRecordingUI(false);
    restoreExportFraming();
    if (universe?.film) {
      universe.stopFilm(false, false);
      universe.setFormation('orbit');
    }
    showFilmChrome(false);
    if (inspecting && profiler.active) finishProfile();
    toast(message);
  }

  function recordFilm() {
    if (recorder) {
      leaveFilm();
      return;
    }
    const { busy, photos, universe } = getState();
    if (busy || !photos.length || !universe) return;
    ensureThresholdDismissed();
    if ($('gallery-dialog').open) closeDialogSmooth($('gallery-dialog'), { instant: true });
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
      onStop: (video) => { recorder = null; setRecordingUI(false); restoreExportFraming(); downloadRecording(video); },
      onError: (error) => recordingFailed(started ? '录制失败，请重新尝试' : '无法启动录制：' + error.message),
    });
    recorder.start();
  }

  function resetFromContextLoss() {
    recorder?.dispose();
    recorder = null;
    setRecordingUI(false);
    restoreExportFraming();
    getState().universe?.stopFilm(false, false);
    showFilmChrome(false);
    if (profiler.active) finishProfile();
  }

  function bindFilmAndExportEvents() {
    document.querySelectorAll('[data-aspect]').forEach((button) => {
      button.addEventListener('click', () => {
        exportAspect = button.dataset.aspect;
        document.querySelectorAll('[data-aspect]').forEach((link) => {
          link.setAttribute('aria-pressed', String(link.dataset.aspect === exportAspect));
        });
      });
    });

    const scrubZone = $('timeline-scrub-zone');
    const scrubAtClientX = (clientX, paused) => {
      const { universe } = getState();
      if ((!universe?.film && !universe?.scrollTimeline) || recorder) return;
      const ratio = Math.max(0, Math.min(1, clientX / Math.max(1, window.innerWidth)));
      const seconds = ratio * 29.65;
      if (universe.film) universe.seekFilmLive(seconds, { paused });
      else universe.setScrollTimeline(seconds, { immediate: true });
    };
    scrubZone?.addEventListener('pointerdown', (event) => {
      const { universe } = getState();
      if ((!universe?.film && !universe?.scrollTimeline) || recorder) return;
      scrubbingFilm = true;
      scrubZone.setPointerCapture?.(event.pointerId);
      scrubAtClientX(event.clientX, true);
    });
    scrubZone?.addEventListener('pointermove', (event) => {
      if (!scrubbingFilm) return;
      scrubAtClientX(event.clientX, true);
    });
    const endEdgeScrub = (event) => {
      if (!scrubbingFilm) return;
      scrubbingFilm = false;
      const { universe } = getState();
      if (universe?.film && !recorder) {
        const ratio = Math.max(0, Math.min(1, event.clientX / Math.max(1, window.innerWidth)));
        universe.seekFilmLive(ratio * 29.65, { paused: false });
      }
    };
    scrubZone?.addEventListener('pointerup', endEdgeScrub);
    scrubZone?.addEventListener('pointercancel', endEdgeScrub);

    document.querySelectorAll('[data-act-seek]').forEach((button) => {
      button.addEventListener('click', () => {
        const { universe, busy } = getState();
        if (!universe || busy || recorder) return;
        if ($('gallery-dialog').open) closeDialogSmooth($('gallery-dialog'));
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

    $('film')?.addEventListener('click', playFilm);
    $('film-quick')?.addEventListener('click', playFilm);
    for (const el of [$('act-roman'), $('film-act'), $('film-time')]) {
      el?.addEventListener('click', () => {
        const { universe, busy } = getState();
        if (!universe || busy || universe.film || universe.focusState) return;
        playFilm();
      });
    }
    $('stop-film')?.addEventListener('click', () => {
      if (getState().universe?.film) leaveFilm();
      else exitScrollMode(true);
    });
    $('record')?.addEventListener('click', recordFilm);

    if (inspecting) {
      $('inspection-panel').hidden = false;
      $('sample-performance')?.addEventListener('click', startProfile);
      $('stop-performance')?.addEventListener('click', finishProfile);
      document.querySelectorAll('[data-inspect-seek]').forEach((button) => {
        button.addEventListener('click', () => {
          const { busy, universe, photos } = getState();
          if (busy || !universe || !photos.length) return;
          const seconds = Number(button.dataset.inspectSeek);
          showFilmChrome(true);
          universe.debugSeekFilm(seconds);
          syncFilmReadout(seconds);
        });
      });
    }
  }

  function dispose(persisted = false) {
    clearTimeout(profileTimer);
    recorder?.dispose();
    recorder = null;
    setRecordingUI(false);
    restoreExportFraming();
    const { universe } = getState();
    if (universe?.film) {
      universe.stopFilm(false, false);
      showFilmChrome(false);
    }
    if (profiler.active) finishProfile();
    if (!persisted && downloadUrl) {
      URL.revokeObjectURL(downloadUrl);
      downloadUrl = null;
    }
  }

  return {
    playFilm,
    endFilm,
    leaveFilm,
    recordFilm,
    onFrame,
    isRecording: () => Boolean(recorder),
    resetFromContextLoss,
    bindFilmAndExportEvents,
    dispose,
  };
}
