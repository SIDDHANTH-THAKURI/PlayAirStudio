/**
 * Headless checks for Air Piano's logic-heavy parts: the calibration
 * homography, the scale layout, and — mostly — the tap detector.
 *
 * The detector is driven with synthetic fingertip trajectories whose shape is
 * chosen to be the thing being asserted: a strike accelerates then stops dead,
 * a placement eases in and out, a hover only jitters. That is what makes these
 * tests worth anything — each one is a *different physical gesture*, not the
 * same gesture at different thresholds.
 *
 * Run: node test/piano.mjs
 */
import { solveHomography, applyH, quadIsSane, TablePlane, defaultQuad } from '../src/piano/geometry.js';
import { TapDetector, DEFAULTS, SURFACES, TIPS } from '../src/piano/onset.js';
import { SCALES, degreeToSemitone, midiName, Keyboard } from '../src/piano/scales.js';

let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ================================================================== *
 *  1. Calibration geometry
 * ================================================================== */
console.log('\ncalibration');
{
  // A believable oblique view: far edge narrow, near edge wide, slightly askew.
  const quad = [{ x: 0.34, y: 0.36 }, { x: 0.71, y: 0.38 }, { x: 0.95, y: 0.86 }, { x: 0.05, y: 0.83 }];
  const P = new TablePlane(quad);
  ok(P.ok, 'an oblique desk quad calibrates');

  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let worst = 0;
  corners.forEach(([u, v], i) => {
    const t = P.toTable(quad[i]);
    worst = Math.max(worst, Math.hypot(t.x - u, t.y - v));
  });
  ok(worst < 1e-9, 'the four corners land exactly on the unit square', `worst ${worst.toExponential(1)}`);

  // Round-tripping is the real test: it exercises both directions and would
  // catch a transposed or inverted matrix that still happened to fit corners.
  let rt = 0;
  for (let i = 0; i < 200; i++) {
    const u = Math.random(), v = Math.random();
    const img = P.toImage(u, v), back = P.toTable(img);
    rt = Math.max(rt, Math.hypot(back.x - u, back.y - v));
  }
  ok(rt < 1e-9, 'image ⇄ table round-trips', `worst ${rt.toExponential(1)}`);

  /* The point of using a homography rather than a simple stretch: under
   * perspective the *centre* of the surface is not the average of the corners.
   * An affine fit would put it there and every key would sit wrong the further
   * up the desk you played. */
  const mid = P.toImage(0.5, 0.5);
  const avg = { x: quad.reduce((s, p) => s + p.x, 0) / 4, y: quad.reduce((s, p) => s + p.y, 0) / 4 };
  ok(Math.hypot(mid.x - avg.x, mid.y - avg.y) > 0.012,
    'perspective is modelled — surface centre ≠ corner average',
    `Δ ${Math.hypot(mid.x - avg.x, mid.y - avg.y).toFixed(3)}`);

  // Far edge is narrower in the image, so a fixed step in u must cover fewer
  // pixels there than near — the property that keeps key widths honest.
  const farW = Math.hypot(P.toImage(1, 0).x - P.toImage(0, 0).x, P.toImage(1, 0).y - P.toImage(0, 0).y);
  const nearW = Math.hypot(P.toImage(1, 1).x - P.toImage(0, 1).x, P.toImage(1, 1).y - P.toImage(0, 1).y);
  ok(farW < nearW * 0.75, 'the far edge really is compressed', `${farW.toFixed(2)} vs ${nearW.toFixed(2)}`);

  ok(P.contains(P.toTable(P.toImage(0.5, 0.5))), 'a point on the desk is on the desk');
  ok(!P.contains({ x: 1.4, y: 0.5 }), 'a point well past the edge is not');

  // Malformed input must be refused rather than silently producing a folded
  // coordinate space — corners entered out of order is the likely user error.
  ok(!quadIsSane([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }]), 'a bow-tie quad is rejected');
  ok(!quadIsSane([{ x: 0, y: 0 }, { x: 0.02, y: 0 }, { x: 0.02, y: 0.02 }, { x: 0, y: 0.02 }]), 'a sliver is rejected');
  // Three corners stacked on a line: solvable-looking, geometrically useless.
  ok(!new TablePlane([{ x: 0.2, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }, { x: 0.5, y: 0.9 }]).ok,
    'a collinear quad reports not-ok rather than throwing');
  ok(quadIsSane(defaultQuad()) && new TablePlane(defaultQuad()).ok, 'the uncalibrated default is usable');
  ok(solveHomography([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], TablePlane.UNIT) === null,
    'four identical points cannot make a homography');
}

