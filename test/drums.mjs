/**
 * Headless checks for Air Drums: stick geometry, the kit's hit testing, and
 * stroke detection driven by synthetic wrist flicks.
 *
 * The point of the synthetic hands here is that a drum stroke is a *rotation* —
 * the wrist barely travels and the tip swings — so the hands are built by
 * rotating about the wrist rather than by sliding a point around. That is what
 * makes these tests say anything about the real gesture.
 *
 * Run: node test/drums.mjs
 */
import { stickOf, pointOf, Pointing, LENGTH } from '../src/drums/stick.js';
import { Kit, PADS } from '../src/drums/kit.js';
import { StickDetector, DEFAULTS } from '../src/drums/onset.js';

let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ================================================================== *
 *  Synthetic hand: a wrist at a point, rotated by `angle`.
 * ================================================================== */
const KN = [5, 9, 13, 17], TIPS = [8, 12, 16, 20];
/**
 * A hand at `wx, wy` whose palm points along `angle`.
 *
 * `point` is the gesture dial: 1 is a clean point (index out, the rest in), 0
 * is a relaxed hand with everything half-curled. The index finger is what the
 * stick is drawn along, so it gets its own reach and the others share one.
 */
function makeHand(id, { wx = 0.5, wy = 0.7, span = 0.12, angle = -Math.PI / 2, point = 1, jitter = 0 } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
  const ux = Math.cos(angle), uy = Math.sin(angle);          // wrist → knuckles
  const px = -uy, py = ux;                                   // across the palm
  const j = () => (jitter ? (Math.random() - 0.5) * 2 * jitter * span : 0);
  lm[0] = { x: wx, y: wy };
  const spread = [-0.34, -0.11, 0.11, 0.34];
  KN.forEach((k, i) => {
    lm[k] = { x: wx + ux * span + px * spread[i] * span + j(),
              y: wy + uy * span + py * spread[i] * span + j() };
  });
  const p = clamp(point, 0, 1);
  const indexReach = 0.42 + 0.54 * p;      // out when pointing
  const otherReach = 0.92 - 0.52 * p;      // …and in
  TIPS.forEach((tp, i) => {
    const reach = i === 0 ? indexReach : otherReach;
    lm[tp] = { x: lm[KN[i]].x + ux * span * reach + j(),
               y: lm[KN[i]].y + uy * span * reach + j() };
  });
  return { id, lm };
}

/* ================================================================== *
 *  1. The stick
 * ================================================================== */
