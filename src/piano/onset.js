/**
 * onset.js — deciding that a fingertip just *struck* the desk.
 *
 * This is the whole instrument. Everything else is plumbing: if this misfires
 * the thing is a toy, and if it lags the thing is unplayable. So it is worth
 * being explicit about what was tried and why this is what survived.
 *
 * ── Approach 1: proximity. "Fire when the fingertip is within ε of the table
 * plane." Fails three ways. MediaPipe's world landmarks are *hand-relative*
 * (origin at the hand's own centre), so there is no scene-anchored height to
 * threshold in the first place. Even with one, a slow deliberate hover-down
 * fires exactly like a strike, so the instrument speaks when you were still
 * deciding. And there is no velocity anywhere in it, so every note is the same
 * loudness — which is most of what makes a piano a piano.
 *
 * ── Approach 2: velocity threshold. "Fire when downward speed exceeds X."
 * Better, and it does yield a loudness. But it fires *during* the approach,
 * before the finger has arrived, so onset timing wanders with how hard you
 * played — the harder you hit, the earlier the note, which is backwards. And
 * it cannot tell a strike from simply moving your hand somewhere else quickly.
 *
 * ── Approach 3 (this one): the strike signature. A finger hitting a solid
 * surface has a kinematic fingerprint nothing else a hand does on a desk
 * shares: speed climbing along the approach, then a *discontinuity* — the desk
 * stops it dead inside a couple of frames. Repositioning your hand decelerates
 * smoothly. A hover never peaks. A lift travels the wrong way. A sideways
 * sweep is perpendicular to the approach axis and projects to nothing. So the
 * detector waits for accelerate-then-abruptly-stop, and fires on the *stop* —
 * which is also the physically correct instant, the moment the note would
 * sound on a real key. The peak speed measured right before that stop is,
 * conveniently, exactly the quantity a piano hammer turns into loudness, so
 * velocity falls out of the detection instead of being bolted on afterwards.
 *
 * Two normalisations make the thresholds device- and player-independent:
 *
 *   • Everything is measured in *palm spans* (wrist→middle-knuckle distance),
 *     not pixels. A hand near the camera and the same hand far away then
 *     produce the same numbers, so one threshold covers both, and small hands
 *     and large hands behave alike.
 *   • Speed is taken from frame-to-frame *displacement* normalised by the span
 *     of that frame, never from a normalised absolute position. Normalising
 *     positions would make the hand simply drifting nearer the camera — which
 *     grows the span — read as motion, and manufacture strikes out of nothing.
 *
 * The approach axis is *learned*. It starts at straight-down in the image and
 * blends toward whatever direction confirmed strikes actually travelled, which
 * is how one detector covers a laptop lid tilted 30° over the desk and a phone
 * propped nearly overhead, where a real vertical tap projects to very different
 * image directions. It is clamped to ±55° of vertical so a run of bad samples
 * cannot walk it somewhere absurd.
 *
 * Pure: no DOM, no audio, no calibration. `test/piano.mjs` drives it with
 * synthetic trajectories.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const inv = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

/** Fingertip landmarks and the knuckle each one is measured against. */
export const TIPS = [4, 8, 12, 16, 20];
const MCPS = [2, 5, 9, 13, 17];
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/* Thresholds. Every distance is in palm spans, every speed in spans/second.
 * Tuned against the synthetic trajectories in test/piano.mjs — see the notes
 * there for what each one is holding off. */
export const DEFAULTS = {
  APPROACH:   1.5,   // spans/s that opens a candidate strike
  MIN_PEAK:   2.2,   // …and the peak it must actually reach to count
  MIN_TRAVEL: 0.085, // spans covered during the approach; rejects jitter spikes
  STOP_RATIO: 0.38,  // "stopped" = speed fell to this fraction of its peak
  MAX_STOP:   0.10,  // s from peak to stop. THE abruptness test (see below)
  MAX_STRIKE: 0.32,  // s a whole approach may take before we call it a drift
  REFRACTORY: 0.075, // s of silence after a hit
  REARM_LIFT: 0.045, // spans the finger must come back up before it can re-fire
  /* Tip-to-knuckle distance, as a sanity check that this is a finger reaching
   * rather than a fist. Deliberately generous: the camera looks along the
   * finger, so a curved hand — which is exactly how anyone actually plays —
   * foreshortens hard in the image, and a strict value here silently refuses
   * to play for people holding their hands correctly. A fist is caught by
   * articulation anyway, since it has none. */
  MIN_EXTEND: 0.26,
  MAX_JUMP:   26,    // spans/s past which this is a tracking glitch, not a finger
  VEL_SOFT:   2.2,   // peak speed mapping to the quietest note…
  VEL_HARD:   13.0,  // …and to the loudest
  SMOOTH:     0.012, // s time constant on the velocity estimate. Small on
                     // purpose: this sits directly in the latency budget,
                     // because the note fires on the frame the collapse is
                     // *seen*, and smoothing delays seeing it.
  SETTLE:     0.12,  // s to ignore after a hand appears, while filters fill
  LEARN:      0.22,  // how strongly each confirmed strike steers the axis
  /* Telling the finger that hit the desk from the ones that merely came along
   * for the ride. See `_arbitrate`. */
  MIN_ARTIC:  0.045, // spans a finger must move *relative to its own palm*
  CLUSTER:    0.055, // s within which strikes are considered one gesture
  CHORD_RATIO: 0.55, // …and how strong a follower must be to count as a chord
};

