/**
 * Headless checks for the logic-heavy modules: chord voicings and banks, the
 * shape-driven gesture engine, and the pattern scheduler.
 * Run: node test/sim.mjs
 */
import { GestureEngine, matchShape, SIGNS, STRUM_SIGNS, FINGER_STRINGS,
  GRID_Y0, GRID_Y1 } from '../src/gestures.js';
import { buildSet, buildChord, specToChord, specName, defaultGridSpecs, defaultSignSpecs,
  GRID_CELLS, SIGN_CELLS, STYLES, NOTE_NAMES } from '../src/chords.js';
import { PatternPlayer, PATTERNS, getPattern, listPatterns, saveCustom, removeCustom,
  loadCustom, blankPattern, tokenToStep, stepToToken, stepsPerSecond,
  resolveString, bassString, altBassString } from '../src/patterns.js';

let fails = 0;
const ok = (c, msg, extra = '') => {
  if (!c) { fails++; console.log(`  FAIL  ${msg} ${extra}`); }
  else console.log(`  ok    ${msg} ${extra}`);
};

/* ============ 1. chord voicings ============ */
console.log('\nchords');
const EXPECT = {
  maj: (r) => [r, (r + 4) % 12, (r + 7) % 12],
  min: (r) => [r, (r + 3) % 12, (r + 7) % 12],
  dom7: (r) => [r, (r + 4) % 12, (r + 7) % 12, (r + 10) % 12],
  min7: (r) => [r, (r + 3) % 12, (r + 7) % 12, (r + 10) % 12],
  power: (r) => [r, (r + 7) % 12],
};
let bad = [];
for (let root = 0; root < 12; root++) {
  for (const q of Object.keys(EXPECT)) {
    const v = buildChord(root, q);
    const pcs = new Set(v.midi.filter((m) => m !== null).map((m) => m % 12));
    const want = EXPECT[q](root);
    const extra = [...pcs].filter((p) => !want.includes(p));
    const lowest = v.midi.find((m) => m !== null);
    if (extra.length) bad.push(`${v.name} extra=${extra}`);
    if (lowest !== undefined && lowest % 12 !== root) bad.push(`${v.name} bad bass`);
  }
}
ok(bad.length === 0, 'all 60 chords: only chord tones, root in the bass', bad.join(' '));
const G = buildSet(7, 'pop', null).map((c) => c.name).join(' ');
ok(G === 'G D Em C Am Bm', 'key of G, pop set', `→ ${G}`);

/* ============ 2. chord banks ============ */
console.log('\nbanks');
{
  for (const style of Object.keys(STYLES)) {
    const g = defaultGridSpecs(0, style), s = defaultSignSpecs(0, style);
    if (g.length !== GRID_CELLS || s.length !== SIGN_CELLS) bad.push(style);
    if (g.some((x) => !x || x.root < 0 || x.root > 11)) bad.push(style + ':root');
  }
  ok(bad.length === 0, `every style fills ${GRID_CELLS} grid + ${SIGN_CELLS} sign slots`, bad.join(' '));
  const specs = defaultGridSpecs(7, 'pop');
  ok(specName(specs[0]) === 'G' && specName(null) === '—', 'spec names, empty slots included');
  ok(specToChord(specs[2]).name === 'Em', 'spec → voicing', `→ ${specToChord(specs[2]).name}`);
  ok(specToChord(specs[0], 'power').name === 'G5', 'power override reaches the bank');
  ok(specToChord(null) === null, 'empty slot builds no chord');
}

/* ---- capo: changes what you hear, never what you play ---- */
{
  const open = buildChord(7, 'maj');          // G, no capo
  const capo3 = buildChord(7, 'maj', 3);

  ok(capo3.frets.join(',') === open.frets.join(','),
    'a capo leaves the shape alone — same fingering', `${capo3.frets.join(' ')}`);
  ok(capo3.name === open.name && capo3.name === 'G',
    'and the same name, because you still finger and call it G');
  ok(capo3.sounding === 'Bb',
    'while reporting what it actually sounds', `G + 3 frets → ${capo3.sounding}`);

  // Every sounding string moves by exactly the capo, and none is lost.
  const shifted = open.midi.every((m, i) =>
    (m === null) === (capo3.midi[i] === null) && (m === null || capo3.midi[i] - m === 3));
  ok(shifted, 'every string sounds exactly three semitones higher',
    `${open.midi.filter(Boolean).join(',')} → ${capo3.midi.filter(Boolean).join(',')}`);

  // The bug that started this: changing the control had to change the sound.
  ok(buildChord(7, 'maj', 1).midi[5] !== open.midi[5],
    'fret 1 is audibly different from no capo');
  ok(buildChord(7, 'maj', 0).midi.join() === open.midi.join(),
    'and 0 is exactly the un-capoed instrument');
  // Out-of-range values must not silently detune the guitar.
  ok(buildChord(7, 'maj', -4).midi.join() === open.midi.join(), 'a negative capo is clamped away');
  ok(specToChord({ root: 7, quality: 'maj' }, null, 2).midi[5] === open.midi[5] + 2,
    'and the capo reaches the bank through specToChord');
}

