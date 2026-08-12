/**
 * Renders the piano worklet headlessly and measures what actually comes out:
 * tuning, decay, the inharmonicity that makes it a piano rather than an organ,
 * and whether velocity changes the tone or merely the volume.
 * Run: node test/piano-dsp.mjs
 */
const SR = 48000;
let Proc = null;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null, postMessage() {} }; } };
globalThis.registerProcessor = (_n, cls) => { Proc = cls; };
await import('../src/piano/piano-worklet.js');

let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Strike one note and capture `secs` of mono output. */
function render(midi, secs, { vel = 0.8, sustain = 0.6 } = {}) {
  globalThis.currentTime = 0;
  const p = new Proc();
  p.port.onmessage({ data: { t: 'note', midi, hz: mtof(midi), vel, sustain, when: 0 } });
  return capture(p, secs);
}

/** Render an already-primed processor, returning both channels and their sum. */
function capture(p, secs) {
  const blocks = Math.ceil((secs * SR) / 128);
  const L = new Float32Array(blocks * 128), R = new Float32Array(blocks * 128);
  const buf = [new Float32Array(128), new Float32Array(128)];
  for (let b = 0; b < blocks; b++) {
    globalThis.currentTime = (b * 128) / SR;
    buf[0].fill(0); buf[1].fill(0);
    p.process([], [buf]);
    L.set(buf[0], b * 128); R.set(buf[1], b * 128);
  }
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
  mono.L = L; mono.R = R;
  return mono;
}

const rms = (x, a, b) => { let s = 0; for (let i = a | 0; i < (b | 0); i++) s += x[i] * x[i]; return Math.sqrt(s / ((b | 0) - (a | 0))); };
const cents = (f, ref) => 1200 * Math.log2(f / ref);

/** Goertzel magnitude at one frequency — enough to interrogate single partials. */
function magAt(x, hz, from, to) {
  const w = (2 * Math.PI * hz) / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from | 0; i < (to | 0); i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / ((to | 0) - (from | 0));
}
/** Refine a partial's true frequency by scanning for the magnitude peak. */
function peakNear(x, hz, from, to, span = 0.03) {
  let best = hz, bv = -1;
  for (let k = -40; k <= 40; k++) {
    const f = hz * (1 + (span * k) / 40);
    const m = magAt(x, f, from, to);
    if (m > bv) { bv = m; best = f; }
  }
  return best;
}

/* ---- tuning ---- */
console.log('\ntuning');
{
  const NOTES = [36, 48, 55, 60, 64, 67, 72, 84, 96];
  let worst = 0; const rows = [];
  for (const m of NOTES) {
    const x = render(m, 0.7);
    const f = peakNear(x, mtof(m), 0.05 * SR, 0.45 * SR, 0.04);
    const c = cents(f, mtof(m));
    worst = Math.max(worst, Math.abs(c));
    rows.push(`${m}:${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`);
  }
  console.log('        ' + rows.join('  '));
  ok(worst < 8, 'fundamentals land in tune across the keyboard', `worst ${worst.toFixed(1)}¢`);
}

