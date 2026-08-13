/**
 * audio-intro.js — the landing page's score, and the sounds the interface makes.
 *
 * This exists only outside the instrument. Inside Air Guitar, UI sound would
 * fight the thing you are actually playing, so play.html loads none of this.
 *
 * ── What it is ────────────────────────────────────────────────────────────
 * A generative cinematic-ambient loop in A minor / C major: sub bass, a
 * breathing pad, and a bell arpeggio through a dotted-eighth ping-pong delay
 * into a convolution hall. Eight bars, so the ear never lands on the seam.
 *
 * No noise anywhere in the signal path except the reverb's impulse response,
 * the air layer and the entry impact — the three places noise belongs.
 *
 * ── Why it is built this way ──────────────────────────────────────────────
 * An earlier version was a Karplus-Strong pluck: a noise burst into a feedback
 * delay. That is the right model for a *string* and completely wrong for
 * interface sound — it rang metallic and had to be torn out. Its replacement
 * was bells and a triangle pad, which was pleasant and thin: four chords, one
 * voice of movement, and an obvious loop point at eight seconds.
 *
 * What is here now keeps the bells and adds the two things that make a score
 * read as *scored* rather than as a widget making notes:
 *
 *  - **Everything is in motion at a different rate.** The pad's filter breathes
 *    on a 0.07 Hz LFO, the air layer sweeps on another, and the delay repeats
 *    fall between the arpeggio's own notes. Nothing lines up, so nothing ticks.
 *  - **The loop is longer than a listener's memory of it.** Eight bars at 68 BPM
 *    is ~28 s, with the arpeggio shape alternating and a high theme note that
 *    only appears in four of the eight. Two passes never sound identical.
 *
 * ── One context, ever ─────────────────────────────────────────────────────
 * `ensure()` is the only thing that constructs an AudioContext, and it must be
 * called from a real gesture: a pointermove is not user activation, so a graph
 * built there sits suspended forever. The whole landing page is therefore silent
 * until the visitor presses ENTER, which is also what the threshold overlay is
 * *for* — a click that means "yes, make sound" before any sound is made.
 * `test/smoke.mjs` counts the constructor calls and requires exactly one.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** MIDI note → Hz. Chords are far easier to read (and to fix) as note numbers. */
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const BPM = 68;
const EIGHTH = 30 / BPM;          // 0.441 s — one arpeggio step
const STEPS = 8;                  // eighths per bar
const DOTTED = EIGHTH * 1.5;      // the delay time: repeats land off the grid

/**
 * Eight bars. ii–V–vi at the end (Dm9 → G6/9 → Am9) resolves deceptively, which
 * is what lets the loop turn over without ever sounding finished.
 */
const PROGRESSION = [
  { bass: 45, pad: [60, 64, 67, 71], arp: [69, 72, 76, 79, 83] },  // Am9
  { bass: 41, pad: [57, 60, 64, 67], arp: [65, 69, 72, 76, 79] },  // Fmaj9
  { bass: 48, pad: [59, 64, 67, 71], arp: [67, 72, 76, 79, 83] },  // Cmaj9
  { bass: 43, pad: [59, 62, 64, 69], arp: [67, 71, 74, 79, 81] },  // G6/9
  { bass: 45, pad: [60, 64, 67, 71], arp: [69, 72, 76, 79, 83] },  // Am9
  { bass: 41, pad: [57, 60, 64, 67], arp: [65, 69, 72, 76, 79] },  // Fmaj9
  { bass: 50, pad: [62, 65, 69, 72], arp: [69, 72, 74, 77, 81] },  // Dm9 — the lift
  { bass: 43, pad: [59, 62, 64, 69], arp: [67, 71, 74, 79, 81] },  // G6/9
];

/* Two arpeggio shapes, alternating by bar. Both are *shapes* — up, fall back,
 * reach — rather than scale runs, which is the difference between a figure and
 * an exercise. */
const SHAPES = [
  [0, 2, 1, 3, 2, 4, 3, 2],
  [0, 3, 2, 4, 3, 1, 2, 0],
];

/** Bars that get the high held theme note. Sparse on purpose. */
const THEME_BARS = new Set([2, 3, 6, 7]);

const BANDS = 40;                 // log-spaced bands handed to the visuals

