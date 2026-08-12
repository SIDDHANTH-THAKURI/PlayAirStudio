/**
 * gestures.js — noisy 21-point landmarks → an instrument you can trust.
 *
 * Both hands run the same front end: per-digit curl → hysteresis → a single
 * discrete SHAPE id ('point', 'peace', 'horns', 'fist', 'palm', …). Everything
 * above that reads shapes, never raw landmarks, which is what keeps the two
 * hands' vocabularies from bleeding into each other.
 *
 * FRETTING hand, two exclusive modes:
 *   grid  — a 4×3 wall of chords. The index *fingertip* is the cursor, and a
 *           cell only commits while the hand is actually POINTING (index out,
 *           middle/ring/pinky in). Hovering with a relaxed hand does nothing,
 *           which is the whole reason the wall is safe to make this big.
 *           ✌️ index+middle = deaden · 🤘 index+pinky = vibrato.
 *   signs — five chords bound to ✋ ✌️ 🤘 👌 🤙. Position stops mattering, so
 *           Y-wobble vibrato is free the whole time. ✊ = deaden.
 *
 * PLUCKING hand, two exclusive modes:
 *   finger — the number of open digits picks one string, one at a time:
 *            1→1st(e) 2→2nd(B) 3→3rd(G) 4→4th(D) 5→5th(A), pinky alone→6th(E).
 *            A shape fires once on arrival; you return toward a fist (or move
 *            to a different count) to re-arm, so a held shape never machine-guns.
 *   strum  — ✊ ✌️ 🤘 🤙 👌 each run a strum pattern while held; ✋ stops.
 *
 * MODE SWITCHING is the same ritual on both hands, and deliberately slow so it
 * can never fire mid-song: hold 👍 for a second to open a two-option dial, tilt
 * the hand left/right to aim, then open your palm to accept.
 *
 * All positions are display-normalised (0..1, mirrored, x grows rightward).
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const inv = (v, a, b) => clamp((v - a) / (b - a), 0, 1);

/* ------------------------------------------------------------------ *
 * One Euro filter — adaptive low-pass. Cutoff rises with speed: heavy
 * smoothing when still (no jitter), light when moving (no lag).
 * ------------------------------------------------------------------ */
class LP { constructor() { this.y = null; }
  f(x, a) { this.y = this.y === null ? x : a * x + (1 - a) * this.y; return this.y; } }

export class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.05, dCutoff = 1.2) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = new LP(); this.dx = new LP(); this.px = null; this.pt = null;
  }
  _a(dt, c) { const tau = 1 / (2 * Math.PI * c); return 1 / (1 + tau / dt); }
  reset() { this.x.y = null; this.dx.y = null; this.px = null; this.pt = null; }
  filter(v, t) {
    if (this.pt === null) { this.pt = t; this.px = v; return this.x.f(v, 1); }
    const dt = clamp(t - this.pt, 1 / 240, 0.1); this.pt = t;
    const d = this.dx.f((v - this.px) / dt, this._a(dt, this.dCutoff)); this.px = v;
    return this.x.f(v, this._a(dt, this.minCutoff + this.beta * Math.abs(d)));
  }
}

/* ---------- landmark helpers (3D world coords where available) ---------- */
const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
function angle(a, b, c) {                       // interior angle at b, radians
  const u = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const v = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
  const n = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z) || 1e-6;
  return Math.acos(clamp((u.x * v.x + u.y * v.y + u.z * v.z) / n, -1, 1));
}
const FINGERS = [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]]; // index→pinky

/**
 * Curl of one finger, 0 = straight, 1 = folded.
 * Knuckle angles, not fingertip distances: distances collapse as soon as the
 * hand rotates toward the camera, angles hold up much better.
 */
function curl(lm, [m, p, d, t]) {
  const straight = (angle(lm[m], lm[p], lm[d]) + angle(lm[p], lm[d], lm[t])) / 2;
  return inv(2.88 - straight, 0, 2.88 - 1.75);
}

