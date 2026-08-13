/**
 * Headless checks for Air Drums: stick geometry, the kit's zones and surfaces,
 * and contact detection driven by synthetic strokes.
 *
 * The synthetic hands here are *fists*, and they are built by placing a wrist
 * and a palm — never a fingertip. That is the point: the instrument is supposed
 * to be indifferent to what the fingers are doing, so the fixture can move them
 * freely and the tests can assert that nothing downstream notices.
 *
 * Run: node test/drums.mjs
 */
import { stickOf, poseOf, spanOf, closeOf, pointOf, Grip, reachOf,
  STICK, FINGER, LENGTH } from '../src/drums/stick.js';
import { Kit, PADS, SURFACE } from '../src/drums/kit.js';
import { StickDetector } from '../src/drums/onset.js';

let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ================================================================== *
 *  Synthetic hand: a wrist, a palm, and four fingers that don't matter.
 * ================================================================== */
const KN = [5, 9, 13, 17], TIPS = [8, 12, 16, 20];
const SPREAD = [-0.34, -0.11, 0.11, 0.34];

/**
 * A hand at `wx, wy` whose palm points along `angle` (π/2 = down the screen).
 *
 * `curl` is the stick-mode grip dial: 1 is a closed fist, 0 a flat open hand.
 * `point`, when given, overrides the index finger alone, which is what the
 * fingertip mode is driven with.
 */