/* ---- why calibration is done by tapping, not clicking ----
 * A homography maps exactly ONE plane. Clicking the corners fits it to the
 * desk (z = 0), but every point it is later asked about is a *fingertip
 * landmark*, which sits a centimetre or two above the desk even when the pad
 * is touching. Those are different planes, and the gap between them is pure
 * parallax — worst with a low camera looking a long way across the desk,
 * which is exactly a laptop lid.
 *
 * Tapping the corners fits the homography to the plane the fingertips
 * actually occupy, so the same error is present in the calibration and in
 * every lookup, and cancels. This is not a fudge: it is the same plane, so it
 * cancels exactly. Modelled here with a real pinhole camera so the claim is
 * measured rather than asserted. */
{
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const nrm = (v) => { const m = Math.hypot(...v); return [v[0] / m, v[1] / m, v[2] / m]; };
  const camera = (eye, look, f = 1.15) => {
    const fwd = nrm(sub(look, eye)), right = nrm(cr(fwd, [0, 0, 1])), up = cr(right, fwd);
    return (Q) => {
      const d = sub(Q, eye), z = dot(d, fwd);
      return z <= 1e-6 ? null
        : { x: 0.5 + (dot(d, right) / z) * f * 0.5, y: 0.5 - (dot(d, up) / z) * f * 0.5 };
    };
  };
  // A 30 cm square of desk, 15 cm in front of the player.
  const X0 = -0.15, X1 = 0.15, Y0 = 0.15, Y1 = 0.45;
  const cornersAt = (h) => [[X0, Y1, h], [X1, Y1, h], [X1, Y0, h], [X0, Y0, h]];

  const rows = [];
  let worstClick = 0, worstTap = 0;
  for (const [label, eye] of [['low lid', [0, -0.10, 0.15]], ['lid', [0, -0.10, 0.25]],
                              ['high', [0, -0.05, 0.45]], ['overhead', [0, 0.28, 0.60]]]) {
    const project = camera(eye, [0, 0.30, 0]);
    const h = 0.015;                                   // fingertip landmark height
    const clicked = new TablePlane(cornersAt(0).map(project));
    const tapped = new TablePlane(cornersAt(h).map(project));
    let ce = 0, te = 0;
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
      const x = X0 + ((X1 - X0) * (i + 0.5)) / 7, y = Y0 + ((Y1 - Y0) * (j + 0.5)) / 7;
      const img = project([x, y, h]);                  // where the fingertip really is
      const want = { x: (x - X0) / (X1 - X0), y: (Y1 - y) / (Y1 - Y0) };
      const c = clicked.toTable(img), t = tapped.toTable(img);
      ce = Math.max(ce, Math.hypot(c.x - want.x, c.y - want.y));
      te = Math.max(te, Math.hypot(t.x - want.x, t.y - want.y));
    }
    worstClick = Math.max(worstClick, ce); worstTap = Math.max(worstTap, te);
    rows.push(`${label} click ${ce.toFixed(3)} / tap ${te.toExponential(0)}`);
  }
  console.log('        worst table-space error — ' + rows.join('  '));
  ok(worstClick > 0.10, 'clicking the desk corners misplaces taps by whole keys',
    `worst ${worstClick.toFixed(3)} of the surface`);
  ok(worstTap < 1e-9, 'tapping the corners cancels it exactly, on every camera rig',
    `worst ${worstTap.toExponential(1)}`);
}

/* ================================================================== *
 *  2. Musical layout
 * ================================================================== */