/**
 * The thumb doesn't curl like a finger — it sweeps across the palm. Blend its
 * (small) joint flexion with how far the tip has tucked toward the pinky-side
 * knuckle; the tuck is the reliable part on a webcam.
 */
function thumbCurl(w) {
  const flex = inv(2.95 - (angle(w[1], w[2], w[3]) + angle(w[2], w[3], w[4])) / 2, 0, 0.85);
  const span = d3(w[0], w[9]) || 1e-6;
  const tuck = inv(1.05 - d3(w[4], w[17]) / span, 0, 0.75);
  return clamp(flex * 0.35 + tuck * 0.65, 0, 1);
}

/** Schmitt trigger + dwell time — the standard cure for boolean flicker. */
class Latch {
  constructor(on, off, hold = 0.06) { Object.assign(this, { on, off, hold });
    this.state = false; this.pend = false; this.since = 0; }
  update(v, t) {
    const want = this.state ? !(v < this.off) : v > this.on;
    if (want !== this.state) {
      if (!this.pend) { this.pend = true; this.since = t; }
      else if (t - this.since >= this.hold) { this.state = want; this.pend = false; }
    } else this.pend = false;
    return this.state;
  }
}
/** A boolean that must hold `hold` seconds before it's believed. */
class Dwell {
  constructor(hold) { this.hold = hold; this.state = false; this.since = 0; this.want = false; }
  update(v, t) {
    if (v !== this.want) { this.want = v; this.since = t; }
    if (v !== this.state && t - this.since >= this.hold) this.state = v;
    return this.state;
  }
}

/* ================================================================== *
 *  Shapes — the shared vocabulary both hands speak
 * ================================================================== */

export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

/* Per-digit hysteresis. Between the two thresholds a digit keeps whatever it
 * was, so a finger resting in the dead zone can't strobe the whole shape. */
const EXT_AT = 0.40, CURL_AT = 0.58;
const PINCH_AT = 0.42;   // thumb-tip ↔ index-tip, as a fraction of palm span

/**
 * Discrete hand shape from the four finger states + thumb + pinch.
 * Written as an ordered ladder rather than a template table because the
 * thumb-only cases (👍 vs ✊, 🤙 vs pinky-only) need explicit priority.
 *
 * A digit sitting in the hysteresis dead zone reads 'mid' — genuinely unknown,
 * not "curled". Guessing there is how a hand resting half-open would fire a
 * note it never meant, so an unresolved digit that the shape *depends on*
 * makes the whole match null instead.
 */
const known = (s) => s === 'ext' || s === 'curl';
export function matchShape(st, pinchClose) {
  const tk = known(st[0]), T = st[0] === 'ext';
  const M = st[2] === 'ext', R = st[3] === 'ext', P = st[4] === 'ext';
  // 👌 is tested before the resolved-digit guard because it is the one shape
  // whose index finger is *meant* to be ambiguous: it curls into a ring against
  // the thumb and so parks in the hysteresis dead zone forever. The branch
  // never reads the index, so demanding a resolved one would permanently reject
  // the very sign that gesture defines.
  if (known(st[2]) && known(st[3]) && known(st[4]) && M && R && P && pinchClose) return 'ok';
  if (!known(st[1]) || !known(st[2]) || !known(st[3]) || !known(st[4])) return null;
  const I = st[1] === 'ext';
  if (I && M && R && P) return tk ? (T ? 'palm' : 'four') : null;
  if (I && M && R && !P) return 'three';
  if (I && M && !R && !P) return 'peace';                   // ✌️
  if (I && !M && !R && P) return 'horns';                   // 🤘
  if (I && !M && !R && !P) return 'point';                  // ☝️
  if (!I && !M && !R && P) return tk ? (T ? 'call' : 'pinky') : null;
  if (!I && !M && !R && !P) return tk ? (T ? 'thumbup' : 'fist') : null;
  return null;                                             // in-between, believe nothing
}

