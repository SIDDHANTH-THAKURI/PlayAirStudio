/**
 * audio.js — the piano's signal chain.
 *
 * Strings live in `piano-worklet.js`; everything after them is Tone: a tone
 * control, gentle EQ, a room, and a limiter to catch ten-finger clusters.
 *
 * Latency is the whole point of this instrument, so the scheduling headroom is
 * deliberately smaller than the guitar's. A guitar strum needs a few
 * milliseconds of runway to lay out its string-to-string spread; a struck key
 * has nothing to lay out, and every millisecond between your finger stopping on
 * the desk and the note arriving is a millisecond the thing feels dead.
 */
import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.7.77/+esm';

/* Runway for the worklet to place a note sample-accurately.
 *
 * Deliberately tiny. Arriving a hair *late* is harmless here — the worklet
 * simply starts the note at the top of the current block, which is at most one
 * render quantum (2.7 ms) away and produces no click, because a struck string
 * begins from silence either way. So there is nothing to buy by scheduling
 * further out, and every millisecond of it is felt between the desk and the
 * sound. */
export const LOOKAHEAD = 0.004;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Used only where AudioWorklet isn't available at all. */
class FallbackBank {
  constructor(dest) {
    this.poly = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.2, modulationIndex: 9,
      envelope: { attack: 0.002, decay: 1.6, sustain: 0.02, release: 1.4 },
      modulationEnvelope: { attack: 0.002, decay: 0.28, sustain: 0, release: 0.2 },
    }).connect(dest);
    this.poly.maxPolyphony = 14;
  }
  note(midi, vel, when) {
    try { this.poly.triggerAttackRelease(mtof(midi), 1.4, when, clamp(vel, 0.05, 1)); } catch {}
  }
  silence() { try { this.poly.releaseAll(); } catch {} }
}

export class PianoEngine {
  constructor() { this.ready = false; this.sustain = 0.55; this.tone = 0.5; }

  async init() {
    await Tone.start();
    const ctx = Tone.getContext();
    try { ctx.lookAhead = 0.01; } catch {}
    this.sr = ctx.sampleRate || 48000;
    const D = Tone.getDestination ? Tone.getDestination() : Tone.Destination;

    this.limiter = new Tone.Limiter(-1.2).connect(D);
    this.reverb = new Tone.Reverb({ decay: 1.9, preDelay: 0.008, wet: 0.18 }).connect(this.limiter);
    this.eq = new Tone.EQ3({ low: 1.5, mid: -1, high: 1, lowFrequency: 250, highFrequency: 2800 }).connect(this.reverb);
    this.lid = new Tone.Filter({ type: 'lowpass', frequency: 7000, rolloff: -12, Q: 0.6 }).connect(this.eq);
    /* A hint of soundboard. A real piano's body has a broad low resonance that
     * is a good part of why the instrument sounds like furniture rather than an
     * oscillator; a single gentle peak gets most of the way there. */
    this.body = new Tone.Filter({ type: 'peaking', frequency: 140, Q: 0.7, gain: 3.5 }).connect(this.lid);
    this.bus = new Tone.Gain(0.5).connect(this.body);

    // Tone 14 runs on standardized-audio-context: its nodes are wrappers rather
    // than native AudioNodes, so the worklet has to be created *through* Tone's
    // context or it cannot join this graph.
    this.node = null;
    try {
      const url = new URL('./piano-worklet.js', import.meta.url).href;
      // Stereo out: the worklet pans by pitch, bass left, treble right, the way
      // it sits under your hands at a keyboard.
      const opts = { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] };
      if (typeof ctx.addAudioWorkletModule === 'function') {
        await ctx.addAudioWorkletModule(url, 'air-piano-strings');
        this.node = ctx.createAudioWorkletNode('air-piano-strings', opts);
      } else {
        const raw = ctx.rawContext;
        await raw.audioWorklet.addModule(url);
        this.node = new AudioWorkletNode(raw, 'air-piano-strings', opts);
      }
      Tone.connect(this.node, this.bus);
    } catch (err) {
      console.warn('[air-piano] AudioWorklet unavailable, using an FM fallback:', err?.message);
      this.node = null;
      this.fallback = new FallbackBank(this.bus);
    }

    try { await this.reverb.generate(); } catch {}
    this.setSustain(this.sustain);
    this.ready = true;
  }

  now() { const ctx = Tone.getContext(); return ctx.currentTime ?? Tone.now(); }

  setVolume(v01) {
    const D = Tone.getDestination ? Tone.getDestination() : Tone.Destination;
    D.volume.rampTo(v01 <= 0.001 ? -60 : lerp(-26, 3, Math.pow(v01, 0.6)), 0.08);
  }
  setRoom(v01) { this.reverb?.wet.rampTo(clamp(v01, 0, 1), 0.15); }
  /** Lid position, in spirit: closed is dark and intimate, open is bright. */
  setTone(v01) {
    this.tone = v01;
    this.lid?.frequency.rampTo(clamp(1400 * Math.pow(14, v01), 900, 16000), 0.1);
  }
  setSustain(v01) {
    this.sustain = clamp(v01, 0, 1);
    this.node?.port.postMessage({ t: 'params', sustain: this.sustain });
  }

  /**
   * Strike a key. `when` defaults to as soon as the audio thread can honour it.
   * @returns the scheduled audio time, so the overlay can line its flash up
   *          with the sound rather than with the frame that detected it.
   */
  note(midi, velocity, when = null) {
    if (!this.ready) return null;
    const t = when ?? this.now() + LOOKAHEAD;
    const vel = clamp(velocity, 0.05, 1);
    if (this.node) {
      this.node.port.postMessage({ t: 'note', midi, hz: mtof(midi), vel, sustain: this.sustain, when: t });
    } else {
      this.fallback.note(midi, vel, t);
    }
    return t;
  }

  /** The player lifted their finger; let the damper fall on that note. */
  damp(midi) {
    if (this.ready) this.node?.port.postMessage({ t: 'damp', midi });
  }

  allOff() {
    if (!this.ready) return;
    this.node ? this.node.port.postMessage({ t: 'silence' }) : this.fallback.silence();
  }
}