console.log('\nlayout');
{
  ok(JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7].map((d) => degreeToSemitone('major', d))) === '[0,2,4,5,7,9,11,12]',
    'major degrees run up and wrap into the next octave');
  ok(degreeToSemitone('major', -1) === -1 && degreeToSemitone('major', -7) === -12,
    'degrees below zero walk downward', `${degreeToSemitone('major', -1)}, ${degreeToSemitone('major', -7)}`);
  ok(SCALES.chromatic.steps.length === 12 && degreeToSemitone('chromatic', 12) === 12, 'chromatic is available intact');
  ok(midiName(60) === 'C4' && midiName(69) === 'A4', 'note names', `${midiName(60)}, ${midiName(69)}`);

  const kb = new Keyboard({ key: 0, scale: 'major', cols: 8, rows: 2, octave: 4 });
  ok(kb.midiAt({ col: 0, row: 0 }) === 60, 'bottom-left is middle C', String(kb.midiAt({ col: 0, row: 0 })));
  ok(kb.midiAt({ col: 7, row: 0 }) === 72, 'eight columns spans an octave');
  ok(kb.midiAt({ col: 0, row: 1 }) === 72, 'the far row is an octave up');
  ok(kb.midiAt({ col: 0, row: 0 }, -1) === 48, 'a hand offset moves a whole hand by octaves');

  // v is 0 at the far edge and 1 near the player, so near ⇒ row 0.
  ok(kb.cellAt({ x: 0.01, y: 0.99 }).col === 0 && kb.cellAt({ x: 0.01, y: 0.99 }).row === 0, 'near-left is the lowest key');
  ok(kb.cellAt({ x: 0.99, y: 0.01 }).col === 7 && kb.cellAt({ x: 0.99, y: 0.01 }).row === 1, 'far-right is the highest');
  ok(kb.cellAt({ x: 1.5, y: 0.5 }) === null, 'a tap off the surface has no key');
  ok(kb.cellAt({ x: 1.03, y: 0.5 })?.col === 7, 'a tap just past the edge still lands on the edge key');
  ok(kb.layout().length === 16 && kb.layout()[0].name === 'C4', 'the full layout is emitted for drawing');
}

/* ================================================================== *
 *  3. Tap detection
 * ================================================================== */
console.log('\ntap detection');

/* --- synthetic hand ------------------------------------------------
 * Only the landmarks the detector reads are meaningful: the wrist and middle
 * knuckle (which set the palm span it measures everything in), each finger's
 * knuckle, and the five fingertips. `depths` is how far each fingertip has
 * travelled along the strike axis, in palm spans — that is the quantity every
 * gesture below is written in terms of. */
const MCPS = [2, 5, 9, 13, 17];
function makeHand(id, { cx = 0.5, cy = 0.62, span = 0.13, depths = [0, 0, 0, 0, 0],
  hand = 0, dir = { x: 0, y: 1 }, extend = 0.8, jitter = 0, rigid = false, rng = Math.random } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
  const jit = () => (jitter ? (rng() - 0.5) * 2 * jitter * span : 0);
  const spread = [-0.55, -0.28, 0, 0.26, 0.5];
  // `rigid` translates the entire hand — wrist and knuckles included — so the
  // fingers never straighten. That is what a fist or a whole arm dropping
  // actually looks like, and keeping the wrist moving too holds the palm span
  // (and therefore the detector's ruler) constant throughout.
  // `hand` dips the entire hand — wrist, knuckles and all — and `depths` then
  // adds per-finger reach on top. That separation is the whole point of the
  // arbitration tests: a passenger finger has hand motion and no reach of its
  // own, while the finger that struck has both.
  const shift = rigid ? depths[0] : hand;
  for (let f = 0; f < 5; f++) {
    const mx = cx + spread[f] * span * 0.9 + dir.x * shift * span;
    // The middle knuckle sits exactly one span from the wrist so the detector's
    // ruler is precisely `span` and the thresholds mean what they say.
    const my = (f === 2 ? cy - span : cy - span * 0.9) + dir.y * shift * span;
    lm[MCPS[f]] = { x: mx, y: my };
    const d = rigid ? 0 : depths[f];
    lm[TIPS[f]] = {
      x: mx + dir.x * d * span + jit(),
      y: my + span * extend + dir.y * d * span + jit(),
    };
  }
  lm[0] = { x: cx + dir.x * shift * span, y: cy + dir.y * shift * span };
  return { id, lm };
}

/* --- gesture profiles ---------------------------------------------- */
/** A strike: speed climbing all the way in, then the desk stops it dead. */
const strike = (t, t0, dur, depth) => {
  if (t <= t0) return 0;
  const u = (t - t0) / dur;
  return u >= 1 ? depth : depth * u * u;
};
/** A placement: eases in *and* out. Same distance, no discontinuity. */
const glide = (t, t0, dur, depth) => {
  const u = clamp((t - t0) / dur, 0, 1);
  return depth * u * u * (3 - 2 * u);
};
/** Strike, rest, then lift away — the full cycle of one played note. */
const tapCycle = (t, t0, { dur = 0.09, depth = 0.34, rest = 0.10, lift = 0.12 } = {}) => {
  const down = strike(t, t0, dur, depth);
  const upStart = t0 + dur + rest;
  if (t <= upStart) return down;
  return depth * (1 - clamp((t - upStart) / lift, 0, 1));
};

