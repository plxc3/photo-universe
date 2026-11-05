// Hybrid spatial soundscape: zero-KB initial boot via procedural Web Audio synthesis
// (darkroom sub-drone, Doppler corridor wind, crystalline stellation harmonics, and
// pentatonic hover micro-foley) blended with an on-demand lazy-loaded stereo felt-piano
// & bowed-cello chamber stem once audio is enabled, routed to both speakers and video export.

const PENTATONIC_HZ = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.25, 739.99, 880.0];

export class SpatialSoundscape {
  constructor({
    AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
    stemUrl = null,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this._AudioContext = AudioContextClass;
    this._stemUrl = stemUrl;
    this._fetch = fetchImpl;
    this._ctx = null;
    this._master = null;
    this._exportMaster = null;
    this._streamDest = null;
    this._droneGain = null;
    this._droneFilter = null;
    this._windGain = null;
    this._windFilter = null;
    this._windPanner = null;
    this._crystalGain = null;
    this._stemSource = null;
    this._stemGain = null;
    this._stemFilter = null;
    this._stemLoading = false;
    this._stemPromise = null;
    this._oscillators = [];
    this._muted = false;
    this._disposed = false;
    this._lastTickMs = -Infinity;
    this._initialized = false;
  }

  get muted() {
    return this._muted;
  }

  get active() {
    return Boolean(this._ctx && this._ctx.state === 'running' && !this._muted);
  }

  get stemLoaded() {
    return Boolean(this._stemSource);
  }

  isSupported() {
    return typeof this._AudioContext === 'function';
  }

  ensureStarted() {
    if (this._disposed || !this.isSupported()) return false;
    if (!this._ctx) {
      try {
        this._buildGraph();
      } catch {
        return false;
      }
    }
    if (this._ctx?.state === 'suspended') {
      this._ctx.resume?.().catch(() => {});
    }
    if (!this._muted) {
      this._ensureAcousticStem();
    }
    return Boolean(this._ctx);
  }

  _ensureAcousticStem() {
    if (
      this._disposed ||
      this._muted ||
      !this._stemUrl ||
      this._stemSource ||
      this._stemLoading ||
      !this._ctx ||
      typeof this._fetch !== 'function' ||
      typeof this._ctx.decodeAudioData !== 'function' ||
      typeof this._ctx.createBufferSource !== 'function'
    ) {
      return this._stemPromise;
    }
    this._stemLoading = true;
    const ctx = this._ctx;
    const fetchFn = this._fetch;
    const stemUrl = this._stemUrl;
    this._stemPromise = Promise.resolve()
      .then(() => fetchFn(stemUrl))
      .then(res => {
        if (!res?.ok) throw new Error('Acoustic stem HTTP ' + (res?.status || 0));
        return res.arrayBuffer();
      })
      .then(buf => ctx.decodeAudioData(buf))
      .then(audioBuffer => {
        if (this._disposed || this._ctx !== ctx) return false;
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.loop = true;

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1850;
        filter.Q.value = 0.55;

        const gain = ctx.createGain();
        const now = ctx.currentTime || 0;
        gain.gain.value = 0.0001;
        gain.gain.setValueAtTime?.(0.0001, now);
        gain.gain.setTargetAtTime?.(0.46, now, 0.75);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this._bus);
        source.start(0);

        this._stemSource = source;
        this._stemFilter = filter;
        this._stemGain = gain;
        this._oscillators.push(source);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        this._stemLoading = false;
      });
    return this._stemPromise;
  }

