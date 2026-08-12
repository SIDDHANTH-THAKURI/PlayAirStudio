/**
 * onset.js — recognising a drum stroke.
 *
 * Same principle as the piano's tap detector, and the reasoning behind it is
 * written up at length in `src/piano/onset.js`: a strike is not a position and
 * not a speed, it is *accelerate then stop abruptly*, and the note belongs on
 * the stop, because that is when a real drum would sound and the peak speed
 * just before it is what a real stick converts into loudness.
 *
 * Three things differ, and they all follow from playing with a stick rather
 * than a finger:
 *
 *  • **One point per hand, not five.** A stick has one tip. All the piano's
 *    machinery for deciding which of five fingers actually struck — and for
 *    ignoring the four that came along for the ride — is simply not needed.
 *  • **No articulation test.** The piano rejects strokes where the fingertip
 *    only moved as much as its palm, because a hand being put down is not a
 *    note. Drumming is the opposite: the whole hand *should* move, that is
 *    what a stroke is. Pointing takes over that job — a relaxed hand has put
 *    the stick down and cannot play.
 *  • **Bigger numbers.** The tip sits two palm-spans out along the hand, so a
 *    wrist flick that barely moves the knuckles swings it several times as
 *    far and as fast. Thresholds are scaled to match, which is what makes a
 *    small, comfortable stroke read clearly.
 *
 * There is nothing to hit, so the stop is a deliberate brake rather than an
 * impact — the same situation as the piano's air mode, and the window that
 * still counts as abrupt is widened for the same reason.
 *
 * Pure: no DOM, no audio, no kit.
 */
import { StickFilter, pointOf, Pointing } from './stick.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

/* Distances in palm spans, speeds in spans/second — measured at the stick tip,
 * which is why these are several times the piano's. */
export const DEFAULTS = {
  APPROACH:   2.2,   // spans/s that opens a candidate stroke
  MIN_PEAK:   3.5,   // …and the peak it must reach to count
  MIN_TRAVEL: 0.15,  // spans the tip must cover; rejects jitter
  STOP_RATIO: 0.52,  // "stopped" = speed fell to this fraction of its peak
  MAX_STOP:   0.17,  // s from peak to stop; braking in air is not instant
  MAX_STRIKE: 0.55,  // s a stroke may take before it is just a hand moving
  REFRACTORY: 0.055, // s of silence after a hit — a fast roll is ~8 hits/s
  REARM_LIFT: 0.10,  // spans the tip must come back up before it can hit again
  REARM_MAX:  0.70,  // …or this long, whatever the tip did. See 'cooling'.
  VEL_SOFT:   3.5,   // peak tip speed for the quietest stroke…
  VEL_HARD:   18.0,  // …and the loudest
  SMOOTH:     0.012, // s; sits directly in the latency budget
  SETTLE:     0.12,  // s ignored after a hand appears, while filters fill
  MAX_JUMP:   60,    // spans/s past which this is a tracking glitch
  LEARN:      0.08,  // how strongly each stroke steers the approach axis
};

/* Deliberately mild, and much milder than the piano's.
 *
 * The piano's taps all go the same way — down onto one plane — so learning that
 * direction is free accuracy. Drum strokes go to seven different places, and a
 * hard axis fitted to the last one *penalises* the next: reach left for the
 * hi-hat, and a stroke down onto the floor tom now projects short and reads as
 * softer than it was, or misses. What is worth learning is only the small
 * standing tilt of a camera that is not level, so the rate is low and the lean
 * is capped well short of anything a stroke direction could drag it to. */
const MAX_TILT = 0.50;   // rad (~29°) the learned axis may lean from vertical

class Arm {
  constructor() {
    this.point = new Pointing();
    // Quieter than the drawn stick's: two frames of lag costs nothing here,
    // and a phantom stroke from tracker noise costs everything.
    this.filter = new StickFilter(0.030);
    this.prevTip = null;
    this.seenAt = -9;
    this.since = 0;
    this.reset();
  }
  reset() {
    this.phase = 'armed';
    this.v = 0; this.peak = 0; this.tPeak = 0; this.t0 = 0;
    this.travel = 0; this.lift = 0;
    this.dx = 0; this.dy = 0;
    this.firedAt = -9;
  }
}