/** Fretting-hand sign chords, in slot order. */
export const SIGNS = [
  { id: 'palm',  glyph: '✋',  label: 'Open palm' },
  { id: 'peace', glyph: '✌️', label: 'Peace' },
  { id: 'horns', glyph: '🤘', label: 'Horns' },
  { id: 'ok',    glyph: '👌', label: 'OK / zero' },
  { id: 'call',  glyph: '🤙', label: 'Call' },
];

/** Plucking-hand pattern signs, in slot order, with their factory patterns. */
export const STRUM_SIGNS = [
  { id: 'fist',  glyph: '✊',  label: 'Fist',      def: 'drive' },
  { id: 'peace', glyph: '✌️', label: 'Peace',     def: 'arp' },
  { id: 'horns', glyph: '🤘', label: 'Horns',     def: 'travis' },
  { id: 'call',  glyph: '🤙', label: 'Call',      def: 'ballad' },
  { id: 'ok',    glyph: '👌', label: 'OK / zero', def: 'march' },
];

/**
 * Fingerstyle: open-digit shape → voicing string index (0 = low E … 5 = high e).
 * Guitar numbering runs the other way, hence the comments.
 * 'call' shares 'pinky' because an extended little finger often drags the
 * thumb open with it, and both readings mean the same musical intent.
 */
export const FINGER_STRINGS = {
  point: 5,   // 1 digit  → 1st string (high e)
  peace: 4,   // 2 digits → 2nd (B)
  three: 3,   // 3 digits → 3rd (G)
  four:  2,   // 4 digits → 4th (D)
  palm:  1,   // 5 digits → 5th (A)
  pinky: 0,   // little finger alone → 6th (low E)
  call:  0,
};
export const STRING_LABELS = ['6 · low E', '5 · A', '4 · D', '3 · G', '2 · B', '1 · high e'];

/* ================================================================== *
 *  The mode dial — 👍 hold, tilt to aim, ✋ to accept
 * ================================================================== */

const WHEEL_HOLD    = 1.0;   // s of 👍 before the dial opens
const WHEEL_TILT    = 0.30;  // rad of hand roll that commits to a side
const WHEEL_ACCEPT  = 0.22;  // s of ✋ before the highlighted option is taken
const WHEEL_LAPSE   = 1.0;   // s without 👍/✋ that quietly closes the dial
const WHEEL_TIMEOUT = 8;     // s open, then give up on our own
const WHEEL_COOL    = 0.5;   // s after closing during which nothing else fires

class Wheel {
  constructor(count) { this.count = count; this.until = -9; this._clear(); }
  _clear() {
    this.open = false; this.sel = 0; this.arm01 = 0;
    this.armAt = 0; this.acceptAt = 0; this.ref = 0; this.openedAt = -9; this.seenAt = -9;
  }
  reset() { this._clear(); this.until = -9; }

  /** @returns the option index chosen this frame, or -1. */
  update(shape, roll, current, t) {
    if (!this.open) {
      if (shape === 'thumbup' && t >= this.until) {
        if (!this.armAt) this.armAt = t;
        this.arm01 = clamp((t - this.armAt) / WHEEL_HOLD, 0, 1);
        if (this.arm01 >= 1) {
          this._clear();
          this.open = true; this.sel = clamp(current, 0, this.count - 1);
          this.ref = roll; this.openedAt = t; this.seenAt = t;
        }
      } else { this.armAt = 0; this.arm01 = 0; }
      return -1;
    }

    if (shape === 'thumbup') {
      this.seenAt = t; this.acceptAt = 0; this.arm01 = 0;
      const d = roll - this.ref;
      if (d < -WHEEL_TILT) this.sel = 0;
      else if (d > WHEEL_TILT) this.sel = this.count - 1;
    } else if (shape === 'palm') {
      this.seenAt = t;
      if (!this.acceptAt) this.acceptAt = t;
      this.arm01 = clamp((t - this.acceptAt) / WHEEL_ACCEPT, 0, 1);
      if (this.arm01 >= 1) {
        const pick = this.sel;
        this._clear(); this.until = t + WHEEL_COOL;
        return pick;
      }
    } else {
      this.acceptAt = 0; this.arm01 = 0;
      if (t - this.seenAt > WHEEL_LAPSE) { this._clear(); this.until = t + WHEEL_COOL * 0.6; }
    }
    if (this.open && t - this.openedAt > WHEEL_TIMEOUT) { this._clear(); this.until = t + 0.3; }
    return -1;
  }