/* Master level, set by measurement rather than by feel: this lands the bed at
 * roughly -19 dBFS RMS with peaks near -7, which is where background music has
 * to sit to be audible under a laptop's own noise floor without ever being the
 * loudest thing on the machine. */
const MASTER = 2.0;

export class IntroAudio {
  constructor() {
    this.ctx = null; this.dead = false; this.on = true; this.playing = false;
    this._timer = 0; this._next = 0; this._step = 0;
    this._noteCbs = [];
    this._bands = new Float32Array(BANDS);
    this._fft = null;
  }

  /* ================================================================== *
   *  Graph
   * ================================================================== */

  /**
   * Build the graph. The only place an AudioContext is ever constructed, and it
   * must run inside a real gesture.
   */
  ensure() {
    if (this.ctx || this.dead) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.dead = true; return null; }

    try {
      const ctx = this.ctx = new AC();

      /* ---- master: gain → glue compressor → analyser → out ---- */
      this.master = ctx.createGain();
      this.master.gain.value = 0;                       // faded up by start()

      /* Glue, not a cap. Everything here overlaps everything else — pad tails
       * under bell tails under delay repeats — so something has to catch the
       * moments they all land together.
       *
       * The threshold sits high on purpose. An earlier -20 dB / 3:1 setting was
       * doing the opposite of what it looked like: with the whole mix above the
       * knee all the time, the output could not exceed roughly -14 dBFS no
       * matter how much level went in, so *raising* the master made the page
       * quieter. Measured RMS was -26 dBFS — background music nobody could
       * hear. At -8 dB the bed passes through untouched and only the stacks
       * get caught. */
      const glue = this.glue = ctx.createDynamicsCompressor();
      glue.threshold.value = -8; glue.knee.value = 10;
      glue.ratio.value = 4; glue.attack.value = 0.003; glue.release.value = 0.25;

      // The visuals read this. It passes audio through untouched.
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.72;
      this._fft = new Uint8Array(this.analyser.frequencyBinCount);

      this.master.connect(glue).connect(this.analyser).connect(ctx.destination);

      // A shelf off the very top keeps the bells from getting glassy on laptop
      // speakers, and a highpass keeps the sub from muddying small ones.
      this.air = ctx.createBiquadFilter();
      this.air.type = 'lowpass'; this.air.frequency.value = 8800; this.air.Q.value = 0.4;
      const sub = ctx.createBiquadFilter();
      sub.type = 'highpass'; sub.frequency.value = 28; sub.Q.value = 0.5;
      this.air.connect(sub).connect(this.master);

      this.dry = ctx.createGain(); this.dry.gain.value = 0.78;
      this.dry.connect(this.air);

      /* ---- hall ---- */
      const pre = ctx.createDelay(0.2);                 // 22 ms of pre-delay: the
      pre.delayTime.value = 0.022;                      // note reads before the room
      this.verb = ctx.createConvolver();
      this.verb.buffer = this._ir(4.2, 2.6);
      const tailLo = ctx.createBiquadFilter();          // an un-damped IR reads
      tailLo.type = 'lowpass'; tailLo.frequency.value = 3200;   // as hiss
      const tailHi = ctx.createBiquadFilter();
      tailHi.type = 'highpass'; tailHi.frequency.value = 180;
      this.send = ctx.createGain(); this.send.gain.value = 0.5;
      this.send.connect(pre).connect(this.verb).connect(tailLo).connect(tailHi).connect(this.air);

      /* ---- dotted-eighth ping-pong ----
       * Two delays at half the ping time, cross-fed, panned hard apart: repeats
       * alternate ears and land *between* the arpeggio's own notes, which is
       * most of why eight notes a bar sound like sixteen. */
      this.echo = ctx.createGain(); this.echo.gain.value = 0.34;
      const dL = ctx.createDelay(1.5), dR = ctx.createDelay(1.5);
      dL.delayTime.value = DOTTED / 2; dR.delayTime.value = DOTTED / 2;
      const damp = ctx.createBiquadFilter();            // repeats darken as they go
      damp.type = 'lowpass'; damp.frequency.value = 2600;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      // A panner per side where the browser has them; straight to the bus where
      // it does not. Never `air.connect(air)` — that is a feedback loop, not a
      // fallback.
      const side = (pan) => {
        if (!ctx.createStereoPanner) return this.air;
        const p = ctx.createStereoPanner(); p.pan.value = pan;
        p.connect(this.air); return p;
      };
      this.echo.connect(dL);
      dL.connect(side(-0.8));
      dL.connect(dR);
      dR.connect(side(0.8));
      dR.connect(damp).connect(fb).connect(dL);

      /* ---- pad bus: one filter for every chord, breathing on its own clock ---- */
      this.padBus = ctx.createGain(); this.padBus.gain.value = 1;
      this.padFilter = ctx.createBiquadFilter();
      this.padFilter.type = 'lowpass';
      this.padFilter.frequency.value = 1150; this.padFilter.Q.value = 0.7;
      this.padBus.connect(this.padFilter).connect(this.dry);
      const padVerb = ctx.createGain(); padVerb.gain.value = 0.6;
      this.padFilter.connect(padVerb).connect(this.send);

      this._lfo(0.07, 460, this.padFilter.frequency);   // cutoff breath
      this._lfo(0.041, 0.14, this.padBus.gain);         // and a slow swell

      /* ---- air: a hair of filtered noise so the room is never dead silent ---- */
      const noise = ctx.createBufferSource();
      noise.buffer = this._noise(3); noise.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass'; band.frequency.value = 1200; band.Q.value = 0.6;
      const nGain = ctx.createGain(); nGain.gain.value = 0.013;
      noise.connect(band).connect(nGain).connect(this.air);
      this._lfo(0.023, 700, band.frequency);
      noise.start();
    } catch { this.dead = true; this.ctx = null; }

