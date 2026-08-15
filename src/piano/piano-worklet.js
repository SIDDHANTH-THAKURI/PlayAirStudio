/**
 * piano-worklet.js — struck strings by modal synthesis.
 *
 * A piano note is a struck string, so the same reasoning that put the guitar in
 * a worklet applies, but the model differs. Karplus-Strong is a delay line: it
 * gives you a *harmonic* series for free, which is right for a plucked nylon
 * string and wrong for a piano. Real piano strings are stiff, and stiffness
 * makes their partials progressively sharp of the harmonic series
 * (`fₙ = n·f₀·√(1+Bn²)`). That inharmonicity is not a defect to be corrected —
 * it is most of why a piano sounds like a piano and not like an organ, and it
 * is why piano tuners stretch octaves.
 *
 * Each note is therefore an explicit sum of decaying partials, which buys four
 * things a delay line will not give up without a fight:
 *
 *   • inharmonicity, by simply placing each partial where physics puts it;
 *   • per-partial decay — high partials die away far faster than the
 *     fundamental, which is the sound of a note "blooming" then settling, and
 *     is the single biggest cue that a note was struck rather than blown;
 *   • velocity as *brightness*. Hitting a key harder does not merely make it
 *     louder, it excites more upper partials. Loudness alone reads as a volume
 *     knob; brightness reads as effort, which is what makes dynamics physical;
 *   • the hammer's *strike point*. A real hammer hits about an eighth of the
 *     way along the string, which cannot excite the 8th partial (or the 16th)
 *     at all, because the string is stationary there for those modes. Notching
 *     them out is one multiply and is a large part of the characteristic
 *     hollowness of the tone.
 *
 * Each partial is voiced **twice**, and this is the biggest single step from
 * "synthesised" toward "instrument". A real string vibrates in two planes at
 * once: the vertical motion couples hard into the bridge, so it is loud and
 * dies fast, while the horizontal barely couples at all, so it is quiet and
 * rings on long after. Their sum is the piano's famous two-stage decay — a
 * brisk initial fall, then a long soft aftersound — which no single decaying
 * sinusoid can produce, because one exponential is a straight line in dB.
 * Unison strings add a touch more of the same. The pair is left a fraction of
 * a cent apart, which keeps the tone alive without beating: mistune it enough
 * to hear the beat and the note audibly dies and comes back, which is much
 * worse than no beating at all.
 *
 * Each partial is one two-pole resonator run in its free response:
 *     y[n] = 2·r·cos(ω)·y[n−1] − r²·y[n−2]
 * which is an exponentially decaying sinusoid for two multiplies a sample, with
 * no `sin()` in the inner loop and no wavetable to interpolate.
 *
 * Message protocol (main thread → processor):
 *   { t:'note',  midi, hz, vel, sustain, when }
 *   { t:'damp',  midi }        — the player lifted their finger
 *   { t:'params', sustain }
 *   { t:'silence' }
 */

const VOICES = 12;          // more than ten fingers can ask for
const PARTIALS = 14;
/* The second string only doubles the low partials. That is where beating is
 * audible, and it keeps the cost near one string rather than two. */
const UNISON_PARTIALS = 6;
const MODES = PARTIALS + UNISON_PARTIALS;

class Voice {
  constructor() {
    this.midi = -1;
    this.active = false;
    this.age = 0;
    this.n = 0;                              // resonators actually in use
    this.c1 = new Float64Array(MODES);
    this.c2 = new Float64Array(MODES);
    this.y1 = new Float64Array(MODES);
    this.y2 = new Float64Array(MODES);
    this.hammer = 0;                         // excitation samples remaining
    this.hz = 0; this.hLp = 0; this.hA = 0; this.hAmp = 0;
    this.gain = 0; this.damping = 0;
    this.panL = 0.707; this.panR = 0.707;
  }

