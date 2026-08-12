/**
 * render.js — warm, light canvas overlay.
 *
 * Left half: whatever the fretting hand is aiming at — a 4×3 wall of chord
 * cells, or five sign badges. Right half: six horizontal strings, colour-coded
 * to the string a shape targets, plus dwell feedback around the hand.
 * Either hand can also be showing the two-option mode dial.
 */
const C = {
  wood: 'rgba(168,112,63,', amber: 'rgba(224,147,47,', deep: 'rgba(192,99,26,',
  ink: 'rgba(44,33,24,', cream: 'rgba(255,250,242,', sage: 'rgba(94,140,106,',
};
/* String colours, bass→treble. The plucking hand's active target lights up in
 * its own colour so "which string am I on" needs no reading. */
export const SCOL = ['#8B5E34', '#A85D96', '#4E7FA8', '#5E8C6A', '#D2604F', '#C0631A'];
export const FCOL = ['#C0631A', '#5E8C6A', '#4E7FA8', '#A85D96', '#D2604F'];
const LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const TAU = Math.PI * 2;

export class Overlay {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.strings = Array.from({ length: 6 }, () => ({ amp: 0, t0: -9, freq: 9 }));
  }
  /**
   * Re-measure the canvas.
   *
   * `w`/`h` are what every normalised landmark is multiplied by, so if they
   * lag the real canvas by even a little, every hand is drawn in the wrong
   * place — and by a lot if the stage changed size a lot. Cheap to call, and
   * a no-op when nothing moved, so it is safe to hang off a ResizeObserver.
   */
  resize() {
    // Phones ship dpr 3, which triples every fill in this overlay for detail
    // nobody can see through a webcam feed. Capping to 1.5 there is close to
    // free visually and buys back real frame time next to the tracker.
    const cap = matchMedia('(pointer: coarse)').matches ? 1.5 : 2;
    const r = this.cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, cap);
    // Bail when nothing changed. Writing canvas.width resets the whole 2D
    // context — transform, styles, the lot — so doing it every frame would be
    // both wasteful and a way to lose state; it also keeps a ResizeObserver
    // from ping-ponging with itself.
    if (r.width === this.w && r.height === this.h && dpr === this.dpr) return;
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.cv.width = Math.round(r.width * dpr); this.cv.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  /** Seed string animation from actually scheduled hits. */
  onStrum(res, now) {
    if (!res) return;
    for (const h of res.hits) {
      const s = this.strings[h.string];
      s.amp = clamp(h.velocity * 1.1, 0, 1); s.t0 = now + h.delay; s.freq = 7 + h.string * 2.4;
    }
  }

  draw(f) {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    this.drawSplit(f);
    if (f.cfg.chordMode === 'signs') this.drawSigns(f); else this.drawGrid(f);
    this.drawStrings(f, f.now);

    if (!f.fret?.present) this.sidePrompt(f.layout.lefty ? 1 : 0, 'fretting hand here',
      f.cfg.chordMode === 'signs' ? 'make a sign to pick a chord' : 'point at a chord');
    if (!f.pluck?.present) this.sidePrompt(f.layout.lefty ? 0 : 1, 'plucking hand here',
      f.cfg.playMode === 'finger' ? 'open 1–5 fingers for a string' : 'hold a sign for a pattern');

    if (f.fret?.present) {
      this.drawHand(f.fretLm, () => C.deep + '.8)', f.fret.dead, f.fret.vibrato);
      this.drawFretCue(f);
    }
    if (f.pluck?.present) this.drawPluckHand(f);
  }

  /* ---------------- shared chrome ---------------- */

  drawSplit(f) {
    const { ctx, w, h } = this;
    const mid = w * 0.5;
    ctx.setLineDash([3, 9]);
    ctx.strokeStyle = C.cream + '.55)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(mid, h * 0.03); ctx.lineTo(mid, h * 0.97); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '600 10.5px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = C.cream + '.85)';
    const chords = f.cfg.chordMode === 'signs' ? 'SIGN CHORDS' : 'CHORD GRID';
    const right = f.cfg.playMode === 'finger' ? 'FINGERSTYLE' : 'STRUM PATTERNS';
    ctx.fillText(f.layout.lefty ? right : chords, w * 0.25, h * 0.045);
    ctx.fillText(f.layout.lefty ? chords : right, w * 0.75, h * 0.045);
  }

  /**
   * "Show me that hand" nudge. Deliberately a chip pinned to the bottom of its
   * half rather than a panel across it — the chord wall and the strings are the
   * thing worth looking at, and covering them to say "put a hand here" trades
   * away the very information the player needs to aim.
   */
  sidePrompt(side, line1, line2) {
    const { ctx, w, h } = this;
    // Each chip owns half the frame. On a phone that half is ~180 px, so the
    // type scales down with the canvas or the two chips meet in the middle.
    const k = clamp(w / 900, 0.68, 1);
    const f1 = 13 * k, f2 = 11.5 * k, pad = 30 * k, ch = 38 * k;
    const cx = side === 0 ? w * 0.25 : w * 0.75, cy = h - ch * 0.72;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${f1}px Inter, sans-serif`;
    const a = ctx.measureText(line1).width;
    ctx.font = `400 ${f2}px Inter, sans-serif`;
    const ww = Math.min(Math.max(a, ctx.measureText(line2).width) + pad, w * 0.47);
    ctx.beginPath(); this.rr(ctx, cx - ww / 2, cy - ch / 2, ww, ch, ch / 2);
    ctx.fillStyle = 'rgba(40,28,18,.62)'; ctx.fill();
    ctx.strokeStyle = C.amber + '.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = '#FFF6E6';
    ctx.font = `600 ${f1}px Inter, sans-serif`;
    ctx.fillText(line1, cx, cy - ch * 0.21);
    ctx.font = `400 ${f2}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(255,246,230,.75)';
    ctx.fillText(line2, cx, cy + ch * 0.19);
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------------- fretting half ---------------- */

  /** Screen rect of grid cell `i`, mirrored for lefties so cell 1 stays outboard. */
  cellRect(i, f) {
    const { w, h } = this, L = f.layout, { cols, rows } = f.cfg;
    let col = i % cols; const row = Math.floor(i / cols);
    if (L.lefty) col = cols - 1 - col;
    const x0 = L.neckX0 * w, y0 = L.gridY0 * h;
    const cw = (L.neckX1 - L.neckX0) * w / cols, ch = (L.gridY1 - L.gridY0) * h / rows;
    return { x: x0 + col * cw, y: y0 + row * ch, w: cw, h: ch };
  }

  drawGrid(f) {
    const { ctx } = this;
    const pointing = f.fret?.present && f.fret.shape === 'point';
    for (let i = 0; i < f.cfg.cols * f.cfg.rows; i++) {
      const r = this.cellRect(i, f), pad = 3.5;
      const x = r.x + pad, y = r.y + pad, cw = r.w - pad * 2, ch = r.h - pad * 2;
      const on = i === f.slot, hot = pointing && i === f.fret.hover;
      const name = f.bank[i]?.name || '';

      ctx.beginPath(); this.rr(ctx, x, y, cw, ch, 11);
      ctx.fillStyle = on ? 'rgba(255,241,219,.82)' : hot ? 'rgba(255,248,236,.5)' : C.wood + '.26)';
      ctx.fill();
      ctx.lineWidth = on ? 2.4 : 1.2;
      ctx.strokeStyle = on ? C.deep + '.85)' : hot ? C.amber + '.85)' : C.cream + '.42)';
      ctx.stroke();

      if (!name) continue;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `600 ${on ? Math.min(30, ch * 0.5) : Math.min(23, ch * 0.42)}px Fraunces, Georgia, serif`;
      ctx.fillStyle = on ? '#7A3D10' : 'rgba(255,252,246,.94)';
      ctx.shadowColor = on ? 'rgba(255,255,255,.6)' : C.ink + '.45)'; ctx.shadowBlur = on ? 6 : 8;
      ctx.fillText(name, x + cw / 2, y + ch / 2);
      ctx.shadowBlur = 0;

      // The dwell ring lives on the cell being aimed at, not on the hand: it
      // answers "is this the one I'm about to get?" where the player is looking.
      if (hot && f.fret.aim === i && f.fret.aim01 > 0.02 && !on) {
        const cx = x + cw / 2, cy = y + ch - 13;
        ctx.beginPath(); ctx.arc(cx, cy, 7, -Math.PI / 2, -Math.PI / 2 + f.fret.aim01 * TAU);
        ctx.strokeStyle = C.deep + '.95)'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  drawSigns(f) {
    const { ctx, w, h } = this, L = f.layout;
    const x0 = L.neckX0 * w, ww = (L.neckX1 - L.neckX0) * w;
    const y0 = L.gridY0 * h, hh = (L.gridY1 - L.gridY0) * h;
    const n = f.bank.length, rh = hh / n;
    for (let i = 0; i < n; i++) {
      const y = y0 + i * rh + 3, ch = rh - 6;
      const on = i === f.slot, hot = f.fret?.present && f.fret.hover === i && !on;
      ctx.beginPath(); this.rr(ctx, x0, y, ww, ch, 12);
      ctx.fillStyle = on ? 'rgba(255,241,219,.82)' : hot ? 'rgba(255,248,236,.5)' : C.wood + '.26)';
      ctx.fill();
      ctx.lineWidth = on ? 2.4 : 1.2;
      ctx.strokeStyle = on ? C.deep + '.85)' : hot ? C.amber + '.85)' : C.cream + '.42)';
      ctx.stroke();

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `${Math.min(26, ch * 0.6)}px 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif`;
      ctx.fillText(f.bank[i].glyph, x0 + 14, y + ch / 2);
      ctx.textAlign = 'right';
      ctx.font = `600 ${Math.min(26, ch * 0.55)}px Fraunces, Georgia, serif`;
      ctx.fillStyle = on ? '#7A3D10' : 'rgba(255,252,246,.94)';
      ctx.shadowColor = on ? 'rgba(255,255,255,.6)' : C.ink + '.45)'; ctx.shadowBlur = on ? 6 : 8;
      ctx.fillText(f.bank[i].name, x0 + ww - 14, y + ch / 2);
      ctx.shadowBlur = 0;

      if (hot && f.fret.aim === i && f.fret.aim01 > 0.02) {
        ctx.beginPath();
        ctx.arc(x0 + ww / 2, y + ch - 9, 6, -Math.PI / 2, -Math.PI / 2 + f.fret.aim01 * TAU);
        ctx.strokeStyle = C.deep + '.95)'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.stroke();
      }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  }

  /** Cursor dot + mode dial for the fretting hand. */
  drawFretCue(f) {
    const { ctx, w, h } = this, F = f.fret;
    if (F.wheel.open) { this.drawWheel(F, f.wheelLabels.fret, f.fretLm); return; }
    if (F.wheel.arm01 > 0.02) this.drawArm(f.fretLm, F.wheel.arm01, '👍');
    if (f.cfg.chordMode !== 'signs') {
      const x = F.cur.x * w, y = F.cur.y * h, pointing = F.shape === 'point';
      ctx.beginPath(); ctx.arc(x, y, pointing ? 9 : 5, 0, TAU);
      ctx.fillStyle = pointing ? C.deep + '.95)' : C.cream + '.55)';
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = C.cream + '.9)'; ctx.stroke();
    }
  }

  /* ---------------- plucking half ---------------- */

  /** Six fixed horizontal strings on the plucking half, bass at the bottom. */
  stringY(i) { return this.h * (0.30 + (5 - i) * 0.082); }

  drawStrings(f, now) {
    const { ctx, w, h } = this, L = f.layout;
    const x0 = L.strumX0 * w + 14, x1 = L.strumX1 * w;
    const names = ['E', 'A', 'D', 'G', 'B', 'e'];
    const aim = f.cfg.playMode === 'finger' && f.pluck?.present ? f.pluck.target : -1;
    for (let i = 0; i < 6; i++) {
      const s = this.strings[i], base = this.stringY(i);
      const age = now - s.t0;
      let a = 0;
      if (age > 0 && s.amp > 0.001) { a = s.amp * Math.exp(-age * 3.4); if (age > 1.6) s.amp = 0; }
      const col = SCOL[i];
      const sounding = f.voicing ? f.voicing.midi[i] !== null : true;
      const targeted = i === aim;

      if (targeted) {                       // a soft band behind the aimed string
        ctx.beginPath(); this.rr(ctx, x0 - 4, base - 11, x1 - x0 + 8, 22, 11);
        ctx.fillStyle = C.amber + '.20)'; ctx.fill();
      }
      ctx.beginPath();
      const N = 26;
      for (let k = 0; k <= N; k++) {
        const u = k / N, x = x0 + (x1 - x0) * u;
        const y = base + Math.sin(u * Math.PI) * Math.sin(age * s.freq * TAU) * a * h * 0.02;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineWidth = (3.4 - i * 0.4) * (targeted ? 1.6 : 1);
      ctx.strokeStyle = `rgba(255,251,244,${(sounding ? 0.6 : 0.22) + a * 0.4 + (targeted ? 0.35 : 0)})`;
      ctx.shadowColor = col; ctx.shadowBlur = (targeted ? 12 : 4) + a * 16;
      ctx.stroke(); ctx.shadowBlur = 0;

      ctx.beginPath(); ctx.arc(x0 - 9, base, 4.5 + a * 3 + (targeted ? 2 : 0), 0, TAU);
      ctx.fillStyle = col; ctx.globalAlpha = sounding ? 0.95 : 0.35; ctx.fill(); ctx.globalAlpha = 1;
      ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillStyle = C.cream + (sounding ? '.9)' : '.45)');
      ctx.fillText(names[i], x0 - 18, base);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  }

  drawPluckHand(f) {
    const { ctx, w, h } = this;
    const lm = f.pluckLm; if (!lm) return;
    const P = f.pluck;
    this.drawHand(lm, () => C.sage + '.8)', false, 0, FCOL);
    if (P.wheel.open) { this.drawWheel(P, f.wheelLabels.pluck, lm); return; }
    if (P.wheel.arm01 > 0.02) { this.drawArm(lm, P.wheel.arm01, '👍'); return; }

    const c = this.palm(lm);
    if (f.cfg.playMode === 'finger') {
      if (P.target >= 0) {                 // ring fills as the count settles
        ctx.beginPath(); ctx.arc(c.x, c.y, 26, -Math.PI / 2, -Math.PI / 2 + P.hold01 * TAU);
        ctx.strokeStyle = SCOL[P.target]; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
        ctx.beginPath(); ctx.arc(c.x, c.y, 26, 0, TAU);
        ctx.strokeStyle = C.cream + '.25)'; ctx.lineWidth = 4; ctx.stroke();
        this.chip(c.x, c.y - 44, f.stringLabel || '');
      }
    } else if (P.active) {                 // steady halo while a pattern runs
      const pulse = 0.5 + 0.5 * Math.sin(f.now * 6);
      ctx.beginPath(); ctx.arc(c.x, c.y, 24 + pulse * 5, 0, TAU);
      ctx.strokeStyle = C.amber + (0.5 + pulse * 0.3) + ')'; ctx.lineWidth = 3.5; ctx.stroke();
      this.chip(c.x, c.y - 44, f.patternLabel || '');
    } else if (P.cand >= 0 && P.hold01 > 0.02) {
      ctx.beginPath(); ctx.arc(c.x, c.y, 26, -Math.PI / 2, -Math.PI / 2 + P.hold01 * TAU);
      ctx.strokeStyle = C.deep + '.9)'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
      ctx.beginPath(); ctx.arc(c.x, c.y, 26, 0, TAU);
      ctx.strokeStyle = C.deep + '.2)'; ctx.lineWidth = 4; ctx.stroke();
      this.chip(c.x, c.y - 44, f.patternLabel || '');
    }
  }

  /* ---------------- mode dial ---------------- */

  /** Progress ring + glyph while 👍 is being held down to open the dial. */
  drawArm(lm, p01, glyph) {
    const { ctx } = this, c = this.palm(lm);
    ctx.beginPath(); ctx.arc(c.x, c.y, 30, 0, TAU);
    ctx.strokeStyle = C.ink + '.18)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 30, -Math.PI / 2, -Math.PI / 2 + p01 * TAU);
    ctx.strokeStyle = C.amber + '.95)'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.stroke();
    ctx.font = '18px "Segoe UI Emoji","Apple Color Emoji",sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(glyph, c.x, c.y);
    ctx.textBaseline = 'alphabetic';
  }

  /** Two-option dial: tilt the hand to aim, open the palm to take it. */
  drawWheel(hand, labels, lm) {
    const { ctx } = this, c = this.palm(lm), R = 66;
    ctx.save();
    ctx.beginPath(); ctx.arc(c.x, c.y, R + 14, 0, TAU);
    ctx.fillStyle = 'rgba(40,28,18,.55)'; ctx.fill();

    labels.forEach((label, i) => {
      const on = i === hand.wheel.sel;
      const a0 = i === 0 ? Math.PI * 0.58 : -Math.PI * 0.42;
      const a1 = i === 0 ? Math.PI * 1.42 : Math.PI * 0.42;
      ctx.beginPath(); ctx.arc(c.x, c.y, R, a0, a1);
      ctx.strokeStyle = on ? C.amber + '.98)' : C.cream + '.30)';
      ctx.lineWidth = on ? 12 : 7; ctx.lineCap = 'butt'; ctx.stroke();

      const mid = (a0 + a1) / 2;
      ctx.font = `${on ? 600 : 400} ${on ? 14 : 12.5}px Inter, sans-serif`;
      ctx.fillStyle = on ? '#FFF6E6' : C.cream + '.7)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x + Math.cos(mid) * (R + 34), c.y + Math.sin(mid) * (R + 34));
    });

    // Accept ring: fills while the palm is open.
    ctx.beginPath(); ctx.arc(c.x, c.y, 30, -Math.PI / 2, -Math.PI / 2 + hand.wheel.arm01 * TAU);
    ctx.strokeStyle = C.sage + '.95)'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
    ctx.font = '600 10.5px Inter, sans-serif';
    ctx.fillStyle = C.cream + '.9)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('tilt', c.x, c.y - 7);
    ctx.fillText('✋ = ok', c.x, c.y + 7);
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------------- hands & helpers ---------------- */

  palm(lm) {
    return { x: (lm[0].x + lm[5].x + lm[17].x) / 3 * this.w,
             y: (lm[0].y + lm[5].y + lm[17].y) / 3 * this.h };
  }

  /** Small dark pill of text pinned above a hand. */
  chip(x, y, text) {
    if (!text) return;
    const { ctx } = this;
    ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const wd = ctx.measureText(text).width + 18;
    ctx.beginPath(); this.rr(ctx, x - wd / 2, y - 11, wd, 22, 11);
    ctx.fillStyle = 'rgba(40,28,18,.68)'; ctx.fill();
    ctx.fillStyle = '#FFF6E6'; ctx.fillText(text, x, y);
    ctx.textBaseline = 'alphabetic';
  }

  drawHand(lm, col, fist, vib, tipCols = null) {
    if (!lm) return;
    const { ctx, w, h } = this;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.shadowColor = col().replace(/[\d.]+\)$/, '.5)'); ctx.shadowBlur = 10;
    ctx.strokeStyle = col(); ctx.lineWidth = fist ? 4 : 3;
    for (const [a, b] of LINKS) {
      ctx.beginPath(); ctx.moveTo(lm[a].x * w, lm[a].y * h); ctx.lineTo(lm[b].x * w, lm[b].y * h); ctx.stroke();
    }
    ctx.shadowBlur = 0;
    [4, 8, 12, 16, 20].forEach((i, f) => {
      ctx.beginPath(); ctx.arc(lm[i].x * w, lm[i].y * h, tipCols ? 5.5 : 4, 0, TAU);
      ctx.fillStyle = tipCols ? tipCols[f] : 'rgba(255,252,246,.95)'; ctx.fill();
      ctx.strokeStyle = tipCols ? 'rgba(255,252,246,.9)' : col(); ctx.lineWidth = 2; ctx.stroke();
    });
    const c = this.palm(lm);
    if (fist) {
      ctx.beginPath(); ctx.arc(c.x, c.y, 16, 0, TAU); ctx.fillStyle = col().replace(/[\d.]+\)$/, '.30)'); ctx.fill();
    }
    if (vib > 0.05) {
      ctx.beginPath(); ctx.arc(c.x, c.y, 22 + vib * 16, 0, TAU);
      ctx.strokeStyle = C.amber + (0.25 + vib * 0.5) + ')'; ctx.lineWidth = 2 + vib * 3; ctx.stroke();
    }
  }

  rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
}
