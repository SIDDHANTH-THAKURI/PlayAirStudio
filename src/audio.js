/**
 * audio.js — the sound engine.
 *
 * Strings: six Karplus-Strong voices inside an AudioWorklet (see
 * karplus-worklet.js for why it isn't a Tone comb filter). One voice per
 * string means re-striking a string steals its own note and only its own
 * note — the single biggest thing that makes this read as "guitar".
 *
 * Everything after the strings is Tone.js: pickup/tone filter, EQ, drive,
 * cabinet, room, limiter, plus the metronome on Tone.Transport.
 */
import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.7.77/+esm';

export const LOOKAHEAD = 0.022;   // s of headroom for a strum's string-to-string spread
/* A single plucked string has no spread to lay out, so it does not need the
 * strum's headroom — and this is the path a gesture triggers, where every
 * millisecond is felt between moving your hand and hearing the note. */
export const PLUCK_LOOKAHEAD = 0.010;
const OPEN = [40, 45, 50, 55, 59, 64];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** One-pole coefficient for a given cutoff — used for both loop and pick filters. */
const coef = (hz, sr) => clamp(1 - Math.exp((-2 * Math.PI * hz) / sr), 0.02, 0.98);

/* ---------- fallback for browsers without AudioWorklet ---------- */
class PluckBank {
  constructor(dest) {
    this.v = OPEN.map(() => {
      const g = new Tone.Gain(1).connect(dest);
      const s = new Tone.PluckSynth({ attackNoise: 1, dampening: 3200, resonance: 0.93 }).connect(g);
      return { s, g };
    });
  }
  pluck(i, freq, vel, decay, when) {
    const { s, g } = this.v[i];
    try {
      s.resonance = clamp(Math.exp(-6.9 / (freq * decay)), 0.1, 0.995);
      s.dampening = clamp(900 + 4200 * vel, 500, 8000);
    } catch {}
    g.gain.setValueAtTime(clamp(vel, 0, 1), when);
    try { s.triggerAttack(freq, when); } catch {}
  }
  expr() {}         // no per-string retune available in the fallback
  silence() {}
}

export class GuitarEngine {
  constructor() { this.ready = false; this.mode = 'acoustic'; this._e = { bend: -1, depth: -1, rate: -1 }; }

