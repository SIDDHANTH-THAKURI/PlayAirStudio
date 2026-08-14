/**
 * stick.js — what the player hits the drums with.
 *
 * Two ways to play, and they produce the same shape of thing so that nothing
 * downstream has to care which is in use:
 *
 *  • **Sticks.** A drumstick gripped in each fist, tip a couple of palm-spans
 *    out. Closer to drumming, and further from the tracker's comfort zone.
 *  • **Fingertip.** Point one index finger and the tip of it is what strikes,
 *    exactly as in the piano. No geometry is invented at all — the striking
 *    point is a landmark the tracker reports directly — so it is the more
 *    reliable of the two by a wide margin, and it is the default.
 *
 * ── Why the stick geometry is what it is
 *
 * A stick has to be *aimed*, so its direction is the whole problem, and it has
 * been wrong twice.
 *
 * **First attempt: along the index finger**, through the knuckle and fingertip
 * and carrying on past. Lovely on paper — you aim the finger you can see — and
 * it fails because a drum stroke *bends that finger*. The index curls on the
 * flick and straightens on the recovery, so the one line the geometry hung from
 * was the line that moved most during the gesture. Arming needed a clean point
 * too, which a drummer's grip is not, so the usual failure was no stick at all.
 *
 * **Second attempt: the knuckle line's perpendicular.** The idea was sound —
 * that line is the widest part of a fist and stays well defined however the
 * wrist turns, unlike the hand's forward axis, which points at the lens in the
 * playing pose and collapses to noise. But a perpendicular has *two ends*, and
 * deciding which one is the tip needs the very measurement that just collapsed.
 * Every scheme for making that choice — a threshold, a smoothed vote — is a
 * discontinuity sitting exactly where the evidence is weakest, so the stick
 * flipped end over end, and between flips it wandered. That is what "keeps
 * changing direction" was.
 *
 * **Third attempt: the forward axis, straight, drawn shorter by exactly how
 * foreshortened it is.** Continuous, unflippable, and honest — and unplayable,
 * which took a projected 3D hand to see rather than a flat fixture. The pose
 * this instrument is actually played in holds the knuckles toward the lens, so
 * the axis projects to *half* its length at a natural 30° of hand pitch and a
 * quarter at 10°. Two things follow, and both are the complaint that "the
 * sticks aren't connected to my hand". The tip hangs a fraction of a stick
 * below the fist instead of a stick, so the kit is out of reach unless you
 * hold your hand at an angle nobody holds it at. And a stroke *is* a wrist
 * flick, so the foreshortening changes through every stroke: measured on a
 * projected hand pitching from 12° to 60°, the tip travels 0.19 of the screen
 * of which 0.12 — nearly two thirds — is the stick telescoping in and out of
 * the fist rather than the hand moving. A stick that changes length when you
 * turn your wrist is not being held.
 *
 * **Now: two estimates of one direction, and a length that does not move.**
 * The forward axis and the knuckle line are the same measurement seen twice.
 * For a rigid frame under projection their image lengths satisfy
 * `|f|² + |l|² = 1 + n_z² ≥ 1`, so they cannot both collapse: whichever pose
 * ruins one leaves the other broadside. The knuckle line's perpendicular is
 * the forward axis's own image direction whenever that line lies in the image
 * plane — which is exactly the pose that flattens the forward axis — so the
 * two are blended by which is better conditioned, and the direction is well
 * defined everywhere.
 *
 * That leaves the one bit the second attempt died on: a perpendicular has two
 * ends. It is *not* re-derived from the collapsed axis every frame, which is
 * what flipped; it is a latch, set from the forward axis whenever the forward
 * axis is worth believing and simply held when it is not. Sitting still is not
 * a discontinuity, and a hand cannot reverse without first passing through the
 * pose where it has no stick at all.
 *
 * The length is then constant — the reason for all of the above. It shrinks
 * only inside a narrow band around the genuine degeneracy (a hand within about
 * 13° of pointing straight down the lens), where a real stick really is a dot,
 * and where the reversal has to happen if it is going to happen. Everywhere a
 * drum can be reached from, the tip sits a fixed distance from the fist.
 *
 * Nothing in the stick geometry reads a finger joint. Everything comes from the
 * wrist and the four knuckles, which are rigid: curl your fingers, make a fist,
 * splay them, and those five points keep the same shape.
 *
 * Pure geometry: no DOM, no audio.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
const smooth = (v, a, b) => { const u = inv(v, a, b); return u * u * (3 - 2 * u); };

const WRIST = 0;
const MCP = [5, 9, 13, 17];
const TIP = [8, 12, 16, 20];
const INDEX_MCP = 5, INDEX_TIP = 8, PINKY_MCP = 17;

/** Pairs across the palm, used to measure the hand without trusting any one. */
const RULERS = [[0, 5], [0, 9], [0, 13], [0, 17], [5, 9], [9, 13], [13, 17], [5, 17]];

