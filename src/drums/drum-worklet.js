/**
 * drum-worklet.js — the kit itself, synthesised.
 *
 * Samples would have been the easy answer, and the wrong one. A sampled kit
 * plays the same snare hit at seven volumes; a real one answers differently to
 * every stroke, and since this instrument's whole proposition is that your arm
 * is the controller, a kit that ignores how you moved it would undo the point.
 * Synthesis also keeps the download at zero bytes, which matters for something
 * that has to be usable the moment the page opens.
 *
 * Percussion is not one model, it is three, and each drum is built from
 * whichever of them physics calls for:
 *
 *  • **A swept sine** for anything with a big, slack head — kick and toms. The
 *    reason a kick has a *pitch* at all is that the head is stretched hard by
 *    the beater and relaxes: the note starts high and falls within about forty
 *    milliseconds. That fall is the entire character of the drum. Take it away
 *    and you have a low beep.
 *  • **Resonant modes** for anything that rings — snare head, tom shell,
 *    cymbals. These are the same two-pole resonators the piano uses,
 *    `y[n] = 2r·cos(ω)·y[n−1] − r²·y[n−2]`, but placed *inharmonically*: a
 *    circular membrane's modes fall at 1, 1.59, 2.14, 2.30… of its fundamental,
 *    not at whole-number multiples, and a cymbal's are more scattered still.
 *    That inharmonicity is precisely why a drum reads as a drum rather than as
 *    a pitched note played badly.
 *  • **Filtered noise** for everything the modes cannot describe — the snare
 *    wires rattling underneath, the beater's click, the wash of a cymbal. Its
 *    filter *sweeps closed* as it decays, because a struck cymbal loses its top
 *    end long before it goes quiet, and a static filter sounds like a hiss with
 *    a volume envelope.
 *
 * Velocity does more than set the gain. A harder stroke drives the modes higher
 * up the bank, opens the noise filter, and lengthens the tail — which is what
 * hitting a drum harder actually does, and is why dynamics here feel like
 * effort rather than like a volume knob.
 *
 * Message protocol (main thread → processor):
 *   { t:'hit', voice, vel, when, tone }
 *   { t:'choke', voice }     — closing the hi-hat cuts the open one
 *   { t:'silence' }
 */

const VOICES = 20;          // a fast roll on a long cymbal needs headroom
const MODES = 16;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Per-sample decay multiplier for a given −60 dB time. */
const decayTo = (secs, sr) => Math.exp(-6.9078 / Math.max(1e-4, secs * sr));
/* Chamberlin SVF tuning coefficient. It goes unstable as `f` approaches 2−q,
 * which in practice means the cutoff cannot be pushed past about a sixth of the
 * sample rate — so it is clamped there rather than left to blow up on whatever
 * hardware happens to be running at 44.1k. */
const svfF = (hz, sr) => 2 * Math.sin(Math.PI * Math.min(hz, sr / 6.2) / sr);

/* ------------------------------------------------------------------ *
 *  Recipes
 *
 *  Each returns { modes:[{ hz, decay, gain }], osc, noise } for one stroke at
 *  one velocity. Built per hit rather than per voice because velocity changes
 *  the shape of the sound and not merely its level.
 * ------------------------------------------------------------------ */

/** Circular-membrane mode ratios — a drum head's, not a string's. */
const MEMBRANE = [1, 1.593, 2.135, 2.295, 2.653, 2.917, 3.155, 3.5];

/** Cymbals: scattered, dense, no pattern the ear can name. */
const CYMBAL = [1, 1.41, 1.78, 2.19, 2.63, 3.21, 3.79, 4.44, 5.13, 6.02, 7.11, 8.34];