/**
 * Playing against a desk, or against a plane you imagined in the air.
 *
 * The detector needs no change of principle for either — a mimed strike still
 * accelerates and then stops — but the *stop* is a different event. Wood
 * arrests a finger in a millisecond or two; stopping yourself in mid-air is a
 * deliberate brake that takes tens of milliseconds however crisply you do it.
 * So air playing needs a longer window to still count as abrupt, and a slightly
 * lower bar for the peak, because there is nothing to hit and people naturally
 * mime more gently than they strike.
 *
 * Everything else — articulation, arbitration, the learned axis — is identical,
 * which is why air mode is a table of three numbers rather than a second
 * detector.
 */
export const SURFACES = {
  desk: {},
  air: { MAX_STOP: 0.14, STOP_RATIO: 0.46, MIN_PEAK: 1.9 },
};

const MAX_TILT = 0.96;   // rad (~55°) the learned axis may lean from vertical

/** Per-finger strike machine. Phases: armed → falling → cooling → armed. */
class Finger {
  constructor() { this.reset(); }
  reset() {
    this.phase = 'armed';
    this.v = 0;           // smoothed approach speed, spans/s
    this.peak = 0;        // largest speed seen this approach
    this.tPeak = 0;       // …and when, which is what makes "abrupt" measurable
    this.t0 = 0;          // approach start
    this.travel = 0;      // spans covered since the approach began
    this.palmTravel = 0;  // …and how much of that was the whole hand moving
    this.lift = 0;        // spans travelled back up since the hit
    this.dx = 0; this.dy = 0;   // raw image displacement, for axis learning
    this.firedAt = -9;
    this.sounded = false;       // did this stroke actually play a note?
  }
}

class Hand {
  constructor() {
    this.fingers = Array.from({ length: 5 }, () => new Finger());
    this.prev = null;      // previous frame's fingertip positions
    this.prevPalm = null;
    this.seenAt = -9;
    this.since = 0;        // when this hand was (re)acquired
    this.cluster = null;   // { t, artic } — the strike this one might belong to
  }
}

/**
 * Which fingers are allowed to play.
 *
 * Ten fingers is the instrument this was built for, and for a lot of people it
 * is also the problem: play a note with the index and the middle finger comes
 * down with it, and while `_arbitrate` catches most of that, "most" is not the
 * same as never — and a stray note is far more annoying than a missing one.
 * Restricting the hand to one finger removes the question rather than
 * answering it better, and it is the pose people naturally adopt anyway when
 * they are picking out a melody rather than playing chords.
 *
 * It is a *detector* setting rather than a filter over the output on purpose.
 * A finger that is not playing must not enter the strike machine at all, or it
 * still joins clusters in arbitration and can talk a real strike out of
 * sounding — which would make the option that exists to stop wrong notes
 * quietly start swallowing right ones.
 *
 * It also needs its own thresholds, and that was not obvious. Two of the
 * defaults exist purely to answer the question this mode has already removed,
 * and left at their full strength they made one-finger playing miss roughly a
 * third of what it was asked to play:
 *
 *  • **`MIN_EXTEND`** checks the fingertip is far enough from its knuckle to be
 *    a finger reaching rather than a fist. Point at a surface in front of you
 *    and your index points *away from the lens*, so it foreshortens and can sit
 *    under the bar — and then the strike never starts at all. With all five
 *    fingers this rarely bites, because a *reaching* finger's own travel pushes
 *    the measurement over the line partway through the tap; a rigid pointing
 *    finger never does. Whether you cleared it came down to the angle of your
 *    hand, which is why it felt intermittent rather than broken.
 *  • **`MIN_ARTIC`** asks the fingertip to travel further than its own palm,
 *    which is exactly and only how a striking finger is told from the four
 *    riding along with it. With one finger there is nobody to tell it from —
 *    and pointing stiffens the finger, so much of the travel is wrist and arm
 *    rather than reach.
 *
 * Both are relaxed rather than removed. Articulation still earns its place
 * here: a pointed hand *put down* and a pointed hand *tapping* have the same
 * kinematics if the finger never moves relative to the palm, so something has
 * to separate them, and this is the only thing that can. `test/piano.mjs`
 * measures both edges — what the relaxation catches, and that placing a hand
 * stays silent.
 */
