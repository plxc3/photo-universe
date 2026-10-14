import test from "node:test";
import assert from "node:assert/strict";
import { CanvasRecorder } from "./recording.js";

// --- lightweight browser doubles -------------------------------------------

class FakeChunk {
  constructor(size) {
    this.size = size;
  }
}

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options && options.type;
    this.size = parts.reduce((total, part) => total + part.size, 0);
  }
}

class FakeTrack {
  constructor() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  constructor() {
    this.tracks = [new FakeTrack(), new FakeTrack()];
  }
  getTracks() {
    return this.tracks;
  }
  get allStopped() {
    return this.tracks.every((track) => track.stopped);
  }
}

class FakeMediaRecorder {
  constructor(stream, options) {
    if (FakeMediaRecorder.throwOnConstruct) throw new Error("encoder unavailable");
    this.stream = stream;
    this.options = options;
    this._state = "inactive";
    this.ondataavailable = null;
    this.onerror = null;
    this.onstop = null;
    this.startCalls = [];
    this.stopCalls = 0;
    // Set by the harness: what the browser still owes this recorder.
    this.pending = [];
  }
  get state() {
    return this._state;
  }
  start(timeslice) {
    if (FakeMediaRecorder.throwOnStart) throw new Error("capture refused");
    this.startCalls.push(timeslice);
    this._state = "recording";
  }
  stop() {
    this.stopCalls += 1;
    if (FakeMediaRecorder.throwOnStop) throw new Error("stop refused");
    this._state = "inactive";
    if (!FakeMediaRecorder.autoSettle) return;
    // Real browsers flush the tail slice, then report the stop asynchronously.
    this.emitData(new FakeChunk(FakeMediaRecorder.tailSize));
    this.emitStop();
    this.deliverLater();
  }
  emitData(data) {
    const handler = this.ondataavailable;
    if (handler) this.pending.push(() => handler({ data }));
  }
  emitError(error) {
    const handler = this.onerror;
    if (handler) this.pending.push(() => handler({ error }));
  }
  emitStop() {
    const handler = this.onstop;
    if (handler) this.pending.push(() => handler());
  }
  deliverLater() {
    queueMicrotask(() => this.flush());
  }
  flush() {
    const queued = this.pending;
    this.pending = [];
    for (const fire of queued) fire();
  }
  drainAsync() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createEnv({ supported = ["video/webm;codecs=vp9"], captureStreamError = null } = {}) {
  const streams = [];
  const recorders = [];
  const canvas = {
    captureStream() {
      if (captureStreamError) throw captureStreamError;
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
  };
  class Recorder extends FakeMediaRecorder {
    constructor(stream, options) {
      super(stream, options);
      recorders.push(this);
    }
    static isTypeSupported(type) {
      return supported.includes(type);
    }
  }
  class Canvas {
    captureStream() {
      return canvas.captureStream();
    }
  }
  globalThis.MediaRecorder = Recorder;
  globalThis.HTMLCanvasElement = Canvas;
  globalThis.Blob = FakeBlob;
  FakeMediaRecorder.throwOnConstruct = false;
  FakeMediaRecorder.throwOnStart = false;
  FakeMediaRecorder.throwOnStop = false;
  FakeMediaRecorder.tailSize = 4;
  FakeMediaRecorder.autoSettle = true;
  return {
    canvas,
    streams,
    recorders,
    get recorder() {
      return recorders[recorders.length - 1];
    },
  };
}

function trackCalls() {
  const calls = { started: 0, stopped: [], errored: [] };
  return {
    calls,
    handlers: {
      onStart() {
        calls.started += 1;
      },
      onStop(payload) {
        calls.stopped.push(payload);
      },
      onError(error) {
        calls.errored.push(error);
      },
    },
  };
}

function clearEnv() {
  delete globalThis.MediaRecorder;
  delete globalThis.HTMLCanvasElement;
  delete globalThis.Blob;
}

// --- tests ------------------------------------------------------------------

test("records the first supported mime type and hands back the finished blob", async () => {
  const env = createEnv({ supported: ["video/mp4", "video/webm;codecs=vp8"] });
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    assert.equal(CanvasRecorder.pickMimeType(), "video/webm;codecs=vp8", "skips unsupported encoders in order");

    recorder.start();
    assert.equal(recorder.state, "recording");
    assert.equal(seen.calls.started, 1);
    assert.equal(env.recorders.length, 1);
    assert.deepEqual(env.recorder.startCalls, [1000]);
    assert.equal(env.recorder.options.mimeType, "video/webm;codecs=vp8");
    assert.equal(env.recorder.options.videoBitsPerSecond, 8_000_000);

    env.recorder.emitData(new FakeChunk(10));
    env.recorder.flush();

    recorder.stop();
    await env.recorder.drainAsync();

    assert.equal(recorder.state, "idle");
    assert.equal(seen.calls.stopped.length, 1);
    assert.equal(seen.calls.errored.length, 0);
    const { blob, mimeType, extension } = seen.calls.stopped[0];
    assert.equal(mimeType, "video/webm;codecs=vp8");
    assert.equal(extension, "webm");
    assert.equal(blob.parts.length, 2, "includes the tail flush from stop()");
    assert.equal(blob.size, 14);

    assert.ok(env.streams[0].allStopped, "capture stream tracks are released");
    assert.equal(env.recorder.stopCalls, 1, "the real recorder is stopped");
    assert.equal(env.recorder.state, "inactive");
    assert.equal(env.recorder.onstop, null);
    assert.equal(env.recorder.onerror, null);
    assert.equal(env.recorder.ondataavailable, null);
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("chooses mp4 when the browser only encodes mp4", async () => {
  const env = createEnv({ supported: ["video/mp4"] });
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    assert.equal(CanvasRecorder.pickMimeType(), "video/mp4");
    recorder.start();
    recorder.stop();
    await env.recorder.drainAsync();
    assert.equal(seen.calls.stopped[0].extension, "mp4");
    assert.equal(CanvasRecorder.extensionFor("video/mp4"), "mp4");
    assert.equal(CanvasRecorder.extensionFor("video/webm;codecs=vp8"), "webm");
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("state is read-only and MediaRecorder.state is never assigned", () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(recorder), "state");
    assert.ok(descriptor.get, "exposed through a getter");
    assert.equal(descriptor.set, undefined, "no setter");
    assert.equal(
      Object.getOwnPropertyDescriptor(FakeMediaRecorder.prototype, "state").set,
      undefined,
      "doubles keep state read-only like the browser",
    );

    // Read-only state: assigning to it throws, so any attempt to fake a stop
    // by writing recorder.state would blow up here instead of passing silently.
    recorder.start();
    assert.throws(() => {
      env.recorder.state = "inactive";
    }, TypeError);
    recorder.stop();
    assert.equal(seen.calls.stopped.length, 0, "stop is deferred until the browser reports it");
    assert.equal(recorder.state, "stopping");
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("an asynchronous recorder error wins over any later success", async () => {
  const env = createEnv();
  FakeMediaRecorder.autoSettle = false;
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    recorder.start();
    env.recorder.emitData(new FakeChunk(10));
    env.recorder.flush();

    recorder.stop();
    // The tail slice is still queued when the failure arrives.
    env.recorder.emitData(new FakeChunk(4));
    env.recorder.emitError(new Error("encode failed"));
    env.recorder.emitStop();
    env.recorder.deliverLater();
    await env.recorder.drainAsync();

    assert.equal(seen.calls.errored.length, 1);
    assert.equal(seen.calls.errored[0].message, "encode failed");
    assert.equal(seen.calls.stopped.length, 0, "an error never turns into a download");
    assert.equal(recorder.state, "idle");
    assert.ok(env.streams[0].allStopped);

    // Late callbacks must not settle the same session a second time.
    env.recorder.emitStop();
    env.recorder.emitError(new Error("late"));
    env.recorder.flush();
    await env.recorder.drainAsync();
    assert.equal(seen.calls.stopped.length, 0);
    assert.equal(seen.calls.errored.length, 1);
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("a throwing stop() is reported as an error, not as a completed recording", async () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    recorder.start();
    env.recorder.emitData(new FakeChunk(10));
    env.recorder.flush();

    FakeMediaRecorder.throwOnStop = true;
    recorder.stop();
    await env.recorder.drainAsync();

    assert.equal(seen.calls.errored.length, 1);
    assert.equal(seen.calls.errored[0].message, "stop refused");
    assert.equal(seen.calls.stopped.length, 0);
    assert.equal(recorder.state, "idle", "never left claiming a recording is in flight");
    assert.ok(env.streams[0].allStopped);

    // A queued onstop for the abandoned session must stay silent.
    env.recorder.emitStop();
    env.recorder.flush();
    assert.equal(seen.calls.stopped.length, 0);
  } finally {
    FakeMediaRecorder.throwOnStop = false;
    recorder.dispose();
    clearEnv();
  }
});

test("stale callbacks from a finished session cannot disturb a new recording", async () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    recorder.start();
    const first = env.recorder;
    const staleStop = first.onstop;
    const staleError = first.onerror;
    const staleData = first.ondataavailable;
    first.emitData(new FakeChunk(10));
    first.flush();
    recorder.stop();
    await first.drainAsync();
    assert.equal(seen.calls.stopped.length, 1);

    recorder.start();
    assert.equal(env.recorders.length, 2, "a second stream is captured");
    const second = env.recorder;
    assert.equal(seen.calls.started, 2);

    staleStop();
    staleError(new Error("stale"));
    staleData({ data: new FakeChunk(99) });
    second.emitData(new FakeChunk(7));
    second.flush();
    await second.drainAsync();

    assert.equal(seen.calls.stopped.length, 1, "stale onstop did not settle the new session");
    assert.equal(seen.calls.errored.length, 0);
    assert.equal(recorder.state, "recording");

    recorder.stop();
    await second.drainAsync();
    assert.equal(seen.calls.stopped.length, 2);
    assert.equal(seen.calls.stopped[1].blob.parts.length, 2, "only the new chunks are kept");
    assert.ok(env.streams[0].allStopped && env.streams[1].allStopped);
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("a failing MediaRecorder constructor releases the captured stream", () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    FakeMediaRecorder.throwOnConstruct = true;
    recorder.start();

    assert.equal(seen.calls.started, 0);
    assert.equal(seen.calls.errored.length, 1);
    assert.equal(seen.calls.errored[0].message, "encoder unavailable");
    assert.equal(recorder.state, "idle");
    assert.ok(env.streams[0].allStopped, "no orphan camera-style stream keeps running");

    FakeMediaRecorder.throwOnConstruct = false;
    recorder.start();
    assert.equal(recorder.state, "recording", "usable again after a failed start");
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("a failing start() reports the error and tears the session down", () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    FakeMediaRecorder.throwOnStart = true;
    recorder.start();
    assert.equal(seen.calls.started, 0);
    assert.equal(seen.calls.errored.length, 1);
    assert.equal(recorder.state, "idle");
    assert.ok(env.streams[0].allStopped);
    assert.equal(env.recorder.onstop, null, "callbacks detached on the failure path");
  } finally {
    FakeMediaRecorder.throwOnStart = false;
    recorder.dispose();
    clearEnv();
  }
});

test("a captureStream failure reports an error without touching the recorder", () => {
  const env = createEnv({ captureStreamError: new Error("GPU busy") });
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    recorder.start();
    assert.equal(seen.calls.errored.length, 1);
    assert.equal(seen.calls.errored[0].message, "GPU busy");
    assert.equal(env.recorders.length, 0);
    assert.equal(recorder.state, "idle");
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("a recording that produced no data is an error, not an empty download", async () => {
  const env = createEnv();
  FakeMediaRecorder.tailSize = 0;
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    recorder.start();
    recorder.stop();
    await env.recorder.drainAsync();
    assert.equal(seen.calls.stopped.length, 0);
    assert.equal(seen.calls.errored.length, 1);
    assert.match(seen.calls.errored[0].message, /no data/i);
    assert.equal(recorder.state, "idle");
    assert.ok(env.streams[0].allStopped);
  } finally {
    FakeMediaRecorder.tailSize = 4;
    recorder.dispose();
    clearEnv();
  }
});

test("unsupported browsers and unusable canvases report an error instead of starting", () => {
  const seen = trackCalls();
  clearEnv();
  const unsupported = new CanvasRecorder({ captureStream: () => new FakeStream() }, seen.handlers);
  unsupported.start();
  assert.equal(seen.calls.errored.length, 1);
  assert.match(seen.calls.errored[0].message, /not supported/i);
  assert.equal(unsupported.state, "idle");

  const env = createEnv({ supported: [] });
  const noEncoder = new CanvasRecorder(env.canvas, seen.handlers);
  noEncoder.start();
  assert.equal(seen.calls.errored.length, 2);
  assert.match(seen.calls.errored[1].message, /mime type/i);

  const noCanvas = new CanvasRecorder(null, seen.handlers);
  noCanvas.start();
  assert.equal(seen.calls.errored.length, 3);
  assert.equal(CanvasRecorder.isSupported(), true);
  clearEnv();
});

test("dispose stops and silences a live recording, and is safe to repeat", async () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  recorder.start();
  const live = env.recorder;
  live.emitData(new FakeChunk(10));
  live.flush();

  recorder.dispose();
  assert.equal(recorder.state, "disposed");
  assert.equal(live.stopCalls, 1, "the browser recorder really stops");
  assert.equal(live.state, "inactive");
  assert.ok(env.streams[0].allStopped);
  assert.equal(live.onstop, null);
  assert.equal(live.onerror, null);
  assert.equal(live.ondataavailable, null);

  // Whatever the browser still had queued must not reach the page.
  recorder.dispose();
  recorder.dispose();
  assert.equal(live.stopCalls, 1, "repeated dispose does not stop it twice");
  assert.equal(seen.calls.stopped.length, 0, "no download after dispose");
  assert.equal(seen.calls.errored.length, 0);

  recorder.start();
  recorder.stop();
  assert.equal(env.recorders.length, 1, "a disposed recorder stays disposed");
  assert.equal(seen.calls.started, 1);
  await live.drainAsync();
  assert.equal(seen.calls.stopped.length, 0);
  assert.equal(seen.calls.errored.length, 0);
  clearEnv();
});

test("onStart only reports while the session is genuinely live", async () => {
  const env = createEnv();
  const seen = trackCalls();
  let stateAtStart = null;
  let tracksDeadAtStart = null;
  const recorder = new CanvasRecorder(env.canvas, {
    ...seen.handlers,
    onStart() {
      seen.handlers.onStart();
      stateAtStart = recorder.state;
      tracksDeadAtStart = env.streams[0].tracks.every((track) => track.stopped);
    },
  });
  try {
    recorder.start();
    assert.equal(seen.calls.started, 1);
    assert.equal(stateAtStart, "recording", "the page can paint its recording state from onStart");
    assert.equal(tracksDeadAtStart, false, "the capture stream is still feeding the recorder");

    recorder.stop();
    await env.recorder.drainAsync();
    assert.equal(recorder.state, "idle", "and the session ends once the browser reports the stop");
    assert.ok(env.streams[0].allStopped);
  } finally {
    recorder.dispose();
    clearEnv();
  }
});

test("stop before start and double stop are no-ops", async () => {
  const env = createEnv();
  const seen = trackCalls();
  const recorder = new CanvasRecorder(env.canvas, seen.handlers);
  try {
    recorder.stop();
    assert.equal(seen.calls.errored.length, 0);
    assert.equal(recorder.state, "idle");

    recorder.start();
    recorder.stop();
    recorder.stop();
    await env.recorder.drainAsync();
    assert.equal(env.recorder.stopCalls, 1);
    assert.equal(seen.calls.stopped.length, 1);

    recorder.start();
    assert.equal(recorder.state, "recording", "sequential recordings reuse one recorder instance");
    assert.equal(env.recorders.length, 2);
    assert.equal(env.streams.length, 2);
    assert.equal(seen.calls.started, 2);
  } finally {
    recorder.dispose();
    clearEnv();
  }
});