    return this.ctx;
  }

  /** A free-running LFO on some AudioParam. Started once, never stopped. */
  _lfo(rate, depth, param) {
    const o = this.ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = rate;
    const g = this.ctx.createGain(); g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
  }

  /** Decaying stereo noise — a plain, well-behaved hall. */
  _ir(seconds, decay) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        // A short fade-in stops the IR starting with a click.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - u, decay) * Math.min(1, u * 260);
      }
    }
    return buf;
  }

  /** Plain white noise, looped. The bandpass in front of it does the shaping. */
  _noise(seconds) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return buf;
  }

  _resume() { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); }

  /* ================================================================== *
   *  Voices
   * ================================================================== */

  /**
   * One bell. Four sine partials at falling gain, soft attack, exponential tail,
   * and a lowpass that closes over the note — the shape of something struck,
   * with nothing percussive in the source itself.
   */
  note(freq, { vel = 0.5, dur = 2.4, when = 0, wet = 1, echo = 0, pan = 0 } = {}) {
    const ctx = this.ensure();
    if (!ctx || !this.on) return;
    this._resume();
    const t = ctx.currentTime + when;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(clamp(vel, 0.001, 1), t + 0.016);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.setValueAtTime(Math.min(freq * 8 + 1100, 11000), t);
    body.frequency.exponentialRampToValueAtTime(Math.max(freq * 2.1, 320), t + dur * 0.7);
    body.Q.value = 0.4;
    body.connect(out);

    // 3.01 rather than 3: struck metal is inharmonic, and a hair of it is the
    // difference between a bell and an organ.
    for (const [mult, gain, detune] of [[1, 1, 0], [2, 0.26, 4], [3.01, 0.1, -5], [4.24, 0.045, 7]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      o.detune.value = detune;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g).connect(body);
      o.start(t); o.stop(t + dur + 0.08);
    }

    let tap = out;
    const panner = pan && ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) { panner.pan.value = clamp(pan, -1, 1); out.connect(panner); tap = panner; }

    tap.connect(this.dry);
    if (wet > 0) { const s = ctx.createGain(); s.gain.value = wet; tap.connect(s).connect(this.send); }
    if (echo > 0) { const e = ctx.createGain(); e.gain.value = echo; tap.connect(e).connect(this.echo); }
  }

  /** A slow chord underneath, wide and detuned. Attacks over more than a second. */
  _pad(midis, when, dur) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.085, t + dur * 0.42);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(this.padBus);

    for (const m of midis) {
      // Two voices a few cents apart, panned opposite: one note, physically wide.
      for (const [cents, side] of [[-7, -0.55], [7, 0.55]]) {
        const o = ctx.createOscillator();
        o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = cents;
        const g = ctx.createGain(); g.gain.value = 0.42;
        const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (p) { p.pan.value = side; o.connect(g).connect(p).connect(out); }
        else o.connect(g).connect(out);
        o.start(t); o.stop(t + dur + 0.12);
      }
    }
  }

  /** Sub bass: one sine, one octave doubling, slow in and slow out. */
  _bass(midi, when, dur) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.2, t + 0.5);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.5;
    lp.connect(out);
    for (const [mult, gain] of [[1, 1], [2, 0.22]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = hz(midi) * mult;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start(t); o.stop(t + dur + 0.1);
    }
    out.connect(this.dry);
  }

  /* ================================================================== *
   *  Interface sounds
   * ================================================================== */

  /** Hover: one quiet high bell, different each time but always in key. */
  hover() {
    const pick = [79, 81, 84, 86, 88][(Math.random() * 5) | 0];
    this.note(hz(pick), { vel: 0.075, dur: 1.6, wet: 0.9, echo: 0.25, pan: (Math.random() - 0.5) * 0.8 });
  }

  /** Tap: a two-note rise, the interval fixed so it always resolves upward. */
  tap(i = 0) {
    const base = [69, 72, 76, 79, 81][i % 5];
    this.note(hz(base), { vel: 0.2, dur: 1.9, echo: 0.35 });
    this.note(hz(base + 7), { vel: 0.13, dur: 2.4, when: 0.07, echo: 0.3 });
  }

  /** Refusal: the same shape, falling instead of rising. Never a buzzer. */
  deny() {
    this.note(hz(76), { vel: 0.15, dur: 1.2 });
    this.note(hz(72), { vel: 0.12, dur: 1.6, when: 0.08 });
  }

  /**
   * ENTER. There is no time to run a riser — the click *is* the moment — so the
   * ignition is built out of things that read instantly: a bright noise sweep,
   * a sub that drops a fifth, and a rising arpeggio that lands on the tonic.
   */
  flourish() {
    const ctx = this.ensure();
    if (!ctx || !this.on) return;
    this._resume();
    const t = ctx.currentTime;

    // Whoosh: noise through a bandpass sweeping up and out of the way.
    const src = ctx.createBufferSource();
    src.buffer = this._noise(1.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(5200, t + 0.9);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.065, t + 0.28);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    src.connect(bp).connect(ng).connect(this.dry);
    const nw = ctx.createGain(); nw.gain.value = 0.7;
    ng.connect(nw).connect(this.send);
    src.start(t); src.stop(t + 1.7);

    /* Impact: a sub falling a fifth. The fall is the whole gesture.
     *
     * Its 0.09 s attack is not a taste decision. A near-instant sine at this
     * level outruns the glue compressor's 3 ms attack, and the first build
     * pinned five frames at full scale — audible distortion on the one sound
     * the whole page is built around. Giving the transient something to catch
     * costs nothing anybody can hear and takes the peak back under -1 dBFS. */
    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(88, t);
    boom.frequency.exponentialRampToValueAtTime(41, t + 1.1);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(0.15, t + 0.09);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    boom.connect(bg).connect(this.dry);
    boom.start(t); boom.stop(t + 2);

    // And the figure, landing on A an octave up.
    [69, 72, 76, 79, 81, 84].forEach((m, k) =>
      this.note(hz(m), { vel: 0.17 - k * 0.014, dur: 3.4, when: 0.06 + k * 0.075, echo: 0.4 }));
  }

  /* ================================================================== *
   *  The loop
   * ================================================================== */

  /**
   * @param fade seconds to reach full level; 0 means start at level.
   *
   * Zero is the default, and that is the opposite of what it looks like it
   * should be. A long master fade sounds like the right idea and quietly ruins
   * the one moment the page is built around: the entry flourish fires at t≈0,
   * and an exponential ramp climbing out of 0.0001 is still essentially at zero
   * a tenth of a second later — ten times quieter than the number suggests,
   * because the ramp is exponential in the wrong direction for this. The
   * ignition played to nobody.
   *
   * The score does not need the ramp anyway. Its first note is 0.35 s out, its
   * pad attacks over 1.4 s and its bass over 0.5 s, so the bed swells in on its
   * own envelopes. Unmuting passes a real fade, because there is no flourish
   * there to cover a hard start.
   */
  start({ fade = 0 } = {}) {
    if (!this.ensure() || this.playing || !this.on) return;
    this._resume();
    this.playing = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    if (fade > 0) {
      this.master.gain.setValueAtTime(0.0001, t);
      this.master.gain.exponentialRampToValueAtTime(MASTER, t + fade);
    } else {
      this.master.gain.setValueAtTime(MASTER, t);
    }
    this._next = t + 0.35;
    this._step = 0;
    // Lookahead scheduling: a 25 ms timer placing notes 0.4 s ahead keeps the
    // arpeggio on the audio clock rather than at the mercy of timer jitter.
    this._timer = setInterval(() => this._tick(), 25);
    this._tick();
  }

  _tick() {
    if (!this.playing || !this.ctx) return;
    const ctx = this.ctx;

    while (this._next < ctx.currentTime + 0.4) {
      const bar = Math.floor(this._step / STEPS) % PROGRESSION.length;
      const chord = PROGRESSION[bar];
      const k = this._step % STEPS;
      const when = this._next - ctx.currentTime;
      const barLen = EIGHTH * STEPS;

      if (k === 0) {
        this._pad(chord.pad, when, barLen * 1.08);
        this._bass(chord.bass, when, barLen * 1.05);
      }

      const shape = SHAPES[bar % SHAPES.length];
      const midi = chord.arp[shape[k]] + (k === 5 ? 12 : 0);
      const accent = k === 0 ? 0.185 : k === 4 ? 0.145 : 0.105;
      // A few milliseconds of drift. Perfectly gridded bells read as a widget.
      const human = (Math.random() - 0.5) * 0.012;

      this.note(hz(midi), {
        vel: accent, dur: 3.2, when: when + human,
        echo: 0.42, pan: ((k % 2) - 0.5) * 0.5,
      });
      this._fire(midi, accent, when + human);

      // The theme: one long high note, only in half the bars.
      if (k === 4 && THEME_BARS.has(bar)) {
        const top = chord.arp[4] + 12;
        this.note(hz(top), { vel: 0.075, dur: 5.5, when: when + 0.02, wet: 1.2, echo: 0.5 });
        this._fire(top, 0.075, when + 0.02);
      }

      this._next += EIGHTH;
      this._step++;
    }
  }

  stop({ fade = 1.2 } = {}) {
    clearInterval(this._timer); this._timer = 0;
    this.playing = false;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), t);
    this.master.gain.exponentialRampToValueAtTime(0.0001, t + fade);
  }

  /** @returns the new state, so the caller can paint its button. */
  toggle() {
    this.on = !this.on;
    if (this.on) this.start({ fade: 1.4 }); else this.stop({ fade: 0.4 });
    return this.on;
  }

  /* ================================================================== *
   *  What the visuals read
   * ================================================================== */

  /**
   * Subscribe to note events. Handed the MIDI note and its velocity *at the
   * moment it sounds*, not when it was scheduled — the visuals are drawing what
   * you can hear, so a note that is 0.4 s out has to arrive 0.4 s late.
   * @returns an unsubscribe function.
   */
  onNote(fn) {
    this._noteCbs.push(fn);
    return () => { this._noteCbs = this._noteCbs.filter((f) => f !== fn); };
  }

  _fire(midi, vel, when) {
    if (!this._noteCbs.length) return;
    setTimeout(() => {
      for (const f of this._noteCbs) { try { f(midi, vel); } catch {} }
    }, Math.max(0, when * 1000));
  }

  /**
   * Log-spaced spectrum, 0..1 per band, written into `out`.
   * @returns the overall level, or 0 when there is nothing to read — which is
   *          the visuals' cue to fall back to their own motion.
   */
  bands(out) {
    if (!this.analyser || !this.playing) return 0;
    this.analyser.getByteFrequencyData(this._fft);
    const n = this._fft.length;
    let sum = 0;
    for (let b = 0; b < BANDS; b++) {
      // Log spacing: linear bins put almost everything audible in the first 5%.
      const lo = Math.floor(Math.pow(n, b / BANDS));
      const hi = Math.max(lo + 1, Math.floor(Math.pow(n, (b + 1) / BANDS)));
      let peak = 0;
      for (let i = lo; i < hi && i < n; i++) if (this._fft[i] > peak) peak = this._fft[i];
      const v = peak / 255;
      out[b] = v; sum += v;
    }
    return sum / BANDS;
  }
}