/* ---- inharmonicity: the thing that makes it a piano ---- */
console.log('\nstring physics');
{
  // Real piano partials run progressively sharp of the harmonic series. If this
  // measured zero the synth would be an organ with a percussive envelope.
  const x = render(41, 1.2, { vel: 0.9 });        // low F, where stiffness bites
  const f0 = peakNear(x, mtof(41), 0.05 * SR, 0.6 * SR, 0.03);
  const rows = [];
  let sharp = 0;
  for (const p of [2, 3, 4, 6]) {
    const f = peakNear(x, f0 * p, 0.05 * SR, 0.6 * SR, 0.05);
    const c = cents(f, f0 * p);
    rows.push(`p${p}:${c >= 0 ? '+' : ''}${c.toFixed(0)}¢`);
    if (c > 1) sharp++;
  }
  console.log('        partials vs harmonic series — ' + rows.join('  '));
  ok(sharp >= 3, 'upper partials are stretched sharp, as stiff strings are', `${sharp}/4 sharp`);
}
{
  // High partials must die before the fundamental does — the "bloom then
  // settle" that separates a struck string from a sustained tone.
  const x = render(60, 2.4, { vel: 0.95 });
  const f0 = mtof(60);
  const early = [1, 6].map((p) => magAt(x, f0 * p, 0.02 * SR, 0.12 * SR));
  const late = [1, 6].map((p) => magAt(x, f0 * p, 1.2 * SR, 1.5 * SR));
  const fundRatio = late[0] / (early[0] || 1e-9), highRatio = late[1] / (early[1] || 1e-9);
  ok(highRatio < fundRatio * 0.5, 'high partials decay faster than the fundamental',
    `p6 kept ${(highRatio * 100).toFixed(1)}% vs p1 ${(fundRatio * 100).toFixed(1)}%`);
}
{
  const bass = render(36, 3.0), treble = render(88, 3.0);
  const bassKeep = rms(bass, 1.8 * SR, 2.0 * SR) / (rms(bass, 0.05 * SR, 0.2 * SR) || 1e-9);
  const trebKeep = rms(treble, 1.8 * SR, 2.0 * SR) / (rms(treble, 0.05 * SR, 0.2 * SR) || 1e-9);
  ok(bassKeep > trebKeep * 3, 'bass strings ring far longer than treble',
    `${(bassKeep * 100).toFixed(1)}% vs ${(trebKeep * 100).toFixed(2)}%`);
}

{
  /* Two strings per note, very slightly apart and damped differently, is what
   * gives a piano its two-stage decay: a brisk initial fall as the pair sheds
   * energy together, then a long quiet aftersound once only the slower string
   * is left. A single decaying sinusoid cannot do that — its decay is one
   * straight line in dB — so measuring the line bend is a direct check that
   * the unison is really there and really doing its job. */
  const x = render(60, 3.4, { vel: 0.9, sustain: 0.8 });
  const w = (a, b) => 20 * Math.log10((rms(x, a * SR, b * SR) || 1e-12));
  const early = (w(0.15, 0.35) - w(0.75, 0.95)) / 0.6;    // dB per second
  const late = (w(1.8, 2.0) - w(2.9, 3.1)) / 1.1;
  ok(late < early * 0.8, 'the decay bends — a real two-stage piano tail',
    `${early.toFixed(1)} dB/s early vs ${late.toFixed(1)} dB/s late`);
}
{
  // Bass to the left, treble to the right, as it sits under your hands.
  const bass = render(34, 0.5), treble = render(88, 0.5);
  const bal = (x) => rms(x.L, 0.02 * SR, 0.4 * SR) / (rms(x.R, 0.02 * SR, 0.4 * SR) || 1e-9);
  ok(bal(bass) > 1.25 && bal(treble) < 0.8, 'the keyboard is spread across the stereo field',
    `bass L/R ${bal(bass).toFixed(2)}, treble L/R ${bal(treble).toFixed(2)}`);
  const mid = render(60, 0.5);
  ok(Math.abs(bal(mid) - 1) < 0.12, 'and the middle stays centred', `L/R ${bal(mid).toFixed(2)}`);
}
{
  // Lifting a finger has to actually stop the note when the damper follows it.
  globalThis.currentTime = 0;
  const p = new Proc();
  p.port.onmessage({ data: { t: 'note', midi: 60, hz: mtof(60), vel: 0.9, sustain: 1, when: 0 } });
  const before = capture(p, 0.5);
  p.port.onmessage({ data: { t: 'damp', midi: 60 } });
  const after = capture(p, 0.5);
  ok(rms(after, 0.2 * SR, 0.45 * SR) < rms(before, 0.2 * SR, 0.45 * SR) * 0.02,
    'damping a note silences it quickly when the finger lifts',
    `${rms(before, 0.2 * SR, 0.45 * SR).toExponential(1)} → ${rms(after, 0.2 * SR, 0.45 * SR).toExponential(1)}`);
}

