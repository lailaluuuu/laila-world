/**
 * AudioSystem — Monument Valley-style ambient music.
 *
 * Sparse pentatonic bell chimes over a barely-audible bass drone,
 * sent through a long convolution reverb.
 *
 * AudioContext is created lazily on first call so the browser's
 * user-gesture policy is naturally satisfied.
 */
export class AudioSystem {
  constructor() {
    this._ctx     = null;
    this._master  = null;
    this._dry     = null;
    this._wet     = null;
    this._rev     = null;
    this._running = false;
    this._nextNote = 0;
    this._schedId  = null;
    this._droneOsc = null;
    this._droneLfo = null;
  }

  // ── Lazy bootstrap ───────────────────────────────────────────────────────
  _boot() {
    if (this._ctx) {
      if (this._ctx.state === 'suspended') this._ctx.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._ctx = ctx;

    this._master = ctx.createGain();
    this._master.gain.value = 0.72;
    this._master.connect(ctx.destination);

    // Synthetic convolution reverb (exponentially decaying stereo noise)
    const sr  = ctx.sampleRate;
    const len = Math.floor(sr * 3.8);
    const ir  = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.9);
      }
    }
    this._rev = ctx.createConvolver();
    this._rev.buffer = ir;
    this._rev.connect(this._master);

    this._dry = ctx.createGain(); this._dry.gain.value = 0.54; this._dry.connect(this._master);
    this._wet = ctx.createGain(); this._wet.gain.value = 0.46; this._wet.connect(this._rev);
  }

  // ── Monument Valley ambient music ────────────────────────────────────────
  startMusic() {
    this._boot();
    if (this._running) return;
    this._running  = true;
    if (globalThis.localStorage?.getItem('debugWorldLogs') === '1') {
      console.debug('[DebugWorld] music:start');
    }
    this._nextNote = this._ctx.currentTime + 1.8;
    this._tick();
    this._startDrone();
  }

  stopMusic() {
    this._running = false;
    if (globalThis.localStorage?.getItem('debugWorldLogs') === '1') {
      console.debug('[DebugWorld] music:stop');
    }
    clearTimeout(this._schedId);
    if (this._droneOsc) {
      const t = this._ctx.currentTime;
      try { this._droneOsc.stop(t + 1.5); } catch (_) {}
      try { this._droneLfo.stop(t + 1.5); } catch (_) {}
      this._droneOsc = null;
      this._droneLfo = null;
    }
  }

  // C major pentatonic, 3 octaves
  static PENTA = [
    130.81, 146.83, 164.81, 196.00, 220.00,
    261.63, 293.66, 329.63, 392.00, 440.00,
    523.25, 587.33, 659.25, 783.99, 880.00,
  ];
  static WEIGHTS = [
    0.15, 0.20, 0.20, 0.18, 0.15,
    1.00, 1.20, 1.00, 0.80, 0.70,
    0.45, 0.35, 0.25, 0.18, 0.12,
  ];

  _tick() {
    if (!this._running) return;
    const ctx = this._ctx;
    while (this._nextNote < ctx.currentTime + 2.0) {
      this._scheduleNote(this._nextNote);
      this._nextNote += 2.0 + Math.random() * 6.5;   // sparse: 2–8.5 s between events
    }
    this._schedId = setTimeout(() => this._tick(), 500);
  }

  _scheduleNote(t) {
    const penta   = AudioSystem.PENTA;
    const weights = AudioSystem.WEIGHTS;
    const total   = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total, idx = penta.length - 1;
    for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }

    this._chime(penta[idx], t, 1.0);

    // 28% chance: add a fifth or fourth (consonant harmony)
    if (Math.random() < 0.28) {
      const harm = penta[idx] * (Math.random() < 0.55 ? 1.5 : 1.333);
      if (harm < 1050) this._chime(harm, t + 0.018, 0.50);
    }

    // 12% chance: gentle ascending 3-note run
    if (Math.random() < 0.12) {
      [penta[idx], penta[idx] * 1.125, penta[idx] * 1.25]
        .forEach((f, i) => { if (f < 950) this._chime(f, t + i * 0.16, 0.55); });
    }
  }

  /**
   * Bell/chime timbre.
   * Fundamental (sine) + two inharmonic partials at the classic bell ratios
   * (×2.756 and ×5.404) give a glockenspiel/marimba quality, perfect for MV.
   */
  _chime(freq, t, vol = 1.0) {
    const ctx = this._ctx;
    const amp = 0.10 * vol;
    const dur = 3.2 + Math.random() * 3.5;

    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2.756;
    const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = freq * 5.404;

    const g1 = ctx.createGain();
    const g2 = ctx.createGain();
    const g3 = ctx.createGain();

    g1.gain.setValueAtTime(0, t);
    g1.gain.linearRampToValueAtTime(amp, t + 0.009);
    g1.gain.exponentialRampToValueAtTime(amp * 0.55, t + 0.20);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    g2.gain.setValueAtTime(0, t);
    g2.gain.linearRampToValueAtTime(amp * 0.38, t + 0.006);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.32);

    g3.gain.setValueAtTime(0, t);
    g3.gain.linearRampToValueAtTime(amp * 0.14, t + 0.003);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.10);

    o1.connect(g1); o2.connect(g2); o3.connect(g3);
    [g1, g2, g3].forEach(g => { g.connect(this._dry); g.connect(this._wet); });
    [o1, o2, o3].forEach((o, i) => {
      o.start(t);
      o.stop(t + [dur, dur * 0.35, dur * 0.12][i] + 0.3);
    });
  }

  /** Barely-audible C2 drone that grounds the soundscape. */
  _startDrone() {
    const ctx   = this._ctx;
    const osc   = ctx.createOscillator();
    const lfo   = ctx.createOscillator();
    const lfoG  = ctx.createGain();
    const dGain = ctx.createGain();

    osc.type = 'sine'; osc.frequency.value = 65.41;   // C2
    lfo.type = 'sine'; lfo.frequency.value = 0.07;    // very slow drift
    lfoG.gain.value = 1.5;

    lfo.connect(lfoG); lfoG.connect(osc.frequency);
    osc.connect(dGain);
    dGain.connect(this._dry);
    dGain.connect(this._wet);

    // Fade in over 6 s so it doesn't startle
    dGain.gain.setValueAtTime(0, ctx.currentTime);
    dGain.gain.linearRampToValueAtTime(0.030, ctx.currentTime + 6.0);

    osc.start(); lfo.start();
    this._droneOsc = osc;
    this._droneLfo = lfo;
  }
}