function makeHand(id, { wx = 0.5, wy = 0.4, span = 0.12, angle = Math.PI / 2,
                        curl = 1, point = null, jitter = 0 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
  const ux = Math.cos(angle), uy = Math.sin(angle);          // wrist → knuckles
  const px = -uy, py = ux;                                   // across the palm
  const j = () => (jitter ? (Math.random() - 0.5) * 2 * jitter * span : 0);
  lm[0] = { x: wx, y: wy };
  KN.forEach((k, i) => {
    lm[k] = { x: wx + ux * span + px * SPREAD[i] * span + j(),
              y: wy + uy * span + py * SPREAD[i] * span + j() };
  });
  const curled = lerp(0.80, 0.32, clamp(curl, 0, 1));
  TIPS.forEach((tp, i) => {
    // A pointing hand: index out, the rest in. Otherwise all four alike.
    const reach = point === null ? curled
      : i === 0 ? lerp(0.32, 0.80, clamp(point, 0, 1)) : lerp(0.80, 0.32, clamp(point, 0, 1));
    lm[tp] = { x: lm[KN[i]].x + ux * span * reach + j(),
               y: lm[KN[i]].y + uy * span * reach + j() };
  });
  return { id, lm };
}

/**
 * Where the striking point sits relative to the wrist, for a hand pointing
 * down the screen. Sideways as well as down: a fingertip is off to one side of
 * the wrist, and aiming a test at a drum without allowing for that quietly
 * strikes half a pad-width away from where the test says it does.
 */
function tipOffset(mode, span = 0.12, reach = LENGTH) {
  const h = makeHand('r', { wx: 0, wy: 0, span, point: mode === FINGER ? 1 : null });
  const p = poseOf(h.lm, { mode, length: reach });
  return { dx: p.tip.x, dy: p.tip.y };
}

/* ================================================================== *
 *  1. The stick
 * ================================================================== */
console.log('\nstick');
{
  const h = makeHand('right', { wx: 0.5, wy: 0.4, span: 0.12 });
  const s = stickOf(h.lm);
  ok(!!s, 'a stick can be placed on a hand');
  ok(Math.abs(s.span - 0.12) < 0.12 * 0.05, 'the palm span is measured off the hand', s.span.toFixed(4));
  ok(s.axis.y > 0.99, 'a level hand hangs its stick straight down',
    `axis ${s.axis.x.toFixed(2)}, ${s.axis.y.toFixed(2)}`);
  ok(s.butt.y < s.grip.y && s.grip.y < s.tip.y, 'butt back out of the fist, tip out in front');
  const reach = Math.hypot(s.tip.x - s.grip.x, s.tip.y - s.grip.y) / s.span;
  ok(Math.abs(reach - LENGTH) < 0.02, 'the tip sits a fixed reach past the fist', reach.toFixed(2));

  // The shaft has to pass through the hand, or it reads as a separate object
  // floating nearby rather than as something being held.
  const off = (pt) => {
    const dx = pt.x - s.grip.x, dy = pt.y - s.grip.y;
    return Math.abs(dx * -s.axis.y + dy * s.axis.x) / s.span;   // ⟂ distance, in spans
  };
  ok(off(h.lm[0]) < 0.02 && off(h.lm[9]) < 0.16, 'the shaft runs through the fist',
    `wrist ${off(h.lm[0]).toFixed(3)}, knuckle ${off(h.lm[9]).toFixed(3)} spans off`);
}
{
  /* The whole reason this file was rewritten. A drum stroke bends the fingers,
   * so if any finger can move the stick then the stick moves during every
   * stroke — which is what the old index-finger geometry did. */
  const open = stickOf(makeHand('r', { curl: 0.15 }).lm);
  const shut = stickOf(makeHand('r', { curl: 1 }).lm);
  const moved = Math.hypot(shut.tip.x - open.tip.x, shut.tip.y - open.tip.y) / open.span;
  ok(moved < 1e-9, 'curling the fingers does not move the stick at all',
    `${moved.toExponential(1)} spans`);

  const wild = makeHand('r', { curl: 1 });
  const before = stickOf(wild.lm);
  wild.lm[8] = { x: 0.9, y: 0.05 };              // an index finger thrown anywhere
  const after = stickOf(wild.lm);
  ok(Math.hypot(after.tip.x - before.tip.x, after.tip.y - before.tip.y) < 1e-9,
    'and the index finger is not read at all');
}
{
  /* The stick points where the hand points, taken straight off the wrist-to-
   * knuckles vector. That vector is *directed*, so there is no end to choose
   * and nothing to flip — which is what the previous design, built on the
   * knuckle line's undirected perpendicular, could not manage. */
  let worst = 0;
  for (let a = -Math.PI; a < Math.PI; a += 0.01) {
    const s = stickOf(makeHand('r', { angle: a }).lm);
    const want = { x: Math.cos(a), y: Math.sin(a) };
    worst = Math.max(worst, Math.acos(clamp(s.axis.x * want.x + s.axis.y * want.y, -1, 1)));
  }
  ok(worst < 0.001, 'the stick lies along the hand, whichever way the hand is turned',
    `worst ${(worst * 180 / Math.PI).toFixed(3)}° off`);

  const down = stickOf(makeHand('r', { angle: Math.PI / 2 }).lm);
  ok(down.axis.y > 0.999, 'a hand pointing at the kit points its stick at the kit');
  const upish = stickOf(makeHand('r', { angle: -Math.PI / 2.2 }).lm);
  ok(upish.axis.y < -0.9, 'and a hand pointing away points away — no silent correction',
    `axis ${upish.axis.x.toFixed(2)}, ${upish.axis.y.toFixed(2)}`);

  /* Sweeping the hand right through the degenerate pose — pointing straight at
   * the camera, where the axis has no length and no meaning — must not throw
   * the tip anywhere. It cannot flip, because the direction is directed; and
   * it barely moves, because the stick is drawn shorter by exactly how little
   * its direction can be believed. */
  let jump = 0, prev = null;
  for (let k = -1; k <= 1; k += 0.005) {
    const h = makeHand('r', { angle: Math.PI / 2, span: 0.12 });
    for (const kn of KN) h.lm[kn].y = h.lm[0].y + 0.12 * k;   // axis shrinks through zero
    const s = stickOf(h.lm);
    if (prev) jump = Math.max(jump, Math.hypot(s.tip.x - prev.x, s.tip.y - prev.y) / s.span);
    prev = s.tip;
  }
  ok(jump < 0.06, 'and turning the hand through the camera never throws the tip',
    `largest step ${jump.toFixed(4)} spans`);
}
{
  /* Reach is held inside a screen range, because the kit is drawn at fixed
   * places on screen and a hand's size is a fact about how close somebody is
   * sitting. Un-clamped, sitting close gives a stick half the height of the
   * frame that sweeps every drum at once — which is what it actually did. */
  const near = stickOf(makeHand('r', { span: 0.30 }).lm);
  const far = stickOf(makeHand('r', { span: 0.045 }).lm);
  const mid = stickOf(makeHand('r', { span: 0.12 }).lm);
  const len = (s) => Math.hypot(s.tip.x - s.grip.x, s.tip.y - s.grip.y);
  ok(Math.abs(mid.unit - mid.span * LENGTH) < 1e-6,
    'at a normal distance the stick is simply proportional to the hand', mid.unit.toFixed(3));
  ok(Math.abs(len(mid) - mid.unit * mid.conf) < 1e-9,
    'and what is drawn is that, projected — nothing else', len(mid).toFixed(3));
  ok(near.unit < 0.27 && near.unit < near.span * LENGTH * 0.55,
    'sitting close does not hand you a caber', near.unit.toFixed(3));
  ok(far.unit > 0.10, 'and sitting back does not leave you a stub', far.unit.toFixed(3));
  ok(reachOf(0.12, 2.5) > reachOf(0.12, 1.4), 'the length control still lengthens it');
}
{
  /* Scale, under foreshortening. Turn a hand away from the camera and every
   * distance in the image shrinks; if the ruler shrinks with them, every
   * threshold measured in spans silently moves. World landmarks are what make
   * this recoverable — see spanOf. */
  const h = makeHand('r', { span: 0.12 });
  const world = h.lm.map((p) => ({ x: (p.x - 0.5) * 1.0, y: (p.y - 0.4) * 1.0, z: 0 }));
  const flat = spanOf(h.lm, world);
  const squashed = { id: 'r', lm: h.lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.35, y: p.y })) };
  ok(Math.abs(spanOf(squashed.lm, world) - flat) / flat < 0.02,
    'turning the hand away from the camera does not shrink the ruler',
    `${flat.toFixed(4)} → ${spanOf(squashed.lm, world).toFixed(4)}`);
  ok(spanOf(squashed.lm, null) > flat * 0.75,
    'and without world landmarks it still holds up, by taking the longer axis',
    `${spanOf(squashed.lm, null).toFixed(4)}`);
}
{
  ok(closeOf(makeHand('r', { curl: 1 }).lm) > 0.9, 'a closed hand is holding a stick');
  ok(closeOf(makeHand('r', { curl: 0 }).lm) < 0.05, 'a flat open hand is not');
  ok(closeOf(makeHand('r', { curl: 0.55 }).lm) > 0.5,
    'and a loose, comfortable grip counts — you should not have to clench',
    closeOf(makeHand('r', { curl: 0.55 }).lm).toFixed(2));

  const g = new Grip();
  ok(!g.update(0.3), 'a half-closed hand does not pick the stick up');
  ok(g.update(0.6) && g.update(0.3), 'once held, it takes a real opening to let go');
  ok(!g.update(0.1), 'and opening properly does let go');
}