function recipe(voice, vel, tone = 0.5) {
  const v = clamp(vel, 0.05, 1);
  const hard = v * v;                 // brightness rises faster than loudness

  switch (voice) {
    case 'kick': {
      /* The pitch envelope is the drum. Starting a little higher when hit
       * harder is what a stretched head really does. */
      const f0 = lerp(92, 138, hard), f1 = 47;
      return {
        osc: { f0, f1, glide: 0.030, amp: 0.92, decay: lerp(0.34, 0.52, v) },
        modes: [{ hz: 84, decay: 0.20, gain: 0.10 * v }],
        noise: {
          amp: 0.30 * hard, decay: 0.008, fc: 2600, fcEnd: 900, glide: 0.010,
          q: 1.1, band: 0.4, high: 0.6,
        },
        gain: 1.05,
      };
    }

    case 'snare': {
      const f0 = 186;
      const modes = MEMBRANE.slice(0, 6).map((r, i) => ({
        hz: f0 * r * (1 + 0.004 * i),
        decay: lerp(0.20, 0.055, i / 5) * lerp(0.85, 1.1, v),
        // Harder strokes reach further up the bank; soft ones stay fundamental.
        gain: (0.60 / (1 + i * 0.85)) * lerp(1, 1 + i * 0.24, hard),
      }));
      return {
        modes,
        /* The wires. Band-passed high and sweeping down, with a decay a little
         * longer than the head's — a snare's rattle outlasts its note, which is
         * why a snare hit has a "sss" after the "thock". */
        noise: {
          amp: lerp(0.20, 0.66, v), decay: lerp(0.20, 0.34, v),
          fc: lerp(2200, 4400, hard), fcEnd: 1500, glide: 0.10,
          q: 0.75, band: 0.80, high: 0.30,
        },
        gain: 0.95,
      };
    }

    case 'hihat':
    case 'hihatOpen': {
      const open = voice === 'hihatOpen';
      const dec = open ? lerp(0.42, 0.72, v) : lerp(0.032, 0.058, v);
      /* Two discs clashing: high, metallic, and deliberately unmusical. The
       * ratios are prime-ish so nothing lines up into a pitch. */
      const modes = [1, 1.35, 1.77, 2.19, 2.63, 3.11, 3.72].map((r, i) => ({
        hz: 3180 * r,
        decay: dec * lerp(1.0, 0.55, i / 6),
        gain: (0.16 / (1 + i * 0.35)) * lerp(0.85, 1.15, hard) * lerp(1, 1 + i * 0.80, hard),
      }));
      return {
        modes,
        noise: {
          amp: lerp(0.24, 0.80, v), decay: dec * 0.85,
          fc: lerp(3200, 8000, hard), fcEnd: open ? 4200 : 6200, glide: open ? 0.30 : 0.04,
          q: 0.6, band: lerp(0.55, 0.18, hard), high: lerp(0.55, 1.0, hard),
        },
        gain: 0.62,
        /* Both hats belong to one physical object, so striking either silences
         * whatever it was already doing — which is exactly what the pedal does
         * when it slams shut on a ringing open hat. */
        group: 'hihat', chokes: 'hihat', chokeTime: open ? 0.055 : 0.018,
      };
    }

    case 'tom':
    case 'floor': {
      const low = voice === 'floor';
      const f0 = low ? lerp(88, 108, hard) : lerp(148, 176, hard);
      const f1 = low ? 78 : 132;
      const modes = MEMBRANE.slice(1, 7).map((r, i) => ({
        hz: f1 * r,
        decay: lerp(low ? 0.34 : 0.26, 0.07, i / 5),
        gain: (0.13 / (1 + i * 0.75)) * lerp(1, 1 + i * 0.55, hard),
      }));
      return {
        osc: { f0, f1, glide: low ? 0.055 : 0.040, amp: 0.72, decay: low ? lerp(0.62, 0.95, v) : lerp(0.44, 0.68, v) },
        modes,
        noise: { amp: 0.26 * hard, decay: lerp(0.006, 0.024, hard), fc: lerp(1300, 3400, hard), fcEnd: 700, glide: 0.020, q: 1.0, band: 0.45, high: 0.6 },
        gain: 0.90,
      };
    }

    case 'crash': {
      const modes = CYMBAL.map((r, i) => ({
        hz: 372 * r * (1 + 0.011 * ((i * 37) % 7) / 7),
        // Low modes ring for seconds, high ones for a fraction of one — that
        // gradient is the shimmer washing out into a hum.
        decay: lerp(4.6, 0.85, i / (CYMBAL.length - 1)) * lerp(0.75, 1.15, v),
        gain: (0.085 / (1 + i * 0.18)) * lerp(0.75, 1.3, hard),
      }));
      return {
        modes,
        noise: {
          amp: lerp(0.24, 0.44, v), decay: lerp(2.6, 4.0, v),
          fc: lerp(5200, 7600, hard), fcEnd: 1300, glide: 1.1,
          q: 0.5, band: 0.4, high: 0.85,
        },
        gain: 0.52, attack: 0.006,
      };
    }

    case 'ride': {
      /* A ride is heard as a *ping* over a wash, which is why it works under a
       * band and a crash does not. `tone` slides from bow to bell. */
      const bell = clamp(tone, 0, 1);
      const ping = [1, 2.24, 3.41].map((r, i) => ({
        hz: 516 * r,
        decay: lerp(2.3, 1.1, i / 2) * lerp(0.85, 1.15, v),
        gain: (0.20 / (1 + i * 0.6)) * lerp(0.8, 1.5, hard) * lerp(0.85, 2.4, bell),
      }));
      const wash = CYMBAL.slice(2).map((r, i) => ({
        hz: 408 * r,
        decay: lerp(4.2, 1.2, i / 9) * lerp(0.8, 1.1, v),
        gain: (0.040 / (1 + i * 0.22)) * lerp(0.8, 1.2, hard) * lerp(1.2, 0.40, bell),
      }));
      return {
        modes: ping.concat(wash).slice(0, MODES),
        noise: {
          amp: lerp(0.10, 0.20, v) * lerp(1, 0.6, bell), decay: lerp(2.2, 3.2, v),
          fc: lerp(4600, 7000, hard), fcEnd: 1800, glide: 0.9,
          q: 0.55, band: 0.4, high: 0.8,
        },
        gain: 0.56,
      };
    }
  }
  return null;
}

