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
 * **Now: the hand's forward axis, straight, with no cleverness.** Wrist to
 * knuckles, in the image, which is unambiguous — it is a vector, not a line, so
 * there is no end to choose and nothing to flip. It really does foreshorten
 * when the hand points at the camera, and the answer is to be honest about it
 * rather than to paper over it: the stick is drawn *shorter* by exactly how
 * foreshortened its direction is. When the angle is reliable the stick is full
 * length and points where the hand points; when the angle is turning to noise
 * the stick is a stub, so the noise has almost nothing to swing. The player can
 * see it happen and tilt their hand down, which is the fix.
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
const INDEX_MCP = 5, INDEX_TIP = 8;

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
const BUTT = 0.32;

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
 * direction is a projection, and it is what the drawn length is scaled by.
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
 * rather than a size. A hand held flat to the camera reaches about 0.78 of a
 * palm length; the same hand curled reaches about 0.3. The thresholds sit
 * between, low enough that the loose, comfortable grip a drummer actually uses
 * counts as holding — this gesture exists to put the sticks *down*, not to make
 * you clench.
 */
export function closeOf(lm, world = null) {
  const { d, ref } = ruler(lm, world);
  let reach = 0;
  for (let i = 0; i < MCP.length; i++) reach += d(MCP[i], TIP[i]) / ref;
  return 1 - inv(reach / MCP.length, 0.44, 0.70);
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
  /* Straight projection, right down to nothing.
   *
   * A floor under this looks kinder and is worse. Pitch a hand from pointing
   * slightly down-and-away to slightly up-and-away and its axis passes through
   * the camera line, where the direction genuinely reverses — so a stick with a
   * minimum length snaps end for end at that instant, which is the flip all
   * over again, just moved somewhere less obvious. Let the length go to zero
   * with it and the reversal is a stick shrinking to a point and growing back
   * the other way, which is what a real one does and is perfectly continuous.
   * It also makes the aiming rule legible: tip your hand further down at the
   * kit and the stick gets longer. */
  const reach = unit * clamp(conf, 0, 1);
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
export function poseOf(lm, { mode = FINGER, length = LENGTH, world = null } = {}) {
  if (!lm) return null;
  const span = spanOf(lm, world);
  return mode === STICK
    ? stickFrom({ grip: gripOf(lm), axis: axisOf(lm, span), span }, length)
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
 * of thing. **Angle** is a pose and gets a couple of frames of lag — but *more*
 * when the axis is foreshortened, because a direction turning into noise is
 * worth lagging and the stick is short by then anyway, so the lag barely shows.
 * **Span** is a measurement of a hand that is not changing size, so it is
 * smoothed hard: length flicker is the single thing that makes a drawn stick
 * look fake. **Position** is by default not smoothed at all — it is what
 * contact is measured from, and lag there is latency you can hear.
 *
 * Fingertip mode smooths nothing but the span. The tip is a landmark the
 * tracker reports directly; there is no derived direction to steady, and any
 * filtering would be pure latency on the one number that matters.
 */
export class PoseFilter {
  constructor(tau = 0.045, posTau = 0) { this.tau = tau; this.posTau = posTau; this.mode = FINGER; this.reset(); }
  reset() { this.ax = null; this.ay = 1; this.span = 0; this.px = 0; this.py = 0; }
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

    const a = axisOf(lm, this.span), g = gripOf(lm);
    if (this.ax === null) { this.ax = a.x; this.ay = a.y; this.px = g.x; this.py = g.y; }
    else {
      // Lag the angle harder the less the axis can be believed.
      const tau = this.tau * (1 + 4 * (1 - smooth(a.conf, 0.18, 0.85)));
      const k = 1 - Math.exp(-step / tau);
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