/** Drive the detector at a fixed rate. `at(t)` returns hands for that instant. */
function run(secs, at, { fps = 60, opts, fingers } = {}) {
  const det = new TapDetector(opts);
  if (fingers) det.setFingers(fingers);
  const events = [];
  const n = Math.round(secs * fps);
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const hs = at(t);
    events.push(...det.update(hs ? (Array.isArray(hs) ? hs : [hs]) : [], t));
  }
  return { det, events };
}
const oneHand = (fn) => (t) => makeHand('right', fn(t));

/* --- the gesture that must fire ------------------------------------ */
{
  const r = run(1.2, oneHand((t) => ({ depths: [0, tapCycle(t, 0.35), 0, 0, 0] })));
  const e = r.events;
  ok(e.length === 1, 'one tap fires exactly one note', `(${e.length})`);
  ok(e[0]?.finger === 1, 'on the finger that actually moved', `finger ${e[0]?.finger}`);
  // The note must sound when the finger *arrives*, not when it set off.
  ok(e[0] && Math.abs(e[0].t - (0.35 + 0.09)) < 0.06,
    'timed to the arrival, not the departure', `t=${e[0]?.t.toFixed(3)} vs ${(0.44).toFixed(3)}`);
}

/* --- the gestures that must not -------------------------------------
 * Each of these travels a comparable distance to a real tap. What separates
 * them is only ever the *shape* of the motion, which is the point. */
{
  const cases = [
    ['a hand gliding down and settling', oneHand((t) => ({ depths: [0, glide(t, 0.3, 0.45, 0.8), 0, 0, 0] }))],
    ['a slow deliberate hover-down', oneHand((t) => ({ depths: [0, glide(t, 0.3, 1.1, 0.6), 0, 0, 0] }))],
    ['a finger lifting away', oneHand((t) => ({ depths: [0, 0.4 - glide(t, 0.3, 0.15, 0.4), 0, 0, 0] }))],
    ['a hand resting still, with tracker jitter', oneHand(() => ({ depths: [0, 0, 0, 0, 0], jitter: 0.02 }))],
    ['a sideways sweep across the desk', (t) => makeHand('right', { cx: 0.3 + clamp((t - 0.3) / 0.4, 0, 1) * 0.4 })],
    ['a curled fist dropping', oneHand((t) => ({ depths: new Array(5).fill(tapCycle(t, 0.35)), extend: 0.15, rigid: true }))],
  ];
  for (const [what, at] of cases) {
    const r = run(1.6, at);
    ok(r.events.length === 0, `${what} is silent`, r.events.length ? `(${r.events.length} spurious)` : '');
  }
}

/* --- tracking glitches ---------------------------------------------
 * MediaPipe re-acquiring a hand after an occlusion teleports it. That is not
 * a gesture, and it lands exactly when someone is reaching to play. */
{
  const r = run(2.0, (t) => makeHand('right', { cx: t > 1.0 ? 0.78 : 0.22, cy: t > 1.0 ? 0.40 : 0.72 }));
  ok(r.events.length === 0, 'a hand teleporting across the frame fires nothing', `(${r.events.length})`);
}
{
  // …and the finger must still work immediately afterwards.
  const r = run(2.6, oneHand((t) => ({
    cx: t > 0.8 ? 0.75 : 0.25,
    depths: [0, tapCycle(t, 1.4), 0, 0, 0],
  })));
  ok(r.events.length === 1, 'and a real tap right after one still plays', `(${r.events.length})`);
}