console.log('\nstick');
{
  const h = makeHand('right', { wx: 0.5, wy: 0.8, span: 0.12, angle: -Math.PI / 2 });
  const s = stickOf(h.lm);
  ok(!!s, 'a stick can be placed on a hand');
  ok(Math.abs(s.span - 0.12) < 0.12 * 0.03, 'the palm span is measured off the hand', s.span.toFixed(4));
  ok(s.axis.y < -0.99, 'it points the way the finger points', `axis ${s.axis.x.toFixed(2)}, ${s.axis.y.toFixed(2)}`);
  ok(s.tip.y < s.grip.y && s.grip.y < s.butt.y, 'butt behind the hand, tip out in front');
  const reach = Math.hypot(s.tip.x - s.grip.x, s.tip.y - s.grip.y) / s.span;
  ok(Math.abs(reach - LENGTH) < 1e-6, 'the tip sits a fixed reach past the knuckle', reach.toFixed(2));

  /* The whole point of drawing it on the finger: the shaft must pass *through*
   * the finger, or it reads as a separate object floating near the hand. */
  const off = (pt) => {
    const dx = pt.x - s.grip.x, dy = pt.y - s.grip.y;
    return Math.abs(dx * -s.axis.y + dy * s.axis.x) / s.span;   // ⟂ distance, in spans
  };
  ok(off(h.lm[5]) < 1e-9 && off(h.lm[8]) < 1e-9,
    'the shaft runs exactly through the index knuckle and fingertip',
    `${off(h.lm[8]).toExponential(1)} spans off`);
  const fingertip = Math.hypot(h.lm[8].x - h.lm[5].x, h.lm[8].y - h.lm[5].y) / s.span;
  ok(reach > fingertip * 1.4, 'and carries on well past the fingertip',
    `finger ${fingertip.toFixed(2)} → stick ${reach.toFixed(2)} spans`);

  /* The lever is the entire reason for playing with a stick: rotating the wrist
   * moves the hand hardly at all and the tip a great deal. */
  const a = stickOf(makeHand('r', { angle: -Math.PI / 2 }).lm);
  const b = stickOf(makeHand('r', { angle: -Math.PI / 2 + 0.5 }).lm);
  const knuckleMove = Math.hypot(b.grip.x - a.grip.x, b.grip.y - a.grip.y);
  const tipMove = Math.hypot(b.tip.x - a.tip.x, b.tip.y - a.tip.y);
  ok(tipMove > knuckleMove * 2.5, 'a wrist flick swings the tip far further than the hand',
    `tip ${(tipMove / a.span).toFixed(2)} vs knuckles ${(knuckleMove / a.span).toFixed(2)} spans`);
}
{
  ok(pointOf(makeHand('r', { point: 1 }).lm) > 0.8, 'a pointing hand is holding a stick');
  ok(pointOf(makeHand('r', { point: 0 }).lm) < 0.15, 'a relaxed hand is not');
  // A flat open hand is the one that must not arm: waving would play drums.
  const flat = makeHand('r', { point: 0 });
  for (const t of TIPS) {
    const k = KN[TIPS.indexOf(t)];
    flat.lm[t] = { x: k === 5 ? flat.lm[k].x : flat.lm[k].x, y: flat.lm[k].y - 0.12 * 0.95 };
  }
  ok(pointOf(flat.lm) < 0.15, 'and neither is a flat open hand', pointOf(flat.lm).toFixed(2));

  const g = new Pointing();
  ok(!g.update(0.4), 'a half-made point does not pick the stick up');
  ok(g.update(0.7) && g.update(0.4), 'once pointing, it takes a real relax to let go');
  ok(!g.update(0.15), 'and relaxing properly does let go');
}

/* ================================================================== *
 *  2. The kit
 * ================================================================== */
console.log('\nkit');
{
  const kit = new Kit();
  const pads = kit.pads();
  ok(pads.length === PADS.length && pads.length === 7, 'seven pads', `(${pads.length})`);
  for (const p of pads) ok(!!kit.hitAt({ x: p.x, y: p.y }) && kit.hitAt({ x: p.x, y: p.y }).id === p.id,
    `${p.label} answers to a hit on its own centre`);
  ok(kit.hitAt({ x: 0.5, y: 0.03 }) === null, 'a stroke above the kit hits nothing');
  // Mirrored for a left-handed setup: the hi-hat swaps sides.
  const left = new Kit({ lefty: true }).pads().find((p) => p.id === 'hihat');
  const right = pads.find((p) => p.id === 'hihat');
  ok(left.x > 0.5 && right.x < 0.5, 'the kit mirrors for a left-hander',
    `${right.x.toFixed(2)} → ${left.x.toFixed(2)}`);
  // Scaling keeps the kit reachable rather than dragging it into a corner.
  const small = new Kit({ scale: 0.7 }).pads();
  const spread = (ps) => Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x));
  ok(spread(small) < spread(pads) * 0.8, 'scaling down pulls the pads together',
    `${spread(pads).toFixed(2)} → ${spread(small).toFixed(2)}`);
  ok(small.every((p) => p.x > 0.03 && p.x < 0.97 && p.y > 0.03 && p.y < 0.99), 'and keeps them on screen');
}

/* ================================================================== *
 *  3. Strokes
 * ================================================================== */
console.log('\nstrokes');

/** Angle over time for one stroke: swing down fast, then brake, rest, lift. */
const stroke = (t, t0, { swing = 0.85, dur = 0.10, brake = 0.05, rest = 0.06, lift = 0.16 } = {}) => {
  const u = t - t0;
  if (u <= 0) return 0;
  if (u < dur) return swing * (u / dur) ** 2 * 0.75;        // accelerating
  const b = Math.min(u - dur, brake);
  const p = swing * 0.75 + swing * 0.25 * (b / brake) * (2 - b / brake);
  if (u < dur + brake) return p;
  const after = u - dur - brake;
  return after < rest ? swing : swing * (1 - clamp((after - rest) / lift, 0, 1));
};