  async init() {
    await Tone.start();
    const ctx = Tone.getContext();
    try { ctx.lookAhead = 0.01; } catch {}
    this.sr = ctx.sampleRate || 48000;
    const D = Tone.getDestination ? Tone.getDestination() : Tone.Destination;

    /* ---- amp / room chain (all Tone) ---- */
    this.limiter = new Tone.Limiter(-1.5).connect(D);
    this.reverb  = new Tone.Reverb({ decay: 2.1, preDelay: 0.012, wet: 0.2 }).connect(this.limiter);
    this.cab     = new Tone.Filter({ type: 'lowpass', frequency: 7200, rolloff: -24 }).connect(this.reverb);
    this.drive   = new Tone.Distortion({ distortion: 0.62, wet: 0 }).connect(this.cab);
    this.eq      = new Tone.EQ3({ low: 2, mid: -1.5, high: 1.5, lowFrequency: 230, highFrequency: 2700 }).connect(this.drive);
    // "Pickup position" — driven live by where the strumming hand sits, and
    // slammed shut for palm mutes.
    this.tone    = new Tone.Filter({ type: 'lowpass', frequency: 4500, rolloff: -12, Q: 0.7 }).connect(this.eq);
    this.bus     = new Tone.Gain(0.32).connect(this.tone);

    /* ---- strings ---- */
    // Tone 14 runs on standardized-audio-context: its nodes are wrappers, not
    // native AudioNodes, so the worklet must be created through Tone's context
    // (a native `new AudioWorkletNode(rawContext, …)` can't join this graph).
    this.node = null;
    try {
      const url = new URL('./karplus-worklet.js', import.meta.url).href;
      const opts = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] };
      if (typeof ctx.addAudioWorkletModule === 'function') {
        await ctx.addAudioWorkletModule(url, 'air-guitar-strings');
        this.node = ctx.createAudioWorkletNode('air-guitar-strings', opts);
      } else {
        const raw = ctx.rawContext;
        await raw.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(raw, 'air-guitar-strings', opts);
      }
      Tone.connect(this.node, this.bus);
    } catch (err) {
      console.warn('[air-guitar] AudioWorklet unavailable, using PluckSynth fallback:', err?.message);
      this.node = null;
      this.fallback = new PluckBank(this.bus);
    }

    /* ---- metronome ---- */
    this.clickOut = new Tone.Gain(0.16).connect(D);
    this.click = new Tone.Synth({ oscillator: { type: 'triangle' },
      envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.02 } }).connect(this.clickOut);
    this._beat = 0;
    Tone.Transport.scheduleRepeat((t) => {
      this.click.triggerAttackRelease(this._beat % 4 === 0 ? 'C6' : 'G5', 0.02, t);
      this._beat++;
    }, '4n');

    try { await this.reverb.generate(); } catch {}
    this.setSound(this.mode);
    this.ready = true;
  }

  /* ---------- settings ---------- */
  setSound(mode) {
    this.mode = mode;
    const el = mode === 'electric';
    this.baseTone = el ? 3400 : 5200;
    this.driveAmt = el ? 0.22 : 0;
    if (!this.ready && !this.cab) return;
    this.cab.frequency.rampTo(el ? 4200 : 7600, 0.1);
    this.eq.mid.rampTo(el ? 1.5 : -1.5, 0.1);
    this.eq.low.rampTo(el ? 0.5 : 2.5, 0.1);
    this.eq.high.rampTo(el ? 0.5 : 2, 0.1);
    this.drive.wet.rampTo(this.driveAmt, 0.1);
  }
  setVolume(v01) {
    const D = Tone.getDestination ? Tone.getDestination() : Tone.Destination;
    D.volume.rampTo(v01 <= 0.001 ? -60 : lerp(-26, 3, Math.pow(v01, 0.6)), 0.08);
  }
  setRoom(v01) { if (this.reverb) this.reverb.wet.rampTo(clamp(v01, 0, 1), 0.15); }
  setMetronome(on, bpm) {
    Tone.Transport.bpm.value = bpm;
    if (on && Tone.Transport.state !== 'started') { this._beat = 0; Tone.Transport.start('+0.05'); }
    else if (!on && Tone.Transport.state === 'started') Tone.Transport.stop();
  }

  /* ---------- per-frame continuous controls ---------- */
  update({ pickup = 0.5, palmMute = false, bend = 0, vibrato = 0, vibRate = 5.4, power = false }) {
    if (!this.ready) return;
    const f = clamp(this.baseTone * lerp(0.45, 1.6, pickup) * (palmMute ? 0.28 : 1), 380, 14000);
    this.tone.frequency.rampTo(f, 0.05);
    if (this.mode === 'electric') this.drive.wet.rampTo(power ? 0.42 : this.driveAmt, 0.12);
    // Only message the worklet when expression actually moved — this runs at
    // frame rate and postMessage isn't free.
    const e = this._e;
    if (Math.abs(bend - e.bend) > 0.004 || Math.abs(vibrato - e.depth) > 0.008 || Math.abs(vibRate - e.rate) > 0.05) {
      e.bend = bend; e.depth = vibrato; e.rate = vibRate;
      // depth is a fraction of the loop length: 3% ≈ ±50 cents at full tilt
      this.node?.port.postMessage({ t: 'expr', bend, depth: vibrato * 0.03, rate: clamp(vibRate, 3.5, 7.5) });
    }
  }

  /** Audio-clock now, for schedulers living outside this module. */
  now() {
    const ctx = Tone.getContext();
    return ctx.currentTime ?? Tone.now();
  }

  /**
   * Fire one stroke.
   * Down = low→high strings, up = high→low and only the treble four, because
   * that's what a pick actually catches. Spread tightens as the hand speeds up.
   * `strings` restricts the brush to a subset (pattern engine); `when` places
   * it on the audio clock (default: now + lookahead).
   */
  strum({ voicing, direction, dynamics, dead = false, palmMute = false, strings = null, when = null }) {
    if (!this.ready || !voicing) return null;
    const t0 = when ?? (this.now() + LOOKAHEAD);
    const down = direction === 'down';
    let idx = voicing.midi.map((m, i) => (m === null ? -1 : i)).filter((i) => i >= 0);
    if (strings) idx = idx.filter((i) => strings.includes(i));
    if (!down) idx = idx.slice(-4).reverse();

    const spread = lerp(0.052, 0.008, dynamics);
    const decay = (dead ? 0.085 : palmMute ? 0.33 : 3.6) * (0.7 + dynamics * 0.5);
    // Harder strums are brighter, both in the pick noise and in the string's
    // own damping — the acoustic reason a hard strum "cuts".
    const loopHz = dead ? 900 : palmMute ? 1600 : lerp(2200, 5200, dynamics);
    const pickHz = lerp(1400, 6000, dynamics) * (dead ? 0.5 : 1);
    const a = coef(loopHz, this.sr || 48000), ba = coef(pickHz, this.sr || 48000);

    const hits = [];
    idx.forEach((s, k) => {
      const frac = idx.length > 1 ? k / (idx.length - 1) : 0;
      const dt = Math.max(0, frac * spread + (Math.random() - 0.5) * 0.002);
      const vel = clamp(dynamics * (down ? 1 - frac * 0.18 : 0.8 - frac * 0.14) * (0.92 + Math.random() * 0.16), 0, 1);
      this._pluck(s, mtof(voicing.midi[s]), vel, decay, a, ba, t0 + dt, s < 2 ? 0.8 : 1);
      hits.push({ string: s, delay: dt, velocity: vel });
    });
    // Strings the shape mutes still get clicked by the pick.
    if (!strings) voicing.midi.forEach((m, i) => {
      if (m !== null) return;
      this._pluck(i, mtof(OPEN[i]), dynamics * 0.09, 0.05, coef(700, this.sr || 48000), ba, t0 + Math.random() * spread, 0.7);
    });
    return { hits, spread, direction, dynamics };
  }

  /**
   * One fingerpicked string — the new right hand's bread and butter.
   * Softer pick filter than a strummed hit: fingertip, not plectrum.
   */
  pluckOne({ voicing, string, velocity, dead = false, when = null }) {
    if (!this.ready || !voicing || voicing.midi[string] === null) return null;
    const t0 = when ?? (this.now() + PLUCK_LOOKAHEAD);
    const decay = (dead ? 0.09 : 3.8) * (0.75 + velocity * 0.4);
    const a = coef(dead ? 900 : lerp(2400, 4600, velocity), this.sr || 48000);
    const ba = coef(lerp(1200, 3800, velocity), this.sr || 48000);
    const vel = clamp(velocity, 0, 1) * (string < 2 ? 0.85 : 1);
    this._pluck(string, mtof(voicing.midi[string]), vel, decay, a, ba, t0, string < 2 ? 0.8 : 1);
    // `delay` is the offset *within* this event, the way a strum's spread is —
    // the caller has already placed the event itself on the visual clock.
    return { hits: [{ string, delay: 0, velocity: vel }], direction: null, dynamics: velocity };
  }

  _pluck(s, freq, vel, decay, a, ba, when, gain) {
    if (this.node) {
      const sr = this.sr;
      const period = sr / freq;
      // fb^(roundtrips) = 1e-3 after `decay` seconds
      const fb = clamp(Math.exp((-6.9 * period) / (sr * decay)), 0, 0.9995);
      this.node.port.postMessage({ t: 'pluck', s, period, vel, fb, a, ba, gain, when });
    } else {
      this.fallback.pluck(s, freq, vel, decay, when);
    }
  }

  allOff() {
    if (!this.ready) return;
    this.node ? this.node.port.postMessage({ t: 'silence' }) : this.fallback.silence();
  }
}
