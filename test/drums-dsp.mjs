/**
 * Renders the drum worklet headlessly and measures what comes out: that each
 * drum sits where it should in the spectrum, that a kick really does sweep, that
 * velocity changes tone and not merely level, and that nothing clips, rings
 * forever, or leaks a voice.
 * Run: node test/drums-dsp.mjs
 */
const SR = 48000;
let Proc = null;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (_n, cls) => { Proc = cls; };
await import('../src/drums/drum-worklet.js');

let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };

/** Hit one drum and capture `secs` of output. */
function render(voice, secs, { vel = 0.8, tone } = {}) {
  globalThis.currentTime = 0;
  const p = new Proc();
  p.port.onmessage({ data: { t: 'hit', voice, vel, tone, when: 0 } });
  return capture(p, secs);
}

function capture(p, secs, t0 = 0) {
  const blocks = Math.ceil((secs * SR) / 128);
  const L = new Float32Array(blocks * 128), R = new Float32Array(blocks * 128);
  const buf = [new Float32Array(128), new Float32Array(128)];
  for (let b = 0; b < blocks; b++) {
    globalThis.currentTime = t0 + (b * 128) / SR;
    buf[0].fill(0); buf[1].fill(0);
    p.process([], [buf]);
    L.set(buf[0], b * 128); R.set(buf[1], b * 128);
  }
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
  mono.L = L; mono.R = R; mono.proc = p;
  return mono;
}

const rms = (x, a, b) => { let s = 0; for (let i = a | 0; i < (b | 0); i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, (b | 0) - (a | 0))); };
const peak = (x) => { let m = 0; for (const v of x) if (Math.abs(v) > m) m = Math.abs(v); return m; };

/** Goertzel magnitude at one frequency. */
function magAt(x, hz, from, to) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from | 0; i < Math.min(to | 0, x.length); i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / Math.max(1, (to | 0) - (from | 0));
}
/**
 * Fraction of a window's energy above `fc` — "how bright is this", 0 to 1.
 *
 * Deliberately not a spectral centroid built from Goertzel bins. One bin
 * captures a *tone* completely but only a sliver of noise of the same power, so
 * that measure reports a snare's low head modes as dominant over its wires and
 * concludes a hard stroke is darker than a soft one, which is the opposite of
 * the truth. Filtering and comparing energies treats tones and noise alike.
 */
function hf(x, from, to, fc = 1200) {
  const a = Math.exp(-2 * Math.PI * fc / SR);   // one-pole high-pass
  let yp = 0, xp = 0, hi = 0, tot = 0;
  for (let i = from | 0; i < Math.min(to | 0, x.length); i++) {
    const y = a * (yp + x[i] - xp);
    yp = y; xp = x[i];
    hi += y * y; tot += x[i] * x[i];
  }
  return Math.sqrt(hi / Math.max(tot, 1e-24));
}
/** Average a measurement over several strokes — the noise excitation means no
 *  two are alike, which is the point, and makes any single one a poor witness. */
const over = (n, f) => { let s = 0; for (let i = 0; i < n; i++) s += f(); return s / n; };

/** Dominant frequency of a short window, by scanning. */
function dominant(x, from, to, lo = 30, hi = 400) {
  let best = 0, bestM = 0;
  for (let hz = lo; hz < hi; hz += 1) { const m = magAt(x, hz, from, to); if (m > bestM) { bestM = m; best = hz; } }
  return best;
}
const ms = (n) => Math.round((n / 1000) * SR);

/* ================================================================== *
 *  1. Every drum makes a sound, and only when asked
 * ================================================================== */
console.log('\nvoices');
const VOICES = ['kick', 'snare', 'hihat', 'hihatOpen', 'tom', 'floor', 'crash', 'ride'];
for (const v of VOICES) {
  const x = render(v, 0.35);
  const p = peak(x);
  ok(p > 0.02 && p < 1.0, `${v} sounds, without clipping`, `peak ${p.toFixed(3)}`);
}
{
  const p = new Proc();
  const x = capture(p, 0.2);
  ok(peak(x) === 0, 'an untouched kit is silent');
}

/* ================================================================== *
 *  2. Each drum occupies its own register
 * ================================================================== */