export const STICK = 'stick', FINGER = 'finger';

/**
 * Stick length from the fist, in palm spans.
 *
 * Shorter than the finger-mounted stick it replaces, and that is the point. The
 * old one was long because it was a lever: a wrist flick barely moves the
 * knuckles, so the tip had to be thrown far out to make the gesture big enough
 * to see. Hits are found by contact now rather than by speed (see `onset.js`),
 * so length buys nothing and costs precision — every wobble in the hand's angle
 * is multiplied by exactly this number before it reaches the tip.
 */
export const LENGTH = 1.9;

/**
 * …but only within these, as a fraction of the frame.
 *
 * "In palm spans" is the right instinct and the wrong law. It keeps the stick
 * in proportion to the hand, which is what makes it look held — and a hand's
 * size on screen is a fact about how close somebody is sitting, not about how
 * far they need to reach. Sit close enough and a stick 1.9 hands long is half
 * the height of the screen: a caber, swinging past every drum at once. Sit far
 * back and it is a stub that cannot reach the kit at all.
 *
 * The kit is drawn at fixed places on screen, so the reach that matters is
 * measured in screen too. Inside the normal range this changes nothing.
 */
const REACH_MIN = 0.11, REACH_MAX = 0.26;

/** The same argument, applied to the ruler the fingertip mode measures in. */
const UNIT_MIN = 0.065, UNIT_MAX = 0.170;

/** How far the butt pokes back out of the fist, as a fraction of the reach. */
export const BUTT = 0.32;

/**
 * The knuckle line, index to pinky, as a fraction of a palm span — the ruler
 * its own foreshortening is measured against. Nominal on purpose: it is only
 * ever compared with the forward axis's conditioning to decide which of the two
 * to lean on, so being a few percent out for a particular hand costs nothing.
 */
const KNUCKLES = 0.75;

/**
 * How far the forward axis has to project before it is trusted on its own,
 * and the band over which it hands over to the knuckle line's perpendicular.
 * Both are estimates of the same direction, so the blend is not a compromise
 * between two answers — it is a weighted average of two measurements of one.
 */
const TRUST_LO = 0.14, TRUST_HI = 0.46;

/**
 * …and the far narrower band in which the stick genuinely has no length.
 *
 * A hand more than about 13° off the camera's own axis (`conf` ≥ `DEGEN_HI`)
 * gets a full-length stick, which is every pose a drum can be reached from.
 * Inside the band the stick shrinks toward a point, because that is what a real
 * one does when you aim it at the lens — and because a reversal has to happen
 * somewhere, and this is the only place it can happen continuously.
 */
const DEGEN_LO = 0.05, DEGEN_HI = 0.22;

/** The end that is the tip is only revised on evidence this strong, held this long. */
const SIGN_TRUST = 0.30, SIGN_HOLD = 3;

/** Hand size changes on nobody's timescale, so it is smoothed far harder than pose. */
const SPAN_TAU = 0.14;

/** How far the tip sits from the fist, on screen, before foreshortening. */
export function reachOf(span, length = LENGTH) {
  const k = length / LENGTH;
  return clamp(span * length, REACH_MIN * k, REACH_MAX * k);
}