/* --- one finger struck; the others merely came along -----------------
 * Tapping one finger dips the whole hand, and the hand is then arrested by the
 * finger that landed — so every finger shows the same accelerate-then-stop and
 * a naive per-finger detector plays a five-note cluster. This is the fault a
 * player hits within seconds of picking the instrument up. */
{
  const dip = (t) => tapCycle(t, 0.35, { dur: 0.10, depth: 0.20 });
  const reach = (t) => tapCycle(t, 0.35, { dur: 0.10, depth: 0.30 });
  const r = run(2.0, oneHand((t) => ({ hand: dip(t), depths: [0, reach(t), 0, 0, 0] })));
  ok(r.events.length === 1, 'a one-finger tap plays one note, not a cluster',
    `(${r.events.length}: fingers ${r.events.map((e) => e.finger)})`);
  ok(r.events[0]?.finger === 1, 'and it is the finger that actually reached');
}
{
  // …while fingers that genuinely reach together are still a chord.
  const dip = (t) => tapCycle(t, 0.35, { dur: 0.10, depth: 0.20 });
  const reach = (t) => tapCycle(t, 0.35, { dur: 0.10, depth: 0.30 });
  const r = run(2.0, oneHand((t) => ({ hand: dip(t), depths: [0, reach(t), reach(t), 0, 0] })));
  ok(r.events.length === 2, 'two fingers reaching together is still a chord',
    `(${r.events.length}: fingers ${r.events.map((e) => e.finger)})`);
}
{
  /* A whole hand put down flat has no articulation anywhere, so nothing fires.
   * That is deliberate: resting your hands on the desk between phrases is the
   * normal thing to do, and it must be silent. */
  const r = run(2.0, oneHand((t) => ({ hand: tapCycle(t, 0.35, { dur: 0.10, depth: 0.34 }) })));
  ok(r.events.length === 0, 'a whole hand put down flat is silent', `(${r.events.length})`);
}
{
  // A passenger must not be able to fire even when it moves a fair amount, as
  // long as it moved no more than the hand it was riding.
  const dip = (t) => tapCycle(t, 0.35, { dur: 0.09, depth: 0.42 });
  const r = run(2.0, oneHand((t) => ({ hand: dip(t), depths: [0, (x) => 0, 0, 0, 0].map(() => 0) })));
  ok(r.events.length === 0, 'a big hand dip alone still plays nothing', `(${r.events.length})`);
}

/* --- one finger per hand --------------------------------------------
 * Arbitration gets the passenger question right most of the time, and "most"
 * is what this setting is for: a stray note is worse than a missing one, and
 * restricting the hand to one finger removes the question instead of answering
 * it better. */
{
  const tap = (t) => tapCycle(t, 0.35, { dur: 0.09, depth: 0.34 });
  const both = (t) => ({ depths: [0, tap(t), tap(t), 0, 0] });

  const all = run(2.0, oneHand(both));
  ok(all.events.length === 2, 'with all fingers, two deliberate fingers are a chord',
    `(${all.events.length})`);

  const one = run(2.0, oneHand(both), { fingers: 'index' });
  ok(one.events.length === 1 && one.events[0].finger === 1,
    'with index only, the same gesture is one note — the index',
    `(${one.events.length}: fingers ${one.events.map((e) => e.finger)})`);

  // The index must still play exactly as well by itself, or the setting is a
  // trade rather than a fix.
  const solo = run(2.0, oneHand((t) => ({ depths: [0, tap(t), 0, 0, 0] })), { fingers: 'index' });
  ok(solo.events.length === 1 && solo.events[0].finger === 1,
    'and a plain index tap is untouched', `(${solo.events.length})`);

  // A middle-finger tap on its own is simply not this instrument any more.
  const other = run(2.0, oneHand((t) => ({ depths: [0, 0, tap(t), 0, 0] })), { fingers: 'index' });
  ok(other.events.length === 0, 'while any other finger is silent, however hard it taps',
    `(${other.events.length})`);

  /* Off means *out of the detector*, not filtered afterwards. A discarded
   * strike would still have joined the arbitration cluster, and a strong one
   * could then talk the index out of sounding — so the option that exists to
   * stop wrong notes would start swallowing right ones. */
  const shadowed = run(2.0, oneHand((t) => ({
    depths: [0, tapCycle(t, 0.35, { dur: 0.09, depth: 0.22 }), tapCycle(t, 0.35, { dur: 0.09, depth: 0.55 }), 0, 0],
  })), { fingers: 'index' });
  ok(shadowed.events.length === 1,
    'a much stronger neighbour cannot arbitrate the index away', `(${shadowed.events.length})`);

  const det = new TapDetector();
  det.setFingers('index');
  ok(det.plays(1) && !det.plays(2) && det.fingerSet === 'index', 'the setting reports itself');
  det.setFingers('nonsense');
  ok(det.fingerSet === 'all', 'and an unknown one falls back to all ten');
}