  /** True while the dial owns the hand — the instrument must stay silent. */
  quiet(t) { return this.open || t < this.until; }
}

/* ================================================================== *
 *  Shared per-hand base: filtered position, digit states, shape, roll
 * ================================================================== */

class HandBase {
  constructor() {
    this.fx = new OneEuro(1.2, 0.09); this.fy = new OneEuro(1.2, 0.09);
    this.cx = new OneEuro(1.6, 0.12); this.cy = new OneEuro(1.6, 0.12);
    this.fist = new Latch(0.66, 0.44, 0.05);
    this.c = [0, 0, 0, 0, 0];                       // smoothed curls
    this.v = [0, 0, 0, 0, 0];                       // curl velocity (1/s)
    this.st = ['mid', 'mid', 'mid', 'mid', 'mid'];  // ext | curl | mid (undecided)
    this.shape = null; this.roll = 0; this.pinch = 1;
    this.present = false; this.lastSeen = -9;
    this.x = 0.5; this.y = 0.5; this.px = 0.5; this.py = 0.5;
    this.cur = { x: 0.5, y: 0.5 };                  // index-fingertip cursor
    this.rawY = 0.5;
  }

  /** Palm centre from wrist + both outer knuckles: far steadier than the wrist. */
  center(lm) {
    return { x: (lm[0].x + lm[5].x + lm[17].x) / 3, y: (lm[0].y + lm[5].y + lm[17].y) / 3 };
  }

  base(hand, t, dt) {
    const lm = hand.lm, w = hand.world || hand.lm;
    const c = this.center(lm);
    const fresh = !this.present;      // re-seed velocity state after dropouts,
    if (fresh) { this.fx.reset(); this.fy.reset(); this.cx.reset(); this.cy.reset(); }
    const nx = this.fx.filter(c.x, t), ny = this.fy.filter(c.y, t);
    this.px = fresh ? nx : this.x; this.py = fresh ? ny : this.y;
    this.x = nx; this.y = ny;
    // The grid cursor is the index fingertip, not the palm: you aim with the
    // finger you point with, or the wall of chords feels like a mitten.
    this.cur = { x: this.cx.filter(lm[8].x, t), y: this.cy.filter(lm[8].y, t) };
    // Near-raw Y lane: One Euro is deliberately sluggish under ~1 Hz, which
    // erases the 4-7 Hz wiggle vibrato detection needs.
    this.rawY = fresh ? c.y : this.rawY + (c.y - this.rawY) * (1 - Math.exp(-dt / 0.015));

    /* --- per-digit curl → hysteresis state → one shape id --- */
    const raw = [thumbCurl(w), curl(w, FINGERS[0]), curl(w, FINGERS[1]),
                 curl(w, FINGERS[2]), curl(w, FINGERS[3])];
    const k = 1 - Math.exp(-dt / 0.035);            // ~35 ms EMA, light
    // A hand that has just appeared has no history, so no digit is decided yet.
    if (fresh) this.st.fill('mid');
    for (let f = 0; f < 5; f++) {
      const prev = fresh ? raw[f] : this.c[f];
      this.c[f] = prev + (raw[f] - prev) * k;
      this.v[f] = fresh ? 0 : (this.c[f] - prev) / Math.max(dt, 1e-3);
      if (this.c[f] > CURL_AT) this.st[f] = 'curl';
      else if (this.c[f] < EXT_AT) this.st[f] = 'ext';
    }
    const span = d3(w[0], w[9]) || 1e-6;
    this.pinch = d3(w[4], w[8]) / span;
    this.shape = matchShape(this.st, this.pinch < PINCH_AT);
    this.openSpeed = Math.max(...this.v.map((v) => -v));   // digits straightening

    // Hand roll for the mode dial: 0 upright, positive tilting right.
    this.roll = Math.atan2(lm[9].x - lm[0].x, -(lm[9].y - lm[0].y));

    this.fistScore = FINGERS.reduce((s, f) => s + curl(w, f), 0) / 4;
    this.isFist = this.fist.update(this.fistScore, t);
    this.fresh = fresh; this.present = true; this.lastSeen = t;
  }