/**
 * How big this hand is on screen, in normalised units — the ruler everything
 * else is measured in.
 *
 * Naively this is one distance across the palm, and naively that is wrong: turn
 * the hand and whichever distance you picked foreshortens, the ruler shrinks,
 * and every threshold measured in "spans" silently moves. With metric world
 * landmarks there is a fix that needs no assumptions about pose at all. Each
 * palm pair has a known real length, so each gives an estimate of the image
 * scale — and a foreshortened pair can only ever read *short*. The largest
 * estimate is therefore the one from whichever pair happens to be side-on to
 * the camera, which is the true scale.
 *
 * This is also what makes `conf` below mean anything: a forward axis that has
 * shrunk can only be recognised as shrunken against a ruler that has not.
 */
export function spanOf(lm, world = null) {
  const d2 = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  if (world && world.length >= 21) {
    const d3 = (a, b) => Math.hypot(world[a].x - world[b].x, world[a].y - world[b].y,
      (world[a].z ?? 0) - (world[b].z ?? 0));
    let scale = 0;
    for (const [a, b] of RULERS) {
      const w = d3(a, b);
      if (w > 1e-4) scale = Math.max(scale, d2(a, b) / w);
    }
    const ref = d3(WRIST, 9);
    if (scale > 0 && ref > 1e-4) return clamp(scale * ref, 0.02, 0.6);
  }
  /* No world landmarks: take the longer of two roughly perpendicular
   * measurements, so a palm turned edge-on to the camera still has one of them
   * intact. Hand width runs about four fifths of palm length, so it is scaled
   * to agree before the two are compared. */
  return clamp(Math.max(d2(WRIST, 9), d2(5, 17) / 0.80), 0.02, 0.6);
}

/**
 * Which way the hand is pointing, and how far that can be believed.
 *
 * `conf` is the axis's length measured against the rotation-proof span: about 1
 * for a hand seen broadside, falling toward 0 as it turns to point at the
 * camera. It is not a fudge factor — it is the honest statement that this
 * direction is a projection, and it is what decides how much of the aim below
 * comes from here rather than from the knuckle line.
 */
export function axisOf(lm, span) {
  let x = 0, y = 0;
  for (const k of MCP) { x += lm[k].x; y += lm[k].y; }
  x = x / MCP.length - lm[WRIST].x;
  y = y / MCP.length - lm[WRIST].y;
  const m = Math.hypot(x, y);
  if (!(m > 1e-6)) return { x: 0, y: 1, conf: 0 };
  return { x: x / m, y: y / m, conf: clamp(m / span, 0, 1.2) };
}

/**
 * The line across the knuckles, and how broadside it is.
 *
 * The widest part of the hand, and the one measurement that is *longest*
 * precisely when the forward axis is shortest — a fist aimed at the lens hides
 * its length and shows its width.
 */
export function knuckleOf(lm, span) {
  const x = lm[PINKY_MCP].x - lm[INDEX_MCP].x, y = lm[PINKY_MCP].y - lm[INDEX_MCP].y;
  const m = Math.hypot(x, y);
  if (!(m > 1e-6)) return { x: 1, y: 0, conf: 0 };
  return { x: x / m, y: y / m, conf: clamp(m / (span * KNUCKLES), 0, 1.2) };
}

/**
 * Where the stick points, from both measurements at once.
 *
 * `sign` is the caller's latch — which end of the knuckle line's perpendicular
 * is the tip. Pass 0 and the current forward axis decides, which is right for a
 * one-off call and not enough over time; `PoseFilter` keeps the latch and is
 * what the instrument actually uses.
 *
 * The returned `vote` is what the forward axis says the sign should be, and
 * `conf` is how much that vote is worth. Deciding is deliberately left to the
 * caller: the whole failure of the second design was making that decision
 * afresh every frame out of the weakest evidence on the hand.
 */