/* ============ 3. patterns ============ */
console.log('\npatterns');
{
  const D = buildChord(2, 'maj');                 // open D: x x 0 2 3 2
  ok(bassString(D) === 2 && altBassString(D) === 3, 'D chord bass/alt-bass = D, G strings');
  const P5 = buildChord(7, 'power');              // G5: trebles muted
  ok(resolveString(P5, 5) === 2, 'muted string resolves to nearest sounding', `→ ${resolveString(P5, 5)}`);
  ok(resolveString(D, 0) === 2, 'muted low E on open D resolves inward');

  let clock = 0;
  const steps = [];
  const p = new PatternPlayer({ now: () => clock, onStep: (s, when) => steps.push({ k: s.k, when: +when.toFixed(3) }) });
  p.start('drive', 120, 0);                       // 8th at 120 bpm = 0.25 s
  for (; clock < 2.01; clock += 1 / 60) p.tick();
  const whens = steps.map((s) => s.when);
  ok(steps.length === 7, 'drive schedules its 6 hits/bar + the next bar\'s first', `(${steps.length} steps)`);
  ok(Math.abs(whens[0] - 0) < 0.01 && Math.abs(whens[1] - 0.5) < 0.01 && Math.abs(whens[2] - 0.75) < 0.01,
    'step times land on the 8th grid', `→ ${whens.slice(0, 4).join(', ')}`);
  ok(whens.every((w, i) => i === 0 || w > whens[i - 1]), 'times strictly increase');
  p.setBpm(80);
  const before = steps.length;
  for (; clock < 3.0; clock += 1 / 60) p.tick();
  ok(steps.length > before && steps.slice(before).every((s, i, a) => i === 0 || s.when > a[i - 1].when),
    'bpm change keeps the schedule monotonic');
  p.stop();
  ok(!p.playing, 'stop() stops');

  // 16-step bars must halve the step spacing, not stretch the bar.
  let c2 = 0; const s16 = [];
  const sixteen = saveCustom({ id: 'my16', label: 'Sixteenths', steps: new Array(16).fill(null)
    .map((_, i) => (i % 2 === 0 ? { k: 'd', v: 0.7 } : null)) });
  ok(!!sixteen && getPattern('my16').steps.length === 16, 'a 16-step custom pattern saves');
  const q = new PatternPlayer({ now: () => c2, onStep: (s, w) => s16.push(+w.toFixed(3)) });
  q.start('my16', 120, 0);
  for (; c2 < 1.01; c2 += 1 / 60) q.tick();
  ok(Math.abs(s16[1] - 0.25) < 0.01, '16ths land twice as often as 8ths', `→ ${s16.slice(0, 3).join(', ')}`);
  ok(Math.abs(s16[4] - 1.0) < 0.02, 'a 16-step bar is still one bar', `→ ${s16[4]}`);
}
{
  // Feel multiplier: same bar, same tempo, twice the steps per second.
  saveCustom({ id: 'fast', label: 'Fast', rate: 2, steps: PATTERNS.drive.steps });
  saveCustom({ id: 'slow', label: 'Slow', rate: 0.5, steps: PATTERNS.drive.steps });
  ok(Math.abs(stepsPerSecond(PATTERNS.drive, 120) - 4) < 1e-9,
    '8ths at 120 BPM = 4 steps/sec', `→ ${stepsPerSecond(PATTERNS.drive, 120)}`);
  ok(stepsPerSecond(getPattern('fast'), 120) === 8 && stepsPerSecond(getPattern('slow'), 120) === 2,
    '2× doubles and ½× halves the strum rate');
  const times = (id) => {
    let c = 0; const out = [];
    const pl = new PatternPlayer({ now: () => c, onStep: (s, w) => out.push(+w.toFixed(4)) });
    pl.start(id, 120, 0);
    for (; c < 1.01; c += 1 / 240) pl.tick();
    return out;
  };
  const norm = times('drive'), fast = times('fast');
  ok(Math.abs(fast[1] - norm[1] / 2) < 1e-6, '2× actually halves the gap between steps',
    `${norm[1]} → ${fast[1]}`);
  ok(fast.length > norm.length, '2× fits more strums into the same second',
    `${norm.length} → ${fast.length}`);
  // Feel must survive a save/reload, or it silently reverts on refresh.
  loadCustom([{ id: 'fast', label: 'Fast', rate: 2, steps: PATTERNS.drive.steps }]);
  ok(getPattern('fast').rate === 2, 'feel persists through a save/load round-trip');
  ok(saveCustom({ id: 'weird', label: 'x', rate: 7, steps: PATTERNS.drive.steps }).rate === 1,
    'a bogus rate falls back to 1×');
  loadCustom([]);
}
{
  // Editor round-trip: every token survives a trip through the step form.
  const toks = [null, 'd', 'u', 'uh', 'x', 'b', 'ab', 's0', 's3', 's5'];
  const rt = toks.map((t) => stepToToken(tokenToStep(t, 0.7)));
  ok(JSON.stringify(rt) === JSON.stringify(toks), 'step tokens round-trip through the editor form', `→ ${rt}`);
  ok(tokenToStep('uh').hi === true && tokenToStep('s3').s === 3, 'treble-up and single-string decode');
}
{
  const before = listPatterns().length;
  const p = blankPattern('Scratch');
  p.steps[0] = { k: 'd', v: 0.9 };
  ok(!!saveCustom(p), 'custom pattern saves');
  ok(listPatterns().length === before + 1, 'custom shows up in the list');
  ok(saveCustom({ ...p, id: 'drive' }) === null, 'a built-in id can never be overwritten');
  ok(PATTERNS.drive.steps.length === 8, 'built-in drive is untouched');
  ok(saveCustom({ id: 'oddlen', label: 'x', steps: new Array(7).fill(null) }) === null,
    'only 8- or 16-step bars are accepted');
  removeCustom(p.id);
  ok(getPattern(p.id) === null, 'custom pattern deletes');
  loadCustom([]);
  ok(listPatterns().length === Object.keys(PATTERNS).length, 'loadCustom([]) leaves only built-ins');
}

