/**
 * karplus-worklet.js — six plucked strings, extended Karplus-Strong.
 *
 * Why a worklet instead of Tone's LowpassCombFilter: Web Audio clamps a
 * DelayNode's delayTime to one render quantum (128 samples ≈ 2.7 ms) whenever
 * the delay sits inside a feedback loop. That caps a comb-filter string at
 * ~375 Hz, so everything above F#4 plays flat — i.e. most of the fretted range.
 * Running the delay line by hand gives correct tuning across the whole neck,
 * fractional-sample delay (so bends and vibrato are smooth rather than
 * stepped), and sample-accurate strum spread.
 *
 * Message protocol (main thread → processor):
 *   { t:'pluck', s, period, vel, fb, a, ba, gain, when }
 *   { t:'expr',  bend, depth, rate }
 *   { t:'silence' }
 */

const NSTR = 6;
const SIZE = 4096, MASK = SIZE - 1;   // ≥ one period of the lowest note we play

class StringVoice {
  constructor() {
    this.buf = new Float32Array(SIZE);
    this.w = 0;
    this.period = 200;   // loop length in samples = 1 / fundamental
    this.fb = 0.99;      // per-round-trip feedback → sets decay time
    this.a = 0.33;       // loop lowpass coefficient → sets brightness/damping
    this.ba = 0.5;       // excitation lowpass → pick softness
    this.lp = 0;
    this.bl = 0;
    this.burst = 0;      // excitation samples remaining
    this.amp = 0;
    this.gain = 1;
  }

  pluck(period, vel, fb, a, ba, gain) {
    // A pick damps the string on the way in. Scaling the delay line (rather
    // than zeroing it) kills the old note without a hard discontinuity, and
    // is what makes re-striking a ringing string sound like a guitar instead
    // of like two overlapping synth voices.
    const b = this.buf;
    for (let i = 0; i < SIZE; i++) b[i] *= 0.22;
    this.lp *= 0.22;
    this.period = period;
    this.fb = fb; this.a = a; this.ba = ba; this.gain = gain;
    this.burst = Math.max(8, Math.round(period));   // classic: one period of noise
    this.amp = vel;
    this.bl = 0;
  }
}

class GuitarProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.v = Array.from({ length: NSTR }, () => new StringVoice());
    this.queue = [];
    this.bendRatio = 1;
    this.depth = 0;
    this.rate = 5.4;
    this.phase = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'pluck') {
        this.queue.push(m);
        this.queue.sort((p, q) => p.when - q.when);
      } else if (m.t === 'expr') {
        // Bend shortens the loop; 2^(-semitones/12) because delay ∝ 1/frequency.
        this.bendRatio = Math.pow(2, -m.bend / 12);
        this.depth = m.depth; this.rate = m.rate;
      } else if (m.t === 'silence') {
        for (const v of this.v) { v.buf.fill(0); v.lp = 0; v.burst = 0; }
        this.queue.length = 0;
      }
    };
  }

  process(_in, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const n = out.length, sr = sampleRate, t0 = currentTime;
    const dPhase = (2 * Math.PI * this.rate) / sr;

    for (let i = 0; i < n; i++) {
      // Sample-accurate event dispatch: this is what preserves the few-ms
      // string-to-string offset that makes a strum read as a strum.
      while (this.queue.length && (this.queue[0].when - t0) * sr <= i) {
        const m = this.queue.shift();
        this.v[m.s].pluck(m.period, m.vel, m.fb, m.a, m.ba, m.gain);
      }

      this.phase += dPhase;
      if (this.phase > 6.283185307) this.phase -= 6.283185307;
      const mul = this.bendRatio * (1 + this.depth * Math.sin(this.phase));

      let sum = 0;
      for (let s = 0; s < NSTR; s++) {
        const v = this.v[s];
        // Total loop delay must equal one period, and the loop lowpass already
        // contributes (1-a)/a samples of group delay — subtract it or every
        // note sits slightly flat.
        let d = v.period * mul - (1 - v.a) / v.a;
        if (d < 2) d = 2; else if (d > SIZE - 2) d = SIZE - 2;

        let rp = v.w - d;
        if (rp < 0) rp += SIZE;
        const i0 = rp | 0, frac = rp - i0;
        const s0 = v.buf[i0 & MASK], s1 = v.buf[(i0 + 1) & MASK];
        const x = s0 + (s1 - s0) * frac;          // fractional-delay read

        v.lp += v.a * (x - v.lp);
        if (v.lp > -1e-20 && v.lp < 1e-20) v.lp = 0;   // denormal guard

        let exc = 0;
        if (v.burst > 0) {
          v.burst--;
          v.bl += v.ba * ((Math.random() * 2 - 1) * v.amp - v.bl);
          exc = v.bl;
        }
        v.buf[v.w] = v.lp * v.fb + exc;
        v.w = (v.w + 1) & MASK;

        sum += (x + exc * 0.4) * v.gain;           // pre-filter tap = brighter
      }
      out[i] = sum;
    }
    return true;
  }
}

registerProcessor('air-guitar-strings', GuitarProcessor);