export function aimOf(lm, span, sign = 0) {
  const f = axisOf(lm, span), k = knuckleOf(lm, span);
  // Perpendicular to the knuckle line — the forward axis's own image direction
  // whenever that line lies in the image plane, which is the pose that flattens
  // the forward axis. Two ends; the latch picks one.
  let px = -k.y, py = k.x;
  const vote = Math.sign(px * f.x + py * f.y) || 1;
  const s = (f.conf > SIGN_TRUST ? vote : (sign || vote)) < 0 ? -1 : 1;
  px *= s; py *= s;
  /* Co-orient before blending. Below `SIGN_TRUST` the forward axis is not
   * trusted to *choose* the end, so it must not be allowed to vote against the
   * latch by cancelling it out either — that would leave a near-zero vector
   * whose direction is pure noise, which is the failure being avoided. */
  const agree = px * f.x + py * f.y < 0 ? -1 : 1;
  const w = f.conf <= 0 ? 0 : smooth(f.conf, TRUST_LO, TRUST_HI);
  const x = f.x * agree * w + px * (1 - w), y = f.y * agree * w + py * (1 - w);
  const m = Math.hypot(x, y);
  if (!(m > 1e-6)) return { x: px, y: py, conf: f.conf, lat: k.conf, vote, sign: s };
  return { x: x / m, y: y / m, conf: f.conf, lat: k.conf, vote, sign: s };
}

/**
 * Where the stick sits in the hand: the middle of the fist, pulled slightly
 * back toward the wrist so the shaft runs out through the fingers.
 *
 * Averaging five landmarks is also the quietest point available on a hand —
 * uncorrelated tracker noise on each of them cancels — which matters because
 * this point is where the stick's whole geometry hangs from.
 */
export function gripOf(lm) {
  let x = 0, y = 0;
  for (const k of MCP) { x += lm[k].x; y += lm[k].y; }
  x /= MCP.length; y /= MCP.length;
  return { x: x * 0.74 + lm[WRIST].x * 0.26, y: y * 0.74 + lm[WRIST].y * 0.26 };
}

/** Distances between landmarks, in 3D when the tracker offers it. */
function ruler(lm, world) {
  const metric = !!(world && world.length >= 21);
  const P = metric ? world : lm;
  const d = metric
    ? (a, b) => Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y, (P[a].z ?? 0) - (P[b].z ?? 0))
    : (a, b) => Math.hypot(P[a].x - P[b].x, P[a].y - P[b].y);
  return { d, ref: d(WRIST, 9) || 1e-6 };
}

/**
 * How closed this hand is, 0 (flat open) to 1 (fist) — the stick-mode grip.
 *
 * All four fingers, measured against the palm's own length so it is a shape
 * rather than a size. A hand held flat reaches about 0.8 of a palm length; the
 * same hand shut hard reaches about 0.35. The thresholds sit between, low
 * enough that the loose, comfortable grip a drummer actually uses counts as
 * holding — this gesture exists to put the sticks *down*, not to make you
 * clench.
 *
 * The window used to be 0.44…0.70, which was measured off a flat fixture and
 * meant it. On a hand projected from real 3D the fingers never fold that far:
 * the gate did not open until the fist was almost completely shut, and a
 * comfortable grip round an imaginary shaft read as an open hand — the sticks
 * were simply not picked up. Moved up to where a real grip lands, with a flat
 * open hand still well clear of the far end.
 */
export function closeOf(lm, world = null) {
  const { d, ref } = ruler(lm, world);
  let reach = 0;
  for (let i = 0; i < MCP.length; i++) reach += d(MCP[i], TIP[i]) / ref;
  return 1 - inv(reach / MCP.length, 0.50, 0.78);
}

/**
 * How much this hand is pointing, 0 to 1 — the fingertip-mode grip.
 *
 * Index out and the rest in, and *both* halves matter. Without the second, a
 * flat open hand waved at the camera would strike drums, which is the single
 * thing this gesture exists to prevent — and it is the reason the mode is worth
 * having at all, since the whole complaint it answers is other fingers setting
 * things off.
 *
 * Forgiving about *how* curled the others are: a comfortable pointing hand does
 * not fold them into a fist, and demanding that is how a gesture goes from
 * natural to a pose you have to hold.
 */