  _buildGraph() {
    const ctx = new this._AudioContext();
    this._ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this._muted ? 0 : 0.72;
    master.connect(ctx.destination);
    this._master = master;

    // Separate pre-mute export bus so recorded videos include the soundtrack
    // unless the user explicitly muted audio.
    const exportMaster = ctx.createGain();
    exportMaster.gain.value = this._muted ? 0 : 0.82;
    this._exportMaster = exportMaster;
    if (typeof ctx.createMediaStreamDestination === 'function') {
      this._streamDest = ctx.createMediaStreamDestination();
      exportMaster.connect(this._streamDest);
    }

    const bus = ctx.createGain();
    bus.gain.value = 1.0;
    bus.connect(master);
    bus.connect(exportMaster);
    this._bus = bus;

    // 1) Warm analog D-major-9 darkroom pad
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 260;
    droneFilter.Q.value = 0.7;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.045;
    droneFilter.connect(droneGain);
    droneGain.connect(bus);
    this._droneFilter = droneFilter;
    this._droneGain = droneGain;

    for (const [freq, type, gainVal] of [
      [73.42, 'sine', 0.48],     // D2 sub
      [110.0, 'triangle', 0.24], // A2 fifth
      [146.83, 'sine', 0.22],    // D3
      [184.99, 'sine', 0.14],    // F#3 warm third
    ]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gainVal;
      osc.connect(g);
      g.connect(droneFilter);
      osc.start();
      this._oscillators.push(osc);
    }

    // 2) Filtered Brownian/pink corridor wind rush
    if (typeof ctx.createBuffer === 'function' && typeof ctx.createBufferSource === 'function') {
      const length = Math.floor(ctx.sampleRate * 2);
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let last = 0;
      let seed = 0x2468ace1;
      for (let i = 0; i < length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const white = ((seed >>> 0) / 0xffffffff) * 2 - 1;
        last = (last + 0.035 * white) / 1.035;
        data[i] = last * 2.8;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.loop = true;

      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.value = 180;
      windFilter.Q.value = 1.25;

      const windGain = ctx.createGain();
      windGain.gain.value = 0.0;
      noise.connect(windFilter);
      if (typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner();
        windFilter.connect(panner);
        panner.connect(windGain);
        this._windPanner = panner;
      } else {
        windFilter.connect(windGain);
      }
      windGain.connect(bus);
      noise.start();
      this._oscillators.push(noise);
      this._windFilter = windFilter;
      this._windGain = windGain;
    }

    // 3) Crystalline stellation choir (Act III 25.4s–29.15s)
    const crystalGain = ctx.createGain();
    crystalGain.gain.value = 0.0;
    crystalGain.connect(bus);
    this._crystalGain = crystalGain;

    for (const [freq, gainVal] of [
      [293.66, 0.24], // D4
      [440.0, 0.20],  // A4
      [554.37, 0.16], // C#5
      [659.25, 0.14], // E5
      [880.0, 0.08],  // A5 shimmer
    ]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.value = gainVal;
      osc.connect(g);
      g.connect(crystalGain);
      osc.start();
      this._oscillators.push(osc);
    }

    this._initialized = true;
  }

  setMuted(muted) {
    this._muted = Boolean(muted);
    if (!this._ctx || !this._master) return this._muted;
    const now = this._ctx.currentTime || 0;
    const target = this._muted ? 0 : 0.72;
    this._master.gain.setTargetAtTime?.(target, now, 0.04);
    this._exportMaster?.gain.setTargetAtTime?.(this._muted ? 0 : 0.82, now, 0.04);
    if (!this._muted && this._ctx.state === 'suspended') {
      this._ctx.resume?.().catch(() => {});
    }
    if (!this._muted) {
      this._ensureAcousticStem();
    }
    return this._muted;
  }

  toggleMuted() {
    if (!this._ctx) this.ensureStarted();
    return this.setMuted(!this._muted);
  }

  /** Returns a cloned MediaStreamTrack suitable for muxing into CanvasRecorder. */
  createRecordingTrack() {
    if (this._muted) return null;
    this.ensureStarted();
    const track = this._streamDest?.stream?.getAudioTracks?.()?.[0];
    if (!track) return null;
    return typeof track.clone === 'function' ? track.clone() : track;
  }

  /** Continuous per-frame modulation from the 3D scene state. */
  update({
    tunnelFactor = 0,
    twist = 0,
    breath = 0,
    morphImpulse = 0,
    focused = false,
    pan = 0,
  } = {}) {
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    const now = this._ctx.currentTime || 0;
    const rush = Math.min(1, tunnelFactor * 0.65 + (twist / 4.35) * 0.55 + morphImpulse * 0.7);

    const hasStem = Boolean(this._stemSource);
    const droneCutoff = focused ? 190 : 250 + rush * 360 + breath * 280;
    const baseDrone = hasStem ? 0.022 : 0.046;
    const droneLevel = focused ? baseDrone * 0.72 : baseDrone + morphImpulse * 0.022;
    this._droneFilter?.frequency.setTargetAtTime?.(droneCutoff, now, 0.08);
    this._droneGain?.gain.setTargetAtTime?.(droneLevel, now, 0.08);

    if (this._stemFilter && this._stemGain) {
      const stemCutoff = focused ? 1150 : 1750 + rush * 1250 + breath * 950;
      const stemLevel = focused ? 0.34 : 0.46 + breath * 0.08;
      this._stemFilter.frequency.setTargetAtTime?.(stemCutoff, now, 0.12);
      this._stemGain.gain.setTargetAtTime?.(stemLevel, now, 0.14);
    }

    if (this._windFilter && this._windGain) {
      this._windFilter.frequency.setTargetAtTime?.(160 + rush * 680, now, 0.06);
      this._windGain.gain.setTargetAtTime?.(rush * 0.075, now, 0.07);
      this._windPanner?.pan.setTargetAtTime?.(Math.max(-0.8, Math.min(0.8, pan)), now, 0.08);
    }

    if (this._crystalGain) {
      this._crystalGain.gain.setTargetAtTime?.(breath * 0.068, now, 0.08);
    }
  }

  /** Soft pentatonic glass micro-chime when brushing across 3D photographs. */
  playHoverTick(spectralKey = 0.5, nowMs = performance.now()) {
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    if (this._ctx.state !== 'running' || nowMs - this._lastTickMs < 95) return;
    this._lastTickMs = nowMs;

    const noteIndex = Math.max(
      0,
      Math.min(PENTATONIC_HZ.length - 1, Math.floor((spectralKey % 1) * PENTATONIC_HZ.length))
    );
    const freq = PENTATONIC_HZ[noteIndex];
    const t = this._ctx.currentTime;
    const osc = this._ctx.createOscillator();
    const env = this._ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2, t);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.015, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    osc.connect(env);
    env.connect(this._bus);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  /** Warm harmonic pulse on 3D photo focus or formation switch. */
  playFocusPulse(opening = true) {
    if (!this._initialized || !this._ctx || this._muted || this._disposed) return;
    if (this._ctx.state !== 'running') return;
    const t = this._ctx.currentTime;
    const osc = this._ctx.createOscillator();
    const env = this._ctx.createGain();
    osc.type = 'triangle';
    const startFreq = opening ? 220 : 293.66;
    const endFreq = opening ? 329.63 : 196.0;
    osc.frequency.setValueAtTime(startFreq, t);
    osc.frequency.exponentialRampToValueAtTime(endFreq, t + 0.24);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.032, t + 0.025);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    osc.connect(env);
    env.connect(this._bus);
    osc.start(t);
    osc.stop(t + 0.36);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const node of this._oscillators) {
      try { node.stop(); } catch {}
      try { node.disconnect(); } catch {}
    }
    this._oscillators = [];
    this._stemSource = null;
    this._stemFilter = null;
    this._stemGain = null;
    try { this._ctx?.close?.(); } catch {}
    this._ctx = null;
  }
}