/* ---- dynamics ---- */
console.log('\ndynamics');
{
  const soft = render(60, 1.0, { vel: 0.2 }), hard = render(60, 1.0, { vel: 1.0 });
  const pk = (x) => { let m = 0; for (let i = 0; i < 0.2 * SR; i++) m = Math.max(m, Math.abs(x[i])); return m; };
  ok(pk(hard) > pk(soft) * 2, 'harder is louder', `${pk(soft).toFixed(3)} → ${pk(hard).toFixed(3)}`);

  /* …and, more importantly, brighter. Measured as the ratio of upper-partial
   * energy to the fundamental, so it is independent of sheer level — a volume
   * knob would leave this number unchanged. */
  const f0 = mtof(60);
  const bright = (x) => {
    const lo = magAt(x, f0, 0.02 * SR, 0.15 * SR) || 1e-9;
    let hi = 0;
    for (const p of [4, 5, 6, 7, 8]) hi += magAt(x, f0 * p, 0.02 * SR, 0.15 * SR);
    return hi / lo;
  };
  const bs = bright(soft), bh = bright(hard);
  ok(bh > bs * 1.8, 'and brighter — velocity changes the tone, not just the level',
    `${bs.toFixed(3)} → ${bh.toFixed(3)}`);
}
{
  const damped = render(60, 3.0, { sustain: 0 }), pedalled = render(60, 3.0, { sustain: 1 });
  const keep = (x) => rms(x, 1.6 * SR, 1.9 * SR) / (rms(x, 0.05 * SR, 0.2 * SR) || 1e-9);
  ok(keep(pedalled) > keep(damped) * 2, 'the sustain control really changes how long notes ring',
    `${(keep(damped) * 100).toFixed(1)}% vs ${(keep(pedalled) * 100).toFixed(1)}%`);
}

/* ---- stability ---- */
console.log('\nstability');
{
  // Ten fingers at once, hardest, plus a re-strike on a ringing note.
  globalThis.currentTime = 0;
  const p = new Proc();
  [48, 52, 55, 59, 60, 64, 67, 71, 72, 76].forEach((m, i) => {
    p.port.onmessage({ data: { t: 'note', midi: m, hz: mtof(m), vel: 1, sustain: 1, when: i * 0.004 } });
  });
  const buf = [new Float32Array(128)];
  let peak = 0, bad = false;
  for (let b = 0; b < Math.ceil((5 * SR) / 128); b++) {
    globalThis.currentTime = (b * 128) / SR;
    if (b === 200) [60, 64, 67].forEach((m) =>
      p.port.onmessage({ data: { t: 'note', midi: m, hz: mtof(m), vel: 1, sustain: 1, when: globalThis.currentTime } }));
    buf[0].fill(0); p.process([], [buf]);
    for (const v of buf[0]) { if (!Number.isFinite(v)) bad = true; peak = Math.max(peak, Math.abs(v)); }
  }
  ok(!bad, 'no NaN/Inf with a ten-note cluster and re-strikes');
  ok(peak < 8, 'output stays bounded', `peak ${peak.toFixed(2)} (bus gain is well under 1, limiter after)`);
}
{
  // More simultaneous notes than there are voices must steal, not corrupt.
  globalThis.currentTime = 0;
  const p = new Proc();
  for (let i = 0; i < 24; i++) {
    p.port.onmessage({ data: { t: 'note', midi: 40 + i * 2, hz: mtof(40 + i * 2), vel: 0.9, sustain: 1, when: i * 0.002 } });
  }
  const buf = [new Float32Array(128)];
  let bad = false;
  for (let b = 0; b < Math.ceil((2 * SR) / 128); b++) {
    globalThis.currentTime = (b * 128) / SR;
    buf[0].fill(0); p.process([], [buf]);
    for (const v of buf[0]) if (!Number.isFinite(v)) bad = true;
  }
  ok(!bad, 'oversubscribing the voice pool steals cleanly');
}
{
  const x = render(96, 1.0, { vel: 1 });
  // Aliasing check: a top-octave note must place no energy above Nyquist's
  // reflection. Partials are simply dropped rather than folded back.
  const junk = magAt(x, SR * 0.49, 0.02 * SR, 0.3 * SR);
  const tone = magAt(x, mtof(96), 0.02 * SR, 0.3 * SR);
  ok(junk < tone * 0.02, 'no aliasing at the top of the keyboard',
    `junk ${junk.toExponential(1)} vs tone ${tone.toExponential(1)}`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