console.log('\nregister');
{
  const c = Object.fromEntries(VOICES.map((v) => [v, over(6, () => hf(render(v, 0.3), 0, ms(120)))]));
  const top = Object.fromEntries(VOICES.map((v) => [v, over(6, () => hf(render(v, 0.3), 0, ms(120), 5000))]));
  const pc = (v) => (c[v] * 100).toFixed(0) + '%';
  console.log('        energy above 1.2 kHz — ' + VOICES.map((v) => `${v}:${pc(v)}`).join('  '));
  console.log('        …and above 5 kHz    — ' + VOICES.map((v) => `${v}:${(top[v] * 100).toFixed(0)}%`).join('  '));
  ok(c.kick < 0.15, 'the kick is the lowest thing in the kit', pc('kick'));
  ok(c.floor < c.tom, 'the floor tom is lower than the rack tom', `${pc('floor')} < ${pc('tom')}`);
  ok(c.snare > c.tom * 1.5, 'the snare is brighter than the toms', `${pc('snare')} > ${pc('tom')}`);
  ok(top.hihat > top.snare * 1.3, 'the hats are brighter than the snare',
    `${(top.hihat * 100).toFixed(0)}% > ${(top.snare * 100).toFixed(0)}% above 5 kHz`);
  ok(c.crash > c.snare, 'the crash is up there too', pc('crash'));
}
{
  // The kick's pitch envelope: it must start high and fall, or it is a beep.
  const x = render('kick', 0.5, { vel: 0.9 });
  const early = dominant(x, ms(2), ms(14), 40, 220);
  const late = dominant(x, ms(120), ms(260), 30, 160);
  ok(early > late * 1.4, 'the kick sweeps down in pitch, which is what makes it a kick',
    `${Math.round(early)} Hz → ${Math.round(late)} Hz`);
  ok(late > 38 && late < 60, 'and settles where a kick lives', `${Math.round(late)} Hz`);
}
{
  /* The snare's rattle must outlast its head, or it is a tom — so compare the
   * two directly, in the tail, where only the wires should still be going. */
  const sn = over(4, () => hf(render('snare', 0.6), ms(110), ms(240), 1500));
  const tm = over(4, () => hf(render('tom', 0.6), ms(110), ms(240), 1500));
  ok(sn > tm * 3, 'the snare wires ring on after the head has gone, where a tom just hums',
    `snare ${(sn * 100).toFixed(0)}% vs tom ${(tm * 100).toFixed(0)}%`);
}

/* ================================================================== *
 *  3. Decay
 * ================================================================== */
console.log('\ndecay');
{
  const tail = (v, secs) => {
    const x = render(v, secs);
    const a = rms(x, 0, ms(30)), b = rms(x, x.length - ms(60), x.length);
    return { a, b, ratio: b / Math.max(a, 1e-9) };
  };
  const closed = tail('hihat', 0.25), open = tail('hihatOpen', 0.9);
  ok(closed.ratio < 0.01, 'a closed hat is gone almost immediately', closed.ratio.toExponential(1));
  ok(rms(render('hihatOpen', 0.9), ms(200), ms(300)) > rms(render('hihat', 0.9), ms(200), ms(300)) * 20,
    'an open hat is still going where a closed one has stopped');
  ok(open.ratio < 0.2, 'and it does eventually stop');

  const crash = render('crash', 4.0);
  const peakRms = rms(crash, ms(5), ms(45));
  console.log(`        crash tail — start ${peakRms.toFixed(4)}  1.2s ${rms(crash, ms(1200), ms(1500)).toFixed(4)}  3.6s ${rms(crash, ms(3600), ms(3990)).toExponential(1)}`);
  ok(rms(crash, ms(1200), ms(1500)) > peakRms * 0.02, 'a crash still washes after a second');
  ok(rms(crash, ms(3600), ms(3990)) < peakRms * 0.01, 'and is finished within four seconds');
  ok(peak(render('kick', 1.2).subarray(ms(900))) < 1e-3, 'the kick is over well inside a second');
}
{
  /* Closing the hat has to cut the open one, exactly as the pedal does. Measured
   * well after the closed hat itself has died, so what is left is only whatever
   * the open hat is still doing. */
  const tail = (choke) => {
    globalThis.currentTime = 0;
    const p = new Proc();
    p.port.onmessage({ data: { t: 'hit', voice: 'hihatOpen', vel: 0.9, when: 0 } });
    if (choke) p.port.onmessage({ data: { t: 'hit', voice: 'hihat', vel: 0.9, when: 0.15 } });
    return rms(capture(p, 0.45), ms(300), ms(440));
  };
  const open = tail(false), choked = tail(true);
  ok(choked < open * 0.2, 'closing the hat chokes the open one',
    `${open.toExponential(1)} → ${choked.toExponential(1)}`);
}