/* ============ 4. shape vocabulary ============ */
console.log('\nshapes');
{
  const S = (t, i, m, r, p) => [t, i, m, r, p].map((v) => (v ? 'ext' : 'curl'));
  const cases = [
    ['palm',    S(1,1,1,1,1), false], ['four',    S(0,1,1,1,1), false],
    ['three',   S(0,1,1,1,0), false], ['peace',   S(0,1,1,0,0), false],
    ['horns',   S(0,1,0,0,1), false], ['point',   S(0,1,0,0,0), false],
    ['call',    S(1,0,0,0,1), false], ['pinky',   S(0,0,0,0,1), false],
    ['thumbup', S(1,0,0,0,0), false], ['fist',    S(0,0,0,0,0), false],
    ['ok',      S(1,0,1,1,1), true],
  ];
  const wrong = cases.filter(([want, st, pinch]) => matchShape(st, pinch) !== want)
    .map(([want, st, pinch]) => `${want}≠${matchShape(st, pinch)}`);
  ok(wrong.length === 0, 'every named shape matches exactly one id', wrong.join(' '));
  ok(matchShape(S(1,0,0,0,0), false) === 'thumbup' && matchShape(S(0,0,0,0,0), false) === 'fist',
    '👍 and ✊ are told apart by the thumb alone');
  ok(SIGNS.length === 5 && STRUM_SIGNS.length === 5, 'five sign slots per hand');
  ok(new Set(Object.values(FINGER_STRINGS)).size === 6, 'the finger counts cover all six strings');
  ok(FINGER_STRINGS.point === 5 && FINGER_STRINGS.pinky === 0,
    'one finger = 1st string, little finger alone = 6th');
}

/* ============ 5. gesture engine ============ */
console.log('\ngestures');
const LAY = { neckX0: 0.03, neckX1: 0.48, gridY0: 0.10, gridY1: 0.93,
  strumX0: 0.52, strumX1: 0.97, lefty: false };
const CFG = (o = {}) => ({ chordMode: 'grid', playMode: 'strum', cols: 4, rows: 3,
  signPatterns: Object.fromEntries(STRUM_SIGNS.map((s) => [s.id, s.def])), ...o });

const R = (a, deg) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c, z: a.z };
};
const add = (p, d, k) => ({ x: p.x + d.x * k, y: p.y + d.y * k, z: p.z + d.z * k });
const lerp3 = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: 0 });
/** Joint bend that produces a given 0..1 curl() reading. */
const fingerDeg = (c) => 14.9 + 64.7 * Math.max(0, Math.min(1, c));

const THUMB_OPEN = [{ x: -0.04, y: -0.02 }, { x: -0.06, y: -0.045 }, { x: -0.075, y: -0.065 }, { x: -0.09, y: -0.085 }];
const THUMB_TUCK = [{ x: -0.035, y: -0.025 }, { x: -0.03, y: -0.05 }, { x: -0.005, y: -0.06 }, { x: 0.02, y: -0.062 }];

/**
 * Synthetic hand. `curls` = per-digit 0..1 [thumb, index, middle, ring, pinky];
 * `pinch` = thumb-tip↔index-tip gap in world units; `roll` = screen-space hand
 * tilt in radians (what the mode dial reads).
 */
