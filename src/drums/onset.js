/**
 * onset.js — recognising a drum stroke.
 *
 * The first version of this file asked "did the stick accelerate and then stop
 * abruptly?", borrowed from the piano's tap detector, and it was the wrong
 * question twice over.
 *
 * **It was late by construction.** A stop can only be recognised after it has
 * happened: the detector had to watch the speed fall to roughly half its peak,
 * and in mid-air a hand takes something like a tenth of a second to brake. That
 * is a tenth of a second of latency that no amount of tuning could remove,
 * added to whatever the tracker already costs, on the one instrument where
 * timing is the entire performance. It felt like playing over a bad phone line.
 *
 * **And it was fragile.** A stroke had to clear an approach speed, then a peak,
 * then a travel distance, then decelerate by the right ratio inside a window,
 * all before a timeout — five gates in series, each with its own way of
 * quietly dropping a stroke you definitely played, and no way to tell which one
 * had done it.
 *
 * So the question is now a much simpler one: **did the tip come down through a
 * drum?** The kit is drawn on screen, each drum has a surface (`kit.js`), and a
 * hit is the tip crossing that surface downward with some speed behind it.
 *
 * That single change fixes both problems at once. It fires on the frame the
 * crossing happens rather than a tenth of a second after the fact — and because
 * the crossing sits *between* two samples, the exact moment can be interpolated
 * and the hit placed there, so a roll comes out even instead of quantised to
 * whenever the tracker happened to look. And there is only one gate left, on a
 * quantity the player can see: you are over that drum, you came down through
 * it, it sounds.
 *
 * What is lost is worth naming. A stroke swung at a gap between two drums used
 * to be caught by a nearest-pad search and played anyway; now it plays nothing.
 * The zones in `kit.js` are sized so those gaps barely exist inside the kit, and
 * the aimed drum is ringed continuously on screen, so a miss is something you
 * can see coming rather than something you discover afterwards.
 *
 * Pure: no DOM, no audio.
 */
import { PoseFilter, holdOf, Grip, STICK, FINGER } from './stick.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

/* Distances and speeds at the striking point, measured in the **pose's own
 * unit** — the stick's reach, or a palm span for a fingertip — which `stick.js`
 * holds inside a screen range whatever size the player's hand appears. Raw palm
 * spans would be the obvious unit and are the wrong one: a hand near the camera
 * is several times a hand at arm's length, so a threshold in spans quietly
 * means something different for every player and every seating position, on a
 * kit whose drums are at fixed places on the screen. */
export const DEFAULTS = {
  MIN_SPEED:  1.05,  // units/s downward at the surface for a crossing to count
  VEL_SOFT:   1.6,   // peak speed for the quietest stroke…
  VEL_HARD:   10.5,  // …and the loudest
  PEAK_HOLD:  0.11,  // s; loudness comes from the fastest part of the swing
  LIFT:       0.18,  // units the tip must come back up before it can hit again
  SLACK:      0.80,  // …or this long, whatever the tip did. See 'rearming'.
  REFRACTORY: 0.045, // s of silence after a hit — a fast roll is ~10 hits/s
  SETTLE:     0.10,  // s ignored after a hand appears, while filters fill
  SMOOTH:     0.010, // s of velocity smoothing; sits in the latency budget
  MAX_JUMP:   37,    // units/s past which this is the tracker re-acquiring
};

/**
 * What changes between playing with sticks and playing with a fingertip.
 *
 * Not much, and that is the point of measuring in the pose's own unit — but a
 * fingertip is not a stick and two things genuinely differ. A tap is a smaller,
 * quicker gesture than a swing, so the floor comes down; and a fingertip is a
 * landmark the tracker reports directly rather than a point projected two
 * spans off the end of a hand, so it is far quieter and can afford it.
 */
export const MODES = {
  [STICK]: {},
  [FINGER]: { MIN_SPEED: 1.8, VEL_SOFT: 2.4, VEL_HARD: 13.0, LIFT: 0.14, REFRACTORY: 0.055 },
};

class Arm {
  constructor(t, mode) {
    this.grip = new Grip();
    /* Angle smoothing only — position is deliberately raw, because position is
     * what contact is measured from and lag there is latency you can hear. */
    this.filter = new PoseFilter(0.045);
    this.filter.setMode(mode);
    this.prev = null;          // { x, y, t } — the previous tip sample
    this.v = 0;                // smoothed downward speed, spans/s
    this.peak = 0; this.peakAt = -9;
    this.armed = true;         // has come back up since the last hit
    this.ready = false;        // …and is over a drum, above its surface
    this.deepest = -9;         // lowest the tip has been since the last hit
    this.firedAt = -9;
    this.seenAt = t; this.since = t;
    this.holding = false;
    this.over = null;
    this.stick = null;
  }
}

export class StickDetector {
  constructor(opts = {}) {
    this.base = { ...opts };
    this.mode = FINGER;
    this.o = { ...DEFAULTS, ...MODES[FINGER], ...opts };
    this.arms = new Map();
    this.kit = null;
    this.reach = undefined;    // stick length, in palm spans; see setReach
    this.lastT = null;
  }

  reset() { this.arms.clear(); this.lastT = null; }

  /** Sticks, or a fingertip. See `MODES`. */
  setMode(mode) {
    this.mode = MODES[mode] ? mode : FINGER;
    this.o = { ...DEFAULTS, ...MODES[this.mode], ...this.base };
    this.arms.clear();
  }

  /** Without a kit there are no surfaces, so nothing can be struck. */
  setKit(kit) {
    this.kit = kit;
    for (const A of this.arms.values()) { A.armed = true; A.deepest = -9; }
  }