/* ================================================================== *
 *  1b. The fingertip
 * ================================================================== */
console.log('\nfingertip');
{
  const h = makeHand('right', { wx: 0.5, wy: 0.4, span: 0.12, point: 1 });
  const p = poseOf(h.lm, { mode: FINGER });
  ok(p.mode === FINGER, 'the fingertip mode makes a fingertip');
  ok(p.tip.x === h.lm[8].x && p.tip.y === h.lm[8].y,
    'and the striking point is the landmark itself — nothing is projected');
  ok(p.grip.x === h.lm[5].x && p.grip.y === h.lm[5].y, 'anchored at the index knuckle');

  /* The reason the mode exists. Whatever the other fingers do, the point that
   * plays is one fingertip, so nothing else on the hand can set a drum off. */
  const before = poseOf(makeHand('r', { point: 1 }).lm, { mode: FINGER });
  const wild = makeHand('r', { point: 1 });
  for (const t of [12, 16, 20]) wild.lm[t] = { x: Math.random(), y: Math.random() };
  const after = poseOf(wild.lm, { mode: FINGER });
  ok(after.tip.x === before.tip.x && after.tip.y === before.tip.y,
    'the other fingers cannot move it');
}
{
  ok(pointOf(makeHand('r', { point: 1 }).lm) > 0.85, 'a pointing hand is armed');
  ok(pointOf(makeHand('r', { point: 0 }).lm) < 0.05, 'a hand pointing with nothing is not');
  ok(pointOf(makeHand('r', { curl: 0 }).lm) < 0.10, 'and neither is a flat open hand',
    pointOf(makeHand('r', { curl: 0 }).lm).toFixed(2));
  ok(pointOf(makeHand('r', { curl: 1 }).lm) < 0.10, 'nor a closed fist',
    pointOf(makeHand('r', { curl: 1 }).lm).toFixed(2));
}