function makeHand(cx, cy, { curls = [0, 0, 0, 0, 0], pinch = null, label = null, roll = 0 } = {}) {
  const w = new Array(21);
  w[0] = { x: 0, y: 0, z: 0 };
  const mcpX = [-0.030, -0.008, 0.014, 0.034];
  [5, 9, 13, 17].forEach((base, f) => {
    const mcp = { x: mcpX[f], y: -0.075, z: 0 };
    const deg = fingerDeg(curls[f + 1]);
    const d0 = { x: 0, y: -1, z: 0 };
    const pip = add(mcp, d0, 0.035);
    const d1 = R(d0, deg), dip = add(pip, d1, 0.022);
    const d2 = R(d1, deg), tip = add(dip, d2, 0.018);
    w[base] = mcp; w[base + 1] = pip; w[base + 2] = dip; w[base + 3] = tip;
  });
  for (let i = 0; i < 4; i++) w[1 + i] = lerp3(THUMB_OPEN[i], THUMB_TUCK[i], curls[0]);
  if (pinch !== null) w[4] = { x: w[8].x - pinch, y: w[8].y, z: 0 };
  let lm = w.map((p) => ({ x: cx + p.x * 1.3, y: cy + p.y * 1.3, z: 0 }));
  lm[0] = { x: cx, y: cy + 0.06 }; lm[5] = { x: cx - 0.03, y: cy - 0.03 }; lm[17] = { x: cx + 0.03, y: cy - 0.03 };
  if (roll) {
    const c = Math.cos(roll), s = Math.sin(roll);
    lm = lm.map((p) => ({ x: cx + (p.x - cx) * c - (p.y - cy) * s,
                          y: cy + (p.x - cx) * s + (p.y - cy) * c, z: 0 }));
  }
  return { lm, world: w, x: cx, label, score: label ? 0.95 : 0 };
}

/* Curl vectors for the shapes the tests need. */
const CURL = {
  palm:    [0, 0, 0, 0, 0],
  four:    [0.95, 0, 0, 0, 0],
  three:   [0.95, 0, 0, 0, 0.95],
  peace:   [0.95, 0, 0, 0.95, 0.95],
  horns:   [0.95, 0, 0.95, 0.95, 0],
  point:   [0.95, 0, 0.95, 0.95, 0.95],
  pinky:   [0.95, 0.95, 0.95, 0.95, 0],
  call:    [0, 0.95, 0.95, 0.95, 0],
  fist:    [0.95, 0.95, 0.95, 0.95, 0.95],
  thumbup: [0, 0.95, 0.95, 0.95, 0.95],
  ok:      [0, 0.5, 0, 0, 0],
};
const shape = (name, extra = {}) =>
  ({ curls: CURL[name], ...(name === 'ok' ? { pinch: 0.015 } : {}), ...extra });

/** Ramp helper: 0 before t0, 1 after t0+dur. */
const ramp = (t, t0, dur) => Math.max(0, Math.min(1, (t - t0) / dur));

/** Drive the engine at 60 fps. fret(t)/pluck(t) → hand options | null. */
function run(secs, fret, pluck, cfg = CFG(), lay = LAY) {
  const g = new GestureEngine();
  const events = [], slots = [];
  for (let i = 0; i < Math.round(secs * 60); i++) {
    const t = i / 60;
    const hands = [];
    const f = fret ? fret(t) : null, p = pluck ? pluck(t) : null;
    if (f) hands.push(makeHand(f.x, f.y, f));
    if (p) hands.push(makeHand(p.x, p.y, p));
    events.push(...g.update(hands, t, lay, cfg).map((e) => ({ ...e })));
    slots.push(g.fret.slot);
  }
  return { g, events, slots };
}
const jit = (a) => (Math.random() - 0.5) * a;
const of = (r, type) => r.events.filter((e) => e.type === type);

/* ---- fretting hand: the chord grid ---- */
let r = run(2, () => ({ x: 0.10, y: 0.6, ...shape('point') }), null);
ok(of(r, 'chord').length <= 1, 'a still pointing hand commits at most one cell',
  `(${of(r, 'chord').length})`);

// Pointing across the grid changes column; the same sweep relaxed changes nothing.
r = run(4, (t) => ({ x: 0.06 + ramp(t, 0.6, 2.4) * 0.36, y: 0.6, ...shape('point') }), null);
{
  const ev = of(r, 'chord');
  ok(JSON.stringify(ev.map((e) => e.index)) === '[0,1,2,3]', 'left→right crosses all four columns',
    `→ ${ev.map((e) => e.index)}`);
  ok(ev.every((e) => e.source === 'grid'), 'grid commits are tagged as such');
}
r = run(4, (t) => ({ x: 0.06 + ramp(t, 0.6, 2.4) * 0.36, y: 0.6, ...shape('palm') }), null);
ok(of(r, 'chord').length === 0, 'the same sweep with an open hand commits nothing',
  `(${of(r, 'chord').length})`);

// Rows: same column, top vs bottom of the wall — column must not drift.
r = run(4, (t) => ({ x: 0.10, y: t < 2 ? 0.30 : 0.95, ...shape('point') }), null);
{
  const ev = of(r, 'chord');
  ok(ev.length >= 1 && ev[ev.length - 1].index === 8, 'moving down the wall changes row, not column',
    `→ ${ev.map((e) => e.index)}`);
}
// Tremor on a cell boundary must not strobe the chord.
r = run(5, () => ({ x: 0.03 + 0.45 / 4 + jit(0.008), y: 0.6, ...shape('point') }), null);
ok(of(r, 'chord').length <= 2, 'cell boundary hover does not flicker', `(${of(r, 'chord').length})`);