export function pointOf(lm, world = null) {
  const { d, ref } = ruler(lm, world);
  const index = d(INDEX_MCP, INDEX_TIP) / ref;
  let others = 0;
  for (let i = 1; i < MCP.length; i++) others += d(MCP[i], TIP[i]) / ref;
  others /= MCP.length - 1;
  return inv(index, 0.50, 0.72) * (1 - inv(others, 0.42, 0.66));
}

/**
 * Assemble a stick from a pose. The one place the geometry is put together.
 *
 * `unit` and `reach` are deliberately different things. `unit` is the ruler the
 * detector measures speeds and lifts in, and it must not move when the hand
 * turns or every threshold moves with it. `reach` is how long the stick
 * actually is right now, which *does* shrink as the direction foreshortens.
 */
export function stickFrom({ grip, axis, span }, length = LENGTH) {
  const m = Math.hypot(axis.x, axis.y) || 1;
  const ax = axis.x / m, ay = axis.y / m;
  const conf = axis.conf ?? 1;
  const unit = reachOf(span, length);
  /* Fixed, except where a stick genuinely has no length.
   *
   * Scaling this by the foreshortening straight — which is what the version
   * before this did — is honest projection and an unplayable instrument: at the
   * hand angles a kit is actually played at it costs half the stick, and since
   * a stroke is a wrist flick it costs a *different* half from one frame to the
   * next, so most of the tip's motion during a stroke is the stick sliding in
   * and out of the fist. Fixed length is what makes the tip read as attached.
   *
   * The shrink survives only inside `DEGEN_LO…DEGEN_HI`, a hand within about
   * 13° of pointing down the lens. Something has to give there: the image
   * direction of a stick aimed at the camera genuinely reverses as it passes
   * through, and a fixed-length stick would have to snap end for end. Letting
   * it shrink to a point and grow back the other way is what a real one does,
   * it is perfectly continuous, and it is confined to a pose from which no drum
   * can be reached anyway — `onset.js` refuses to strike with a stub. */
  const reach = unit * smooth(conf, DEGEN_LO, DEGEN_HI);
  return {
    mode: STICK, span, unit, reach, conf,
    axis: { x: ax, y: ay },
    grip: { x: grip.x, y: grip.y },
    butt: { x: grip.x - ax * reach * BUTT, y: grip.y - ay * reach * BUTT },
    tip: { x: grip.x + ax * reach, y: grip.y + ay * reach },
  };
}

/** The fingertip pose: no geometry invented, the tip is a landmark. */
export function fingerFrom(lm, span) {
  const g = lm[INDEX_MCP], p = lm[INDEX_TIP];
  const dx = p.x - g.x, dy = p.y - g.y;
  const reach = Math.hypot(dx, dy);
  const m = reach || 1;
  return {
    mode: FINGER, span, reach, conf: clamp(reach / span, 0, 1.2),
    // The ruler is the hand itself, held inside a screen range for the same
    // reason the stick's is: the kit does not move when the player leans in.
    unit: clamp(span, UNIT_MIN, UNIT_MAX),
    axis: { x: dx / m, y: dy / m },
    grip: { x: g.x, y: g.y },
    butt: { x: g.x, y: g.y },
    tip: { x: p.x, y: p.y },
  };
}

/**
 * Where the striking point is, given one hand's landmarks.
 * @returns { mode, tip, grip, butt, axis, span, unit, reach, conf }
 */
export function poseOf(lm, { mode = FINGER, length = LENGTH, world = null, sign = 0 } = {}) {
  if (!lm) return null;
  const span = spanOf(lm, world);
  return mode === STICK
    ? stickFrom({ grip: gripOf(lm), axis: aimOf(lm, span, sign), span }, length)
    : fingerFrom(lm, span);
}

