/**
 * render.js — drawing the kit, and drawing the sticks into your hands.
 *
 * Visuals are load-bearing here, not decoration. An air instrument has no
 * physical object to aim at, so whatever is on screen *is* the instrument: if
 * the drums look like coloured circles the player is pointing at coloured
 * circles, and if the sticks look like sticks the player is holding sticks.
 * Three things do most of that work.
 *
 * **The sticks are rendered as objects, not as cursors.** A tapered wooden
 * shaft with a turned tip, gripped in the fist — butt poking back out of the
 * hand, shaft running down through the fingers and on toward the kit — with a
 * shadow cast onto the drums below and a motion trail that stretches with
 * speed. They appear when you close your hand and are lowered when you open it,
 * so picking them up and putting them down is something you *see*, not
 * something you read in a status line. That single detail is what turns a
 * tracked hand into a player.
 *
 * **The kit is drawn as drums.** Each pad is an ellipse — a drum head seen from
 * a player's angle — with a rim, lugs, a shell edge beneath it, and shading
 * that puts the near drums lower and larger than the far ones. Cymbals get a
 * different treatment entirely: thinner, brassier, with concentric lathe
 * grooves. You should be able to tell the ride from the snare with the labels
 * off, which you can.
 *
 * **A hit is answered on the head that was hit.** The head flashes, a ring
 * travels out from the point of contact, the drum dips and wobbles like a
 * struck membrane, and a spray of particles leaves the stick along the line it
 * was travelling. All four scale with velocity, so a ghost note and a rimshot
 * look as different as they sound.
 *
 * **And the drum you are *about to* hit is lit before you hit it.** Without
 * that, aiming is guesswork you only get feedback on after committing to a
 * stroke — you swing, something else sounds, and there is no way to learn
 * where the edges are. With it, the kit answers continuously to where the tip
 * is, and hitting the drum you meant becomes something you can see rather than
 * something you find out.
 *
 * The ring says two things at once, because a stroke needs two. Solid, with the
 * drum's surface drawn as a bright line across it, means the tip is above that
 * line and a stroke would land. Faint and dashed, with no line, means the tip
 * is already below it and has to come back up first — which is the one state
 * that would otherwise be a silent mystery, since everything looks right and
 * nothing sounds.
 *
 * Everything here works in normalised coordinates multiplied by the canvas
 * size, so it lines up with the video underneath at any aspect ratio.
 */
import { SURFACE } from './kit.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

/** Hands are told apart by hue, as in the other instruments. */
export const HAND_COL = { left: '#4E7FA8', right: '#C0631A' };

/* A drum kit is wood, skin and brass, and the palette is those three things —
 * kept warm so it sits on top of a webcam image without looking like a HUD.
 * The actual stops live in the gradients below, since every one of them is
 * shaded rather than flat. */

const isCymbal = (id) => id === 'crash' || id === 'ride' || id === 'hihat';