/** Where each drum sits across the stereo image, from the player's seat. */
const PAN = { kick: 0, snare: -0.12, hihat: -0.42, hihatOpen: -0.42, tom: 0.18, floor: 0.42, crash: -0.55, ride: 0.52 };

/* ------------------------------------------------------------------ */

class Voice {
  constructor() {
    this.active = false;
    this.n = 0;
    this.c1 = new Float64Array(MODES);
    this.c2 = new Float64Array(MODES);
    this.y1 = new Float64Array(MODES);
    this.y2 = new Float64Array(MODES);
    this.g = new Float64Array(MODES);
    this.age = 0;
  }
}

class DrumProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.v = Array.from({ length: VOICES }, () => new Voice());
    this.queue = [];
    this.master = 0.9;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.t === 'hit') {
        this.queue.push(m);
        this.queue.sort((a, b) => a.when - b.when);
      } else if (m.t === 'choke') {
        this._choke(m.voice, 0.045);
      } else if (m.t === 'params') {
        if (typeof m.master === 'number') this.master = clamp(m.master, 0, 2);
      } else if (m.t === 'silence') {
        this.queue.length = 0;
        for (const v of this.v) { v.active = false; v.n = 0; }
      }
    };
  }

  /** Fade out every voice of a kind — the pedal closing on an open hat. */
  _choke(kind, secs) {
    const d = decayTo(secs, sampleRate);
    for (const v of this.v) if (v.active && v.kind === kind && !v.choking) v.choking = d;
  }

  _take() {
    /* Steal the quietest, oldest voice rather than the first free one, so a
     * fast roll never cuts off the cymbal ringing underneath it. */
    let free = null, worst = null, worstScore = Infinity;
    for (const v of this.v) {
      if (!v.active) { free = v; break; }
      const score = v.level / (1 + v.age / sampleRate);
      if (score < worstScore) { worstScore = score; worst = v; }
    }
    return free || worst;
  }

  _start(msg) {
    const r = recipe(msg.voice, msg.vel ?? 0.8, msg.tone);
    if (!r) return;
    if (r.chokes) this._choke(r.chokes, r.chokeTime ?? 0.030);

    const v = this._take();
    const sr = sampleRate;
    v.active = true; v.age = 0; v.kind = r.group || msg.voice;
    v.level = 1; v.choking = 0;
    /* Overall loudness is applied once, here, rather than being sprinkled
     * through the recipes — which is where it was, and where the snare quietly
     * lost it: its head modes came out the same at every velocity. The recipes
     * now only describe how a stroke's *balance* shifts with force; how loud it
     * ends up is this one line. */
    v.gain = (r.gain ?? 1) * this.master * lerp(0.30, 1, clamp(msg.vel ?? 0.8, 0.05, 1));

    // Modes.
    const ms = (r.modes || []).slice(0, MODES);
    v.n = 0;
    for (const m of ms) {
      if (!(m.hz > 20) || m.hz > sr * 0.47 || !(m.gain > 1e-4)) continue;
      const i = v.n++;
      const w = 2 * Math.PI * m.hz / sr;
      const rr = decayTo(m.decay, sr);
      v.c1[i] = 2 * rr * Math.cos(w);
      v.c2[i] = rr * rr;
      /* A resonator this sharp has enormous gain at its own frequency — a
       * two-second decay is a Q in the thousands — so feeding it raw would put
       * the output three orders of magnitude over full scale. Its impulse
       * response is `a·rⁿ·sin((n+1)w)/sin(w)`, so scaling the input by `sin(w)`
       * makes `gain` mean what it says: the mode's actual peak amplitude,
       * whatever its frequency or how long it rings. */
      v.g[i] = m.gain * Math.sin(w);
      v.y1[i] = 0; v.y2[i] = 0;
    }

    /* Excite with a short noise burst rather than a single impulse. An impulse
     * gives every mode the same phase, which sums to one sharp click that
     * sounds like a click and not like a stick; a few milliseconds of noise
     * scatters them and reads as a strike. Cymbals get a longer one — they are
     * excited by a stick sliding across metal, not by a point impact. */
    v.excN = Math.max(1, Math.round((r.attack ?? 0.0015) * sr));
    // Held at constant *energy*, so lengthening the burst changes the texture
    // of the attack without also making the drum louder.
    v.excG = 1 / Math.sqrt(v.excN);

    // Swept body oscillator.
    const o = r.osc;
    v.oscOn = !!o;
    if (o) {
      v.f = o.f0; v.fEnd = o.f1;
      v.fk = 1 - Math.exp(-1 / Math.max(1e-4, o.glide * sr));
      v.oAmp = o.amp;
      v.oDec = decayTo(o.decay, sr);
      v.phase = Math.random();     // a kick that always starts at zero clicks
    }

    // Noise section.
    const nz = r.noise;
    v.nOn = !!nz;
    if (nz) {
      v.nAmp = nz.amp;
      v.nDec = decayTo(nz.decay, sr);
      v.nF = svfF(nz.fc, sr);
      v.nFEnd = svfF(nz.fcEnd, sr);
      v.nFk = 1 - Math.exp(-1 / Math.max(1e-4, nz.glide * sr));
      v.nQ = nz.q;
      v.nBand = nz.band; v.nHigh = nz.high;
      v.nLow = 0; v.nBandZ = 0;
    }

    const pan = clamp((PAN[msg.voice] ?? 0) + (msg.pan ?? 0), -1, 1);
    // Constant-power, so a kick down the middle isn't quieter than a hi-hat.
    const a = (pan + 1) * Math.PI / 4;
    v.panL = Math.cos(a); v.panR = Math.sin(a);
  }

  process(_in, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const L = out[0], R = out.length > 1 ? out[1] : null;
    const n = L.length, sr = sampleRate, t0 = currentTime;

    for (let i = 0; i < n; i++) {
      while (this.queue.length && (this.queue[0].when - t0) * sr <= i) this._start(this.queue.shift());

      let l = 0, r = 0;
      for (let k = 0; k < VOICES; k++) {
        const v = this.v[k];
        if (!v.active) continue;
        v.age++;

        // One noise sample, shared by the excitation and the noise section, so
        // the wires and the head are driven by the same rattle.
        const white = Math.random() * 2 - 1;
        const exc = v.excN > 0 ? (v.excN--, white * v.excG) : 0;

        let s = 0;
        for (let p = 0; p < v.n; p++) {
          const y = v.g[p] * exc + v.c1[p] * v.y1[p] - v.c2[p] * v.y2[p];
          v.y2[p] = v.y1[p]; v.y1[p] = y;
          s += y;
        }

        if (v.oscOn) {
          v.f += (v.fEnd - v.f) * v.fk;
          v.phase += v.f / sr;
          if (v.phase >= 1) v.phase -= 1;
          s += Math.sin(2 * Math.PI * v.phase) * v.oAmp;
          v.oAmp *= v.oDec;
        }

        if (v.nOn) {
          // Chamberlin state-variable filter; its cutoff closes as it decays.
          v.nF += (v.nFEnd - v.nF) * v.nFk;
          v.nLow += v.nF * v.nBandZ;
          const high = white - v.nLow - v.nQ * v.nBandZ;
          v.nBandZ += v.nF * high;
          s += (v.nBandZ * v.nBand + high * v.nHigh) * v.nAmp;
          v.nAmp *= v.nDec;
        }

        if (v.choking) {
          v.gain *= v.choking;
          if (v.gain < 1e-4) { v.active = false; v.n = 0; v.choking = 0; continue; }
        }

        const o = s * v.gain;
        l += o * v.panL; r += o * v.panR;

        /* Retire silent voices and flush denormals on the way. Subnormal
         * arithmetic is punishingly slow, and a cymbal's tail spends a long
         * time down there — it would show up as glitching in whatever is
         * playing next, long after the cymbal stopped mattering. */
        if ((v.age & 511) === 0) {
          let energy = (v.oscOn ? Math.abs(v.oAmp) : 0) + (v.nOn ? Math.abs(v.nAmp) : 0);
          for (let p = 0; p < v.n; p++) {
            if (v.y1[p] > -1e-18 && v.y1[p] < 1e-18) { v.y1[p] = 0; v.y2[p] = 0; }
            energy += Math.abs(v.y1[p]);
          }
          v.level = energy;
          if (energy < 2e-5 && v.excN <= 0) { v.active = false; v.n = 0; }
        }
      }

      /* A soft clip rather than a hard one. Everything in a drum kit peaks at
       * once by definition, and a limiter downstream cannot undo a sample that
       * already wrapped. tanh-ish, cheap, and inaudible below about 0.7. */
      l = l < -0.7 || l > 0.7 ? Math.sign(l) * (0.7 + 0.3 * Math.tanh((Math.abs(l) - 0.7) / 0.3)) : l;
      r = r < -0.7 || r > 0.7 ? Math.sign(r) * (0.7 + 0.3 * Math.tanh((Math.abs(r) - 0.7) / 0.3)) : r;

      if (R) { L[i] = l; R[i] = r; } else { L[i] = (l + r) * 0.7071; }
    }
    return true;
  }
}

registerProcessor('air-drums-kit', DrumProcessor);
