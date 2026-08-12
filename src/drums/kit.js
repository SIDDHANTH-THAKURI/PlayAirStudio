/**
 * kit.js — where the drums are.
 *
 * Deliberately *not* calibrated. The piano needs a homography because a key is
 * two centimetres wide and hitting the wrong one is a wrong note; a drum is the
 * size of a dinner plate and there are seven of them, so screen-space regions
 * are plenty. Dropping calibration removes the single biggest piece of setup
 * friction in the project — you point a camera at yourself and play.
 *
 * The layout is a kit seen from the stool: hi-hat and crash to the left, snare
 * in front, kick low and central, toms across to the right, ride out on the far
 * right. The video is mirrored, so the player's left hand really does fall on
 * the hi-hat. Pads are ellipses rather than circles because a drum head viewed
 * from a player's angle is one.
 *
 * Pure: no DOM, no audio.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * `x`, `y` are normalised screen coordinates; `rx`, `ry` the ellipse radii.
 * `depth` is purely cosmetic — how "near" the pad reads, which the renderer
 * uses for size and shading so the kit doesn't look flat.
 */
export const PADS = [
  /* Laid out for where the stick tip can actually *go*, which is not the same
   * as where a drum kit looks right.
   *
   * The tip hangs a couple of palm-spans out along the hand, and the hand
   * points down-and-forward, so the reachable region is offset well below
   * wherever your hands are comfortable — roughly the lower two-thirds of the
   * frame. The first layout spread the kit corner to corner and put the
   * cymbals near the top edge, which meant reaching them required holding your
   * hands *above* the frame. It read as the instrument being broken, and it
   * was: those pads were not reachable at all.
   *
   * So the whole kit sits lower and narrower than a photograph of a kit would.
   * Cymbals at the top of the reachable band, snare and floor at the bottom of
   * it, kick below them where a kick belongs. Pads are sized so neighbours
   * touch rather than pile up — a real kit does overlap, but on screen the
   * overlap is what makes it hard to tell which drum you are aiming at, and
   * aiming is the entire interaction. Everything stays inside the frame with
   * room for its shell, which sits three-quarters of a radius below the head. */
  { id: 'crash',  label: 'Crash',  voice: 'crash', x: 0.150, y: 0.382, rx: 0.098, ry: 0.064, depth: 0.15 },
  { id: 'hihat',  label: 'Hi-hat', voice: 'hihat', x: 0.272, y: 0.578, rx: 0.084, ry: 0.055, depth: 0.55 },
  { id: 'snare',  label: 'Snare',  voice: 'snare', x: 0.398, y: 0.752, rx: 0.094, ry: 0.062, depth: 0.90 },
  { id: 'kick',   label: 'Kick',   voice: 'kick',  x: 0.560, y: 0.840, rx: 0.098, ry: 0.056, depth: 1.00 },
  { id: 'tom',    label: 'Tom',    voice: 'tom',   x: 0.648, y: 0.578, rx: 0.084, ry: 0.055, depth: 0.55 },
  { id: 'floor',  label: 'Floor',  voice: 'floor', x: 0.786, y: 0.752, rx: 0.094, ry: 0.062, depth: 0.90 },
  { id: 'ride',   label: 'Ride',   voice: 'ride',  x: 0.868, y: 0.382, rx: 0.100, ry: 0.066, depth: 0.15 },
];



export class Kit {
  /**
   * @param scale  grows or shrinks every pad about the kit's centre, for people
   *               sitting closer or further from the camera.
   * @param lefty  mirror the kit for a left-handed setup.
   */
  constructor({ scale = 1, lefty = false } = {}) {
    this.scale = clamp(scale, 0.6, 1.6);
    this.lefty = !!lefty;
  }

  /** The pads as actually laid out, after scale and handedness. */
  pads() {
    if (this._pads) return this._pads;      // fixed once constructed, and read
    const s = this.scale;                   // several times per frame
    return (this._pads = PADS.map((p) => {
      const x = this.lefty ? 1 - p.x : p.x;
      return {
        ...p,
        // Scale about the middle of the reachable band rather than the middle
        // of the frame, so shrinking pulls the pads toward where the tip
        // already goes instead of dragging them somewhere else.
        x: clamp(0.5 + (x - 0.5) * s, 0.04, 0.96),
        y: clamp(0.63 + (p.y - 0.63) * s, 0.04, 0.98),
        rx: p.rx * s,
        ry: p.ry * s,
      };
    }));
  }

  /**
   * Which pad was struck.
   *
   * Nearest by *normalised* distance, so a big pad claims a hit further from
   * its centre than a small one, and overlapping pads resolve to whichever the
   * point is more deeply inside.
   *
   * The margin is generous on purpose, and more generous than it first was. A
   * stroke that lands in the gap between two drums is not a mistake anyone
   * needs punishing for — it is a stroke aimed at one of them, and swallowing
   * it teaches nothing except that the instrument is unreliable. At this
   * setting the pads' catch areas meet, so anywhere in the kit plays
   * *something*, while a stroke well outside it still plays nothing.
   */
  hitAt(p, margin = 1.55) {
    if (!p) return null;
    let best = null, bestD = Infinity;
    for (const pad of this.pads()) {
      const dx = (p.x - pad.x) / pad.rx, dy = (p.y - pad.y) / pad.ry;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = pad; }
    }
    return bestD <= margin ? best : null;
  }
}