/* ================================================================== *
 *  4. Velocity is effort, not a volume knob
 * ================================================================== */
console.log('\nvelocity');
/* Each drum is asked about the band it actually lives in — a kick has nothing
 * above 1.2 kHz to speak of either way, so measuring it there says nothing. */
for (const [v, fc] of [['snare', 1200], ['kick', 400], ['hihat', 6000], ['tom', 600]]) {
  const ls = over(3, () => rms(render(v, 0.5, { vel: 0.2 }), 0, ms(60)));
  const lh = over(3, () => rms(render(v, 0.5, { vel: 1.0 }), 0, ms(60)));
  ok(lh > ls * 1.8, `${v}: hitting harder is louder`, `${(lh / ls).toFixed(1)}×`);
  const bs = over(8, () => hf(render(v, 0.5, { vel: 0.2 }), 0, ms(90), fc));
  const bh = over(8, () => hf(render(v, 0.5, { vel: 1.0 }), 0, ms(90), fc));
  ok(bh > bs * 1.08, `${v}: …and brighter, not merely louder`,
    `${(bs * 100).toFixed(0)}% → ${(bh * 100).toFixed(0)}% above ${fc} Hz`);
}
{
  // Two hits of the same drum at the same velocity must not be identical —
  // that sameness is exactly what gives a sampled kit away.
  const a = render('snare', 0.3), b = render('snare', 0.3);
  let diff = 0;
  for (let i = 0; i < ms(80); i++) diff += Math.abs(a[i] - b[i]);
  ok(diff / ms(80) > 1e-4, 'no two strokes are bit-identical', (diff / ms(80)).toExponential(1));
}
{
  const ping = (tone) => over(5, () => magAt(render('ride', 0.6, { tone }), 516, ms(20), ms(400)));
  const bow = ping(0), bell = ping(1);
  ok(bell > bow * 1.3, 'riding on the bell pings harder than riding on the bow',
    `${bow.toExponential(1)} → ${bell.toExponential(1)}`);
}

/* ================================================================== *
 *  5. Under load
 * ================================================================== */
console.log('\nload');
{
  // A dense roll: nothing may clip, and the kit must come back to silence.
  globalThis.currentTime = 0;
  const p = new Proc();
  let when = 0;
  for (let i = 0; i < 48; i++) {
    p.port.onmessage({ data: { t: 'hit', voice: VOICES[i % VOICES.length], vel: 0.9, when } });
    when += 0.045;
  }
  const x = capture(p, 3.0);
  ok(peak(x) <= 1.0, 'forty-eight hits in two seconds never clip', `peak ${peak(x).toFixed(3)}`);
  ok(rms(x, ms(200), ms(2000)) > 0.01, 'and they are all actually audible');
  const rest = capture(p, 6.0);
  ok(peak(rest.subarray(ms(5000))) < 1e-4, 'the kit returns to silence afterwards');
  ok(p.v.every((v) => !v.active), 'every voice was released', `${p.v.filter((v) => v.active).length} stuck`);
}
{
  const p = new Proc();
  for (let i = 0; i < 12; i++) p.port.onmessage({ data: { t: 'hit', voice: 'crash', vel: 1, when: i * 0.01 } });
  const x = capture(p, 0.6);
  ok(Number.isFinite(peak(x)) && peak(x) <= 1.0, 'twelve simultaneous crashes stay finite and in range',
    `peak ${peak(x).toFixed(3)}`);
  p.port.onmessage({ data: { t: 'silence' } });
  ok(peak(capture(p, 0.3)) === 0, 'silence stops everything at once');
}
{
  // Stereo: a kick sits in the middle, a hi-hat does not.
  const k = render('kick', 0.3), h = render('hihat', 0.3);
  ok(Math.abs(rms(k.L, 0, ms(80)) - rms(k.R, 0, ms(80))) < rms(k.L, 0, ms(80)) * 0.05, 'the kick is centred');
  ok(rms(h.L, 0, ms(60)) > rms(h.R, 0, ms(60)) * 1.3, 'the hats sit off to one side');
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