/** Drive the detector at a fixed rate. `at(t)` returns hands for that instant. */
function run(secs, at, { fps = 60, opts } = {}) {
  const det = new StickDetector(opts);
  const hits = [];
  for (let i = 0; i < Math.round(secs * fps); i++) {
    const t = i / fps;
    const hs = at(t);
    hits.push(...det.update(hs ? (Array.isArray(hs) ? hs : [hs]) : [], t));
  }
  return { det, hits };
}
/* A drummer rests with the stick tip *pointing down at the kit*, not straight
 * up, and the stroke rotates it further down. That matters: starting vertical
 * and rotating swings the tip mostly sideways, which projects to almost no
 * downward travel — the gesture would be real and the detector would be right
 * to ignore it. `REST` is roughly a stick held out and angled at the drum. */
const REST = 0.55;
const arm = (angle, extra = {}) => (t) =>
  makeHand('right', { wx: 0.5, wy: 0.42, angle: REST + angle(t), ...extra });

{
  const r = run(1.4, arm((t) => stroke(t, 0.35)));
  ok(r.hits.length === 1, 'one stroke, one hit', `(${r.hits.length})`);
  ok(r.hits[0] && Math.abs(r.hits[0].t - 0.50) < 0.08, 'timed to the stop, not the swing',
    `t=${r.hits[0]?.t.toFixed(3)}`);
}
{
  const times = [0.35, 0.70, 1.05, 1.40, 1.75];
  const r = run(2.4, arm((t) => times.reduce((s, t0) => s + stroke(t, t0, { rest: 0.03, lift: 0.10 }), 0)));
  ok(r.hits.length === times.length, 'five strokes, five hits', `(${r.hits.length})`);
}
{
  const soft = run(1.4, arm((t) => stroke(t, 0.35, { swing: 0.40, dur: 0.16 })));
  const hard = run(1.4, arm((t) => stroke(t, 0.35, { swing: 0.95, dur: 0.07 })));
  ok(soft.hits.length === 1 && hard.hits.length === 1, 'both a soft and a hard stroke land',
    `${soft.hits.length}/${hard.hits.length}`);
  if (soft.hits.length && hard.hits.length) {
    ok(hard.hits[0].velocity > soft.hits[0].velocity + 0.2, 'hitting harder really is louder',
      `${soft.hits[0].velocity.toFixed(2)} → ${hard.hits[0].velocity.toFixed(2)}`);
  }
}
{
  const cases = [
    ['a relaxed hand has put the stick down', arm((t) => stroke(t, 0.35), { point: 0 })],
    /* Raised and held. A raise that snapped straight back down would fire, and
     * rightly so — coming down fast and stopping dead is a drum stroke however
     * you got up there. */
    ['raising the stick', arm((t) => -0.7 * clamp((t - 0.35) / 0.12, 0, 1))],
    ['a hand held still with tracker jitter', arm(() => 0, { jitter: 0.03 })],
    ['moving the arm across the kit', (t) =>
      makeHand('right', { wx: 0.25 + clamp((t - 0.3) / 0.7, 0, 1) * 0.5, wy: 0.42, angle: REST })],
    ['lowering the arm slowly', arm((t) => 0.85 * clamp((t - 0.3) / 1.1, 0, 1))],
  ];
  for (const [what, at] of cases) {
    /* Repeated, because the jitter case is random and one clean run proves
     * nothing about it. The lever multiplies tracker noise exactly as much as
     * it multiplies the gesture, so a still hand really can play a drum if the
     * smoothing is not doing its job — and it will do so once in five runs,
     * which is precisely the kind of bug a single pass waves through. */
    let spurious = 0;
    for (let i = 0; i < 8; i++) spurious += run(1.8, at).hits.length;
    ok(spurious === 0, `${what} is silent`, spurious ? `(${spurious} spurious in 8 runs)` : '');
  }
}
{
  /* A stick that hits and is then simply held still must not be dead. Requiring
   * the lift and nothing else means one unseen recovery — an occluded hand, a
   * dropped frame, a gentle drift back up — takes that hand out of service for
   * good, which is a far worse failure than an extra hit. */
  const held = run(3.2, arm((t) => (t < 1.4 ? stroke(t, 0.35, { rest: 9, lift: 0.01 }) : 0.85 + stroke(t - 1.4, 0.35))));
  ok(held.hits.length === 2, 'a stick that stays down can still play again',
    `(${held.hits.length}) — without the re-arm timeout this hand would be dead`);
}
{
  // Both hands, independently — the whole point of two sticks.
  const r = run(2.0, (t) => [
    makeHand('left', { wx: 0.3, wy: 0.42, angle: REST + stroke(t, 0.35) }),
    makeHand('right', { wx: 0.7, wy: 0.42, angle: REST + stroke(t, 0.95) }),
  ]);
  const L = r.hits.filter((h) => h.id === 'left'), R = r.hits.filter((h) => h.id === 'right');
  ok(L.length === 1 && R.length === 1, 'each hand plays its own stroke', `L${L.length} R${R.length}`);
  ok(R[0].t > L[0].t + 0.4, 'in the order they were played');
}
{
  /* Where the *tip* lands decides the drum, so place the wrist such that the
   * tip arrives on the snare at the end of the swing. */
  const kit = new Kit();
  for (const want of ['snare', 'hihat', 'floor']) {
    const pad = kit.pads().find((p) => p.id === want);
    const span = 0.11, swing = 0.85, reach = 3 * span;   // wrist → tip
    const end = REST + swing;
    const wx = pad.x - Math.cos(end) * reach, wy = pad.y - Math.sin(end) * reach;
    const r = run(1.4, (t) => makeHand('right', { wx, wy, span, angle: REST + stroke(t, 0.35, { swing }) }));
    const landed = r.hits[0] ? kit.hitAt(r.hits[0])?.id : null;
    ok(r.hits.length === 1 && landed === want, `a stroke aimed at the ${pad.label} lands on it`,
      `→ ${landed || 'nothing'}`);
  }
}
{
  /* The two numbers that decide whether this instrument feels good, printed
   * rather than asserted because they are a *margin*, and a margin is only
   * meaningful as a pair. Loosening the detector until a gentle flick registers
   * is easy; doing it without a still hand starting to play by itself is the
   * actual problem, since the lever multiplies tracker noise by exactly as much
   * as it multiplies the gesture. */
  const still = (jit) => {
    let n = 0;
    for (let k = 0; k < 8; k++) n += run(1.8, arm(() => 0, { jitter: jit })).hits.length;
    return n;
  };
  const gentle = (swing) => {
    let n = 0;
    for (let k = 0; k < 8; k++) n += run(1.4, arm((t) => stroke(t, 0.35, { swing, dur: 0.16 }), { jitter: 0.015 })).hits.length;
    return n;
  };
  console.log('        a still hand, per tracker jitter - '
    + [0.02, 0.03, 0.04, 0.06].map((j) => `${(j * 100).toFixed(0)}%:${still(j)}`).join('  ') + ' spurious');
  console.log('        smallest flick still caught     - '
    + [0.5, 0.35, 0.25, 0.18].map((w) => `${w}rad:${gentle(w)}/8`).join('  '));
  ok(still(0.03) === 0, 'realistic tracker jitter never plays a drum by itself');
  const small = gentle(0.25);
  ok(small >= 7, 'a small wrist flick is enough to play', `${small}/8`);
}
{
  // Detection rate: reported rather than demanded at the bottom, because it is
  // a property of the tracker rather than of anything tunable here.
  const at = arm((t) => [0.35, 0.75, 1.15, 1.55].reduce((s, t0) =>
    s + stroke(t, t0, { rest: 0.04, lift: 0.12 }), 0));
  const rows = [];
  for (const fps of [60, 45, 30, 20, 15]) rows.push(`${fps}fps:${run(2.1, at, { fps }).hits.length}/4`);
  console.log('        caught per tracking rate — ' + rows.join('  '));
  ok(run(2.1, at, { fps: 60 }).hits.length === 4, 'all four at 60 detections/s');
  ok(run(2.1, at, { fps: 30 }).hits.length === 4, 'all four at 30 detections/s');
  ok(run(2.1, at, { fps: 20 }).hits.length >= 3, 'most at 20 detections/s');
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
