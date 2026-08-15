/**
 * render.js — drawing the instrument onto the desk that is actually there.
 *
 * The rule this file exists to keep: nothing is drawn in screen space that
 * claims to be part of the instrument. Every key, edge and label is computed in
 * table coordinates and pushed through the calibration homography, so the grid
 * lies *on* the desk in the camera's own perspective — the far edge narrower
 * than the near one, the whole thing skewed exactly as much as the desk is. A
 * flat keyboard graphic pasted over the video would sit at a different angle to
 * the surface your hands are on, and the mismatch is precisely what makes those
 * overlays feel like a costume rather than an instrument.
 *
 * The same rule drives the feedback: a hit lights up the *cell that was struck*
 * and blooms a ring at the exact point of contact, both in table space. What
 * you see is where you actually hit.
 */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

/* Warm, and distinguishable at a glance without reading anything. Hands are
 * told apart by hue; the surface itself stays neutral so the video reads. */
export const HAND_COL = { left: '#4E7FA8', right: '#C0631A' };
const INK = 'rgba(44,33,24,';
const CREAM = 'rgba(255,250,242,';

export class Overlay {
  constructor(canvas, video = null) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.hits = [];        // recent strikes, for the bloom
  }

  /**
   * Re-measure the canvas. `w`/`h` are what every table coordinate and every
   * landmark is multiplied by, so stale ones put the whole instrument
   * somewhere it isn't. A no-op when nothing moved, so it is safe on a
   * ResizeObserver and safe to call every frame.
   */
  resize() {
    const cap = matchMedia('(pointer: coarse)').matches ? 1.5 : 2;
    const r = this.cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, cap);
    const vw = this.video?.videoWidth || 0, vh = this.video?.videoHeight || 0;
    if (r.width === this.boxW && r.height === this.boxH && dpr === this.dpr
        && vw === this.vw && vh === this.vh) return;
    this.boxW = r.width; this.boxH = r.height; this.dpr = dpr;
    this.vw = vw; this.vh = vh;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);

    /* `w`/`h` are the size the video is *painted* at, not the box. The video is
       object-fit: cover, so any shape mismatch crops it, and multiplying a
       landmark by the box width assumes that crop is zero. See the long note in
       src/render.js — this is the intermittent hand-displacement bug. When the
       shapes agree this collapses to the old arithmetic. */
    const s = vw > 0 && vh > 0 ? Math.max(r.width / vw, r.height / vh) : 0;
    this.w = s ? vw * s : r.width;
    this.h = s ? vh * s : r.height;
    this.ox = (r.width - this.w) / 2;
    this.oy = (r.height - this.h) / 2;
    this.ctx.setTransform(dpr, 0, 0, dpr, this.ox * dpr, this.oy * dpr);
  }

  /**
   * Record a strike for the visual bloom.
   * `at` is an audio-clock-aligned time so the flash and the note land together
   * rather than the flash arriving a frame early.
   */
  onHit({ u, v, cell, hand, velocity, at }) {
    this.hits.push({ u, v, cell, hand, velocity, at });
    if (this.hits.length > 24) this.hits.shift();
  }

  /** Table point → canvas pixels. Null when the plane is not calibrated. */
  _px(plane, u, v) {
    const p = plane?.toImage(u, v);
    return p ? { x: p.x * this.w, y: p.y * this.h } : null;
  }

  draw(f) {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';

    if (f.calibrating) { this._calibration(f); return; }
    if (!f.plane?.ok) return;

    this._surface(f);
    this._keys(f);
    this._blooms(f);
    for (const hand of f.hands || []) this._hand(f, hand);
    if (!f.hands?.length) this._prompt('rest your hands on the desk');
    else if (f.lowRate) this._prompt(`tracking at ${Math.round(f.rate)}/s — taps may be missed`, true);
  }

  /* ---------------- the surface ---------------- */

  _surface(f) {
    const { ctx } = this;
    const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => this._px(f.plane, u, v));
    if (pts.some((p) => !p)) return;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    // Barely-there wash: enough to say "this patch is the instrument", not so
    // much that it hides the desk or your hands.
    ctx.fillStyle = 'rgba(255,244,226,0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(224,147,47,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  /** One quad per key, in table space, so perspective comes out automatically. */
  _cellQuad(f, col, row) {
    const { cols, rows } = f.keyboard;
    const u0 = col / cols, u1 = (col + 1) / cols;
    // Row 0 is the row nearest the player, and v runs 0 = far → 1 = near.
    const v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows;
    return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => this._px(f.plane, u, v));
  }

  /**
   * Draw the keyboard.
   *
   * Deliberately not a grid of boxes. Outlining every cell equally gives a
   * spreadsheet laid over the video — busy, and nothing about it says
   * "instrument". A keyboard reads the way it does because the keys are
   * *contiguous*: you see the gaps between them and the front edge you strike,
   * not four sides of each one. So: one fill for the whole surface, hairlines
   * where keys meet, and a brighter lip along the near edge of each key, which
   * is the part your eye uses to aim.
   */
  _keys(f) {
    const { ctx } = this;
    const { cols, rows } = f.keyboard;
    const layout = f.keyboard.layout(0);
    const quad = (u0, u1, v0, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]
      .map(([u, v]) => this._px(f.plane, u, v));
    const trace = (q) => {
      ctx.beginPath();
      q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    };

    for (const key of layout) {
      const u0 = key.col / cols, u1 = (key.col + 1) / cols;
      const vNear = 1 - key.row / rows, vFar = 1 - (key.row + 1) / rows;
      const body = quad(u0, u1, vFar, vNear);
      if (body.some((p) => !p)) continue;

      // The tonic of each octave is tinted. On a surface with no edges and no
      // ridges it is the only landmark there is for finding your place.
      if (key.root) { trace(body); ctx.fillStyle = 'rgba(224,147,47,0.17)'; ctx.fill(); }

      // The lip: a band along the edge nearest the player, which is the part
      // you actually aim at, and the thing that makes a flat shape read as a key.
      const lip = quad(u0 + 0.06 / cols, u1 - 0.06 / cols, vNear - 0.22 / rows, vNear - 0.03 / rows);
      if (!lip.some((p) => !p)) {
        trace(lip);
        ctx.fillStyle = key.root ? 'rgba(255,236,205,0.34)' : 'rgba(255,250,240,0.16)';
        ctx.fill();
      }
    }

    // Hairlines where keys meet — the gaps, not the outlines.
    ctx.strokeStyle = CREAM + '0.34)';
    ctx.lineWidth = 1;
    for (let c = 1; c < cols; c++) {
      const a = this._px(f.plane, c / cols, 0), b = this._px(f.plane, c / cols, 1);
      if (!a || !b) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (let r = 1; r < rows; r++) {
      const v = r / rows;
      const a = this._px(f.plane, 0, v), b = this._px(f.plane, 1, v);
      if (!a || !b) continue;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }

    // Labels sit near the front of each key, the way they would be printed on
    // one, and shrink with the perspective so far keys don't shout over near.
    const near = this._px(f.plane, 0.5, 1), far = this._px(f.plane, 0.5, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const key of layout) {
      if (!f.showNames && !key.root) continue;
      const c = this._px(f.plane, (key.col + 0.5) / cols, 1 - (key.row + 0.42) / rows);
      if (!c) continue;
      const dep = near && far ? clamp((c.y - far.y) / Math.max(1, near.y - far.y), 0, 1) : 0.5;
      ctx.font = `600 ${(8.5 + dep * 4.5).toFixed(1)}px Inter, sans-serif`;
      ctx.fillStyle = CREAM + (key.root ? '0.95)' : '0.66)');
      ctx.shadowColor = INK + '0.55)'; ctx.shadowBlur = 4;
      ctx.fillText(key.name, c.x, c.y);
      ctx.shadowBlur = 0;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  }

  /* ---------------- feedback ---------------- */

  _blooms(f) {
    const { ctx } = this;
    const now = f.now;
    this.hits = this.hits.filter((hit) => now - hit.at < 0.85);
    for (const hit of this.hits) {
      const age = now - hit.at;
      if (age < 0) continue;                     // scheduled a hair ahead
      const k = 1 - age / 0.85;
      const col = HAND_COL[hit.hand] || HAND_COL.right;

      // Flood the struck key…
      const q = this._cellQuad(f, hit.cell.col, hit.cell.row);
      if (!q.some((p) => !p)) {
        ctx.beginPath();
        q.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.globalAlpha = k * k * (0.30 + 0.4 * hit.velocity);
        ctx.fillStyle = col; ctx.fill();
        ctx.globalAlpha = 1;
      }
      // …and ring the exact point of contact, so a hit near an edge visibly
      // reads as near that edge instead of being rounded to the key's middle.
      const p = this._px(f.plane, hit.u, hit.v);
      if (p) {
        const r = 6 + (1 - k) * (26 + hit.velocity * 26);
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU);
        ctx.strokeStyle = col;
        ctx.globalAlpha = k * 0.85;
        ctx.lineWidth = 2 + hit.velocity * 2.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  _hand(f, hand) {
    const { ctx } = this;
    const col = HAND_COL[hand.id] || HAND_COL.right;
    /* Slide the drawn hand forward by however stale its pose is. The whole
     * hand moves together — a single translation, not per-landmark
     * extrapolation — so the shape you read is exactly the shape that was
     * measured, only in the right place. It falls to zero as the hand slows,
     * which is to say it is already gone by the time a note fires. */
    const lead = hand.lead;
    const shifted = lead && (lead.dx || lead.dy);
    if (shifted) { ctx.save(); ctx.translate(lead.dx * this.w, lead.dy * this.h); }
    for (let i = 0; i < hand.tips.length; i++) {
      const tip = hand.tips[i];
      const x = tip.x * this.w, y = tip.y * this.h;
      const st = hand.states?.[i];
      const falling = st?.phase === 'falling';
      /* A finger switched off is drawn as a faint outline — present, so you can
       * still see the tracker has your hand, but visibly not armed. Leaving it
       * looking identical to a live one would make "one finger" mode read as
       * the instrument having gone deaf on four of them. */
      const plays = hand.plays ? hand.plays[i] : true;
      if (!plays) {
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(x, y, 2.8, 0, TAU);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      // A fingertip on its way down is shown swelling. That is the only moment
      // where the player can see the machine agreeing with them *before* a note
      // exists — it turns a missed tap from a mystery into a visible near-miss.
      ctx.beginPath();
      ctx.arc(x, y, falling ? 5 + clamp(st.peak * 0.7, 0, 7) : 3.6, 0, TAU);
      ctx.fillStyle = falling ? col : CREAM + '0.75)';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = falling ? CREAM + '0.95)' : col;
      ctx.stroke();
    }
      if (shifted) ctx.restore();
  }

  _prompt(text, warn = false) {
    const { ctx, w, h } = this;
    ctx.font = '600 12.5px Inter, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const ww = ctx.measureText(text).width + 28;
    const x = w / 2, y = h - 26;
    ctx.beginPath(); this._rr(x - ww / 2, y - 15, ww, 30, 15);
    ctx.fillStyle = warn ? 'rgba(120,45,20,0.72)' : 'rgba(40,28,18,0.62)';
    ctx.fill();
    ctx.fillStyle = '#FFF6E6';
    ctx.fillText(text, x, y);
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------------- calibration ---------------- */

  /**
   * Marking out the desk. The quad is drawn live as it is built, so the shape
   * is confirmed by eye against the actual surface before a single note exists.
   */
  _calibration(f) {
    const { ctx, w, h } = this;
    const pts = f.draft.map((p) => ({ x: p.x * w, y: p.y * h }));
    const LABELS = ['far left', 'far right', 'near right', 'near left'];

    if (pts.length > 1) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (pts.length === 4) ctx.closePath();
      ctx.strokeStyle = 'rgba(224,147,47,0.9)'; ctx.lineWidth = 2.5;
      ctx.stroke();
      if (pts.length === 4) { ctx.fillStyle = 'rgba(224,147,47,0.14)'; ctx.fill(); }
    }

    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, TAU);
      ctx.fillStyle = '#C0631A'; ctx.fill();
      ctx.strokeStyle = '#FFF6E6'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.font = '700 11px Inter, sans-serif';
      ctx.fillStyle = '#FFF6E6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
    });

    const next = f.draft.length;
    this._prompt(next < 4
      ? `click the ${LABELS[next]} corner of your playing area  ·  ${next}/4`
      : 'looks right? press Use this area — or click a corner to move it');
  }

  _rr(x, y, w, h, r) {
    const { ctx } = this;
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