export class Overlay {
  constructor(canvas, video = null) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.video = video;
    this.hits = [];        // recent strikes, for the bloom
    this.bits = [];        // particles
    this.glow = new Map(); // pad id → how lit it is right now, 0…1
  }

  /**
   * Re-measure the canvas.
   *
   * `w`/`h` are what every coordinate is multiplied by, so a stale pair puts
   * the whole kit somewhere it isn't — which is exactly the displacement bug
   * that took three passes to find in the other instruments. A no-op when
   * nothing moved, so it is safe on a ResizeObserver and safe every frame.
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
   * Record a strike.
   * `at` is an audio-clock-aligned time so the flash and the hit land together
   * rather than the flash arriving a frame early.
   */
  onHit({ pad, x, y, hand, velocity, at, dir, open }) {
    this.hits.push({ pad, x, y, hand, velocity, at, open: !!open, dir: dir || { x: 0, y: -1 } });
    if (this.hits.length > 20) this.hits.shift();
    this._spray(x, y, velocity, dir, hand);
  }

  /** Chips of light thrown off along the stick's line of travel. */
  _spray(x, y, vel, dir, hand) {
    const n = Math.round(lerp(5, 16, clamp(vel, 0, 1)));
    const base = Math.atan2(-(dir?.y ?? -1), -(dir?.x ?? 0));   // back up the stroke
    for (let i = 0; i < n; i++) {
      const a = base + (Math.random() - 0.5) * 2.0;
      const sp = lerp(0.10, 0.42, Math.random()) * lerp(0.5, 1.5, vel);
      this.bits.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.06,
        life: 1, decay: lerp(1.6, 3.4, Math.random()), size: lerp(1.1, 2.8, Math.random()),
        col: HAND_COL[hand] || '#C0631A',
      });
    }
    if (this.bits.length > 260) this.bits.splice(0, this.bits.length - 260);
  }

  /**
   * @param f.pads      laid-out pads from the Kit
   * @param f.sticks    [{ id, stick, hold, speed, vel, over }]
   * @param f.now       audio-clock seconds, so flashes match what you hear
   * @param f.dt        seconds since the last frame
   * @param f.labels    show pad names
   * @param f.armed     the engine is running
   */
  draw(f) {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    this._decay(f);
    this._kit(f);
    this._bits(f.dt);
    this._sticks(f);
    if (!f.armed) this._hint(f);
  }

  /** Advance the per-pad glow and drop hits that have finished blooming. */
  _decay(f) {
    const dt = clamp(f.dt || 0.016, 0, 0.1);
    const fall = Math.exp(-dt / 0.11);
    for (const [k, v] of this.glow) {
      const nv = v * fall;
      if (nv < 0.004) this.glow.delete(k); else this.glow.set(k, nv);
    }
    for (const hit of this.hits) {
      if (hit.lit || hit.at > f.now) continue;
      hit.lit = true;
      const g = this.glow.get(hit.pad) || 0;
      this.glow.set(hit.pad, clamp(g + lerp(0.45, 1, hit.velocity), 0, 1.3));
    }
    this.hits = this.hits.filter((hit) => f.now - hit.at < 0.75);
  }

  /* ================================================================ *
   *  The kit
   * ================================================================ */
  _kit(f) {
    const { ctx, w, h } = this;
    /* Ground the kit. Without this the drums float on whatever the webcam
     * happens to be showing, and a busy room makes them read as stickers; a
     * soft pool of shade under everything is all it takes to put them in a
     * space. Cheap, and it does more for the illusion than any amount of
     * detail on the drums themselves. */
    const floor = ctx.createRadialGradient(w * 0.5, h * 1.02, h * 0.05, w * 0.5, h * 1.02, h * 0.78);
    floor.addColorStop(0, 'rgba(28,20,13,.30)');
    floor.addColorStop(0.55, 'rgba(28,20,13,.15)');
    floor.addColorStop(1, 'rgba(28,20,13,0)');
    ctx.fillStyle = floor;
    ctx.fillRect(0, 0, w, h);

    /* Which pad each raised stick is currently over. Collected before drawing
     * so a pad can be marked while it is being drawn rather than having a ring
     * stamped over the top of whatever ends up in front of it. */
    const aimed = new Map();
    for (const st of f.sticks || []) {
      if (st.hold <= 0.35 || !st.over) continue;
      const was = aimed.get(st.over);
      // Two sticks over one drum: whichever of them could actually play it wins
      // the ring, since that is the thing the ring is there to tell you.
      if (!was || (st.armed && !was.armed)) aimed.set(st.over, { col: HAND_COL[st.id] || '#C0631A', armed: !!st.armed });
    }

    // Far drums first, so the near ones overlap them the way a real kit stacks.
    const pads = [...(f.pads || [])].sort((a, b) => a.depth - b.depth);
    for (const pad of pads) {
      const lit = this.glow.get(pad.id) || 0;
      // A struck head sinks and spreads, then springs back. Small — a drum head
      // barely moves — but it is the difference between a light turning on and
      // something being hit.
      const dip = lit * 0.05;
      const cx = pad.x * w, cy = (pad.y + pad.ry * dip * 0.5) * h;
      const rx = pad.rx * w * (1 + dip * 0.35), ry = pad.ry * h * (1 - dip * 0.30);
      if (pad.id === 'hihat') this._hats(ctx, pad, cx, cy, rx, ry, lit, f);
      else if (isCymbal(pad.id)) this._cymbal(ctx, pad, cx, cy, rx, ry, lit, f);
      else this._drum(ctx, pad, cx, cy, rx, ry, lit, f);
      const a = aimed.get(pad.id);
      if (a) this._aim(ctx, cx, cy, rx, ry, a, f.now);
    }
    this._ripples(f);
    if (f.labels) for (const pad of pads) this._label(ctx, pad, w, h);
  }

  /**
   * "This is the one you would hit" — and, just as importantly, whether you
   * could hit it from where the stick currently is. See the header.
   */
  _aim(ctx, cx, cy, rx, ry, { col, armed }, now) {
    ctx.save();
    if (armed) {
      ctx.globalAlpha = 0.62 + 0.18 * Math.sin(now * 5);
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(2.2, ry * 0.20);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * 1.12, ry * 1.16, 0, 0, TAU);
      ctx.stroke();

      /* The surface itself, drawn where `kit.js` puts it. An air instrument has
       * no object to make contact with, so the line a stroke has to come down
       * through is otherwise invisible — and a rule you cannot see is a rule
       * you have to be told, repeatedly, and still get wrong. */
      const ly = cy - ry * SURFACE;
      const half = rx * Math.sqrt(Math.max(0, 1 - SURFACE * SURFACE));
      const g = ctx.createLinearGradient(cx - half, 0, cx + half, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, col);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = g;
      ctx.lineWidth = Math.max(1.6, ry * 0.11);
      ctx.beginPath();
      ctx.moveTo(cx - half, ly);
      ctx.lineTo(cx + half, ly);
      ctx.stroke();
    } else {
      // Below the surface: aimed at this drum, but the stick has to come up
      // before it can come down again.
      ctx.globalAlpha = 0.26;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.4, ry * 0.11);
      ctx.setLineDash([Math.max(5, rx * 0.13), Math.max(5, rx * 0.13)]);
      ctx.lineDashOffset = -now * 26;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * 1.12, ry * 1.16, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drum(ctx, pad, cx, cy, rx, ry, lit, f) {
    /* Shell, peeking out below the head — what makes it read as a drum and not
     * a disc lying on the floor. Kept shallow: it is pure decoration, it hangs
     * *below* the pad, and on a laptop-height window every pixel of it pushes
     * the bottom row of the kit closer to falling off the screen. */
    const depth = ry * 0.58;
    ctx.beginPath();
    ctx.ellipse(cx, cy + depth, rx, ry, 0, 0, Math.PI);
    ctx.lineTo(cx - rx, cy);
    ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 0, true);
    ctx.closePath();
    const shell = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
    shell.addColorStop(0, 'rgba(58,34,18,.92)');
    shell.addColorStop(0.35, 'rgba(120,72,38,.92)');
    shell.addColorStop(0.72, 'rgba(88,52,26,.92)');
    shell.addColorStop(1, 'rgba(48,28,15,.92)');
    ctx.fillStyle = shell;
    ctx.fill();

    // Head.
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    const g = ctx.createRadialGradient(cx - rx * 0.28, cy - ry * 0.42, ry * 0.08, cx, cy, rx);
    const a = lerp(0.30, 0.60, clamp(lit, 0, 1));
    g.addColorStop(0, `rgba(255,252,246,${a + 0.16})`);
    g.addColorStop(0.62, `rgba(244,237,225,${a})`);
    g.addColorStop(1, `rgba(206,190,168,${a + 0.06})`);
    ctx.fillStyle = g;
    ctx.fill();

    // Rim and lugs.
    ctx.lineWidth = Math.max(2, ry * 0.13);
    ctx.strokeStyle = lit > 0.02
      ? `rgba(255,214,138,${clamp(0.45 + lit * 0.55, 0, 1)})`
      : 'rgba(150,146,138,.85)';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(120,116,108,.75)';
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * TAU;
      const lx = cx + Math.cos(t) * rx * 1.03, ly = cy + Math.sin(t) * ry * 1.03;
      ctx.beginPath();
      ctx.ellipse(lx, ly, Math.max(1.4, rx * 0.030), Math.max(2.2, ry * 0.075), t, 0, TAU);
      ctx.fill();
    }
    // The snare's wires, visible under the near edge.
    if (pad.id === 'snare') {
      ctx.strokeStyle = `rgba(210,204,190,${0.30 + lit * 0.4})`;
      ctx.lineWidth = 1;
      for (let i = -3; i <= 3; i++) {
        const off = (i / 3) * rx * 0.42;
        ctx.beginPath();
        ctx.moveTo(cx + off, cy + ry * 0.86);
        ctx.lineTo(cx + off, cy + depth + ry * 0.55);
        ctx.stroke();
      }
    }
  }

  _cymbal(ctx, pad, cx, cy, rx, ry, lit, f, { stand = true } = {}) {
    /* A cymbal is thin, so it *tilts* rather than sinking, and it keeps moving
     * long after it was hit — which is the visual half of why a crash reads as
     * still ringing while a snare reads as already finished. */
    const ring = this._ringing(pad.id, f.now);
    const wob = Math.sin(f.now * 26 + pad.x * 30) * ring * 0.13;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(1, wob * 0.25, 0, 1 - Math.abs(wob) * 0.18, 0, 0);

    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
    const g = ctx.createRadialGradient(-rx * 0.3, -ry * 0.45, ry * 0.05, 0, 0, rx);
    const a = lerp(0.44, 0.78, clamp(lit, 0, 1));
    g.addColorStop(0, `rgba(248,228,168,${a + 0.14})`);
    g.addColorStop(0.5, `rgba(201,162,75,${a})`);
    g.addColorStop(1, `rgba(126,95,30,${a + 0.05})`);
    ctx.fillStyle = g;
    ctx.fill();

    // Lathe grooves — the concentric turning marks that make brass read as brass.
    ctx.strokeStyle = `rgba(94,70,20,${0.22 + lit * 0.25})`;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 5; i++) {
      const k = i / 6;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx * k, ry * k, 0, 0, TAU);
      ctx.stroke();
    }
    // Bell.
    ctx.beginPath();
    ctx.ellipse(0, -ry * 0.06, rx * 0.19, ry * 0.19, 0, 0, TAU);
    ctx.fillStyle = `rgba(242,220,155,${0.55 + lit * 0.4})`;
    ctx.fill();

    ctx.lineWidth = Math.max(1.5, ry * 0.07);
    ctx.strokeStyle = lit > 0.02
      ? `rgba(255,226,150,${clamp(0.5 + lit * 0.5, 0, 1)})`
      : 'rgba(140,107,34,.85)';
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
    ctx.stroke();
    ctx.restore();

    if (!stand) return;
    ctx.strokeStyle = 'rgba(70,64,56,.55)';
    ctx.lineWidth = Math.max(1.5, rx * 0.022);
    ctx.beginPath();
    ctx.moveTo(cx, cy + ry * 0.2);
    ctx.lineTo(cx, cy + ry * 2.6);
    ctx.stroke();
  }

  /**
   * The hi-hat, as the two discs it actually is.
   *
   * Where across it you strike is what decides open or closed — there is no
   * foot pedal to work with here, and every stroke arrives over the top of the
   * head, so up-and-down carries no information to read. Through the middle is
   * the closed hat, out at either edge is the open one, which also means the
   * ride's bell-to-bow gradient and the hat's tight-to-washy one are the same
   * gesture on both cymbals.
   *
   * The edges are therefore banded, because otherwise it is a rule the player
   * has to be told rather than something they can see. An open hit lifts the
   * top disc and it settles back down over the next second, so the hat looks
   * open for as long as it sounds open.
   */
  _hats(ctx, pad, cx, cy, rx, ry, lit, f) {
    let gap = 0;
    for (const hit of this.hits) {
      if (hit.pad !== 'hihat' || hit.at > f.now) continue;
      const k = Math.exp(-(f.now - hit.at) / 0.5);
      gap = Math.max(gap, hit.open ? k : -k);        // a closed hit slams it shut
    }
    gap = clamp(gap, 0, 1);
    const lift = ry * (0.34 + 1.05 * gap);
    this._cymbal(ctx, pad, cx, cy + ry * 0.34, rx * 0.94, ry * 0.94, lit * 0.55, f, { stand: true });
    const top = cy - lift * 0.5;
    this._cymbal(ctx, pad, cx, top, rx, ry, lit, f, { stand: false });

    // The open edges: the outer fifth on each side, marked just enough to be
    // findable without turning the cymbal into a diagram.
    ctx.save();
    ctx.globalAlpha = 0.30 + lit * 0.28 + gap * 0.3;
    ctx.strokeStyle = 'rgba(255,236,186,.95)';
    ctx.lineWidth = Math.max(1.6, ry * 0.16);
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx, top, rx * 0.97, ry * 0.97, 0,
        dir > 0 ? -0.42 : Math.PI - 0.42, dir > 0 ? 0.42 : Math.PI + 0.42);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** How much a cymbal is still moving — decays slower than the head flash. */
  _ringing(id, now) {
    let m = 0;
    for (const hit of this.hits) {
      if (hit.pad !== id || hit.at > now) continue;
      m = Math.max(m, hit.velocity * Math.exp(-(now - hit.at) / 0.55));
    }
    return m;
  }

  /** Rings travelling out from where the stick actually landed. */
  _ripples(f) {
    const { ctx, w, h } = this;
    for (const hit of this.hits) {
      const age = f.now - hit.at;
      if (age < 0 || age > 0.6) continue;
      const k = age / 0.6;
      const pad = (f.pads || []).find((p) => p.id === hit.pad);
      if (!pad) continue;
      const r = lerp(0.12, 1.5, Math.sqrt(k)) * lerp(0.7, 1.25, hit.velocity);
      ctx.save();
      ctx.globalAlpha = (1 - k) * (1 - k) * lerp(0.35, 0.9, hit.velocity);
      ctx.strokeStyle = HAND_COL[hit.hand] || '#C0631A';
      ctx.lineWidth = lerp(3.2, 0.6, k);
      ctx.beginPath();
      ctx.ellipse(hit.x * w, hit.y * h, pad.rx * w * r, pad.ry * h * r, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  _label(ctx, pad, w, h) {
    const lit = this.glow.get(pad.id) || 0;
    ctx.font = '600 11px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const x = pad.x * w, y = (pad.y + pad.ry * 0.02) * h + 4;
    ctx.fillStyle = `rgba(28,20,14,${0.34 + lit * 0.3})`;
    ctx.fillText(pad.label.toUpperCase(), x + 1, y + 1);
    ctx.fillStyle = `rgba(255,250,242,${0.72 + lit * 0.28})`;
    ctx.fillText(pad.label.toUpperCase(), x, y);
  }

  /* ================================================================ *
   *  Particles
   * ================================================================ */
  _bits(dt) {
    const { ctx, w, h } = this;
    const step = clamp(dt || 0.016, 0, 0.05);
    ctx.save();
    for (const b of this.bits) {
      b.life -= step * b.decay;
      if (b.life <= 0) continue;
      b.x += b.vx * step; b.y += b.vy * step;
      b.vy += step * 0.85;              // gravity, so the spray falls back
      b.vx *= 0.94; b.vy *= 0.985;
      ctx.globalAlpha = b.life * b.life;
      ctx.fillStyle = b.col;
      ctx.beginPath();
      ctx.arc(b.x * w, b.y * h, b.size * b.life, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    this.bits = this.bits.filter((b) => b.life > 0);
  }

  /* ================================================================ *
   *  The sticks
   * ================================================================ */
  _sticks(f) {
    for (const s of f.sticks || []) {
      if (s.stick?.mode === 'finger') this._finger(s, f); else this._stick(s, f);
    }
  }

  /**
   * Fingertip mode.
   *
   * Nothing is invented here, and the drawing says so: a sleeve along the
   * finger the player is actually pointing with, and a bead on the tip that is
   * a landmark rather than a projection. It brightens and grows with speed, and
   * it carries the same trail a stick tip does, because the one thing the
   * player needs to see is where the striking point is and how fast it is
   * going — which is exactly what the detector is watching.
   */
  _finger(s, f) {
    const { ctx, w, h } = this;
    const st = s.stick;
    if (!st) return;
    const col = HAND_COL[s.id] || '#C0631A';
    const up = s.hold;
    if (up < 0.02) return;
    const hot = clamp((s.speed - 1.2) / 9, 0, 1);

    const gx = st.grip.x * w, gy = st.grip.y * h;
    const tx = st.tip.x * w, ty = st.tip.y * h;
    const wide = clamp((st.unit * w) / 11, 3, 16);

    ctx.save();
    ctx.globalAlpha = up;

    if (s.speed > 0.7) {
      const stretch = clamp(s.speed / 10, 0, 1);
      ctx.strokeStyle = col;
      for (let i = 3; i >= 1; i--) {
        const k = (i / 3) * stretch * 1.6;
        ctx.globalAlpha = up * stretch * (0.28 / i);
        ctx.lineWidth = wide * (0.5 + i * 0.35);
        ctx.beginPath();
        ctx.moveTo(tx - s.vel.x * w * k, ty - s.vel.y * h * k);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      ctx.globalAlpha = up;
    }

    // The finger itself, sleeved from knuckle to tip — enough to read as "this
    // finger is the one that plays" without drawing a hand over the player's.
    ctx.lineCap = 'round';
    ctx.globalAlpha = up * 0.32;
    ctx.strokeStyle = col;
    ctx.lineWidth = wide * 0.9;
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(tx, ty);
    ctx.stroke();

    const bead = wide * (0.62 + hot * 0.22);
    ctx.globalAlpha = up * (s.armed ? 0.30 + hot * 0.42 : 0.14);
    const glow = ctx.createRadialGradient(tx, ty, bead * 0.3, tx, ty, bead * 3.2);
    glow.addColorStop(0, col);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(tx, ty, bead * 3.2, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = up;
    ctx.beginPath();
    ctx.arc(tx, ty, bead, 0, TAU);
    const g = ctx.createRadialGradient(tx - bead * 0.35, ty - bead * 0.35, bead * 0.15, tx, ty, bead);
    g.addColorStop(0, '#FFF6E6');
    g.addColorStop(1, col);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(52,34,16,.55)';
    ctx.stroke();
    ctx.restore();
  }

  _stick(s, f) {
    const { ctx, w, h } = this;
    const st = s.stick;
    if (!st) return;
    const col = HAND_COL[s.id] || '#C0631A';

    /* An open hand has put the stick down, so it fades out and sinks — the
     * gesture is legible without a word of instruction. */
    const up = s.hold;
    if (up < 0.02) return;
    const drop = (1 - up) * st.reach * 0.30;
    const hot = clamp((s.speed - 1.6) / 12, 0, 1);   // how fast it is travelling

    const bx = st.butt.x * w, by = (st.butt.y + drop) * h;
    const tx = st.tip.x * w, ty = (st.tip.y + drop) * h;
    const len = Math.hypot(tx - bx, ty - by);
    if (!(len > 4)) return;
    const ux = (tx - bx) / len, uy = (ty - by) / len;
    const px = -uy, py = ux;                       // across the stick
    // Thickness follows the stick's own length, not the hand's size: a real 5A
    // is about 400mm of wood at 14mm across, and holding that ratio is what
    // keeps it reading as a turned piece of hickory at any distance.
    const wide = clamp((st.reach * w) / 26, 2.6, 13);

    ctx.save();
    ctx.globalAlpha = up;

    /* Trail: where the tip has just been, smeared back along its travel. This
     * is what makes a hard stroke *look* hard before you hear it, so it is
     * built out of several fading passes rather than one flat streak — a single
     * translucent line reads as a graphic, a gradient of them reads as speed. */
    if (s.speed > 0.65) {
      const stretch = clamp(s.speed / 14, 0, 1);
      const back = { x: s.vel.x * w, y: s.vel.y * h };
      ctx.strokeStyle = col;
      ctx.lineCap = 'round';
      for (let i = 3; i >= 1; i--) {
        const k = (i / 3) * stretch * 1.5;
        ctx.globalAlpha = up * stretch * (0.30 / i);
        ctx.lineWidth = wide * (0.9 + i * 0.5);
        ctx.beginPath();
        ctx.moveTo(tx - back.x * k, ty - back.y * k);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
      ctx.globalAlpha = up;
    }

    // Shadow on the kit below — grounds the stick in the scene instead of
    // letting it float in front of the picture.
    ctx.globalAlpha = up * 0.20;
    ctx.strokeStyle = '#241a12';
    ctx.lineWidth = wide * 1.3;
    ctx.beginPath();
    ctx.moveTo(bx + wide * 1.6, by + wide * 2.6);
    ctx.lineTo(tx + wide * 1.6, ty + wide * 2.6);
    ctx.stroke();
    ctx.globalAlpha = up;

    /* The shaft, tapered: a drumstick is thicker at the butt and thins toward
     * the tip. Drawn as a quad rather than a stroked line, because a line of
     * even width reads as a pointer and a taper reads as a piece of wood. */
    const wb = wide, wt = wide * 0.62;
    ctx.beginPath();
    ctx.moveTo(bx + px * wb, by + py * wb);
    ctx.lineTo(tx + px * wt, ty + py * wt);
    ctx.lineTo(tx - px * wt, ty - py * wt);
    ctx.lineTo(bx - px * wb, by - py * wb);
    ctx.closePath();
    const grain = ctx.createLinearGradient(bx + px * wb, by + py * wb, bx - px * wb, by - py * wb);
    grain.addColorStop(0, '#5C3A18');
    grain.addColorStop(0.26, '#C08C46');
    grain.addColorStop(0.46, '#EBC489');
    grain.addColorStop(0.70, '#A9762F');
    grain.addColorStop(1, '#4E3115');
    ctx.fillStyle = grain;
    ctx.fill();
    ctx.strokeStyle = 'rgba(52,34,16,.55)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // A rim light down one side. One line, and it is most of what stops the
    // shaft reading as a flat brown polygon.
    ctx.globalAlpha = up * 0.5;
    ctx.strokeStyle = 'rgba(255,242,214,.75)';
    ctx.lineWidth = Math.max(1, wide * 0.22);
    ctx.beginPath();
    ctx.moveTo(bx + px * wb * 0.62, by + py * wb * 0.62);
    ctx.lineTo(tx + px * wt * 0.62, ty + py * wt * 0.62);
    ctx.stroke();
    ctx.globalAlpha = up;

    // The turned tip — an acorn bead, which is the silhouette that says
    // "drumstick" rather than "pencil".
    const bead = wide * 1.45;
    ctx.beginPath();
    ctx.ellipse(tx, ty, bead, bead * 0.86, Math.atan2(uy, ux), 0, TAU);
    const bg = ctx.createRadialGradient(tx - ux * bead * 0.3, ty - uy * bead * 0.3, bead * 0.15, tx, ty, bead);
    bg.addColorStop(0, '#F2D9A8');
    bg.addColorStop(1, '#9A6C33');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(52,34,16,.5)';
    ctx.stroke();

    /* Grip tape, in the hand's colour, wrapped over the butt end of the shaft.
     * Drummers really do tape their grips, and it solves the one thing a pair
     * of identical wooden sticks cannot: at a glance, across a moving frame,
     * which stick is which hand. A small coloured dot does not survive motion
     * blur; a band along a third of the shaft does.
     *
     * It runs from the butt to a little past the fist, which is not decoration:
     * it is the band the hand closes around, so it puts the *held* part of the
     * stick exactly where the hand is and the stick reads as gripped rather
     * than as stuck to a wrist. */
    const wrap = 0.34;
    const mx = bx + (tx - bx) * wrap, my = by + (ty - by) * wrap;
    const ww = lerp(wb, wt, wrap);
    ctx.beginPath();
    ctx.moveTo(bx + px * wb, by + py * wb);
    ctx.lineTo(mx + px * ww, my + py * ww);
    ctx.lineTo(mx - px * ww, my - py * ww);
    ctx.lineTo(bx - px * wb, by - py * wb);
    ctx.closePath();
    ctx.fillStyle = col;
    ctx.globalAlpha = up * 0.9;
    ctx.fill();
    ctx.globalAlpha = up * 0.35;
    ctx.strokeStyle = 'rgba(255,250,242,.9)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Where the tape ends, which is the detail that makes it read as wrapped on
    // rather than as a colour change in the wood.
    ctx.globalAlpha = up * 0.55;
    ctx.strokeStyle = 'rgba(255,252,246,.85)';
    ctx.lineWidth = Math.max(1, wide * 0.18);
    ctx.beginPath();
    ctx.moveTo(mx + px * ww, my + py * ww);
    ctx.lineTo(mx - px * ww, my - py * ww);
    ctx.stroke();
    ctx.globalAlpha = up;

    /* A soft halo at the tip whenever it is over a drum. The drum itself is
     * ringed too — this end of it says *which stick* is doing the aiming, which
     * matters the moment both are over the same one. It brightens with speed,
     * so a stick that is committed to a stroke looks it. */
    if (s.over) {
      const g = ctx.createRadialGradient(tx, ty, bead * 0.4, tx, ty, bead * (2.2 + hot * 1.4));
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = up * (s.armed ? 0.34 + hot * 0.4 : 0.16);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(tx, ty, bead * (2.2 + hot * 1.4), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Shown before the kit is live, so an idle screen still explains itself. */
  _hint(f) {
    const { ctx, w, h } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '600 15px Inter, ui-sans-serif, system-ui, sans-serif';
    const msg = f.hint || 'Close your hands to pick up the sticks';
    ctx.fillStyle = 'rgba(28,20,14,.45)';
    ctx.fillText(msg, w / 2 + 1, h * 0.12 + 1);
    ctx.fillStyle = 'rgba(255,250,242,.92)';
    ctx.fillText(msg, w / 2, h * 0.12);
    ctx.restore();
  }
}