  /** Short dropouts are tracker hiccups, not the player leaving — hold state. */
  miss(t) { if (t - this.lastSeen > 0.25) this.present = false; }
}

/* ================================================================== *
 *  Fretting hand — chord grid or sign chords
 * ================================================================== */

const POINT_DWELL = 0.16;   // s of steady pointing before a grid cell commits
const SIGN_DWELL  = 0.25;   // s a sign must settle before its chord takes over
const CELL_HYST   = 0.28;   // fraction of a cell you must pass to change cell

class FretHand extends HandBase {
  constructor() {
    super();
    this.slot = 0; this.hover = 0; this.col = 0; this.row = 0;
    // `fired` is per *aim acquisition*, not per index. Gating on "is this a
    // different slot than last time" instead would make the engine a second
    // source of truth for the selection, and it desyncs the moment anything
    // else moves it — a mode switch, a number key — leaving a re-point at the
    // stale index silently emitting nothing.
    this.aim = -1; this.aimSince = 0; this.aim01 = 0; this.fired = false;
    this.lastMode = null;
    this.ySlow = null; this.osc = 0; this.flip = 0; this.rate = 5.4; this.bendSm = 0;
    this.vibrato = 0; this.bend = 0; this.dead = false;
    this.wheel = new Wheel(2);
    this.muteDwell = new Dwell(0.07);
    this.mode = 'idle';
  }

  update(hand, t, dt, layout, cfg, out) {
    this.base(hand, t, dt);
    if (this.fresh) { this.ySlow = this.rawY; this.osc = 0; }

    /* --- mode dial owns the hand while it's up --------------------- */
    const pick = this.wheel.update(this.shape, this.roll, cfg.chordMode === 'signs' ? 1 : 0, t);
    if (pick >= 0) out.push({ type: 'mode', hand: 'fret', value: pick === 0 ? 'grid' : 'signs', t });
    if (this.wheel.quiet(t)) { this.mode = 'wheel'; this.aim = -1; this.aim01 = 0; this.clear(); return; }

    const grid = cfg.chordMode !== 'signs';
    this.mode = grid ? 'grid' : 'signs';
    // A mode switch means the old aim refers to a bank that no longer exists.
    if (this.mode !== this.lastMode) {
      this.lastMode = this.mode;
      this.slot = 0; this.col = 0; this.row = 0;
      this.aim = -1; this.aim01 = 0; this.fired = false;
    }

    if (grid) this._grid(t, layout, cfg, out);
    else this._signs(t, out);

    /* --- deaden ------------------------------------------------------
     * Grid mode borrows ✌️ for it (index stays out, so the cursor keeps
     * tracking); sign mode has no spare finger shapes, so a fist does it. */
    const wantDead = grid ? (this.shape === 'peace' || this.shape === 'fist') : this.shape === 'fist';
    this.dead = this.muteDwell.update(wantDead, t);

    /* --- vibrato: oscillation energy on the Y axis --------------------
     * In grid mode Y *means* something (it picks the row), so vibrato only
     * listens while the hand is in the dedicated 🤘 shape — no shape, no
     * wobble. In sign mode position is meaningless and it's always live. */
    this.ySlow = this.ySlow === null ? this.rawY : lerp(this.ySlow, this.rawY, 1 - Math.exp(-dt / 0.22));
    const o = this.rawY - this.ySlow;
    this.osc = lerp(this.osc, Math.abs(o), 1 - Math.exp(-dt / 0.11));
    let vib = inv(this.osc, 0.0045, 0.014);
    const s = Math.sign(o);
    if (s !== 0 && s !== this.lastSign && Math.abs(o) > 0.003) {
      if (this.lastSign) {
        const half = clamp(t - this.flip, 0.05, 0.35);
        this.rate = lerp(this.rate, clamp(1 / (2 * half), 3.5, 7.5), 0.4);
      }
      this.lastSign = s; this.flip = t;
    }
    if (t - this.flip > 0.5) vib *= 0.3;             // slow drift isn't vibrato
    this.vibArmed = grid ? this.shape === 'horns' : true;
    this.vibrato = this.vibArmed ? vib : 0;

    /* --- bend: thumb-index pinch, gated on middle finger extended (a fist
     * would otherwise read as a maximal pinch).
     *
     * Grid mode only. A pinch with the last three fingers out *is* 👌, so in
     * sign mode the bend gesture and a chord are the same hand, and the chord
     * bound to 👌 would ring a whole step sharp every single time. Signs own
     * the shape vocabulary here; bend steps aside, exactly as finger-counting
     * displaces the pattern signs on the other hand. Vibrato survives because
     * it reads motion, not shape. */
    const raw = grid && this.st[2] === 'ext' ? inv(0.55 - this.pinch, 0, 0.31) : 0;
    this.bendSm = lerp(this.bendSm, raw, 1 - Math.exp(-dt / 0.07));
    this.bend = this.bendSm < 0.08 ? 0 : (this.bendSm - 0.08) / 0.92 * 2;  // ≤ whole step
  }