/* --- what one finger buys, and what it must not cost ----------------
 * Two of the detector's gates exist only to answer questions this mode has
 * already removed. `MIN_EXTEND` refuses a finger that isn't reaching, because
 * a whole hand coming down is not a chord; `MIN_ARTIC` asks which finger of
 * several actually struck. With one finger there are no passengers and no
 * cluster, so both can be relaxed — which is what pulls in the pointing hand
 * that comes down mostly as one piece and only leads a little with the tip.
 *
 * The relaxation must be *strictly* confined to this mode: all-fingers is the
 * mode people already play, and the first half of this block pins its numbers
 * so a future tweak to the index preset can't leak into it. */
{
  const pinned = (fingers, surface) => {
    const d = new TapDetector();
    d.setSurface(surface);
    d.setFingers(fingers);
    return d.o;
  };
  for (const surface of Object.keys(SURFACES)) {
    const want = { ...DEFAULTS, ...SURFACES[surface] };
    const got = pinned('all', surface);
    ok(Object.keys(want).every((k) => got[k] === want[k]),
      `all-fingers on ${surface} is exactly the tuning it always was`,
      Object.keys(want).filter((k) => got[k] !== want[k]).join(' ') || '');
  }

  // And the relaxation is only ever a relaxation — never a different detector.
  const air = pinned('all', 'air'), airOne = pinned('index', 'air');
  const moved = Object.keys(air).filter((k) => air[k] !== airOne[k]);
  ok(moved.length === 2 && moved.every((k) => airOne[k] < air[k]),
    'index-only moves two thresholds, both downwards', `(${moved.join(', ')})`);

  /* A pointing hand descends nearly as one piece. `reach` is how much of the
   * travel is the fingertip's own, in palm spans — the quantity MIN_EXTEND
   * gates on — with the rest carried by the hand. */
  const lead = (reach) => oneHand((t) => {
    const c = tapCycle(t, 0.35, { dur: 0.09, depth: 0.34 });
    return { hand: (c / 0.34) * (0.34 - reach), depths: [0, c * (reach / 0.34), 0, 0, 0] };
  });
  ok(run(1.4, lead(0.05)).events.length === 1
    && run(1.4, lead(0.05), { fingers: 'index' }).events.length === 1,
    'a clearly-leading finger plays in either mode');
  ok(run(1.4, lead(0.03)).events.length === 0
    && run(1.4, lead(0.03), { fingers: 'index' }).events.length === 1,
    'a barely-leading one plays only with index only — the 30% that was missing');

  // The gate it replaces is the one keeping resting silent, so that has to
  // survive the relaxation. A whole hand set down leads with nothing at all.
  for (const dur of [0.12, 0.18, 0.25, 0.35]) {
    const r = run(1.6, oneHand((t) => ({ hand: glide(t, 0.3, dur, 0.5) })), { fingers: 'index' });
    ok(r.events.length === 0, `putting the hand down over ${dur}s is still silent`,
      r.events.length ? `(${r.events.length} spurious)` : '');
  }
}

/* --- playing against a desk, and against nothing at all -------------
 * Miming a strike in mid-air is the same gesture minus the wood, and the wood
 * is precisely what makes the stop instant. Braking yourself takes tens of
 * milliseconds no matter how crisply you do it, so the question is whether the
 * detector can be widened enough to hear that without also hearing a hand
 * simply being lowered. `flick` makes the brake an explicit dial so the answer
 * is measured rather than asserted. */
{
  /** Velocity ramps up over `dur`, then down to nothing over `brake`. */
  const flick = (t, t0, { peak = 6, dur = 0.09, brake = 0.02 } = {}) => {
    const u = t - t0;
    if (u <= 0) return 0;
    if (u < dur) return (peak / dur) * u * u / 2;
    const p1 = (peak * dur) / 2, b = Math.min(u - dur, brake);
    return p1 + peak * b - (peak * b * b) / (2 * brake);
  };
  const gesture = (o) => oneHand((t) => ({ depths: [0, flick(t, 0.35, o), 0, 0, 0] }));
  const count = (o, surface) => {
    const det = new TapDetector();
    det.setSurface(surface);
    let n = 0;
    const at = gesture(o);
    for (let i = 0; i < Math.round(1.6 * 60); i++) n += det.update([at(i / 60)], i / 60).length;
    return n;
  };

  const rows = [];
  for (const [what, o] of [['desk strike', { brake: 0.015 }], ['air flick', { brake: 0.07 }],
                           ['soft air flick', { peak: 4, brake: 0.09 }], ['lowering a hand', { peak: 3.2, brake: 0.30 }]]) {
    rows.push(`${what}: desk ${count(o, 'desk')} / air ${count(o, 'air')}`);
  }
  console.log('        notes fired — ' + rows.join('  ·  '));

  ok(count({ brake: 0.015 }, 'desk') === 1, 'a desk strike fires on the desk setting');
  ok(count({ brake: 0.07 }, 'air') === 1, 'an air flick fires on the air setting');
  ok(count({ peak: 4, brake: 0.09 }, 'air') === 1, 'and so does a gentler one');
  // The thing air mode must not start doing is playing when you put a hand down.
  ok(count({ peak: 3.2, brake: 0.30 }, 'air') === 0, 'lowering a hand is still silent in air mode');
  ok(count({ brake: 0.015 }, 'air') === 1, 'and a real desk strike still works if you switch back');
}