/* ================================================================== *
 *  2. The kit
 * ================================================================== */
console.log('\nkit');
{
  const kit = new Kit();
  const pads = kit.pads();
  ok(pads.length === PADS.length && pads.length === 7, 'seven pads', `(${pads.length})`);
  for (const p of pads) ok(kit.zoneAt({ x: p.x, y: p.y })?.id === p.id,
    `${p.label} answers to a stroke on its own centre`);
  ok(kit.zoneAt({ x: 0.5, y: 0.03 }) === null, 'a stroke above the kit hits nothing');
  for (const p of pads) ok(p.sy < p.y && Math.abs((p.y - p.sy) / p.ry - SURFACE) < 1e-9,
    `${p.label}'s surface sits just above its centre`);

  /* Zones exist so that a stroke aimed between two drums still belongs to one
   * of them. The property is *not* that the kit's bounding box is covered —
   * a kit is an arch, cymbals high and outboard, drums low and central, and
   * the empty middle above the snare is empty on a real kit too. What must
   * hold is that there is no crack between neighbours: walk the line joining
   * every close pair of pads and every point on it must belong to a drum. */
  let cracks = 0, walked = 0;
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i], b = pads[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 0.28) continue;   // not neighbours
      for (let k = 0; k <= 40; k++) {
        const u = k / 40;
        walked++;
        if (!kit.zoneAt({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })) cracks++;
      }
    }
  }
  ok(walked > 100 && cracks === 0, 'no crack between neighbouring drums for a stroke to fall down',
    `${walked} points walked between adjacent pads, ${cracks} belonging to nothing`);

  const left = new Kit({ lefty: true }).pads().find((p) => p.id === 'hihat');
  const right = pads.find((p) => p.id === 'hihat');
  ok(left.x > 0.5 && right.x < 0.5, 'the kit mirrors for a left-hander',
    `${right.x.toFixed(2)} → ${left.x.toFixed(2)}`);
  const small = new Kit({ scale: 0.7 }).pads();
  const spread = (ps) => Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x));
  ok(spread(small) < spread(pads) * 0.8, 'scaling down pulls the pads together',
    `${spread(pads).toFixed(2)} → ${spread(small).toFixed(2)}`);
  ok(small.every((p) => p.x > 0.03 && p.x < 0.97 && p.y > 0.03 && p.y < 0.99), 'and keeps them on screen');
}

/* ================================================================== *
 *  3. Strokes
 *
 *  Run twice, once per mode. Both are real instruments people will play, so
 *  neither gets to be the one that only works in principle — and the detector
 *  underneath is shared, so a change made for one silently reaches the other.
 * ================================================================== */

const kit = new Kit();
const SPAN = 0.12;

/**
 * One stroke: the tip waits above the drum, comes down through it, and lifts
 * back. Heights are given as tip positions, which is what actually plays.
 */
