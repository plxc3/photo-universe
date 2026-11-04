const FPS = 30;
const VIDEO_BITS_PER_SECOND = 8_000_000;
export const CINEMA_VIDEO_BITS_PER_SECOND = 18_000_000;
const AUDIO_BITS_PER_SECOND = 160_000;
const TIMESLICE_MS = 1000;
const MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/mp4",
  "video/webm",
];
const AUDIO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  ...MIME_CANDIDATES,
];

const noop = () => {};

function stopTracks(stream) {
  if (!stream || typeof stream.getTracks !== "function") return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Tracks may already be gone; cleanup is best-effort.
    }
  }
}

function attempt(action) {
  try {
    action();
  } catch {
    // Teardown must never throw out of a browser callback.
  }
}

export class CanvasRecorder {
  constructor(canvas, { onStart, onStop, onError, audioTrack = null, fps = FPS, videoBitsPerSecond = VIDEO_BITS_PER_SECOND } = {}) {
    this._canvas = canvas;
    this._onStart = typeof onStart === "function" ? onStart : noop;
    this._onStop = typeof onStop === "function" ? onStop : noop;
    this._onError = typeof onError === "function" ? onError : noop;
    this._audioTrack = audioTrack || null;
    this._fps = Number.isFinite(fps) && fps > 0 ? fps : FPS;
    this._videoBitsPerSecond = Number.isFinite(videoBitsPerSecond) && videoBitsPerSecond > 0
      ? videoBitsPerSecond
      : VIDEO_BITS_PER_SECOND;
    this._state = "idle";
    this._stream = null;
    this._recorder = null;
    // Holds only per-round state (stream, recorder, chunks, settled flag) so
    // queued events from a finished round cannot observe or disturb a new one.
    this._session = null;
  }

  get state() {
    return this._state;
  }

  static isSupported() {
    return (
      typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function"
    );
  }

  static pickMimeType(withAudio = false) {
    if (
      typeof MediaRecorder === "undefined" ||
      typeof MediaRecorder.isTypeSupported !== "function"
    ) {
      return null;
    }
    const candidates = withAudio ? AUDIO_MIME_CANDIDATES : MIME_CANDIDATES;
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return null;
  }

  static extensionFor(mimeType) {
    return mimeType && mimeType.includes("mp4") ? "mp4" : "webm";
  }

  // Genuinely stop the recorder and hand back every resource the session owns.
  _release(session) {
    if (!session || session.released) return;
    session.released = true;
    const recorder = session.recorder;
    if (recorder) {
      attempt(() => {
        recorder.ondataavailable = null;
        recorder.onerror = null;
        recorder.onstop = null;
      });
      let state = "inactive";
      try {
        state = recorder.state;
      } catch {
        state = null;
      }
      if (state !== "inactive") attempt(() => recorder.stop());
    }
    attempt(() => stopTracks(session.stream));
    attempt(() => stopTracks(recorder && recorder.stream));
    if (session.audioTrack && typeof session.audioTrack.stop === "function") {
      attempt(() => session.audioTrack.stop());
    }
    session.chunks = [];
  }

  _abandon(session) {
    this._release(session);
    if (!session || this._session !== session) return;
    this._session = null;
    this._recorder = null;
    this._stream = null;
    if (this._state === "recording" || this._state === "stopping") this._state = "idle";
  }

  // One-way door: the first settle for a session wins, forever.
  _settle(session, error, payload) {
    if (!session || session.settled) return;
    session.settled = true;
    this._abandon(session);
    if (error) this._onError(error);
    else if (payload) this._onStop(payload);
  }

  _complete(session) {
    if (session.chunks.length === 0) {
      this._settle(session, new Error("Recording produced no data"), null);
      return;
    }
    const { mimeType } = session;
    let blob;
    try {
      blob = new Blob(session.chunks, { type: mimeType });
    } catch (error) {
      this._settle(session, error, null);
      return;
    }
    this._settle(session, null, {
      blob,
      mimeType,
      extension: CanvasRecorder.extensionFor(mimeType),
    });
  }

  start() {
    if (this._state !== "idle") return;
    if (!CanvasRecorder.isSupported()) {
      this._onError(new Error("Recording is not supported in this browser"));
      return;
    }
    if (!this._canvas || typeof this._canvas.captureStream !== "function") {
      this._onError(new Error("Canvas is unavailable"));
      return;
    }
    const hasAudio = Boolean(this._audioTrack);
    const mimeType = CanvasRecorder.pickMimeType(hasAudio) || CanvasRecorder.pickMimeType(false);
    if (!mimeType) {
      this._onError(new Error("No supported recording mime type"));
      return;
    }

    const session = {
      stream: null,
      recorder: null,
      audioTrack: this._audioTrack,
      chunks: [],
      mimeType,
      settled: false,
      released: false,
    };
    this._session = session;
    try {
      const stream = this._canvas.captureStream(this._fps);
      session.stream = stream;
      this._stream = stream;

      let recorder;
      if (hasAudio && typeof stream.addTrack === "function") {
        try {
          stream.addTrack(this._audioTrack);
          recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: this._videoBitsPerSecond,
            audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          });
        } catch {
          if (typeof stream.removeTrack === "function") {
            attempt(() => stream.removeTrack(this._audioTrack));
          }
          const fallbackMime = CanvasRecorder.pickMimeType(false) || mimeType;
          session.mimeType = fallbackMime;
          recorder = new MediaRecorder(stream, {
            mimeType: fallbackMime,
            videoBitsPerSecond: this._videoBitsPerSecond,
          });
        }
      } else {
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: this._videoBitsPerSecond,
        });
      }
      session.recorder = recorder;
      this._recorder = recorder;

      recorder.ondataavailable = (event) => {
        if (session.settled) return;
        const data = event && event.data;
        if (data && data.size > 0) session.chunks.push(data);
      };
      recorder.onerror = (event) => {
        this._settle(session, (event && event.error) || new Error("MediaRecorder error"), null);
      };
      recorder.onstop = () => {
        this._complete(session);
      };

      recorder.start(TIMESLICE_MS);
      this._state = "recording";
      this._onStart();
    } catch (error) {
      this._settle(session, error, null);
    }
  }

  stop() {
    if (this._state !== "recording") return;
    const session = this._session;
    if (!session || !session.recorder) {
      this._settle(
        session || { stream: null, recorder: null, chunks: [], mimeType: null, settled: false, released: false },
        new Error("Recorder is unavailable"),
        null,
      );
      return;
    }
    this._state = "stopping";
    try {
      session.recorder.stop();
    } catch (error) {
      this._settle(session, error, null);
    }
  }

  dispose() {
    const session = this._session;
    this._state = "disposed";
    this._canvas = null;
    if (session) {
      session.settled = true;
      this._abandon(session);
    }
  }
}