  /**
   * Match the stick the player can see. Contact happens at the *tip*, so
   * measuring one length while drawing another would put hits somewhere nobody
   * aimed — the single most confusing thing an air instrument can do.
   */
  setReach(spans) { this.reach = spans; this.arms.clear(); }

  /** Read-only, for the overlay: what is this hand doing right now? */
  state(id) { return this.arms.get(id) || null; }

  /**
   * @param frame [{ id, lm, world }] — id stable per hand ('left' | 'right').
   * @param t     seconds, monotonic, stamped when the frame was *captured*.
   * @returns [{ id, pad, x, y, t, velocity, peak, ox, vx, vy }] — one per hit,
   *          at the point on the surface where the tip came through it.
   */
  update(frame, t) {
    const o = this.o;
    const dt = this.lastT === null ? 1 / 60 : clamp(t - this.lastT, 1 / 240, 0.25);
    this.lastT = t;
    const out = [];
    const present = new Set();

    for (const hand of frame || []) {
      if (!hand?.lm) continue;
      let A = this.arms.get(hand.id);
      if (!A) { A = new Arm(t, this.mode); this.arms.set(hand.id, A); }

      const stick = A.filter.update(hand.lm, this.reach, dt, hand.world);
      if (!stick) continue;
      present.add(hand.id);

      // A hand that blinked out and came back has a stale tip; the jump between
      // the two is not a stroke the player played.
      if (t - A.seenAt > 0.25) {
        A.prev = null; A.since = t; A.armed = true; A.deepest = -9; A.v = 0; A.peak = 0;
        A.filter.reset();
      }
      A.seenAt = t;
      A.stick = stick;
      A.holding = A.grip.update(holdOf(hand.lm, this.mode, hand.world));

      const tip = stick.tip;
      const zone = this.kit ? this.kit.zoneAt(tip) : null;
      A.over = zone ? zone.id : null;

      const prev = A.prev;
      A.prev = { x: tip.x, y: tip.y, t };
      // Nothing to compare against yet. Being armed costs nothing here: a
      // crossing needs a sample above the surface *and* one below it, so a hand
      // that appears already low simply cannot fire until it has come up.
      if (!prev) continue;

      const step = Math.max(t - prev.t, 1 / 240);
      const vy = ((tip.y - prev.y) / step) / stick.unit;   // units/s, + is down
      if (Math.abs(vy) > o.MAX_JUMP) { A.v = 0; A.peak = 0; A.armed = true; A.deepest = -9; continue; }
      A.v += (vy - A.v) * (1 - Math.exp(-step / o.SMOOTH));

      /* Loudness comes from the fastest moment of the swing, not from whichever
       * sample happened to land on the surface. At a low tracking rate those
       * are rarely the same frame, and taking the last one alone makes a hard
       * stroke read as a soft one purely because of when the camera looked. */
      if (A.v > A.peak || t - A.peakAt > o.PEAK_HOLD) {
        A.peak = Math.max(A.v, 0); A.peakAt = t;
      }

      /* Rearming. Coming back *up* is what reloads the stroke, which is how
       * drumming works anyway — and it is measured as travel from the lowest
       * the tip has been rather than as a height above anything, because the
       * kit is a staircase of surfaces at different heights. Rearming against
       * whichever drum the tip currently happens to be over lets one long swing
       * down the frame sound every drum it passes: it goes through the hi-hat,
       * and is immediately "above" the snare's lower surface, and fires again.
       *
       * The timeout is the important part. Requiring the lift and nothing else
       * means one unseen recovery — an occluded hand, a dropped frame, a player
       * who drifts back up too gently to measure — takes that stick out of
       * service permanently, and a dead hand is a far worse failure than an
       * extra hit. After this long, whatever comes next is a new gesture. */
      if (tip.y <= A.deepest - o.LIFT * stick.unit || t - A.firedAt > o.SLACK) A.armed = true;
      A.deepest = Math.max(A.deepest, tip.y);

      const surf = zone ? this.kit.surfaceY(zone) : 0;
      A.ready = !!zone && A.armed && A.holding && tip.y < surf;

      if (!zone || !A.holding || t - A.since < o.SETTLE) continue;
      if (!A.armed || t - A.firedAt < o.REFRACTORY) continue;
      if (!(prev.y < surf && tip.y >= surf)) continue;
      if (A.v < o.MIN_SPEED) continue;

      /* Where and when, *between* these two samples, the tip met the head. At
       * twenty-five looks a second the difference between this and "now" is up
       * to forty milliseconds of timing error, applied at random — which is
       * exactly the thing that makes a steady roll sound drunk. */
      const u = clamp((surf - prev.y) / (tip.y - prev.y), 0, 1);
      const x = prev.x + (tip.x - prev.x) * u;
      A.armed = false; A.ready = false; A.firedAt = t; A.deepest = tip.y;

      const peak = Math.max(A.peak, A.v);
      out.push({
        id: hand.id, pad: zone.id,
        x, y: surf, t: prev.t + (t - prev.t) * u,
        velocity: this._velocity(peak), peak,
        ox: clamp((x - zone.x) / zone.rx, -1, 1),
        vx: (tip.x - prev.x) / step, vy: (tip.y - prev.y) / step,
      });
    }

    for (const [id, A] of this.arms) if (!present.has(id) && t - A.seenAt > 1.5) this.arms.delete(id);
    return out;
  }

  /** Peak tip speed → how hard it was hit. */
  _velocity(peak) {
    const u = inv(peak, this.o.VEL_SOFT, this.o.VEL_HARD);
    return clamp(0.20 + 0.80 * Math.pow(u, 0.65), 0.20, 1);
  }
}