/** How held/pointed the hand is for a given mode, 0…1. */
export function holdOf(lm, mode, world = null) {
  return mode === STICK ? closeOf(lm, world) : pointOf(lm, world);
}

/** Kept for the stick's own tests and for anything that only wants a stick. */
export const stickOf = (lm, length = LENGTH, world = null) =>
  poseOf(lm, { mode: STICK, length, world });

/**
 * A pose smoothed over time.
 *
 * Different quantities, different timescales, because they are different kinds
 * of thing. **Angle** is a pose and gets a couple of frames of lag — a constant
 * couple, now that `aimOf` returns a direction that is well conditioned in
 * every pose and so has no weak case to lag harder. **Span** is a measurement
 * of a hand that is not changing size, so it is smoothed hard: length flicker
 * is the single thing that makes a drawn stick look fake. **Position** is by
 * default not smoothed at all — it is what contact is measured from, and lag
 * there is latency you can hear.
 *
 * The filter also owns the **sign latch**: which end of the knuckle line the
 * tip is on. It is set from the forward axis whenever the forward axis is worth
 * believing, held unchanged when it is not, and revised only after `SIGN_HOLD`
 * consecutive frames of strong disagreement — so a single noisy frame at the
 * ambiguous angle cannot turn a stick round mid-stroke, which is what the
 * design before last did.
 *
 * Fingertip mode smooths nothing but the span. The tip is a landmark the
 * tracker reports directly; there is no derived direction to steady, and any
 * filtering would be pure latency on the one number that matters.
 */
export class PoseFilter {
  constructor(tau = 0.030, posTau = 0) { this.tau = tau; this.posTau = posTau; this.mode = FINGER; this.reset(); }
  reset() { this.ax = null; this.ay = 1; this.span = 0; this.px = 0; this.py = 0; this.sign = 0; this.dissent = 0; }
  setMode(mode) { if (mode !== this.mode) { this.mode = mode; this.reset(); } }

  update(lm, length = LENGTH, dt = 1 / 60, world = null) {
    if (!lm) return null;
    const step = Math.max(dt, 1e-4);
    const span = spanOf(lm, world);
    this.span = this.ax === null ? span
      : this.span + (span - this.span) * (1 - Math.exp(-step / SPAN_TAU));

    if (this.mode !== STICK) {
      if (this.ax === null) this.ax = 0;      // marks the filter as primed
      return fingerFrom(lm, this.span);
    }

    const a = aimOf(lm, this.span, this.sign), g = gripOf(lm);
    /* The latch. Adopt on the first believable look, hold through everything
     * weaker, and only turn the stick round after several consecutive strong
     * frames saying the hand really has gone over. A hand cannot reverse
     * without passing through the pose where it has no stick to reverse. */
    if (a.conf > SIGN_TRUST) {
      if (!this.sign) this.sign = a.vote;
      else if (a.vote !== this.sign) { if (++this.dissent >= SIGN_HOLD) { this.sign = a.vote; this.dissent = 0; } }
      else this.dissent = 0;
    } else this.dissent = 0;

    if (this.ax === null) { this.ax = a.x; this.ay = a.y; this.px = g.x; this.py = g.y; }
    else {
      const k = 1 - Math.exp(-step / this.tau);
      this.ax += (a.x - this.ax) * k;
      this.ay += (a.y - this.ay) * k;
      if (this.posTau > 0) {
        const c = 1 - Math.exp(-step / this.posTau);
        this.px += (g.x - this.px) * c;
        this.py += (g.y - this.py) * c;
      } else { this.px = g.x; this.py = g.y; }
    }
    return stickFrom({
      grip: { x: this.px, y: this.py },
      axis: { x: this.ax, y: this.ay, conf: a.conf },
      span: this.span,
    }, length);
  }
}

/** Schmitt trigger, so a hand resting near the threshold can't strobe. */
export class Grip {
  constructor(on = 0.40, off = 0.20) { this.on = on; this.off = off; this.held = false; }
  update(c) {
    this.held = this.held ? c > this.off : c > this.on;
    return this.held;
  }
}