/* ---- the bottom row has to be physically reachable ----
 *
 * Regression, and one that made four of the twelve chords simply unusable.
 *
 * The measurement that matters is the *middle of the lowest drawn cell*, not
 * its top edge, because that is where a player aims — the wall is painted on
 * screen and you point at the box you can see. Merely entering the row was
 * always borderline-possible; centring on it was not. With the old 0.90 bound
 * the lowest cell centred at 0.77, and a pointing hand carries its wrist about
 * a quarter of a frame below the fingertip, which put the wrist past the
 * bottom edge with no palm context left for the tracker. The hand was gone
 * before the chord was.
 *
 * So: aim at the cell centre, then assert the wrist is still on screen. The
 * hand geometry is measured off the rig rather than assumed, and the *real*
 * GRID_Y0/GRID_Y1 are used rather than this file's LAY fixture, so pushing the
 * wall's lower bound back down fails right here. */
{
  const REAL = { ...LAY, gridY0: GRID_Y0, gridY1: GRID_Y1 };
  const { rows } = CFG();
  const rowMid = GRID_Y0 + ((rows - 0.5) / rows) * (GRID_Y1 - GRID_Y0);

  const probe = makeHand(0.10, 0.5, shape('point'));
  const tipOff = probe.lm[8].y - 0.5;          // fingertip, relative to `cy`
  const drop = probe.lm[0].y - probe.lm[8].y;  // wrist sits this far below it
  const cy = rowMid - tipOff;                  // put the fingertip on rowMid
  const wrist = cy + (probe.lm[0].y - 0.5);

  ok(wrist <= 0.90, 'aiming at the lowest cell leaves the wrist on screen',
    `wrist y=${wrist.toFixed(3)}, cell centre ${rowMid.toFixed(3)}, wrist drop ${drop.toFixed(3)}`);

  const r2 = run(2, () => ({ x: 0.10, y: cy, ...shape('point') }), null, CFG(), REAL);
  const ev = of(r2, 'chord');
  ok(ev.length >= 1 && ev[ev.length - 1].index >= 8, '…and that aim commits a bottom-row chord',
    `→ cell ${ev.length ? ev[ev.length - 1].index : 'none'}`);
}

/* ---- fretting hand: sign chords ---- */
r = run(2, () => ({ x: 0.2, y: 0.5, ...shape('horns') }), null, CFG({ chordMode: 'signs' }));
{
  const ev = of(r, 'chord');
  const want = SIGNS.findIndex((s) => s.id === 'horns');
  ok(ev.length === 1 && ev[0].index === want && ev[0].source === 'sign',
    '🤘 selects its sign chord once', `(${ev.map((e) => e.index)})`);
}
r = run(3, (t) => ({ x: 0.2, y: 0.5, ...shape(t < 1.2 ? 'peace' : 'call') }), null,
  CFG({ chordMode: 'signs' }));
ok(of(r, 'chord').length === 2, 'changing sign changes chord', `(${of(r, 'chord').length})`);
// In sign mode the hand may wander anywhere without touching the chord.
r = run(3, (t) => ({ x: 0.05 + t * 0.13, y: 0.3 + t * 0.15, ...shape('peace') }), null,
  CFG({ chordMode: 'signs' }));
ok(of(r, 'chord').length === 1, 'sign chords ignore hand position', `(${of(r, 'chord').length})`);

/* ---- selection must re-assert, never assume it still owns the slot ----
 * Regression: the engine used to suppress the event when the target matched
 * its own remembered slot. Anything else moving the selection (a mode switch,
 * a number key) then left a re-point silently emitting nothing, and you heard
 * the wrong chord. */
{
  // Grid → point at cell 2 → switch to signs → make the sign at index 2.
  const g = new GestureEngine();
  const ev = [];
  const at = (t, cfg, hand) => ev.push(...g.update([makeHand(hand.x, hand.y, hand)], t, LAY, cfg));
  for (let i = 0; i < 120; i++) at(i / 60, CFG(), { x: 0.30, y: 0.6, ...shape('point') });
  const gridPicks = ev.filter((e) => e.type === 'chord').length;
  ev.length = 0;
  const signs = CFG({ chordMode: 'signs' });
  const want = SIGNS.findIndex((s) => s.id === 'horns');
  for (let i = 120; i < 300; i++) at(i / 60, signs, { x: 0.30, y: 0.6, ...shape('horns') });
  const picks = ev.filter((e) => e.type === 'chord');
  ok(gridPicks >= 1, 'grid pointing commits before the switch', `(${gridPicks})`);
  ok(picks.length === 1 && picks[0].index === want,
    'after a mode switch the sign still announces its own chord',
    `→ ${picks.map((e) => e.index)} (want ${want})`);
}
{
  // Re-acquiring the same cell must re-announce it: the app may have moved the
  // selection with the keyboard while the hand sat still.
  const r2 = run(5, (t) => ({ x: 0.10, y: 0.6, ...shape(t > 1.5 && t < 2.5 ? 'palm' : 'point') }), null);
  const ix = of(r2, 'chord').map((e) => e.index);
  ok(ix.length === 2 && ix[0] === ix[1], 'dropping and re-taking a cell announces it twice', `→ ${ix}`);
}
{
  // Holding one cell still fires exactly once — the fix must not add repeats.
  const r2 = run(5, () => ({ x: 0.30, y: 0.6, ...shape('point') }), null);
  ok(of(r2, 'chord').length === 1, 'a steadily held cell still fires once', `(${of(r2, 'chord').length})`);
  const r3 = run(5, () => ({ x: 0.2, y: 0.5, ...shape('horns') }), null, CFG({ chordMode: 'signs' }));
  ok(of(r3, 'chord').length === 1, 'a steadily held sign still fires once', `(${of(r3, 'chord').length})`);
}

