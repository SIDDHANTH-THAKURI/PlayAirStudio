/**
 * geometry.js — turning a camera's oblique view of a desk into flat table
 * coordinates.
 *
 * THE PROBLEM. The camera looks *down and across* at the desk, so the
 * rectangular patch of table the player wants to use arrives in the image as
 * an arbitrary quadrilateral: near edge wide, far edge narrow, both edges
 * possibly sloped because nobody centres a laptop perfectly. A fingertip two
 * thirds of the way along the far edge and one two thirds along the near edge
 * are at completely different image x. Any layout built on raw image
 * coordinates would therefore have keys that change width and drift sideways
 * depending on how far up the desk your hand is — which is exactly the "feels
 * fake and imprecise" failure we are trying to avoid.
 *
 * THE FIX. Four corner clicks give four point correspondences between the
 * image and the unit square. Four correspondences are exactly enough to pin
 * down a planar homography, and a homography is exactly the right model: any
 * two images of the *same plane* are related by one, whatever the camera's
 * position, tilt or focal length. So this generalises across desks, camera
 * heights and angles for free — there is no per-setup fudge factor anywhere.
 *
 * Everything downstream then works in table coordinates: u across (0 = left
 * edge, 1 = right), v away from the player (0 = far edge, 1 = near edge).
 * Keys become an honest grid in that space, and the *drawing* code runs the
 * mapping backwards so the grid painted on screen sits on the real desk in
 * correct perspective rather than floating in front of it.
 *
 * Pure maths, no DOM — `test/piano.mjs` exercises it directly.
 */

const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += A[r * 3 + k] * B[k * 3 + c];
    C[r * 3 + c] = s;
  }
  return C;
};

/** Inverse of a 3×3 via its adjugate. Null when it is singular. */
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
  const k = 1 / det;
  return [A * k, (c * h - b * i) * k, (b * f - c * e) * k,
          B * k, (a * i - c * g) * k, (c * d - a * f) * k,
          C * k, (b * g - a * h) * k, (a * e - b * d) * k];
}

/**
 * Closed-form homography taking the unit square onto an arbitrary quad
 * (Heckbert's construction).
 *
 * Worth the specificity rather than a generic four-point least-squares fit.
 * The generic route builds an 8×8 system out of raw image coordinates that all
 * sit in a narrow band, and on a *symmetric* quad — which is exactly what
 * somebody marking out the desk in front of them will click — the final pivot
 * collapses into cancellation noise and the solver declares a perfectly
 * ordinary desk unsolvable. That really happened here with the default quad.
 * This form has no pivoting to go wrong: it is a handful of subtractions and
 * one division, and it is exact.
 *
 * Both directions then come from this one map, with the image→table direction
 * being its literal inverse — so the round trip is exact by construction
 * rather than by luck, which matters because the renderer and the note lookup
 * use opposite directions and must agree perfectly.
 */
function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  // A parallelogram has no vanishing point, so the projective terms drop out
  // and the map is plainly affine. Falling through the general formula would
  // divide by zero.
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    return [p1.x - p0.x, p3.x - p0.x, p0.x,
            p1.y - p0.y, p3.y - p0.y, p0.y,
            0, 0, 1];
  }
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  if (!Number.isFinite(den) || Math.abs(den) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
          p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
          g, h, 1];
}

/**
 * The homography H (row-major 3×3) with dst = H · src for four correspondences,
 * composed through the unit square: src → square → dst.
 */