  /** Hysteretic 1-D cell pick: you must clear CELL_HYST of a cell to move. */
  _axis(u, n, cur) {
    const f = u * n;
    const want = clamp(Math.floor(f), 0, n - 1);
    if (want === cur) return cur;
    const edge = want > cur ? cur + 1 : cur;
    return Math.abs(f - edge) > CELL_HYST ? want : cur;
  }

  _grid(t, layout, cfg, out) {
    let u = inv(this.cur.x, layout.neckX0, layout.neckX1);
    if (layout.lefty) u = 1 - u;                      // keep cell 1 on the outside
    const v = inv(this.cur.y, layout.gridY0, layout.gridY1);
    this.col = this._axis(u, cfg.cols, this.col);
    this.row = this._axis(v, cfg.rows, this.row);
    this.hover = this.row * cfg.cols + this.col;

    if (this.shape === 'point') {
      if (this.aim !== this.hover) { this.aim = this.hover; this.aimSince = t; this.fired = false; }
      this.aim01 = clamp((t - this.aimSince) / POINT_DWELL, 0, 1);
      if (this.aim01 >= 1 && !this.fired) {
        this.fired = true; this.slot = this.hover;
        out.push({ type: 'chord', index: this.slot, source: 'grid', t });
      }
    } else { this.aim = -1; this.aim01 = 0; this.fired = false; }
  }

  _signs(t, out) {
    const i = SIGNS.findIndex((s) => s.id === this.shape);
    this.hover = i;
    if (i >= 0) {
      if (this.aim !== i) { this.aim = i; this.aimSince = t; this.fired = false; }
      this.aim01 = clamp((t - this.aimSince) / SIGN_DWELL, 0, 1);
      if (this.aim01 >= 1 && !this.fired) {
        this.fired = true; this.slot = i;
        out.push({ type: 'chord', index: i, source: 'sign', t });
      }
    } else { this.aim = -1; this.aim01 = 0; this.fired = false; }
  }

  clear() { this.vibrato = 0; this.bend = 0; this.dead = false; }
  lost() { this.clear(); this.aim = -1; this.aim01 = 0; this.wheel.reset(); this.mode = 'idle'; }
}

/* ================================================================== *
 *  Plucking hand — one string at a time, or a pattern per sign
 * ================================================================== */

