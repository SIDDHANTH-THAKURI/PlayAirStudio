/**
 * stick.js — putting a drumstick in your hand.
 *
 * The instrument is played with sticks, not fingertips, and that is a
 * detection decision as much as a visual one.
 *
 * A drum stroke is a wrist flick. The wrist itself barely travels — rotate the
 * hand thirty degrees and the knuckles move almost nowhere — so watching a
 * fingertip means watching the smallest part of the gesture. A stick is a
 * lever: the tip sits a couple of palm-spans out along the hand, so the same
 * flick swings it several times as far and several times as fast. The motion
 * the detector has to recognise is therefore much larger than the motion the
 * player actually makes, which is exactly the right way round.
 *
 * **The stick lies along the index finger.** Point, and it appears as a
 * continuation of the finger you are pointing with — butt behind the knuckle,
 * shaft running exactly through the knuckle and the fingertip, tip carrying on
 * past. That is what makes it legible: you are not aiming an invisible object
 * attached to a fist, you are aiming the finger you can see, and the stick is
 * simply where that finger is already pointing.
 *
 * It is also the more robust signal, which was not obvious until a fist was
 * tried first. A closed hand held naturally in front of a webcam points its
 * knuckles *at the camera*, so the palm axis is foreshortened to almost
 * nothing and its direction becomes noise — the stick flails, or the grip
 * never registers at all. An extended index finger is a long, well-defined
 * line in the image whichever way the hand is turned.
 *
 * Pointing is what arms it: extend your index finger and you are holding a
 * stick, relax your hand and you have put it down. Resting, gesturing,
 * scratching your nose — all silent, without any special case for any of them.
 *
 * Pure geometry: no DOM, no audio.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

const INDEX_MCP = 5, INDEX_TIP = 8;
const OTHER_MCP = [9, 13, 17], OTHER_TIP = [12, 16, 20];

/**
 * Stick length from the index knuckle, in palm spans.
 *
 * An extended index finger is about 0.9 spans, so at 2.2 the stick carries on
 * roughly another 1.3 spans past the fingertip — visibly a stick rather than a
 * long finger, without putting the tip so far out that reaching the near drums
 * means pointing off the bottom of the frame.
 */
export const LENGTH = 2.2;

/**
 * Where the stick is, given one hand's landmarks.
 *
 * The shaft is the line through the index knuckle and the index fingertip,
 * extended, so it passes *exactly* through the finger it is drawn on. The butt
 * pokes out behind the knuckle because a real one does, and because it makes
 * the hand read as holding the stick rather than as having one glued to it.
 *
 * @returns { butt, grip, tip, axis, span } in image-normalised coordinates.
 */
export function stickOf(lm, length = LENGTH) {
  if (!lm) return null;
  const knuckle = lm[INDEX_MCP], point = lm[INDEX_TIP];

  let ax = point.x - knuckle.x, ay = point.y - knuckle.y;
  const len = Math.hypot(ax, ay);
  if (!(len > 1e-6)) return null;
  ax /= len; ay /= len;

  // The palm span is the ruler everything else is measured in, exactly as in
  // the other instruments: it barely changes with pose, so one set of
  // thresholds covers a hand near the camera and the same hand far away. Taken
  // across the palm rather than along the finger, so curling the finger cannot
  // change the scale everything is measured in.
  const span = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y) || 1e-6;

  return {
    span,
    axis: { x: ax, y: ay },
    grip: { x: knuckle.x, y: knuckle.y },
    butt: { x: knuckle.x - ax * span * 0.55, y: knuckle.y - ay * span * 0.55 },
    tip: { x: knuckle.x + ax * span * length, y: knuckle.y + ay * span * length },
  };
}

/** How far a finger reaches from its own knuckle, in palm spans. */
function reachOf(lm, mcp, tip, span) {
  return Math.hypot(lm[tip].x - lm[mcp].x, lm[tip].y - lm[mcp].y) / span;
}

/**
 * How much this hand is pointing, 0 (not at all) to 1 (unmistakably).
 *
 * Index out, the rest in. Both halves matter: without the second, a flat open
 * hand waved at the camera would arm a stick and start playing drums, which is
 * the one thing this gesture exists to prevent.
 *
 * Deliberately forgiving about *how* curled the others are. A comfortable
 * pointing hand does not fold its remaining fingers into a tight fist, and
 * demanding one is how a gesture goes from natural to a pose you have to hold.
 */
export function pointOf(lm) {
  if (!lm) return 0;
  const span = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y) || 1e-6;
  const index = reachOf(lm, INDEX_MCP, INDEX_TIP, span);
  let others = 0;
  for (let i = 0; i < OTHER_MCP.length; i++) others += reachOf(lm, OTHER_MCP[i], OTHER_TIP[i], span);
  others /= OTHER_MCP.length;

  const out = inv(index, 0.52, 0.80);        // the index is extended…
  const in_ = 1 - inv(others, 0.50, 0.86);   // …and the rest are not
  return out * in_;
}

/**
 * A stick whose direction is smoothed over time.
 *
 * This exists because the lever cuts both ways. Putting the tip two spans out
 * multiplies the real gesture by two, which is the whole idea — and it
 * multiplies the tracker's *noise* by two as well, which is not. A three
 * hundredth of a span of wobble at the knuckle is nothing; the same wobble
 * rocking the finger's direction throws the tip a tenth of a span, and at sixty
 * frames a second that is six spans per second of apparent speed, which is
 * quite fast enough to look like somebody hitting a drum. A hand held perfectly
 * still would play.
 *
 * Only the *direction* is filtered, and the shaft still starts exactly at the
 * knuckle, because that is where the amplification is: the knuckle's own jitter
 * is not multiplied by anything and needs no help.
 *
 * `tau` is the trade. The detector wants it quiet and can afford a couple of
 * frames of lag; the drawn stick wants to stay glued to the finger and can
 * afford some shimmer. So they use different ones rather than compromising on
 * a single value that suits neither.
 */
export class StickFilter {
  constructor(tau = 0.030) { this.tau = tau; this.ax = null; this.ay = 0; }
  reset() { this.ax = null; }

  update(lm, length = LENGTH, dt = 1 / 60) {
    const raw = stickOf(lm, length);
    if (!raw) return null;
    if (this.ax === null) { this.ax = raw.axis.x; this.ay = raw.axis.y; }
    else {
      const a = 1 - Math.exp(-Math.max(dt, 1e-4) / this.tau);
      this.ax += (raw.axis.x - this.ax) * a;
      this.ay += (raw.axis.y - this.ay) * a;
    }
    const m = Math.hypot(this.ax, this.ay);
    if (!(m > 1e-6)) return raw;
    const ax = this.ax / m, ay = this.ay / m;
    const { grip, span } = raw;
    return {
      span,
      axis: { x: ax, y: ay },
      grip,
      butt: { x: grip.x - ax * span * 0.55, y: grip.y - ay * span * 0.55 },
      tip: { x: grip.x + ax * span * length, y: grip.y + ay * span * length },
    };
  }
}

/** Schmitt trigger so a hand hovering near the threshold can't strobe. */
export class Pointing {
  constructor(on = 0.5, off = 0.26) { this.on = on; this.off = off; this.held = false; }
  update(p) {
    this.held = this.held ? p > this.off : p > this.on;
    return this.held;
  }
}
