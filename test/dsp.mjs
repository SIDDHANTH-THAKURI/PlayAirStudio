/**
 * Runs the AudioWorklet string model headlessly (globals shimmed) and measures
 * what actually comes out: tuning across the neck, decay time, stability.
 * Run: node test/dsp.mjs
 */
const SR = 48000;
let Proc = null;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (_n, cls) => { Proc = cls; };
await import('../src/karplus-worklet.js');

let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };
const coef = (hz) => Math.max(0.02, Math.min(0.98, 1 - Math.exp((-2 * Math.PI * hz) / SR)));

/** Pluck one string and capture `secs` of mono output. */
function render(freq, secs, { decay = 3.6, loopHz = 4000, pickHz = 5000, vel = 0.9, s = 0 } = {}) {
  globalThis.currentTime = 0;
  const p = new Proc();
  const period = SR / freq;
  p.port.onmessage({ data: { t: 'expr', bend: 0, depth: 0, rate: 5 } });
  p.port.onmessage({ data: {
    t: 'pluck', s, period, vel, gain: 1,
    fb: Math.min(0.9995, Math.exp((-6.9 * period) / (SR * decay))),
    a: coef(loopHz), ba: coef(pickHz), when: 0,
  } });
  const blocks = Math.ceil((secs * SR) / 128);
  const out = new Float32Array(blocks * 128);
  const buf = [new Float32Array(128)];
  for (let b = 0; b < blocks; b++) {
    globalThis.currentTime = (b * 128) / SR;
    buf[0].fill(0);
    p.process([], [buf]);
    out.set(buf[0], b * 128);
  }
  return out;
}

/** Autocorrelation pitch estimate, parabolic-refined, searched ±35% of target. */
function pitchOf(x, from, to, target) {
  const a = x.subarray(from, to), N = a.length;
  const p0 = Math.floor(SR / (target * 1.35)), p1 = Math.ceil(SR / (target * 0.65));
  let best = p0, bv = -Infinity;
  const r = new Float64Array(p1 + 2);
  for (let lag = p0; lag <= p1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < N; i++) s += a[i] * a[i + lag];
    r[lag] = s / (N - lag);
    if (r[lag] > bv) { bv = r[lag]; best = lag; }
  }
  const y0 = r[best - 1] ?? bv, y1 = bv, y2 = r[best + 1] ?? bv;
  const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1e-9);
  return SR / (best + d);
}
const cents = (f, ref) => 1200 * Math.log2(f / ref);

/* ---- tuning across the whole playable range ---- */
console.log('\ntuning (the reason the string model is a worklet at all)');
const NOTES = [['E2', 82.41], ['A2', 110.00], ['D3', 146.83], ['G3', 196.00],
  ['B3', 246.94], ['E4', 329.63], ['A4', 440.00], ['C5', 523.25], ['E5', 659.26]];
let worst = 0, rows = [];
for (const [name, f] of NOTES) {
  const x = render(f, 0.45);
  const est = pitchOf(x, Math.round(0.06 * SR), Math.round(0.30 * SR), f);
  const c = cents(est, f);
  worst = Math.max(worst, Math.abs(c));
  rows.push(`${name} ${est.toFixed(1)}Hz (${c >= 0 ? '+' : ''}${c.toFixed(1)}¢)`);
}
console.log('        ' + rows.join('  '));
ok(worst < 12, 'every note is in tune within 12 cents', `worst ${worst.toFixed(1)}¢`);

/* ---- what the naive comb-filter approach would have done ----
 * Web Audio clamps a looped DelayNode to 128 samples, so anything above
 * sampleRate/128 gets pinned there. Show the damage we avoided. */
const clampHz = SR / 128;
const pinned = NOTES.filter(([, f]) => f > clampHz);
console.log(`        (a DelayNode loop would pin everything above ${clampHz.toFixed(0)} Hz — ` +
  `${pinned.length}/${NOTES.length} of these notes: ${pinned.map((n) => n[0]).join(', ')})`);

