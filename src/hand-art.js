/**
 * hand-art.js — a drawable, poseable synthetic hand.
 *
 * The tutorial deliberately shows the *same* skeleton the tracker draws over
 * your real hand, rather than photos or emoji. A learner's first job is to
 * recognise the overlay as "me", so teaching with a different picture than the
 * one they'll actually see wastes the whole lesson.
 *
 * Poses are 5 curl values (thumb→pinky, 0 = straight, 1 = folded) plus a
 * spread and a wrist roll. Everything animates by interpolating those numbers,
 * so any pose morphs into any other for free.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* Finger geometry, in hand-relative units (palm width = 1).
 * [ base x, base y, length, rest angle in degrees ] — the rest angle fans the
 * fingers out from the wrist the way a relaxed hand actually sits. */
const FINGERS = [
  { bx: -0.42, by: 0.16, len: 0.62, ang: -52, seg: [0.42, 0.32, 0.26], thumb: true },
  { bx: -0.26, by: -0.34, len: 0.92, ang: -8 },
  { bx: -0.02, by: -0.40, len: 1.00, ang: -1 },
  { bx:  0.20, by: -0.36, len: 0.92, ang: 6 },
  { bx:  0.40, by: -0.26, len: 0.76, ang: 15 },
];
const SEG = [0.40, 0.33, 0.27];        // proportions of knuckle→tip

/** Named poses: [thumb, index, middle, ring, pinky] curls, 0..1. */
export const POSES = {
  open:   [0.05, 0.02, 0.02, 0.02, 0.02],
  fist:   [0.80, 0.98, 0.98, 0.98, 0.98],
  point:  [0.55, 0.02, 0.97, 0.97, 0.97],
  peace:  [0.60, 0.02, 0.02, 0.97, 0.97],
  horns:  [0.72, 0.02, 0.97, 0.97, 0.02],
  call:   [0.02, 0.97, 0.97, 0.97, 0.02],
  ok:     [0.62, 0.62, 0.05, 0.05, 0.05],   // thumb + index meet, rest open
  thumb:  [0.02, 0.97, 0.97, 0.97, 0.97],   // 👍
  one:    [0.90, 0.02, 0.97, 0.97, 0.97],
  two:    [0.90, 0.02, 0.02, 0.97, 0.97],
  three:  [0.90, 0.02, 0.02, 0.02, 0.97],
  four:   [0.90, 0.02, 0.02, 0.02, 0.02],
  five:   [0.02, 0.02, 0.02, 0.02, 0.02],
  pinky:  [0.95, 0.97, 0.97, 0.97, 0.02],
};

/** A pose plus its presentation: where it sits, how it's turned, its scale. */
export function pose(name, extra = {}) {
  return { curls: POSES[name] || POSES.open, x: 0.5, y: 0.5, scale: 1, roll: 0, spread: 1, ...extra };
}

/** Blend two pose states. `t` is 0..1; everything is numeric, so this is total. */
export function blend(a, b, t) {
  const k = t * t * (3 - 2 * t);            // smoothstep: no linear snapping
  return {
    curls: a.curls.map((c, i) => lerp(c, b.curls[i], k)),
    x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k),
    scale: lerp(a.scale, b.scale, k),
    roll: lerp(a.roll, b.roll, k),
    spread: lerp(a.spread, b.spread, k),
  };
}

/**
 * Build 21 screen-space points for a pose, in MediaPipe's landmark order, so
 * this can be handed to anything that already knows how to draw a hand.
 */
