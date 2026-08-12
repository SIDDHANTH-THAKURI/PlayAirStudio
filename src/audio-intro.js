/**
 * audio-intro.js — the landing page's music and touch sounds.
 *
 * This exists only outside the instrument. Inside Air Guitar, UI sound would
 * fight the thing you are actually playing, so play.html loads none of this.
 *
 * The first attempt at intro sound was a Karplus-Strong pluck: a noise burst
 * into a feedback delay. That is the right model for a *string* and completely
 * wrong for interface sound — it rang metallic and buzzy and had to be torn
 * out. What is here instead is the other classic approach: a few sine partials
 * with a soft attack and a long exponential tail, fed through a real reverb.
 * No noise anywhere in the signal path except the reverb's impulse response,
 * where it belongs.
 *
 * Everything is pinned to a D-major pentatonic. Any two notes that can sound
 * together are consonant by construction, so a hurried player mashing four
 * cards still gets a chord rather than a cluster.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* D major pentatonic across three octaves — the palette for every touch. */
const PENT = [
  146.83, 164.81, 185.00, 220.00, 246.94,          // D3 E3 F#3 A3 B3
  293.66, 329.63, 369.99, 440.00, 493.88,          // D4 E4 F#4 A4 B4
  587.33, 659.25, 739.99, 880.00,                  // D5 E5 F#5 A5
];

/* Four warm chords, each held for one bar. Voiced high and open so the
 * arpeggio never muddies against the pad. */
const PROGRESSION = [
  { pad: [146.83, 220.00], arp: [293.66, 369.99, 440.00, 554.37] },  // Dmaj7
  { pad: [123.47, 185.00], arp: [246.94, 293.66, 369.99, 440.00] },  // Bm7
  { pad: [196.00, 293.66], arp: [246.94, 293.66, 369.99, 493.88] },  // Gmaj9
  { pad: [220.00, 329.63], arp: [277.18, 329.63, 369.99, 440.00] },  // A6
];

const BEAT = 0.62;               // s per arpeggio note — unhurried, not sleepy
const NOTES_PER_CHORD = 8;

export class IntroAudio {
  constructor() {
    this.ctx = null; this.dead = false; this.on = true; this.playing = false;
    this._timer = 0; this._next = 0; this._step = 0;
  }