export const FINGER_SETS = {
  all: { fingers: [0, 1, 2, 3, 4], opts: {} },
  index: { fingers: [1], opts: { MIN_EXTEND: 0.12, MIN_ARTIC: 0.022 } },
};

export class TapDetector {
  constructor(opts = {}) {
    this.base = { ...opts };
    this.surface = 'desk';
    this.fingers = 'all';
    this.active = FINGER_SETS.all.fingers;
    this._retune();
    this.hands = new Map();
    // Straight down in image space until strikes teach us otherwise.
    this.dir = { x: 0, y: 1 };
    this.learned = 0;
    this.lastT = null;
    /** Set by the app to follow the damper with the finger. `({id, finger, t})` */
    this.onLift = null;
  }

  reset() { this.hands.clear(); this.dir = { x: 0, y: 1 }; this.learned = 0; this.lastT = null; }

  /** Which finger set is in force. */
  get fingerSet() { return this.fingers; }

  /**
   * The one place thresholds are assembled: defaults, then what the surface
   * asks for, then what the finger set asks for, then anything the caller was
   * explicit about — which wins, because being explicit is the point of it.
   */
  _retune() {
    this.o = { ...DEFAULTS, ...SURFACES[this.surface],
      ...FINGER_SETS[this.fingers].opts, ...this.base };
  }

  /** Retune for a desk or for a plane in mid-air. See `SURFACES`. */
  setSurface(kind) {
    this.surface = SURFACES[kind] ? kind : 'desk';
    this._retune();
  }

  /** All ten fingers, or one index finger each. See `FINGER_SETS`. */
  setFingers(kind) {
    this.fingers = FINGER_SETS[kind] ? kind : 'all';
    this.active = FINGER_SETS[this.fingers].fingers;
    this._retune();
    // A finger that was mid-strike when it was switched off would otherwise sit
    // in `falling` forever and come back holding a note nobody played.
    for (const H of this.hands.values()) { for (const f of H.fingers) f.reset(); H.cluster = null; }
  }

  /** Is this finger one of the ones that plays? */
  plays(finger) { return this.active.includes(finger); }

  /** Read-only peek for the overlay: what is this finger doing right now? */
  state(id, finger) {
    const h = this.hands.get(id);
    return h ? h.fingers[finger] : null;
  }

  /**
   * @param frame [{ id, lm }] — id is stable per hand role ('left' | 'right'),
   *              lm is the 21 image-normalised landmarks for that hand.
   * @param t     seconds, monotonic.
   * @returns [{ id, finger, x, y, velocity, peak, t }] — one per strike, in
   *          image-normalised coordinates so the caller can map them onto the
   *          calibrated table itself.
   */
  update(frame, t) {
    const o = this.o;
    const dt = this.lastT === null ? 1 / 60 : clamp(t - this.lastT, 1 / 240, 0.25);
    this.lastT = t;
    const out = [];

    const present = new Set();
    for (const hand of frame || []) {
      if (!hand?.lm) continue;
      present.add(hand.id);
      let H = this.hands.get(hand.id);
      if (!H) { H = new Hand(); H.since = t; this.hands.set(hand.id, H); }
      // A hand that blinked out and came back has a stale `prev`; the jump
      // between the two positions is not motion the player made.
      if (t - H.seenAt > 0.25) {
        H.prev = null; H.prevPalm = null; H.since = t; H.cluster = null;
        for (const f of H.fingers) f.reset();
      }
      H.seenAt = t;
      this._hand(H, hand, t, dt, out);
    }
    for (const [id, H] of this.hands) if (!present.has(id) && t - H.seenAt > 1.5) this.hands.delete(id);
    return out;
  }