/* --- postures the camera makes hard to read -------------------------
 * A camera pointed down a desk looks roughly *along* the fingers, so a curved
 * hand — which is how anyone actually plays — projects its fingers much
 * shorter than they are. A strict tip-to-knuckle gate silently refuses to play
 * for people holding their hands correctly, which is the worst kind of bug:
 * it looks like the detector simply doesn't work. */
{
  for (const [what, ext] of [['flat', 0.85], ['curved', 0.45], ['steeply foreshortened', 0.30]]) {
    const r = run(1.6, oneHand((t) => ({ extend: ext, depths: [0, tapCycle(t, 0.35), 0, 0, 0] })));
    ok(r.events.length === 1, `a ${what} hand still plays`, `(${r.events.length})`);
  }
  // …but a fist is still not a finger, and articulation is what proves it.
  const fist = run(1.6, oneHand((t) => ({
    depths: new Array(5).fill(tapCycle(t, 0.35)), extend: 0.15, rigid: true })));
  ok(fist.events.length === 0, 'and a fist is still silent', `(${fist.events.length})`);
}
{
  /* A tap that falls just short must not lock the finger out of the next one.
   * The first here is too gentle to qualify; the second is a real strike a
   * moment later, and has to play. */
  const r = run(2.2, oneHand((t) => ({
    depths: [0, glide(t, 0.30, 0.40, 0.30) - glide(t, 0.75, 0.20, 0.30)
                + tapCycle(t, 1.20), 0, 0, 0],
  })));
  ok(r.events.length === 1, 'a near-miss does not swallow the tap after it',
    `(${r.events.length})`);
}

/* --- repetition, chords, dynamics ---------------------------------- */
{
  const times = [0.30, 0.60, 0.90, 1.20, 1.50];
  const r = run(2.1, oneHand((t) => ({
    depths: [0, times.reduce((s, t0) => s + tapCycle(t, t0, { rest: 0.05, lift: 0.10 }), 0), 0, 0, 0],
  })));
  ok(r.events.length === times.length, 'five repeated taps fire five notes', `(${r.events.length})`);
}
{
  // Three fingers landing together is a chord, and must stay three notes.
  const r = run(1.2, oneHand((t) => {
    const d = tapCycle(t, 0.35);
    return { depths: [0, d, d, d, 0] };
  }));
  ok(r.events.length === 3, 'a three-finger chord fires three notes', `(${r.events.length})`);
  ok(new Set(r.events.map((e) => e.finger)).size === 3, 'one per finger, not three on one');
  const spread = Math.max(...r.events.map((e) => e.t)) - Math.min(...r.events.map((e) => e.t));
  ok(spread < 0.02, 'and they land together', `${(spread * 1000).toFixed(0)} ms apart`);
}
{
  const soft = run(1.0, oneHand((t) => ({ depths: [0, strike(t, 0.35, 0.20, 0.28), 0, 0, 0] })));
  const hard = run(1.0, oneHand((t) => ({ depths: [0, strike(t, 0.35, 0.055, 0.40), 0, 0, 0] })));
  ok(soft.events.length === 1 && hard.events.length === 1, 'both a soft and a hard tap register',
    `${soft.events.length}/${hard.events.length}`);
  const sv = soft.events[0]?.velocity ?? 0, hv = hard.events[0]?.velocity ?? 0;
  ok(hv > sv + 0.25, 'striking harder really is louder', `${sv.toFixed(2)} → ${hv.toFixed(2)}`);
  ok(sv >= 0.16 && hv <= 1, 'velocity stays inside its range', `${sv.toFixed(2)}..${hv.toFixed(2)}`);
}
{
  // A finger left resting on the desk must not retrigger, however long it sits.
  const r = run(2.5, oneHand((t) => ({ depths: [0, strike(t, 0.35, 0.09, 0.34), 0, 0, 0] })));
  ok(r.events.length === 1, 'a finger left resting on the desk plays once', `(${r.events.length})`);
}