  /**
   * Build the graph. Must be called from a real gesture: a pointermove is not
   * user activation, so a context built there would sit suspended forever.
   */
  ensure() {
    if (this.ctx || this.dead) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.dead = true; return null; }
    try {
      const ctx = this.ctx = new AC();

      this.master = ctx.createGain();
      this.master.gain.value = 0;                     // faded in by start()
      this.master.connect(ctx.destination);

      // A gentle shelf keeps the bells from getting glassy on laptop speakers.
      this.air = ctx.createBiquadFilter();
      this.air.type = 'lowpass'; this.air.frequency.value = 6200; this.air.Q.value = 0.5;
      this.air.connect(this.master);

      this.dry = ctx.createGain(); this.dry.gain.value = 0.72;
      this.dry.connect(this.air);

      this.verb = ctx.createConvolver();
      this.verb.buffer = this._ir(2.9, 3.1);
      const tail = ctx.createBiquadFilter();          // damp the tail, or noise
      tail.type = 'lowpass'; tail.frequency.value = 3400;  // IR reads as hiss
      this.send = ctx.createGain(); this.send.gain.value = 0.42;
      this.send.connect(this.verb).connect(tail).connect(this.air);
    } catch { this.dead = true; this.ctx = null; }
    return this.ctx;
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
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - u, decay) * Math.min(1, u * 220);
      }
    }
    return buf;
  }

  _resume() { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); }

  /**
   * One bell. Three sine partials at falling gain, soft attack, exponential
   * tail — the shape of something struck, without anything percussive in the
   * source itself.
   */
  note(freq, { vel = 0.5, dur = 2.4, when = 0, wet = 1 } = {}) {
    const ctx = this.ensure();
    if (!ctx || !this.on) return;
    this._resume();
    const t = ctx.currentTime + when;

    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(clamp(vel, 0.001, 1), t + 0.018);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.setValueAtTime(Math.min(freq * 8 + 900, 9000), t);
    body.frequency.exponentialRampToValueAtTime(Math.max(freq * 2.2, 320), t + dur * 0.7);
    body.Q.value = 0.4;
    body.connect(out);

    for (const [mult, gain, detune] of [[1, 1, 0], [2, 0.24, 4], [3, 0.09, -5], [4.2, 0.04, 7]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      o.detune.value = detune;
      const g = ctx.createGain(); g.gain.value = gain;
      o.connect(g).connect(body);
      o.start(t); o.stop(t + dur + 0.08);
    }

    out.connect(this.dry);
    if (wet > 0) {
      const s = ctx.createGain(); s.gain.value = wet;
      out.connect(s).connect(this.send);
    }
  }

  /** A slow breathing chord underneath the arpeggio. */
  _pad(freqs, when, dur) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.075, t + dur * 0.35);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 0.6;
    lp.connect(out);
    for (const f of freqs) {
      for (const cents of [-6, 6]) {                 // two slightly detuned saws
        const o = ctx.createOscillator();            // read as one wide voice
        o.type = 'triangle'; o.frequency.value = f; o.detune.value = cents;
        const g = ctx.createGain(); g.gain.value = 0.5;
        o.connect(g).connect(lp);
        o.start(t); o.stop(t + dur + 0.1);
      }
    }
    out.connect(this.dry);
    const s = ctx.createGain(); s.gain.value = 0.5;
    out.connect(s).connect(this.send);
  }

  /* ---------------- touch sounds ---------------- */

  /** Hover: one quiet high note, different each time but always in key. */
  hover() {
    this.note(PENT[8 + ((Math.random() * 5) | 0)], { vel: 0.10, dur: 1.5 });
  }
  /** Tap: a two-note rise, the interval fixed so it always resolves upward. */
  tap(i = 0) {
    const base = 5 + (i % 5);
    this.note(PENT[base], { vel: 0.22, dur: 1.8 });
    this.note(PENT[base + 3], { vel: 0.14, dur: 2.2, when: 0.075 });
  }
  /** Refusal: the same shape, falling instead of rising. Never a buzzer. */
  deny() {
    this.note(PENT[7], { vel: 0.16, dur: 1.2 });
    this.note(PENT[4], { vel: 0.13, dur: 1.6, when: 0.085 });
  }
  /** Entering: a rising flourish that lands on the tonic an octave up. */
  flourish() {
    [5, 7, 9, 10, 12].forEach((n, k) =>
      this.note(PENT[n], { vel: 0.3 - k * 0.02, dur: 2.8, when: k * 0.075 }));
  }

  /* ---------------- the loop ---------------- */

  start() {
    if (!this.ensure() || this.playing || !this.on) return;
    this.playing = true;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.master.gain.exponentialRampToValueAtTime(0.5, this.ctx.currentTime + 2.5);
    this._next = this.ctx.currentTime + 0.12;
    this._step = 0;
    // Lookahead scheduling: a 25 ms timer placing notes 0.4 s ahead keeps the
    // arpeggio on the audio clock rather than at the mercy of timer jitter.
    this._timer = setInterval(() => this._tick(), 25);
    this._tick();
  }

  _tick() {
    if (!this.playing) return;
    const ctx = this.ctx;
    while (this._next < ctx.currentTime + 0.4) {
      const chordIx = Math.floor(this._step / NOTES_PER_CHORD) % PROGRESSION.length;
      const chord = PROGRESSION[chordIx];
      const k = this._step % NOTES_PER_CHORD;
      const when = this._next - ctx.currentTime;

      if (k === 0) this._pad(chord.pad, when, BEAT * NOTES_PER_CHORD * 1.05);
      // Up four, then back down three — a shape, not a scale run.
      const order = [0, 1, 2, 3, 2, 1, 2, 3];
      const f = chord.arp[order[k]] * (k === 3 || k === 7 ? 2 : 1);
      this.note(f, { vel: k === 0 ? 0.20 : 0.13, dur: 3.0, when });

      this._next += BEAT;
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
    if (this.on) this.start(); else this.stop({ fade: 0.4 });
    return this.on;
  }
}