export function solveHomography(src, dst) {
  if (src?.length !== 4 || dst?.length !== 4) return null;
  if ([...src, ...dst].some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const toSrc = squareToQuad(src), toDst = squareToQuad(dst);
  if (!toSrc || !toDst) return null;
  const fromSrc = inv3(toSrc);
  if (!fromSrc) return null;
  const H = mul3(toDst, fromSrc);
  if (H.some((n) => !Number.isFinite(n))) return null;
  /* A homography is only defined up to scale, so normalise — but by the largest
   * element, never by H[8].
   *
   * H[8] is legitimately zero. It vanishes exactly when the source quad's
   * vanishing point maps to infinity, which is what a *symmetric* trapezoid
   * does — and a symmetric trapezoid is precisely what marking out the desk in
   * front of you produces. Dividing by it discards a perfectly good transform.
   * This is also why the textbook 8-unknown formulation, which pins h8 = 1 as
   * a convenience, cannot represent this case at all: it is not a conditioning
   * problem, that quad simply has no solution of that form. `applyH` divides
   * through by the full third row, so any scale works. */
  const m = Math.max(...H.map(Math.abs));
  if (!(m > 1e-12)) return null;
  return H.map((n) => n / m);
}

/** Apply a 3×3 homography to a point, dividing through by the third component. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  if (!w || !Number.isFinite(w)) return null;
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/**
 * Is this quad usable as a playing surface?
 *
 * Rejects the two ways four clicks go wrong in practice: a bow-tie (corners
 * entered out of order, which a homography will happily "solve" into a
 * coordinate space that folds back on itself) and a sliver too small to place
 * keys in. Convexity is the signed-area test on consecutive triples — all four
 * must turn the same way.
 */
export function quadIsSane(q, minArea = 0.02, minTurn = 0.005) {
  if (q?.length !== 4 || q.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return false;
  let neg = 0, pos = 0, area = 0;
  for (let i = 0; i < 4; i++) {
    const s = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    // Every corner must actually turn. A corner that doesn't means three points
    // on one line, which no homography can map to a square however cleanly the
    // arithmetic appears to go — catch it here rather than downstream, where it
    // would surface as a coordinate space that quietly folds in on itself.
    if (Math.abs(s) < minTurn) return false;
    if (s < 0) neg++; else pos++;
    const a = q[i], b = q[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return (neg === 0 || pos === 0) && Math.abs(area / 2) >= minArea;
}

/**
 * A calibrated desk.
 *
 * `corners` are image-normalised (0..1, the same mirrored space the tracker
 * emits landmarks in) in the order the calibration UI collects them:
 * far-left, far-right, near-right, near-left. That maps to the unit square
 * corners (0,0) (1,0) (1,1) (0,1), so v runs away-from-player → toward-player
 * and u runs left → right, matching how a keyboard is laid out.
 */
export class TablePlane {
  static UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  constructor(corners) {
    this.corners = corners.map((p) => ({ x: p.x, y: p.y }));
    this.toTableH = solveHomography(this.corners, TablePlane.UNIT);
    this.toImageH = solveHomography(TablePlane.UNIT, this.corners);
    this.ok = !!(this.toTableH && this.toImageH) && quadIsSane(this.corners);
  }

  /** Image point → table coordinates. Values outside 0..1 are off the surface. */
  toTable(p) { return this.ok ? applyH(this.toTableH, p.x, p.y) : null; }
  /** Table coordinates → image point, for painting the grid in perspective. */
  toImage(u, v) { return this.ok ? applyH(this.toImageH, u, v) : null; }

  /**
   * Is this table point on the playing surface?
   *
   * `margin` deliberately defaults negative-tolerant: a fingertip a hair past
   * the edge the player *drew* is still a fingertip on the desk they meant, and
   * calibration is done by eye. Being strict here would silently eat the
   * outermost keys — the ones nearest the edge, which are the easiest to aim at.
   */
  contains(t, margin = 0.06) {
    return !!t && t.x >= -margin && t.x <= 1 + margin && t.y >= -margin && t.y <= 1 + margin;
  }

  toJSON() { return this.corners; }
  static from(json) {
    if (!Array.isArray(json) || json.length !== 4) return null;
    const p = new TablePlane(json);
    return p.ok ? p : null;
  }
}

/**
 * A sensible default quad for someone who has not calibrated yet.
 *
 * Shaped like a desk seen from a laptop lid: the far edge is narrower than the
 * near edge, because perspective. It is a guess, but a guess in the right shape
 * is far better than a rectangle — it gets a first-time player making sound
 * immediately, and the calibration step then becomes a refinement rather than a
 * wall standing between them and the instrument.
 */
export function defaultQuad() {
  return [{ x: 0.30, y: 0.40 }, { x: 0.70, y: 0.40 }, { x: 0.94, y: 0.88 }, { x: 0.06, y: 0.88 }];
}