/* ---- every sign plays its own chord, cleanly ----
 * Regression: 👌 selected nothing (its index finger curls into the ring, so it
 * sits in the hysteresis dead zone and the resolved-digit guard rejected the
 * whole shape) *and* leaked a full whole-step bend (the bend gesture is a
 * thumb-index pinch with the middle finger out, which is what 👌 *is*). The
 * chord bound to it therefore rang two semitones sharp — C came out as D. */
{
  const signs = CFG({ chordMode: 'signs' });
  const got = SIGNS.map((s) => {
    const rr = run(2, () => ({ x: 0.2, y: 0.5, ...shape(s.id) }), null, signs);
    const ev = of(rr, 'chord');
    return { id: s.id, slot: ev.length === 1 ? ev[0].index : -1,
      bend: rr.g.fret.bend, dead: rr.g.fret.dead, shape: rr.g.fret.shape };
  });
  ok(got.every((g, i) => g.slot === i), 'each sign selects its own chord slot, exactly once',
    `→ ${got.map((g) => `${g.id}:${g.slot}`).join(' ')}`);
  ok(got.every((g) => g.shape === g.id), 'each sign is recognised as itself',
    `→ ${got.map((g) => g.shape).join(' ')}`);
  ok(got.every((g) => g.bend === 0), 'no sign bends the chord it just selected',
    `→ ${got.map((g) => `${g.id}:${g.bend.toFixed(2)}`).join(' ')}`);
  ok(got.every((g) => !g.dead), 'no sign deadens the chord it just selected');
}
{
  // 👌 specifically: the index must be allowed to be undecided.
  const st = (t, i, m, r, p) => [t, i, m, r, p];
  ok(matchShape(st('ext', 'mid', 'ext', 'ext', 'ext'), true) === 'ok',
    '👌 matches with the index parked in the dead zone');
  ok(matchShape(st('ext', 'mid', 'ext', 'ext', 'ext'), false) === null,
    '…but only when the thumb and index are actually touching');
  ok(matchShape(st('ext', 'ext', 'ext', 'ext', 'ext'), false) === 'palm',
    'an open palm is still an open palm');
}
{
  // Grid mode keeps the bend — there, a pinch means nothing else.
  const r2 = run(2, () => ({ x: 0.2, y: 0.5, ...shape('ok') }), null);
  ok(r2.g.fret.bend > 1.5, 'grid mode still bends on a pinch', r2.g.fret.bend.toFixed(2));
  const r3 = run(2, () => ({ x: 0.2, y: 0.5, ...shape('ok') }), null, CFG({ chordMode: 'signs' }));
  ok(r3.g.fret.bend === 0, 'sign mode never bends — the pinch is a chord there', String(r3.g.fret.bend));
}

/* ---- deaden + vibrato gating ---- */
r = run(2, () => ({ x: 0.2, y: 0.5, ...shape('peace') }), null);
ok(r.g.fret.dead === true, '✌️ deadens in grid mode');
r = run(2, () => ({ x: 0.2, y: 0.5, ...shape('point') }), null);
ok(r.g.fret.dead === false, 'pointing does not deaden');
r = run(2, () => ({ x: 0.2, y: 0.5, ...shape('peace') }), null, CFG({ chordMode: 'signs' }));
ok(r.g.fret.dead === false, '✌️ is a chord, not a mute, in sign mode');
r = run(2, () => ({ x: 0.2, y: 0.5, ...shape('fist') }), null, CFG({ chordMode: 'signs' }));
ok(r.g.fret.dead === true, '✊ deadens in sign mode');