  /**
   * Strike this string.
   *
   * `sustain` scales every decay time — a stand-in for the damper pedal, since
   * tapping a desk gives no key-release to lift a damper on. Re-striking a
   * ringing note scales its existing state down rather than zeroing it, for the
   * same reason the guitar does: killing the old note outright makes a repeated
   * note sound like two synth voices overlapping instead of one string being
   * hit twice.
   */
  strike(midi, hz, vel, sustain, sr) {
    const reused = this.active && this.midi === midi;
    for (let p = 0; p < MODES; p++) {
      if (reused) { this.y1[p] *= 0.25; this.y2[p] *= 0.25; }
      else { this.y1[p] = 0; this.y2[p] = 0; }
    }
    this.midi = midi; this.hz = hz; this.active = true; this.age = 0; this.damping = 0;

    // Inharmonicity coefficient. Bass strings are short relative to their pitch
    // and so are the stiffest; the treble climbs again. Small numbers, large
    // audible consequences.
    const B = 0.0004 + 0.0016 * Math.exp(-(midi - 21) / 26) + 0.0000009 * Math.max(0, midi - 74) ** 2;
    /* Longer strings ring longer — roughly an order of magnitude from the
     * bottom of the keyboard to the top.
     *
     * The coefficient is 5.5 rather than the 13 a pedalled grand measures,
     * and that is a playability decision rather than a modelling one. On a
     * real piano a low note rings that long *because you can stop it* — you
     * lift the key, or the pedal. Tapping a desk gives no key release at all,
     * so in the default 'pedal' damper mode nothing ever ends a note early:
     * every strike runs its full course. At 13 a left-hand note was audible
     * for 22.9 s measured, and since the register split puts the left hand two
     * octaves down, an ordinary bass line stacked a dozen 20-second voices on
     * top of each other. That is the "loud continuous weird sound".
     *
     * Scaled uniformly rather than compressed: the ratio between bass and
     * treble is a real property of strings and the tests check it, so the
     * whole curve moves and its shape does not. `sustain` still scales this
     * either way, so a longer tail is one slider away. */
    const t60 = Math.max(0.55, 5.5 * Math.pow(hz / 55, -0.62)) * (0.45 + 1.15 * sustain);
    const nyq = sr * 0.47;
    /* Hammer strike point, as a fraction of the string. Real actions strike
     * nearer the end in the treble; the ratio is why partial 8 (and 16) all but
     * vanish in the bass and mid. */
    const strikePos = midi < 60 ? 0.125 : 0.125 + 0.045 * Math.min(1, (midi - 60) / 28);
    /* Unison mistuning, in *cents* rather than hertz.
     *
     * A fixed hertz offset is a very different interval at 60 Hz than at 2 kHz
     * — it detuned the bass by more than a sixth of a semitone, which measured
     * as the whole instrument going flat. A cent and a half is what a tuner
     * would leave, and it stays a cent and a half everywhere.
     *
     * Below the bottom of the tenor range there is no partner at all, because
     * real pianos string those notes singly. That is both the honest model and
     * the reason the bass now sits in tune. */
    /* Half a cent. Enough that the pair never phase-locks into something
     * sterile, far too little to beat audibly inside the life of a note —
     * measured, 1.5 cents put a null right in the middle of a held C4. */
    const detune = hz * 0.000289;              // ≈0.5 cents
    const unison = midi >= 36 ? UNISON_PARTIALS : 0;

    let n = 0;
    for (let p = 1; p <= PARTIALS; p++) {
      const f = hz * p * Math.sqrt(1 + B * p * p);
      if (f >= nyq) break;                       // no aliasing, ever
      // Spectral tilt: 1/p falloff, tilted further by how hard the key was
      // struck. A soft note keeps almost only its fundamental; a hard one
      // arrives with the whole series lit up.
      const tilt = Math.pow(vel, 0.35 + 0.16 * (p - 1));
      const notch = Math.abs(Math.sin(Math.PI * p * strikePos));
      const amp = (0.9 / Math.pow(p, 1.22)) * tilt * notch;
      // Upper partials decay faster, and faster still the higher they are.
      const dp = t60 / (1 + 0.55 * (p - 1) + 0.04 * (p - 1) * (p - 1));

      n = this._mode(n, f, amp, dp, sr, reused);
      if (p <= unison && n < MODES) {
        /* The weakly-coupled partner: a fraction of a cent apart, much
         * quieter, and ringing well over twice as long. Quiet enough to stay
         * out of the way of the attack, persistent enough to still be there
         * when the prompt sound has gone — which is the aftersound. */
        /* …capped in absolute terms as well as relative. 2.4× is what makes
         * the two-stage tail, but 2.4× of a bass note's decay is half a minute
         * of aftersound that nothing can stop. The cap only ever binds in the
         * bottom octave — at C4 the partner is 5.5 s and passes straight
         * through — so the bend the tests measure is untouched. */
        n = this._mode(n, f + detune, amp * 0.35, Math.min(dp * 2.4, 9), sr, reused);
      }
    }
    this.n = n;

    // The hammer itself: a short filtered noise burst. Felt on a bass string is
    // soft and thuddy, a treble hammer is a hard tick, and both get brighter
    // the harder they are thrown.
    this.hammer = Math.max(24, Math.round(sr * (0.0032 + 900 / (hz * 1000))));
    this.hA = Math.min(0.9, 0.10 + 0.55 * vel + hz / 6000);
    this.hAmp = 0.16 * vel * (0.6 + 0.5 * Math.min(1, hz / 500));
    this.hLp = 0;
    this.gain = 0.34 * (0.35 + 0.65 * vel);

    /* A little stereo, laid out as the player hears it from the keyboard: bass
     * to the left, treble to the right. Costs nothing and does more for
     * "sounds like a real instrument in a room" than most of the spectrum work.
     */
    const pan = Math.max(-1, Math.min(1, (midi - 60) / 34)) * 0.55;
    this.panL = Math.cos((pan + 1) * Math.PI / 4);
    this.panR = Math.sin((pan + 1) * Math.PI / 4);
  }

