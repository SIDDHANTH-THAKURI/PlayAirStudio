/**
 * audio.js — the drums' signal chain.
 *
 * The kit itself lives in `drum-worklet.js`; everything after it is Tone, and
 * it is doing a specific job: making seven synthesised drums sound like one
 * instrument in one room rather than seven sounds in a mixer.
 *
 * Latency matters more here than anywhere else in the project. A guitar strum
 * has a few milliseconds of internal spread to hide behind and a piano note
 * blooms rather than snaps, but a drum is *nothing but* its attack — timing
 * error is the only thing you hear. So the runway is the same 4 ms the piano
 * uses, and the reverb is short and quiet, because a long tail on a fast part
 * turns into mud that reads as lag whether or not it is.
 */
import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.7.77/+esm';

/** Runway for the worklet to place a hit sample-accurately. See piano/audio.js. */
export const LOOKAHEAD = 0.004;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Used only where AudioWorklet isn't available at all. */
class FallbackKit {
  constructor(dest) {
    this.noise = new Tone.NoiseSynth({ envelope: { attack: 0.001, decay: 0.16, sustain: 0 } }).connect(dest);
    this.body = new Tone.MembraneSynth({ octaves: 6, pitchDecay: 0.04 }).connect(dest);
  }
  hit(voice, vel, when) {
    const v = clamp(vel, 0.05, 1);
    try {
      if (voice === 'kick') this.body.triggerAttackRelease('C1', 0.3, when, v);
      else if (voice === 'tom') this.body.triggerAttackRelease('G2', 0.3, when, v);
      else if (voice === 'floor') this.body.triggerAttackRelease('D2', 0.4, when, v);
      else this.noise.triggerAttackRelease(voice === 'hihat' ? 0.03 : 0.3, when, v);
    } catch {}
  }
  silence() { try { this.noise.triggerRelease(); } catch {} }
}

export class DrumEngine {
  constructor() { this.ready = false; this.room = 0.22; }

  async init() {
    await Tone.start();
    const ctx = Tone.getContext();
    try { ctx.lookAhead = 0.01; } catch {}
    this.sr = ctx.sampleRate || 48000;
    const D = Tone.getDestination ? Tone.getDestination() : Tone.Destination;

    /* A drum kit is the one instrument that genuinely needs a compressor. Its
     * peaks are twenty decibels over its body by nature, so without one the
     * only way to get a kit *audible* is to have it clipping half the time.
     * A slow-ish attack lets the stick through before it clamps down, which is
     * the difference between control and squashing the life out of every hit. */
    this.limiter = new Tone.Limiter(-1).connect(D);
    this.comp = new Tone.Compressor({ threshold: -18, ratio: 3.2, attack: 0.006, release: 0.14 }).connect(this.limiter);
    this.reverb = new Tone.Reverb({ decay: 1.35, preDelay: 0.006, wet: this.room }).connect(this.comp);
    this.eq = new Tone.EQ3({ low: 2, mid: -1.5, high: 1.5, lowFrequency: 180, highFrequency: 3200 }).connect(this.reverb);
    // Rolls off the very top so the cymbals read as metal rather than as hiss.
    this.air = new Tone.Filter({ type: 'lowpass', frequency: 13000, rolloff: -12, Q: 0.5 }).connect(this.eq);
    this.bus = new Tone.Gain(0.85).connect(this.air);

    // Tone 14 runs on standardized-audio-context: its nodes are wrappers rather
    // than native AudioNodes, so the worklet has to be created *through* Tone's
    // context or it cannot join this graph.
    this.node = null;
    try {
      const url = new URL('./drum-worklet.js', import.meta.url).href;
      const opts = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] };
      if (typeof ctx.addAudioWorkletModule === 'function') {
        await ctx.addAudioWorkletModule(url, 'air-drums-kit');
        this.node = ctx.createAudioWorkletNode('air-drums-kit', opts);
      } else {
        const raw = ctx.rawContext;
        await raw.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(raw, 'air-drums-kit', opts);
      }
      Tone.connect(this.node, this.bus);
    } catch (err) {
      console.warn('[air-drums] AudioWorklet unavailable, using a fallback kit:', err?.message);
      this.node = null;
      this.fallback = new FallbackKit(this.bus);
    }

    try { await this.reverb.generate(); } catch {}
    this.ready = true;
  }

  now() { const ctx = Tone.getContext(); return ctx.currentTime ?? Tone.now(); }

  setVolume(v01) {
    const D = Tone.getDestination ? Tone.getDestination() : Tone.Destination;
    D.volume.rampTo(v01 <= 0.001 ? -60 : lerp(-24, 4, Math.pow(v01, 0.6)), 0.08);
  }
  setRoom(v01) { this.room = clamp(v01, 0, 1); this.reverb?.wet.rampTo(this.room, 0.15); }

  /**
   * Strike a drum.
   *
   * @param pan  where across the pad it was struck, −1…1. Real drums answer
   *             differently near the rim, and it also spreads a two-handed part
   *             out so the two sticks are distinguishable.
   * @param tone 0…1, only the ride uses it: bow to bell.
   * @returns the scheduled audio time, so the overlay can line its flash up
   *          with the sound rather than with the frame that detected it.
   */
  hit(voice, velocity, { when = null, pan = 0, tone } = {}) {
    if (!this.ready) return null;
    const t = when ?? this.now() + LOOKAHEAD;
    const vel = clamp(velocity, 0.05, 1);
    if (this.node) {
      this.node.port.postMessage({ t: 'hit', voice, vel, pan: clamp(pan, -1, 1) * 0.35, tone, when: t });
    } else {
      this.fallback.hit(voice, vel, t);
    }
    return t;
  }

  allOff() {
    if (!this.ready) return;
    this.node ? this.node.port.postMessage({ t: 'silence' }) : this.fallback.silence();
  }
}