const SHAPE_DWELL = 0.12;   // s a finger count must settle before it sounds
const POSE_DWELL  = 0.42;   // s a sign must hold before its pattern engages
const POSE_COOL   = 0.22;   // s after a pattern stops before another can start

class PluckHand extends HandBase {
  constructor() {
    super();
    this.wheel = new Wheel(2);
    this.mode = 'idle';
    this.target = -1;                   // string the current shape is aimed at
    this.shapeId = null; this.shapeSince = 0; this.fired = false;
    this.peakV = 0; this.hold01 = 0;
    this.active = null;                 // sign id of the running pattern
    this.cand = -1; this.candSince = 0; this.cool = -9;
    this.pickup = 0.5;
  }

  update(hand, t, dt, layout, cfg, out) {
    this.base(hand, t, dt);

    const pick = this.wheel.update(this.shape, this.roll, cfg.playMode === 'strum' ? 1 : 0, t);
    if (pick >= 0) out.push({ type: 'mode', hand: 'pluck', value: pick === 0 ? 'finger' : 'strum', t });
    if (this.wheel.quiet(t)) { this.mode = 'wheel'; this._hush(out, t); return; }

    if (cfg.playMode === 'finger') { this.mode = 'finger'; this._finger(t, out); }
    else { this.mode = 'strum'; this._strum(t, cfg, out); }

    // Passive tone control: distance toward the frame edge = bridge pickup.
    const p = inv(this.x, layout.strumX0, layout.strumX1);
    this.pickup = layout.lefty ? 1 - p : p;
  }

  /** One string per shape; a held shape sounds once and then waits. */
  _finger(t, out) {
    const target = FINGER_STRINGS[this.shape];
    if (target === undefined) {                       // fist / in-between = rest
      this.shapeId = null; this.fired = false; this.hold01 = 0; this.target = -1;
      return;
    }
    if (this.shapeId !== this.shape) {
      this.shapeId = this.shape; this.shapeSince = t; this.fired = false; this.peakV = 0;
    }
    this.peakV = Math.max(this.peakV, this.openSpeed);
    this.target = target;
    this.hold01 = clamp((t - this.shapeSince) / SHAPE_DWELL, 0, 1);
    if (!this.fired && this.hold01 >= 1) {
      this.fired = true;
      // Dynamics from how briskly the digits opened, floored high — this is a
      // calm instrument and a timid reading shouldn't vanish.
      const velocity = clamp(0.58 + 0.42 * inv(this.peakV, 1.5, 7), 0.5, 1);
      out.push({ type: 'pluck', string: target, velocity, t });
    }
  }

  /** A sign held past the dwell runs its pattern until the sign breaks. */
  _strum(t, cfg, out) {
    const i = STRUM_SIGNS.findIndex((s) => s.id === this.shape);
    this.target = -1;
    if (this.active) {
      if (i < 0 || STRUM_SIGNS[i].id !== this.active) {
        out.push({ type: 'pattern', action: 'stop', sign: this.active, t });
        this.active = null; this.cool = t + POSE_COOL; this.hold01 = 0;
      } else this.hold01 = 1;
      this.cand = -1;
      return;
    }
    if (i >= 0 && t >= this.cool) {
      if (this.cand !== i) { this.cand = i; this.candSince = t; }
      this.hold01 = clamp((t - this.candSince) / POSE_DWELL, 0, 1);
      if (this.hold01 >= 1) {
        this.active = STRUM_SIGNS[i].id; this.cand = -1;
        out.push({ type: 'pattern', action: 'start', sign: this.active,
          pattern: cfg.signPatterns?.[this.active] || STRUM_SIGNS[i].def, t });
      }
    } else { this.cand = -1; this.hold01 = 0; }
  }

  /** Silence anything running — used by the dial and by presence loss. */
  _hush(out, t) {
    if (this.active) { out.push({ type: 'pattern', action: 'stop', sign: this.active, t }); this.active = null; }
    this.cand = -1; this.hold01 = 0; this.target = -1;
    this.shapeId = null; this.fired = false;
  }