/* --- two hands, independently -------------------------------------- */
{
  const r = run(1.6, (t) => [
    makeHand('left', { cx: 0.3, depths: [0, tapCycle(t, 0.35), 0, 0, 0] }),
    makeHand('right', { cx: 0.7, depths: [0, 0, tapCycle(t, 0.75), 0, 0] }),
  ]);
  const L = r.events.filter((e) => e.id === 'left'), R = r.events.filter((e) => e.id === 'right');
  ok(L.length === 1 && R.length === 1, 'each hand fires its own note', `L${L.length} R${R.length}`);
  ok(L[0]?.finger === 1 && R[0]?.finger === 2, 'and attributes it to the right finger');
  ok(R[0].t > L[0].t + 0.3, 'in the order they were played');
}
{
  // One hand vanishing must not disturb the other, and must not fire on return.
  const r = run(2.2, (t) => {
    const hands = [makeHand('right', { cx: 0.7, depths: [0, tapCycle(t, 1.5), 0, 0, 0] })];
    if (t < 0.6 || t > 1.0) hands.unshift(makeHand('left', { cx: 0.3, depths: [0, 0, 0, 0, 0] }));
    return hands;
  });
  ok(r.events.length === 1 && r.events[0].id === 'right',
    'a hand leaving and returning fires nothing by itself', `(${r.events.length})`);
}

/* --- camera angle ---------------------------------------------------
 * The same physical tap projects to a different image direction depending on
 * how the camera is tilted. The detector starts assuming straight-down and
 * learns the truth from confirmed strikes. */
{
  const tilted = { x: Math.sin(0.7), y: Math.cos(0.7) };   // ~40° off vertical
  const times = [0.35, 0.7, 1.05, 1.4, 1.75, 2.1];
  const r = run(2.6, oneHand((t) => ({
    dir: tilted,
    depths: [0, times.reduce((s, t0) => s + tapCycle(t, t0, { rest: 0.06, lift: 0.10 }), 0), 0, 0, 0],
  })));
  ok(r.events.length >= times.length - 1, 'taps still register on a steeply tilted camera',
    `(${r.events.length}/${times.length})`);
  const learnt = Math.atan2(r.det.dir.x, r.det.dir.y);
  ok(Math.abs(learnt - 0.7) < 0.35, 'and the approach axis learns the tilt',
    `${(learnt * 57.3).toFixed(0)}° vs 40°`);
}

/* --- detection rate -------------------------------------------------
 * The detector can only see what the tracker delivers. This is not a threshold
 * to tune away — it is a hard floor set by how often MediaPipe runs, and the
 * reason the app warns when the tracking rate drops. Reported rather than
 * asserted at the low end so the number stays visible. */
{
  const at = oneHand((t) => ({
    depths: [0, [0.35, 0.75, 1.15, 1.55].reduce((s, t0) => s + tapCycle(t, t0, { rest: 0.08, lift: 0.12 }), 0), 0, 0, 0],
  }));
  const rows = [];
  for (const fps of [60, 45, 30, 20, 15, 10]) rows.push(`${fps}fps:${run(2.1, at, { fps }).events.length}/4`);
  console.log('        caught per tracking rate — ' + rows.join('  '));
  ok(run(2.1, at, { fps: 60 }).events.length === 4, 'all four caught at 60 detections/s');
  ok(run(2.1, at, { fps: 30 }).events.length === 4, 'all four caught at 30 detections/s');
  ok(run(2.1, at, { fps: 20 }).events.length >= 3, 'most caught at 20 detections/s');

  /* A *hard* tap is the shortest event the detector ever sees, so it is the
   * first thing a coarse sample rate loses — and losing hard taps while soft
   * ones survive is precisely backwards. Regression: the abruptness window was
   * fixed at 100 ms, which at 20 looks/s is two frames, i.e. exactly the
   * minimum a peak-then-stop can occupy, so the firmest playing fell through. */
  for (const fps of [60, 30, 20]) {
    const hard = run(1.4, oneHand((t) => ({ depths: [0, tapCycle(t, 0.35, { dur: 0.06, depth: 0.55 }), 0, 0, 0] })), { fps });
    ok(hard.events.length === 1, `a hard, fast tap still registers at ${fps} detections/s`, `(${hard.events.length})`);
  }
  // …and the widened window must not start letting placements through.
  for (const fps of [30, 20]) {
    const g = run(1.8, oneHand((t) => ({ depths: [0, glide(t, 0.3, 0.45, 0.8), 0, 0, 0] })), { fps });
    ok(g.events.length === 0, `a hand settling is still silent at ${fps} detections/s`, `(${g.events.length})`);
  }
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