  /** Seed one resonator's free response at `amp`, decaying to −60 dB in `dp`. */
  _mode(n, f, amp, dp, sr, reused) {
    if (n >= MODES || f >= sr * 0.47) return n;
    const w = (2 * Math.PI * f) / sr;
    const r = Math.exp(-6.9078 / (dp * sr));
    this.c1[n] = 2 * r * Math.cos(w);
    this.c2[n] = r * r;
    const seed = amp * Math.sin(w);
    if (reused) this.y1[n] += seed; else this.y1[n] = seed;
    this.y2[n] = 0;
    return n + 1;
  }

  /** Damp like a felt: fast, but not a click. */
  release() { this.damping = 0.9992; }
}

class PianoProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.v = Array.from({ length: VOICES }, () => new Voice());
    this.queue = [];
    this.sustain = 0.55;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'note') {
        this.queue.push(m);
        this.queue.sort((a, b) => a.when - b.when);
      } else if (m.t === 'params') {
        if (typeof m.sustain === 'number') this.sustain = m.sustain;
      } else if (m.t === 'damp') {
        for (const v of this.v) if (v.active && v.midi === m.midi) v.release();
      } else if (m.t === 'silence') {
        for (const v of this.v) { v.active = false; v.n = 0; v.hammer = 0; v.y1.fill(0); v.y2.fill(0); }
        this.queue.length = 0;
      }
    };
  }

  /**
   * Pick a voice. Same note first (a re-strike belongs on the string it is
   * re-striking), then anything idle, then the oldest — stealing the note that
   * has been decaying longest is the least audible theft available.
   */
  _take(midi) {
    let idle = null, oldest = this.v[0];
    for (const v of this.v) {
      if (v.active && v.midi === midi) return v;
      if (!v.active && !idle) idle = v;
      if (v.age > oldest.age) oldest = v;
    }
    return idle || oldest;
  }

  process(_in, outputs) {
    const chans = outputs[0];
    const L = chans[0];
    if (!L) return true;
    const R = chans[1] || null;
    const n = L.length, sr = sampleRate, t0 = currentTime;

    for (let i = 0; i < n; i++) {
      // Sample-accurate dispatch: a chord's notes are meant to be simultaneous,
      // and quantising them to the 128-sample block would smear them.
      while (this.queue.length && (this.queue[0].when - t0) * sr <= i) {
        const m = this.queue.shift();
        this._take(m.midi).strike(m.midi, m.hz, m.vel, m.sustain ?? this.sustain, sr);
      }

      let l = 0, r = 0;
      for (let k = 0; k < VOICES; k++) {
        const v = this.v[k];
        if (!v.active) continue;
        v.age++;

        let s = 0;
        for (let p = 0; p < v.n; p++) {
          const y = v.c1[p] * v.y1[p] - v.c2[p] * v.y2[p];
          v.y2[p] = v.y1[p]; v.y1[p] = y;
          s += y;
        }

        if (v.hammer > 0) {
          v.hammer--;
          v.hLp += v.hA * ((Math.random() * 2 - 1) * v.hAmp - v.hLp);
          s += v.hLp;
        }

        if (v.damping) {
          v.gain *= v.damping;
          if (v.gain < 1e-4) { v.active = false; v.damping = 0; v.n = 0; continue; }
        }
        const out = s * v.gain;
        l += out * v.panL; r += out * v.panR;

        // Retire a voice once it is inaudible, and flush denormals on the way —
        // subnormal arithmetic is punishingly slow and would show up as audio
        // glitching long after the note itself stopped mattering.
        if ((v.age & 1023) === 0) {
          let energy = 0;
          for (let p = 0; p < v.n; p++) {
            if (v.y1[p] > -1e-18 && v.y1[p] < 1e-18) { v.y1[p] = 0; v.y2[p] = 0; }
            energy += Math.abs(v.y1[p]);
          }
          if (energy < 1e-7 && v.hammer <= 0) { v.active = false; v.n = 0; }
        }
      }
      if (R) { L[i] = l; R[i] = r; } else { L[i] = (l + r) * 0.7071; }
    }
    return true;
  }
}

registerProcessor('air-piano-strings', PianoProcessor);