  lost(out, t) { this._hush(out, t); this.mode = 'idle'; this.wheel.reset(); }
}

/* ================================================================== *
 *  Engine: handedness-locked role assignment
 * ================================================================== */

export const DEFAULT_CFG = {
  chordMode: 'grid',      // 'grid' | 'signs'
  playMode: 'strum',      // 'finger' | 'strum'
  cols: 4, rows: 3,
  signPatterns: null,     // { [signId]: patternId }
};

export class GestureEngine {
  constructor() {
    this.fret = new FretHand(); this.pluck = new PluckHand();
    this.lastT = null;
    this.lock = null;          // { fretLabel: 'Left'|'Right' } once inferred
    this.bothLostAt = null;
  }

  /**
   * @param hands  [{ lm, world, x, label:'Left'|'Right'|null, score }]
   * @param layout { neckX0, neckX1, gridY0, gridY1, strumX0, strumX1, lefty }
   * @param cfg    see DEFAULT_CFG
   *
   * Role rules: MediaPipe handedness labels are stable per hand but their
   * anatomical meaning depends on whether the pipeline mirrored the frame —
   * rather than trust a convention, we *lock* the mapping by observation: the
   * first time two confidently-labelled hands are seen, whichever label sits
   * on the neck side becomes the fretting label for the whole session. From
   * then on hands can cross sides freely without swapping roles. Position is
   * only a seed and a fallback for unlabelled/ambiguous frames.
   */
  update(hands, t, layout, cfg = DEFAULT_CFG) {
    const C = { ...DEFAULT_CFG, ...cfg };
    const dt = this.lastT === null ? 1 / 60 : clamp(t - this.lastT, 1 / 240, 0.1);
    this.lastT = t;
    const events = [];

    const labelled = hands.filter((h) => h.label && (h.score ?? 1) > 0.6);
    let fretH = null, pluckH = null;

    if (hands.length >= 2) {
      const [a, b] = [...hands].sort((p, q) => p.x - q.x);
      const bySide = layout.lefty ? { fret: b, pluck: a } : { fret: a, pluck: b };
      if (labelled.length === 2 && labelled[0].label !== labelled[1].label) {
        if (!this.lock) this.lock = { fretLabel: bySide.fret.label ?? labelled[0].label };
        fretH = hands.find((h) => h.label === this.lock.fretLabel) || bySide.fret;
        pluckH = hands.find((h) => h !== fretH) || bySide.pluck;
      } else {
        ({ fret: fretH, pluck: pluckH } = bySide);
      }
    } else if (hands.length === 1) {
      const h = hands[0];
      if (this.lock && h.label) {
        if (h.label === this.lock.fretLabel) fretH = h; else pluckH = h;
      } else {
        // Unlocked single hand: the side it's on says what it's doing.
        const u = inv(h.x, 0, 1);
        const neckSide = layout.lefty ? u > 0.5 : u < 0.5;
        if (neckSide) fretH = h; else pluckH = h;
      }
    }

    if (fretH) this.fret.update(fretH, t, dt, layout, C, events);
    else {
      const was = this.fret.present;
      this.fret.miss(t);
      if (was && !this.fret.present) this.fret.lost();
      else if (!this.fret.present) this.fret.clear();
    }

    if (pluckH) this.pluck.update(pluckH, t, dt, layout, C, events);
    else {
      const was = this.pluck.present;
      this.pluck.miss(t);
      if (was && !this.pluck.present) this.pluck.lost(events, t);
    }

    // Forget the label lock only after both hands have been gone a while
    // (someone else may pick it up, or the player may turn around).
    if (!hands.length) {
      if (this.bothLostAt === null) this.bothLostAt = t;
      else if (t - this.bothLostAt > 2.5) this.lock = null;
    } else this.bothLostAt = null;

    this.handCount = hands.length;
    this.fretLm = fretH?.lm || null;
    this.pluckLm = pluckH?.lm || null;
    return events;
  }
}