const swing = (t, t0, { top, bottom, fall = 0.13, hold = 0.05, lift = 0.16 }) => {
  const u = t - t0;
  if (u <= 0) return top;
  if (u < fall) return lerp(top, bottom, (u / fall) ** 1.7);
  if (u < fall + hold) return bottom;
  return lerp(bottom, top, clamp((u - fall - hold) / lift, 0, 1));
};

function strokes(MODE) {
console.log(`\nstrokes — ${MODE === FINGER ? 'fingertip' : 'sticks'}`);

const OFF = tipOffset(MODE, SPAN);   // wrist → striking point, hand pointing down

/**
 * A hand posed for whichever mode is being exercised, placed so that its
 * *striking point* — not its wrist — lands on `wx, wy`. Every test below is
 * about where the thing that hits ends up, so that is what the fixture takes.
 * `curl: 0` means "not holding / not pointing".
 */
const hand = (id, o = {}) => {
  const { curl, wx = 0.5, wy = 0.4, ...rest } = o;
  const base = { ...rest, wx: wx - OFF.dx, wy: wy - OFF.dy };
  return MODE === STICK
    ? makeHand(id, { ...base, curl })
    : makeHand(id, { ...base, point: curl === 0 ? 0 : 1 });
};

/** Drive the detector at a fixed rate. `at(t)` returns hands for that instant. */
function run(secs, at, { fps = 60, opts, kit: k = kit } = {}) {
  const det = new StickDetector(opts);
  det.setMode(MODE);
  det.setKit(k);
  const hits = [];
  for (let i = 0; i < Math.round(secs * fps); i++) {
    const t = i / fps;
    const hs = at(t);
    hits.push(...det.update(hs ? (Array.isArray(hs) ? hs : [hs]) : [], t));
  }
  return { det, hits };
}

const snare = kit.byId('snare');
const above = snare.sy - snare.ry * 1.1, below = snare.sy + snare.ry * 1.1;
const one = (opts = {}) => (t) => hand('right', {
  wx: snare.x, wy: (swing(t, 0.35, { top: above, bottom: below, ...opts })), span: SPAN,
});

{
  const r = run(1.4, one());
  ok(r.hits.length === 1, 'one stroke, one hit', `(${r.hits.length})`);
  ok(r.hits[0]?.pad === 'snare', 'on the drum it went through', r.hits[0]?.pad || 'nothing');
  /* Timed to the crossing, not to the stop — the crossing here is a little way
   * into the fall, and the old detector would not have spoken until the stick
   * had finished braking a tenth of a second later. */
  ok(r.hits[0] && r.hits[0].t > 0.35 && r.hits[0].t < 0.35 + 0.13,
    'timed to the moment it went through the head, not to the stop',
    `t=${r.hits[0]?.t.toFixed(3)}`);
}
{
  /* Sub-frame placement. At twenty looks a second the samples straddling the
   * surface are fifty milliseconds apart, and taking the later one would put
   * every hit up to that far late, at random. Interpolating puts it back. */
  const slow = run(1.4, one(), { fps: 20 });
  const fast = run(1.4, one(), { fps: 120 });
  ok(slow.hits.length === 1 && fast.hits.length === 1, 'the stroke lands at either rate');
  if (slow.hits.length && fast.hits.length) {
    const err = Math.abs(slow.hits[0].t - fast.hits[0].t);
    ok(err < 0.012, 'and lands at the same *moment*, far inside one sample interval',
      `${(err * 1000).toFixed(1)} ms apart, samples 50 ms apart`);
  }
}
{
  const times = [0.35, 0.62, 0.89, 1.16, 1.43];
  const r = run(2.0, (t) => {
    let y = above;
    for (const t0 of times) if (t >= t0 && t < t0 + 0.27) y = swing(t, t0, { top: above, bottom: below, fall: 0.10, hold: 0.03, lift: 0.12 });
    return hand('right', { wx: snare.x, wy: (y), span: SPAN });
  });
  ok(r.hits.length === times.length, 'five strokes, five hits', `(${r.hits.length})`);
}
{
  const soft = run(1.4, one({ fall: 0.30 }));
  const hard = run(1.4, one({ fall: 0.07 }));
  ok(soft.hits.length === 1 && hard.hits.length === 1, 'both a soft and a hard stroke land',
    `${soft.hits.length}/${hard.hits.length}`);
  if (soft.hits.length && hard.hits.length) {
    ok(hard.hits[0].velocity > soft.hits[0].velocity + 0.2, 'hitting harder really is louder',
      `${soft.hits[0].velocity.toFixed(2)} → ${hard.hits[0].velocity.toFixed(2)}`);
  }
}
{
  const still = (y) => (t) => hand('right', { wx: snare.x, wy: (y), span: SPAN });
  const cases = [
    ['an open hand has put the stick down', (t) => hand('right', {
      wx: snare.x, wy: (swing(t, 0.35, { top: above, bottom: below })), span: SPAN, curl: 0 })],
    ['a hand held still above the drum, with tracker jitter', (t) =>
      hand('right', { wx: snare.x, wy: (above), span: SPAN, jitter: 0.03 })],
    ['a hand held still on the drum, with tracker jitter', (t) =>
      hand('right', { wx: snare.x, wy: (snare.y), span: SPAN, jitter: 0.03 })],
    ['moving the sticks sideways across the kit', (t) => hand('right', {
      wx: 0.25 + clamp((t - 0.3) / 0.7, 0, 1) * 0.5, wy: (snare.sy - 0.002), span: SPAN })],
    ['lowering the arm slowly', (t) => hand('right', {
      wx: snare.x, wy: (lerp(above, below, clamp((t - 0.3) / 1.3, 0, 1))), span: SPAN })],
  ];
  for (const [what, at] of cases) {
    let spurious = 0;
    for (let i = 0; i < 8; i++) spurious += run(1.8, at).hits.length;
    ok(spurious === 0, `${what} is silent`, spurious ? `(${spurious} spurious in 8 runs)` : '');
  }
}
{
  /* One long sweep down the whole frame passes through several drums' zones,
   * and must still be one gesture rather than a chord. Coming back up is what
   * reloads the stroke — which is how drumming works anyway. */
  const sweep = run(2.0, (t) => hand('right', {
    wx: 0.32, wy: (lerp(0.34, 0.95, clamp((t - 0.3) / 0.35, 0, 1))), span: SPAN,
  }));
  ok(sweep.hits.length === 1, 'one swing down the kit sounds one drum, not every drum on the way',
    `(${sweep.hits.length}: ${sweep.hits.map((h) => h.pad).join(' ') || 'none'})`);
}
{
  // Both hands, independently — the whole point of two sticks.
  const hh = kit.byId('hihat');
  const r = run(2.0, (t) => [
    hand('left', { wx: hh.x, wy: (swing(t, 0.35, { top: hh.sy - hh.ry * 1.1, bottom: hh.sy + hh.ry * 1.1 })), span: SPAN }),
    hand('right', { wx: snare.x, wy: (swing(t, 0.95, { top: above, bottom: below })), span: SPAN }),
  ]);
  const L = r.hits.filter((h) => h.id === 'left'), R = r.hits.filter((h) => h.id === 'right');
  ok(L.length === 1 && R.length === 1, 'each hand plays its own stroke', `L${L.length} R${R.length}`);
  ok(L[0]?.pad === 'hihat' && R[0]?.pad === 'snare', 'each on its own drum',
    `${L[0]?.pad} / ${R[0]?.pad}`);
  ok(R[0].t > L[0].t + 0.4, 'in the order they were played');
}
{
  // Where the tip goes through decides the drum, for every drum in the kit.
  for (const want of ['crash', 'hihat', 'snare', 'kick', 'tom', 'floor', 'ride']) {
    const pad = kit.byId(want);
    const r = run(1.4, (t) => hand('right', {
      wx: pad.x, span: SPAN,
      wy: (swing(t, 0.35, { top: pad.sy - pad.ry * 1.1, bottom: pad.sy + pad.ry * 1.1 })),
    }));
    ok(r.hits.length === 1 && r.hits[0].pad === want, `a stroke through the ${pad.label} sounds it`,
      `→ ${r.hits[0]?.pad || 'nothing'}`);
  }
}
{
  /* Across the head, which is the only expression left once every stroke
   * arrives from directly above: the middle of a cymbal is not its edge. */
  const hh = kit.byId('hihat');
  const across = (dx) => run(1.4, (t) => hand('right', {
    wx: hh.x + dx, span: SPAN,
    wy: (swing(t, 0.35, { top: hh.sy - hh.ry * 1.1, bottom: hh.sy + hh.ry * 1.1 })),
  })).hits[0];
  const mid = across(0), edge = across(hh.rx * 0.8);
  ok(mid && Math.abs(mid.ox) < 0.15, 'a stroke through the middle knows it was in the middle',
    mid ? mid.ox.toFixed(2) : 'nothing');
  ok(edge && edge.ox > 0.55, 'and one out at the edge knows that too — the open hat',
    edge ? edge.ox.toFixed(2) : 'nothing');
}
{
  /* Detection rate. Contact is caught on the frame it happens rather than
   * after the stroke finishes braking, so a slow tracker costs timing rather
   * than whole strokes — which is the trade this detector exists to make. */
  const times = [0.35, 0.75, 1.15, 1.55];
  const at = (t) => {
    let y = above;
    for (const t0 of times) if (t >= t0 && t < t0 + 0.34) y = swing(t, t0, { top: above, bottom: below, hold: 0.04, lift: 0.15 });
    return hand('right', { wx: snare.x, wy: (y), span: SPAN });
  };
  const rows = [];
  for (const fps of [60, 45, 30, 20, 15]) rows.push(`${fps}fps:${run(2.1, at, { fps }).hits.length}/4`);
  console.log('        caught per tracking rate — ' + rows.join('  '));
  ok(run(2.1, at, { fps: 60 }).hits.length === 4, 'all four at 60 detections/s');
  ok(run(2.1, at, { fps: 30 }).hits.length === 4, 'all four at 30 detections/s');
  ok(run(2.1, at, { fps: 15 }).hits.length >= 3, 'most at 15 detections/s');
}
{
  /* The pair of numbers that decides whether this feels good, printed rather
   * than asserted because a margin is only meaningful as a pair: loosening the
   * detector until the gentlest stroke registers is easy, and doing it without
   * a resting hand playing by itself is the actual problem. */
  const stillness = (jit) => {
    let n = 0;
    for (let k = 0; k < 8; k++) {
      n += run(1.8, () => hand('right', { wx: snare.x, wy: (snare.y), span: SPAN, jitter: jit })).hits.length;
    }
    return n;
  };
  const gentle = (fall) => {
    let n = 0;
    for (let k = 0; k < 8; k++) n += run(1.4, (t) => hand('right', {
      wx: snare.x, span: SPAN, jitter: 0.015,
      wy: (swing(t, 0.35, { top: above, bottom: below, fall })),
    })).hits.length;
    return n;
  };
  console.log('        a hand resting on a drum, per tracker jitter - '
    + [0.02, 0.03, 0.04, 0.06].map((j) => `${(j * 100).toFixed(0)}%:${stillness(j)}`).join('  ') + ' spurious');
  console.log('        slowest stroke still caught              - '
    + [0.2, 0.35, 0.5, 0.8].map((f) => `${f}s:${gentle(f)}/8`).join('  '));
  ok(stillness(0.03) === 0, 'realistic tracker jitter never plays a drum by itself');
  const small = gentle(0.5);
  ok(small >= 7, 'and an unhurried, half-second stroke still plays', `${small}/8`);
}
}

strokes(FINGER);
strokes(STICK);

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