const wobble = (t) => 0.5 + 0.022 * Math.sin(2 * Math.PI * 5.5 * t) + jit(0.006);
r = run(3, (t) => ({ x: 0.2, y: wobble(t), ...shape('horns') }), null);
ok(r.g.fret.vibrato > 0.6, '🤘 + shake → vibrato', r.g.fret.vibrato.toFixed(2));
r = run(3, (t) => ({ x: 0.2, y: wobble(t), ...shape('point') }), null);
ok(r.g.fret.vibrato === 0, 'shaking while pointing is aiming, not vibrato', String(r.g.fret.vibrato));
r = run(3, (t) => ({ x: 0.2, y: wobble(t), ...shape('peace') }), null, CFG({ chordMode: 'signs' }));
ok(r.g.fret.vibrato > 0.6, 'in sign mode any shake is vibrato', r.g.fret.vibrato.toFixed(2));

/* ---- bend ---- */
r = run(2, () => ({ x: 0.2, y: 0.5, pinch: 0.018 }), null);
ok(r.g.fret.bend > 1.5, 'pinch → ~2 semitone bend', r.g.fret.bend.toFixed(2));
r = run(2, () => ({ x: 0.2, y: 0.5, pinch: 0.018, ...shape('fist') }), null);
ok(r.g.fret.bend === 0, 'a fist is not read as a pinch', r.g.fret.bend.toFixed(2));

/* ---- plucking hand: fingerstyle ---- */
const FCFG = CFG({ playMode: 'finger' });
for (const [name, want] of [['point', 5], ['peace', 4], ['three', 3], ['four', 2], ['palm', 1], ['pinky', 0]]) {
  const rr = run(1.5, null, () => ({ x: 0.75, y: 0.5, ...shape(name) }), FCFG);
  const ev = of(rr, 'pluck');
  ok(ev.length === 1 && ev[0].string === want, `${name} → string index ${want}`,
    `(${ev.map((e) => e.string)})`);
}
r = run(4, null, () => ({ x: 0.75, y: 0.5, ...shape('point') }), FCFG);
ok(of(r, 'pluck').length === 1, 'a held count sounds once, not forever', `(${of(r, 'pluck').length})`);
r = run(4, null, (t) => ({ x: 0.75, y: 0.5, ...shape(t < 1 ? 'point' : t < 2 ? 'fist' : 'point') }), FCFG);
ok(of(r, 'pluck').length === 2, 'returning to a fist re-arms the same string', `(${of(r, 'pluck').length})`);
r = run(4, null, (t) => ({ x: 0.75, y: 0.5, ...shape(t < 1 ? 'point' : t < 2 ? 'peace' : 'three') }), FCFG);
{
  const ev = of(r, 'pluck');
  ok(ev.length === 3 && JSON.stringify(ev.map((e) => e.string)) === '[5,4,3]',
    'walking the counts walks the strings', `(${ev.map((e) => e.string)})`);
}
r = run(4, null, () => ({ x: 0.75, y: 0.5, curls: [0.5 + jit(0.1), 0.5 + jit(0.1), 0.5 + jit(0.1), 0.5 + jit(0.1), 0.5 + jit(0.1)] }), FCFG);
ok(r.events.length === 0, 'a hand parked in the dead zone fires nothing', `(${r.events.length})`);
r = run(3, null, () => ({ x: 0.75, y: 0.5, ...shape('fist') }), FCFG);
ok(of(r, 'pluck').length === 0, 'a fist is rest, never a note');
r = run(3, null, () => ({ x: 0.75, y: 0.5, ...shape('thumbup') }), FCFG);
ok(of(r, 'pluck').length === 0, '👍 is the mode dial, never a note');

/* ---- plucking hand: strum patterns ---- */
r = run(3, null, (t) => ({ x: 0.75, y: 0.5, ...shape(t < 2 ? 'fist' : 'palm') }), CFG());
{
  const ev = of(r, 'pattern');
  ok(ev.length === 2 && ev[0].action === 'start' && ev[0].sign === 'fist' && ev[0].pattern === 'drive',
    '✊ starts its bound pattern once', `(${ev.map((e) => e.action + ':' + (e.pattern || '')).join(',')})`);
  ok(ev[0].t > 0.4 && ev[0].t < 0.7, 'start comes after the dwell', `t=${ev[0]?.t.toFixed(2)}`);
  ok(ev[1].action === 'stop' && ev[1].t > 1.95 && ev[1].t < 2.3, '✋ stops it', `t=${ev[1]?.t.toFixed(2)}`);
}
r = run(3, null, () => ({ x: 0.75, y: 0.5, ...shape('horns') }), CFG());
ok(of(r, 'pattern')[0]?.pattern === 'travis', '🤘 → Travis by default');
r = run(3, null, () => ({ x: 0.75, y: 0.5, ...shape('call') }), CFG({
  signPatterns: { ...CFG().signPatterns, call: 'march' } }));
