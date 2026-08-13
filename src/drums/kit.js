/**
 * kit.js — where the drums are, and where their playing surfaces are.
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
 * Two geometries per pad, and the difference between them is the whole design:
 *
 *  • The **head** is what is drawn — the drum you can see.
 *  • The **zone** is a larger, and especially a *taller*, ellipse around it.
 *    Zones decide only which drum you are aiming at, never whether you hit
 *    anything, and they are sized so that neighbours overlap: everywhere in the
 *    kit belongs to exactly one drum, with no crack in between for a stroke to
 *    fall down. Aiming resolves continuously and visibly (`render.js` rings the
 *    aimed drum) instead of being adjudicated after the fact.
 *  • The **surface** is a line just above the head's centre. Crossing it going
 *    down is the hit. That is what makes the drum an object rather than a
 *    scoring region: the sound happens where you can see the stick meet it.
 *
 * Pure: no DOM, no audio.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * How much bigger the aiming zone is than the drawn head.
 *
 * Wider than tall would be the obvious choice and it is the wrong one. The kit
 * is a couple of rows of drums with a lot of air between them vertically, and
 * heads are drawn flat because they are seen at an angle — so the gaps that
 * swallow strokes are the vertical ones. Stretching the zones lets the rows
 * meet without making the drums themselves look like dinner plates.
 */
export const ZONE = { rx: 1.50, ry: 2.20 };

/** Where the playing surface sits above the head's centre, in head radii. */
export const SURFACE = 0.25;

/**
 * `x`, `y` are normalised screen coordinates; `rx`, `ry` the head radii.
 * `depth` is purely cosmetic — how "near" the pad reads, which the renderer
 * uses for size and shading so the kit doesn't look flat.
 */
export const PADS = [
  /* Laid out for where the stick tip can actually *go*, which is not the same
   * as where a drum kit looks right.
   *
   * The tip hangs a couple of palm-spans below the fist, so the reachable
   * region is offset well below wherever your hands are comfortable — roughly
   * the lower two-thirds of the frame. An early layout spread the kit corner to
   * corner and put the cymbals near the top edge, which meant reaching them
   * required holding your hands *above* the frame. It read as the instrument
   * being broken, and it was: those pads were not reachable at all.
   *
   * So the whole kit sits lower and narrower than a photograph of a kit would.
   * Cymbals at the top of the reachable band, snare and floor at the bottom of
   * it, kick below them where a kick belongs. Everything stays inside the frame
   * with room for its shell, which sits three-quarters of a radius below the
   * head. */
  { id: 'crash',  label: 'Crash',  voice: 'crash', x: 0.150, y: 0.382, rx: 0.098, ry: 0.064, depth: 0.15 },
  { id: 'hihat',  label: 'Hi-hat', voice: 'hihat', x: 0.272, y: 0.578, rx: 0.084, ry: 0.055, depth: 0.55 },
  { id: 'snare',  label: 'Snare',  voice: 'snare', x: 0.398, y: 0.744, rx: 0.094, ry: 0.062, depth: 0.90 },
  /* The kick sits high enough to be a neighbour of the tom rather than
   * marooned at the bottom of the frame. It is the one pad with drums on three
   * sides of it, so a hole around it is the easiest place in the kit for a
   * stroke to land on nothing — and it is also the hardest pad to reach, since
   * the tip has to get *below* it. */
  { id: 'kick',   label: 'Kick',   voice: 'kick',  x: 0.560, y: 0.812, rx: 0.098, ry: 0.056, depth: 1.00 },
  { id: 'tom',    label: 'Tom',    voice: 'tom',   x: 0.648, y: 0.578, rx: 0.084, ry: 0.055, depth: 0.55 },
  { id: 'floor',  label: 'Floor',  voice: 'floor', x: 0.786, y: 0.744, rx: 0.094, ry: 0.062, depth: 0.90 },
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
    this._pads = PADS.map((p) => {
      const x = this.lefty ? 1 - p.x : p.x;
      // Scale about the middle of the reachable band rather than the middle of
      // the frame, so shrinking pulls the pads toward where the tip already
      // goes instead of dragging them somewhere else.
      const px = clamp(0.5 + (x - 0.5) * s, 0.04, 0.96);
      const py = clamp(0.63 + (p.y - 0.63) * s, 0.04, 0.98);
      const ry = p.ry * s;
      return { ...p, x: px, y: py, rx: p.rx * s, ry, sy: py - ry * SURFACE };
    });
    this._by = new Map(this._pads.map((p) => [p.id, p]));
    return this._pads;
  }

  byId(id) { this.pads(); return this._by.get(id) || null; }

  /** The line a stroke has to come down through to sound this drum. */
  surfaceY(pad) { return pad.sy; }

  /**
   * Which drum you are aimed at, or null for "none of them".
   *
   * Nearest by zone-normalised distance, so the pads' catch areas overlap and
   * whichever one you are more deeply inside wins — the same rule as before,
   * but on the taller zone ellipse rather than the drawn head, which is what
   * closes the gaps between the rows.
   */
  zoneAt(p) {
    if (!p) return null;
    let best = null, bestD = Infinity;
    for (const pad of this.pads()) {
      const dx = (p.x - pad.x) / (pad.rx * ZONE.rx);
      const dy = (p.y - pad.y) / (pad.ry * ZONE.ry);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = pad; }
    }
    return bestD <= 1 ? best : null;
  }

  /** Kept as the name the rest of the app already asks by. */
  hitAt(p) { return this.zoneAt(p); }
}