export class StickDetector {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.arms = new Map();
    this.dir = { x: 0, y: 1 };     // straight down until strokes teach otherwise
    this.learned = 0;
    this.lastT = null;
    this.reach = undefined;        // stick length, in palm spans; see setReach
  }

  reset() { this.arms.clear(); this.dir = { x: 0, y: 1 }; this.learned = 0; this.lastT = null; }

  /**
   * Match the stick the player can see. Detection happens at the *tip*, so a
   * longer stick is genuinely a longer lever and a longer throw — measuring one
   * length while drawing another would put the hit somewhere the player did not
   * aim, which is the single most confusing thing an air instrument can do.
   */
  setReach(spans) { this.reach = spans; this.arms.clear(); }

  /** Read-only, for the overlay: what is this hand doing right now? */
  state(id) { return this.arms.get(id) || null; }

  /**
   * @param frame [{ id, lm }] — id stable per hand ('left' | 'right').
   * @param t     seconds, monotonic.
   * @returns [{ id, x, y, velocity, peak, t }] — one per stroke, at the stick
   *          tip in image-normalised coordinates, for the kit to place.
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
      if (!A) { A = new Arm(); A.since = t; this.arms.set(hand.id, A); }
      const stick = A.filter.update(hand.lm, this.reach, dt);
      if (!stick) continue;
      present.add(hand.id);
      // A hand that blinked out and came back has a stale tip; the jump between
      // the two is not a stroke the player played.
      if (t - A.seenAt > 0.25) { A.prevTip = null; A.since = t; A.reset(); A.filter.reset(); }
      A.seenAt = t;
      A.stick = stick;
      A.holding = A.point.update(pointOf(hand.lm));

      const prev = A.prevTip;
      A.prevTip = { x: stick.tip.x, y: stick.tip.y };
      if (!prev) continue;

      const rdx = stick.tip.x - prev.x, rdy = stick.tip.y - prev.y;
      const d = (rdx * this.dir.x + rdy * this.dir.y) / stick.span;
      // A tip cannot cross the frame in one sample; that is the tracker
      // re-acquiring, and believing it would play a stroke nobody made.
      if (Math.abs(d) > o.MAX_JUMP * dt) { A.reset(); continue; }

      const a = 1 - Math.exp(-dt / o.SMOOTH);
      A.v += (d / dt - A.v) * a;

      const usable = A.holding && t - A.since >= o.SETTLE;

      switch (A.phase) {
        case 'armed':
          if (usable && A.v > o.APPROACH) {
            A.phase = 'falling';
            A.t0 = t; A.peak = A.v; A.tPeak = t;
            A.travel = Math.max(0, d); A.dx = rdx; A.dy = rdy;
          }
          break;

        case 'falling': {
          A.travel += d; A.dx += rdx; A.dy += rdy;
          if (A.v > A.peak) { A.peak = A.v; A.tPeak = t; }
          // Relaxing your hand mid-stroke is putting the stick down.
          if (!A.holding || t - A.t0 > o.MAX_STRIKE) { A.phase = 'armed'; break; }

          if (A.v < A.peak * o.STOP_RATIO) {
            // Abruptness is the whole test — a stroke stops, a hand being moved
            // eases off. The window widens when samples are scarce, because
            // seeing a peak and then a stop needs at least two of them.
            const abrupt = t - A.tPeak <= Math.max(o.MAX_STOP, dt * 2.5);
            if (abrupt && A.peak >= o.MIN_PEAK && A.travel >= o.MIN_TRAVEL) {
              A.phase = 'cooling'; A.firedAt = t; A.lift = 0;
              this._learn(A.dx, A.dy);
              out.push({
                id: hand.id, x: stick.tip.x, y: stick.tip.y,
                velocity: this._velocity(A.peak), peak: A.peak, t,
              });
            } else {
              A.phase = 'cooling'; A.firedAt = t; A.lift = 0; A.missed = true;
            }
          }
          break;
        }

        case 'cooling': {
          /* A stroke that *sounded* must see the stick lifted before the next
           * one, which is exactly how drumming works — you cannot hit twice
           * without coming back up. One that was rejected only waits out the
           * refractory, so a stroke that fell just short never costs you the
           * one after it.
           *
           * The time limit is the important part. Requiring the lift and
           * nothing else means one unseen recovery — an occluded hand, a
           * dropped frame, a player who simply drifts back up too gently to
           * measure — takes that stick out of service permanently, and a dead
           * hand is a far worse failure than an extra hit. After this long
           * with nothing happening, whatever comes next is a new gesture. */
          if (d < 0) A.lift -= d;
          const waited = t - A.firedAt;
          if (waited > o.REFRACTORY && (A.missed || A.lift > o.REARM_LIFT || waited > o.REARM_MAX)) {
            A.phase = 'armed'; A.peak = 0; A.missed = false;
          }
          break;
        }
      }
    }

    for (const [id, A] of this.arms) if (!present.has(id) && t - A.seenAt > 1.5) this.arms.delete(id);
    return out;
  }

  /** Peak tip speed → how hard it was hit. */
  _velocity(peak) {
    const u = inv(peak, this.o.VEL_SOFT, this.o.VEL_HARD);
    return clamp(0.18 + 0.82 * Math.pow(u, 0.7), 0.18, 1);
  }

  /**
   * Steer the approach axis toward where strokes actually travel. A kit reached
   * across is struck at an angle, and nobody should have to describe their
   * camera to a drum machine.
   */
  _learn(dx, dy) {
    const m = Math.hypot(dx, dy);
    if (m < 1e-4) return;
    const k = this.o.LEARN;
    const x = this.dir.x * (1 - k) + (dx / m) * k;
    const y = this.dir.y * (1 - k) + (dy / m) * k;
    const ang = clamp(Math.atan2(x, Math.max(y, 1e-6)), -MAX_TILT, MAX_TILT);
    this.dir = { x: Math.sin(ang), y: Math.cos(ang) };
    this.learned++;
  }
}