ok(of(r, 'pattern')[0]?.pattern === 'march', 'a rebound sign plays the pattern you bound to it');
r = run(2, null, (t) => ({ x: 0.75, y: 0.5, ...shape(t > 0.5 && t < 0.8 ? 'fist' : 'palm') }), CFG());
ok(of(r, 'pattern').length === 0, 'a sign held under the dwell never triggers', `(${of(r, 'pattern').length})`);
r = run(3, null, (t) => (t > 1.6 ? null : { x: 0.75, y: 0.5, ...shape('fist') }), CFG());
{
  const ev = of(r, 'pattern');
  ok(ev.length === 2 && ev[1].action === 'stop', 'hand lost mid-pattern → pattern stops',
    `(${ev.map((e) => e.action).join(',')})`);
}
r = run(4, null, () => ({ x: 0.75, y: 0.5, ...shape('point') }), CFG());
ok(r.events.length === 0, 'finger counts are silent while strumming mode is on', `(${r.events.length})`);

/* ---- the mode dial ---- */
function dial(hand, tiltRad, cfg) {
  // 👍 for 1.2 s → tilt while still 👍 → ✋ to accept.
  const at = (t) => {
    if (t < 1.2) return { x: hand, y: 0.5, ...shape('thumbup') };
    if (t < 1.9) return { x: hand, y: 0.5, ...shape('thumbup'), roll: tiltRad };
    return { x: hand, y: 0.5, ...shape('palm'), roll: tiltRad };
  };
  return run(2.6, hand < 0.5 ? at : null, hand < 0.5 ? null : at, cfg);
}
{
  let d = dial(0.75, 0.6, FCFG);
  let ev = of(d, 'mode');
  ok(ev.length === 1 && ev[0].hand === 'pluck' && ev[0].value === 'strum',
    '👍 hold + tilt right + ✋ switches the plucking hand to strumming',
    `(${ev.map((e) => e.value)})`);
  d = dial(0.75, -0.6, CFG());
  ev = of(d, 'mode');
  ok(ev.length === 1 && ev[0].value === 'finger', 'tilt left picks the other option', `(${ev.map((e) => e.value)})`);
  d = dial(0.2, 0.6, CFG());
  ev = of(d, 'mode');
  ok(ev.length === 1 && ev[0].hand === 'fret' && ev[0].value === 'signs',
    'the same ritual switches the fretting hand to sign chords', `(${ev.map((e) => e.value)})`);
  // Never on a brief thumbs-up, and never without the accept.
  d = run(2.6, null, (t) => ({ x: 0.75, y: 0.5, ...shape(t < 0.6 ? 'thumbup' : 'fist') }), FCFG);
  ok(of(d, 'mode').length === 0, 'a short 👍 opens nothing', `(${of(d, 'mode').length})`);
  d = run(3, null, (t) => ({ x: 0.75, y: 0.5, ...shape(t < 1.4 ? 'thumbup' : 'fist') }), FCFG);
  ok(of(d, 'mode').length === 0, 'dropping the shape cancels instead of committing');
  // Opening the dial must not leak notes out of the hand underneath it.
  ok(of(dial(0.75, 0.6, FCFG), 'pluck').length === 0, 'no strings sound while the dial is up');
}

/* ---- roles, dropouts ---- */
{
  const g = new GestureEngine();
  for (let i = 0; i < 300; i++) {
    const t = i / 60, crossed = t > 2;
    g.update([
      makeHand(crossed ? 0.8 : 0.2, 0.5, { label: 'Right', ...shape('point') }),
      makeHand(crossed ? 0.2 : 0.8, 0.5, { label: 'Left', ...shape('fist') }),
    ], t, LAY, CFG());
  }
  ok(g.lock?.fretLabel === 'Right', 'label lock seeded from the neck side', `→ ${g.lock?.fretLabel}`);
  ok(g.fret.present && g.pluck.present, 'after crossing, both roles survive');
}
{
  const g = new GestureEngine();
  let ev = 0;
  for (let i = 0; i < 300; i++) {
    const t = i / 60;
    if (t < 1) {
      g.update([makeHand(0.2, 0.5, { label: 'Right' }), makeHand(0.8, 0.5, { label: 'Left' })], t, LAY, FCFG);
    } else {
      // Only the plucking (Left-labelled) hand remains, and it drifts to the
      // NECK side — with the lock it must keep plucking, not start fretting.
      const s = t > 2 && t < 2.6 ? 'point' : 'fist';
      ev += g.update([makeHand(0.3, 0.5, { label: 'Left', ...shape(s) })], t, LAY, FCFG)
        .filter((e) => e.type === 'pluck').length;
    }
  }
  ok(ev === 1, 'lone labelled hand keeps its plucking role on the wrong side', `(${ev} plucks)`);
}
{
  const g = new GestureEngine();
  let ev = 0;
  for (let i = 0; i < 300; i++) {
    const t = i / 60, gone = t > 1.5 && t < 2.0;
    ev += g.update(gone ? [] : [makeHand(0.2, 0.5, shape('palm')),
      makeHand(0.75, t < 1.5 ? 0.5 : 0.3, shape('fist'))], t, LAY, FCFG).length;
  }
  ok(ev === 0, 'dropout + reappearance fires nothing', `(${ev})`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