export function landmarks(p, w, h) {
  const R = Math.min(w, h) * 0.34 * p.scale;
  const cx = p.x * w, cy = p.y * h;
  const rot = (p.roll * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  // Hand space → screen: y is negated so "up the fingers" is up the screen.
  const put = (hx, hy) => ({ x: cx + (hx * cos - hy * sin) * R, y: cy + (hx * sin + hy * cos) * R });

  const out = new Array(21);
  // Wrist. Kept close to the knuckles on purpose: the palm is about as wide as
  // it is long on a real hand, and a distant wrist turns the two skeleton links
  // that reach it into a long narrow V that reads as an arrow, not a palm.
  out[0] = put(0.03, 0.30);

  FINGERS.forEach((f, i) => {
    const base = i === 0 ? 1 : 1 + i * 4;
    const curl = clamp(p.curls[i], 0, 1);
    // Curling swings the whole finger inward *and* bends each joint — a folded
    // finger that only rotated at the knuckle reads as a broken stick.
    const spread = (f.ang * p.spread) + (f.thumb ? curl * 44 : curl * 4);
    let a = (spread * Math.PI) / 180;
    let x = f.bx, y = f.by;
    out[base] = put(x, y);
    /* Total sweep from straight to fully folded, split across three joints.
     * ~185° is what a real finger closes through; the obvious-looking 90° per
     * joint spirals the tip back out past the knuckle and draws a blob. The
     * few degrees of rest bend keep an open hand from looking like a rake. */
    const REST = 6;
    const bend = REST + (f.thumb ? 26 : 58) * curl;
    const w = [0.85, 1.10, 1.05];
    for (let s = 0; s < 3; s++) {
      a += (bend * w[s] * Math.PI) / 180;
      const L = f.len * (f.thumb ? f.seg[s] : SEG[s]);
      x += Math.sin(a) * L;
      y -= Math.cos(a) * L;
      out[base + 1 + s] = put(x, y);
    }
  });
  return out;
}

const LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

/**
 * Draw the hand. `tips` optionally colours individual fingertips (used to tie
 * a finger to the string it plays).
 */
export function drawHand(ctx, lm, { color = '#C0631A', glow = 0.55, tips = null, scale = 1 } = {}) {
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  /* Palm plate — gives the skeleton some body so it reads as a hand, not a
   * tree. The wrist is a single landmark, so joining it straight to the fanned
   * knuckles draws a downward V; a real palm is nearly as wide at the base.
   * So the heel is widened to two corners either side of the wrist, square to
   * the palm axis, and the outline is rounded. */
  const k0 = lm[5], k1 = lm[17], w0 = lm[0];
  const span = Math.hypot(k1.x - k0.x, k1.y - k0.y) || 1;
  const ax = (k0.x + k1.x) / 2 - w0.x, ay = (k0.y + k1.y) / 2 - w0.y;
  const an = Math.hypot(ax, ay) || 1;
  const px = -ay / an, py = ax / an;                 // unit vector across the palm
  const heel = span * 0.42;
  // `px,py` points from the index knuckle toward the pinky, so the pinky-side
  // heel corner must follow landmark 17 — taking them the other way round
  // makes the outline cross itself and fill as a bowtie.
  const hPinky = { x: w0.x + px * heel, y: w0.y + py * heel };
  const hIndex = { x: w0.x - px * heel, y: w0.y - py * heel };
  ctx.beginPath();
  const ring = [lm[5], lm[9], lm[13], lm[17], hPinky, hIndex];
  ctx.moveTo((ring[0].x + ring[ring.length - 1].x) / 2, (ring[0].y + ring[ring.length - 1].y) / 2);
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i], n = ring[(i + 1) % ring.length];
    ctx.quadraticCurveTo(c.x, c.y, (c.x + n.x) / 2, (c.y + n.y) / 2);
  }
  ctx.closePath();
  ctx.fillStyle = color + '38'; ctx.fill();

  ctx.shadowColor = color + Math.round(glow * 255).toString(16).padStart(2, '0');
  ctx.shadowBlur = 14 * scale;
  ctx.strokeStyle = color; ctx.lineWidth = 5.5 * scale;
  for (const [a, b] of LINKS) {
    ctx.beginPath(); ctx.moveTo(lm[a].x, lm[a].y); ctx.lineTo(lm[b].x, lm[b].y); ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // knuckles
  ctx.fillStyle = '#FFFCF6';
  for (const i of [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19]) {
    ctx.beginPath(); ctx.arc(lm[i].x, lm[i].y, 2.6 * scale, 0, 7); ctx.fill();
  }
  // fingertips
  [4, 8, 12, 16, 20].forEach((i, f) => {
    ctx.beginPath(); ctx.arc(lm[i].x, lm[i].y, 6.5 * scale, 0, 7);
    ctx.fillStyle = tips?.[f] || '#FFFCF6'; ctx.fill();
    ctx.lineWidth = 2.6 * scale; ctx.strokeStyle = tips?.[f] ? '#FFFCF6' : color; ctx.stroke();
  });
  ctx.restore();
}

/** Wrist stub, so the hand looks attached to an arm rather than floating. */
export function drawWrist(ctx, lm, color, scale = 1) {
  const w = lm[0], m = lm[9];
  const dx = w.x - m.x, dy = w.y - m.y;
  const n = Math.hypot(dx, dy) || 1;
  ctx.save();
  ctx.strokeStyle = color + '55'; ctx.lineWidth = 26 * scale; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(w.x, w.y);
  ctx.lineTo(w.x + (dx / n) * 46 * scale, w.y + (dy / n) * 46 * scale);
  ctx.stroke();
  ctx.restore();
}