/* ---- decay, dynamics, stability ---- */
console.log('\nstring behaviour');
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const ring = render(196, 3.0, { decay: 3.0 });
const t0 = rms(ring, 0.05 * SR, 0.10 * SR), t1 = rms(ring, 2.4 * SR, 2.5 * SR);
ok(t1 / t0 < 0.05 && t1 / t0 > 1e-5, 'an open note decays over ~3 s', `${(20 * Math.log10(t1 / t0)).toFixed(0)} dB at 2.4 s`);

const mute = render(196, 1.0, { decay: 0.33, loopHz: 1600 });
const chunk = render(196, 1.0, { decay: 0.085, loopHz: 900 });
const eOpen = rms(ring, 0.35 * SR, 0.45 * SR), eMute = rms(mute, 0.35 * SR, 0.45 * SR), eChunk = rms(chunk, 0.35 * SR, 0.45 * SR);
ok(eOpen > eMute * 4 && eMute > eChunk * 3, 'open > palm mute > dead chunk',
  `${eOpen.toFixed(4)} / ${eMute.toFixed(4)} / ${eChunk.toFixed(5)}`);

const soft = render(196, 0.5, { vel: 0.35, pickHz: 1800 }), loud = render(196, 0.5, { vel: 1.0, pickHz: 6000 });
const pk = (x) => Math.max(...x.subarray(0, Math.round(0.15 * SR)).map(Math.abs));
ok(pk(loud) > pk(soft) * 1.8, 'velocity maps to attack level', `${pk(soft).toFixed(3)} → ${pk(loud).toFixed(3)}`);

/* every string at once, hardest settings, must stay finite and unclipped */
{
  globalThis.currentTime = 0;
  const p = new Proc();
  p.port.onmessage({ data: { t: 'expr', bend: 2, depth: 0.03, rate: 6 } });
  [82.41, 110, 146.83, 196, 246.94, 329.63].forEach((f, s) => {
    const period = SR / f;
    p.port.onmessage({ data: { t: 'pluck', s, period, vel: 1, gain: 1,
      fb: Math.min(0.9995, Math.exp((-6.9 * period) / (SR * 4))), a: coef(5200), ba: coef(6000), when: s * 0.008 } });
  });
  const buf = [new Float32Array(128)];
  let peak = 0, bad = false;
  for (let b = 0; b < Math.ceil((6 * SR) / 128); b++) {
    globalThis.currentTime = (b * 128) / SR;
    buf[0].fill(0); p.process([], [buf]);
    for (const v of buf[0]) { if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); }
  }
  ok(!bad, 'no NaN/Inf with all six strings ringing under bend + vibrato');
  ok(peak < 6, 'feedback loops stay bounded', `peak ${peak.toFixed(2)} (bus gain is 0.32, limiter after)`);
}

/* bend actually retunes a ringing string */
{
  globalThis.currentTime = 0;
  const p = new Proc();
  const f = 196, period = SR / f;
  p.port.onmessage({ data: { t: 'expr', bend: 0, depth: 0, rate: 5 } });
  p.port.onmessage({ data: { t: 'pluck', s: 0, period, vel: 0.9, gain: 1,
    fb: Math.min(0.9995, Math.exp((-6.9 * period) / (SR * 4))), a: coef(4000), ba: coef(5000), when: 0 } });
  const out = new Float32Array(Math.ceil(SR * 0.9)), buf = [new Float32Array(128)];
  for (let b = 0; b * 128 < out.length; b++) {
    globalThis.currentTime = (b * 128) / SR;
    if (globalThis.currentTime > 0.35) p.port.onmessage({ data: { t: 'expr', bend: 2, depth: 0, rate: 5 } });
    buf[0].fill(0); p.process([], [buf]);
    out.set(buf[0].subarray(0, Math.min(128, out.length - b * 128)), b * 128);
  }
  const before = pitchOf(out, 0.06 * SR | 0, 0.30 * SR | 0, f);
  const after = pitchOf(out, 0.55 * SR | 0, 0.85 * SR | 0, f * 1.12);
  ok(Math.abs(cents(after, before) - 200) < 25, 'a whole-step bend really moves the pitch 200¢',
    `${before.toFixed(1)} → ${after.toFixed(1)} Hz (${cents(after, before).toFixed(0)}¢)`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