  _hand(H, hand, t, dt, out) {
    const o = this.o, lm = hand.lm;
    // Palm span: the one length on a hand that barely changes with pose, which
    // is what makes it usable as a ruler for everything else.
    const span = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y) || 1e-6;
    const tips = TIPS.map((i) => lm[i]);
    const prev = H.prev;
    H.prev = tips.map((p) => ({ x: p.x, y: p.y }));
    // The palm, tracked the same way, is the reference the fingers are judged
    // against — see `_arbitrate`.
    const palm = { x: (lm[0].x + lm[5].x + lm[17].x) / 3, y: (lm[0].y + lm[5].y + lm[17].y) / 3 };
    const prevPalm = H.prevPalm;
    H.prevPalm = palm;
    if (!prev || !prevPalm) return;
    const dPalm = ((palm.x - prevPalm.x) * this.dir.x + (palm.y - prevPalm.y) * this.dir.y) / span;
    const settling = t - H.since < o.SETTLE;

    for (const f of this.active) {
      const F = H.fingers[f], tip = tips[f];
      // Displacement first, *then* normalise by this frame's span — see the
      // header: normalising position instead would turn "hand moved closer to
      // the camera" into phantom speed.
      const rdx = tip.x - prev[f].x, rdy = tip.y - prev[f].y;
      const d = (rdx * this.dir.x + rdy * this.dir.y) / span;
      const raw = d / dt;
      // Light smoothing only. Heavier would round off the peak and, worse,
      // delay the stop — and the stop is the event we are timing the note to.
      const a = 1 - Math.exp(-dt / o.SMOOTH);
      F.v += (raw - F.v) * a;

      /* A fingertip cannot cross the desk in a single sample. A jump that big
       * is the tracker re-acquiring after an occlusion — a hand coming back
       * into view, or a frame where the model latched onto the other hand —
       * and taking it at face value fires a note nobody played, right at the
       * moment the player was reaching for a real one. Drop the frame and
       * start this finger over. */
      if (Math.abs(d) > o.MAX_JUMP * dt) { F.reset(); continue; }

      const mcp = lm[MCPS[f]];
      const extend = Math.hypot(tip.x - mcp.x, tip.y - mcp.y) / span;
      const usable = !settling && extend > o.MIN_EXTEND;

      switch (F.phase) {
        case 'armed':
          if (usable && F.v > o.APPROACH) {
            F.phase = 'falling';
            F.t0 = t; F.peak = F.v; F.tPeak = t;
            F.travel = Math.max(0, d); F.palmTravel = Math.max(0, dPalm);
            F.dx = rdx; F.dy = rdy;
          }
          break;

        case 'falling': {
          F.travel += d; F.palmTravel += dPalm; F.dx += rdx; F.dy += rdy;
          if (F.v > F.peak) { F.peak = F.v; F.tPeak = t; }

          // Ran too long to be a strike — this was a hand travelling, not a
          // finger arriving. Drop it and re-arm.
          if (t - F.t0 > o.MAX_STRIKE) { F.phase = 'armed'; break; }

          if (F.v < F.peak * o.STOP_RATIO) {
            /* Speed has collapsed. The question is whether it collapsed
             * *abruptly*, because that is the entire difference between
             * hitting something and merely slowing down. A desk stops a
             * finger within a frame or two; a hand being placed somewhere
             * eases off over a fifth of a second. `MAX_STOP` is that line, and
             * it is why the time of the peak is tracked rather than just its
             * value.
             *
             * The window has to widen when samples are scarce. Seeing a peak
             * and then a stop takes at least two frames, so at 20 looks a
             * second the fixed 100 ms *is* two frames and a genuinely hard tap
             * — which is over fastest — becomes the one thing that cannot
             * satisfy it. Harder playing failing while soft playing worked is
             * exactly backwards, and it was a real miss: the browser test
             * caught it at a sample rate the unit tests were not running at.
             * Below about three samples the distinction is not measurable at
             * all, so scale with dt and let the tracking-rate warning carry
             * the honest message. */
            const abrupt = t - F.tPeak <= Math.max(o.MAX_STOP, dt * 2.5);
            const artic = F.travel - F.palmTravel;
            if (abrupt && F.peak >= o.MIN_PEAK && F.travel >= o.MIN_TRAVEL
                && this._arbitrate(H, artic, t)) {
              F.phase = 'cooling'; F.firedAt = t; F.lift = 0; F.sounded = true;
              this._learn(F.dx, F.dy);
              out.push({
                id: hand.id, finger: f, x: tip.x, y: tip.y,
                velocity: this._velocity(F.peak), peak: F.peak, artic, t,
              });
            } else {
              // A rejected candidate still has to cool off, or it will re-offer
              // itself on the very next frame and every frame after.
              F.phase = 'cooling'; F.firedAt = t; F.lift = 0; F.sounded = false;
            }
          }
          break;
        }

        case 'cooling':
          /* A note that *sounded* needs both time and a real lift before it can
           * sound again — time alone would let a finger resting on the desk
           * retrigger on landmark noise, and requiring the lift means one note
           * per actual tap however long you rest.
           *
           * A candidate that was *rejected* only needs the time. Demanding a
           * lift from it too was over-strict: a tap that fell just short, or
           * one arbitrated away as a passenger, would lock that finger out of
           * the next few notes entirely. Nothing is risked by letting it try
           * again, because articulation is what actually keeps passengers
           * quiet, and that test is applied afresh every time. */
          if (d < 0) F.lift -= d;
          if (t - F.firedAt > o.REFRACTORY && (!F.sounded || F.lift > o.REARM_LIFT)) {
            F.phase = 'armed'; F.peak = 0;
            // Lifting off a real key is what lets the damper fall. Reported
            // separately from strikes so the note stream stays a note stream.
            if (F.sounded && this.onLift) this.onLift({ id: hand.id, finger: f, t });
            F.sounded = false;
          }
          break;
      }
    }
  }

  /**
   * Which of the fingers that just "struck" actually touched the desk?
   *
   * Tap one finger and the others come along for the ride, because the hand
   * itself dips and is then arrested by the finger that landed. Every finger
   * therefore shows the same accelerate-then-stop — the stop is *shared* — and
   * a per-finger detector fires all five. That is the single most reported
   * fault with this kind of instrument, and thresholds cannot fix it: the
   * passengers' motion is genuinely a strike shape.
   *
   * What separates them is not the stop but the *reaching*. The finger that
   * hit the desk travelled further than its own palm did; a passenger simply
   * rode along, so its travel and the palm's are nearly equal. Measuring
   * fingertip travel minus palm travel — articulation — isolates that, and it
   * happens to be free, since both are already being tracked.
   *
   * So: a strike needs real articulation of its own, and any strike arriving
   * in the same brief window as a stronger one must be a decent fraction of it
   * to count as a deliberate chord rather than a passenger. The leader fires
   * immediately and is never delayed for arbitration — this is an instrument,
   * and waiting to see what else arrives would put the wait in every note.
   */
  _arbitrate(H, artic, t) {
    if (artic < this.o.MIN_ARTIC) return false;      // rode the hand, didn't reach
    if (!H.cluster || t - H.cluster.t > this.o.CLUSTER) {
      H.cluster = { t, artic };
      return true;
    }
    if (artic < H.cluster.artic * this.o.CHORD_RATIO) return false;
    H.cluster.artic = Math.max(H.cluster.artic, artic);
    return true;
  }

  /** Peak approach speed → note velocity, curved so soft playing stays usable. */
  _velocity(peak) {
    const u = inv(peak, this.o.VEL_SOFT, this.o.VEL_HARD);
    return clamp(0.16 + 0.84 * Math.pow(u, 0.72), 0.16, 1);
  }

  /**
   * Steer the approach axis toward where strikes actually go.
   *
   * A laptop lid over a desk and a phone propped nearly overhead project the
   * same physical tap to very different image directions, and asking the player
   * to describe their camera angle would be absurd. Each confirmed strike is a
   * labelled example of "this is what down looks like here", so the axis is
   * nudged toward it. The clamp keeps a bad run — a glancing hit, a mistracked
   * frame — from walking the axis somewhere it can never recover from.
   */
  _learn(dx, dy) {
    const m = Math.hypot(dx, dy);
    if (m < 1e-4) return;
    const k = this.o.LEARN;
    let x = this.dir.x * (1 - k) + (dx / m) * k;
    let y = this.dir.y * (1 - k) + (dy / m) * k;
    // Re-express as a lean from straight-down, clamp it, rebuild the unit
    // vector. Doing it in angle space makes "±55°" mean exactly that.
    const ang = clamp(Math.atan2(x, Math.max(y, 1e-6)), -MAX_TILT, MAX_TILT);
    this.dir = { x: Math.sin(ang), y: Math.cos(ang) };
    this.learned++;
  }
}
