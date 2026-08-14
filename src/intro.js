/**
 * intro.js — the front door: one canvas of sky, three scenes over the top.
 *
 * ── The layers ────────────────────────────────────────────────────────────
 * Everything that moves is drawn on a single canvas in one rAF, back to front:
 *
 *   Nebula     domain-warped fBm cloud, generated once into three coloured
 *              tiles and then only ever blitted
 *   Stars      ~600 of them across three depths, parallaxed against the clouds,
 *              a handful with diffraction flares
 *   Horizon    a planet's limb low in the frame, so the content has a floor
 *   Scrim      a soft dark pool through the middle: the price of a busy sky is
 *              that type stops being readable, and this is how it is paid
 *   Dial       a ring of spectrum ticks — the score, drawn as an instrument
 *   Strings    six pluckable lines, answering the pointer *and* the score
 *   Dust       parallax motes, pushed by the cursor and by shockwaves
 *   Waves      expanding rings thrown by ENTER and by every click
 *   Cursor     a soft light following the pointer on a spring
 *
 * ── Why noise and not gradients ───────────────────────────────────────────
 * The first version of this background was five big radial gradients drifting
 * on Lissajous paths. It was cheap, it was smooth, and it looked like every
 * other dark landing page — because a radial gradient can only ever make a
 * blob, and a nebula is not blobs. It is filaments: bright threads with dark
 * dust lanes between them. That structure comes from *domain warping* — sample
 * the noise at coordinates that are themselves displaced by noise — and there
 * is no way to fake it with gradients.
 *
 * It costs about a tenth of a second per tile, which is far too long to spend
 * inside a frame, so the tiles are built one per rAF and faded in as they
 * arrive. The page is interactive throughout and the sky assembles behind it.
 *
 * ── Sound is never ahead of consent ───────────────────────────────────────
 * The threshold overlay exists because a browser will not start audio without a
 * genuine gesture, and a page that opens by asking permission to make noise has
 * already lost the moment. So the overlay asks for exactly one click, and that
 * click is what builds the audio graph. Nothing before it makes a sound — a
 * pointermove is not user activation, and `test/smoke.mjs` asserts that dragging
 * across the strings builds no AudioContext at all.
 *
 * The instrument pages load none of this: UI sound inside Air Guitar would fight
 * the thing you are actually playing.
 */
import { IntroAudio } from './audio-intro.js';
/* Only the two-line settings half of privacy.js reaches this page. The face
   model and the MediaPipe bundle are behind a dynamic import inside FaceVeil,
   which the shelf never constructs — so choosing the setting here costs a
   localStorage write and nothing else. */
import { faceHidden, setFaceHidden, onFaceHiddenChange } from './privacy.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

const VIOLET = '139,107,255', CYAN = '59,227,236', AMBER = '255,179,92', ROSE = '255,110,147';
const BANDS = 40;

/** A soft round light, drawn once and then only ever blitted. */
function sprite(rgb, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(${rgb},1)`);
  grd.addColorStop(0.22, `rgba(${rgb},.42)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/* ================================================================== *
 *  Noise
 * ================================================================== */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u, bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

function fbm(x, y, seed, oct) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f, seed + i * 131);
    norm += amp; f *= 2.03; amp *= 0.5;
  }
  return v / norm;
}

/**
 * One cloud tile. The `warp` term is the whole trick: sampling the noise at
 * coordinates that have themselves been displaced by noise is what turns round
 * blobs into the threads and dust lanes a nebula is actually made of.
 *
 * The radial falloff at the end is not cosmetic either — without it the tile's
 * square edge is plainly visible everywhere it is blitted.
 */
function makeCloud({ size, seed, scale, warp, contrast, threshold, gain, lo, hi }) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    const fy = y / size;
    for (let x = 0; x < size; x++) {
      const fx = x / size;

      // Round the tile off first — most pixels fail here, and the cheap test
      // saves the expensive noise on all of them.
      const dx = fx - 0.5, dy = fy - 0.5;
      let fall = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2.05);
      if (fall <= 0) continue;
      fall = Math.pow(fall, 1.35);

      const nx = fx * scale, ny = fy * scale;
      const wx = fbm(nx + 5.2, ny + 1.3, seed + 311, 2) - 0.5;
      const wy = fbm(nx + 9.7, ny + 8.1, seed + 577, 2) - 0.5;

      /* Summed octaves of value noise cluster hard around 0.5 — the raw range
       * is roughly 0.3–0.7, not 0–1. Thresholding that directly and then
       * raising it to a power left every pixel at about 3% alpha, which is why
       * the first build's sky was invisible. Stretch the contrast about the
       * midpoint *first*, and the threshold then means what it looks like it
       * means: dark lanes below it, bright filaments above. */
      let n = fbm(nx + warp * wx, ny + warp * wy, seed, 5);
      n = (n - 0.5) * contrast + 0.5;
      n = (n - threshold) / (1 - threshold);
      if (n <= 0) continue;
      if (n > 1) n = 1;

      const dens = Math.pow(n, 1.35) * gain * fall;
      if (dens <= 0.004) continue;

      // A second, slower noise moves the colour around inside the cloud, so it
      // is not one hue at varying brightness.
      const t = fbm(nx * 0.55 + 3, ny * 0.55 + 7, seed + 907, 2);
      const i = (y * size + x) * 4;
      d[i]     = lo[0] + (hi[0] - lo[0]) * t;
      d[i + 1] = lo[1] + (hi[1] - lo[1]) * t;
      d[i + 2] = lo[2] + (hi[2] - lo[2]) * t;
      d[i + 3] = Math.min(255, dens * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

const CLOUDS = [
  // The big rose-magenta body.
  { size: 384, seed: 11, scale: 2.2, warp: 1.05, contrast: 2.1, threshold: 0.30, gain: 2.0,
    lo: [126, 22, 94], hi: [255, 104, 168] },
  // Violet through the middle of it.
  { size: 384, seed: 47, scale: 3.4, warp: 1.40, contrast: 2.3, threshold: 0.34, gain: 1.7,
    lo: [54, 30, 158], hi: [162, 122, 255] },
  // And the cold bright wisps on top.
  { size: 336, seed: 83, scale: 5.2, warp: 1.75, contrast: 2.6, threshold: 0.54, gain: 1.5,
    lo: [28, 118, 176], hi: [210, 250, 255] },
];

class Nebula {
  constructor() { this.tiles = []; this.built = 0; this.ready = 0; this.px = 0; this.py = 0; }

  /** One tile per frame. Each costs ~100 ms, which is a stall inside a frame
   *  and nothing at all spread across three. */
  build() {
    if (this.built >= CLOUDS.length) return false;
    this.tiles.push(makeCloud(CLOUDS[this.built++]));
    return true;
  }

  frame(ctx, t, w, h, mood) {
    if (!this.tiles.length) return;
    this.ready = Math.min(1, this.ready + 0.02);
    const span = Math.max(w, h);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.tiles.length; i++) {
      const tile = this.tiles[i];
      const depth = 0.3 + i * 0.35;
      // Two passes per tile at different scales and rotations: one copy of a
      // cloud is a shape you can recognise, two overlapping is a cloud.
      for (let k = 0; k < 2; k++) {
        const ph = i * 2.1 + k * 3.7;
        const drift = reduced ? 0 : t;
        const sc = span * (1.14 + i * 0.13 + k * 0.30);
        const cx = w * (0.5 + Math.sin(drift * 0.0085 + ph) * (0.22 + k * 0.1)) + this.px * depth;
        const cy = h * (0.40 + Math.cos(drift * 0.0067 + ph * 1.3) * (0.20 + k * 0.08)) + this.py * depth;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.sin(drift * 0.0038 + ph) * 0.28 + k * 1.9);
        // Steeply falling per layer: the fine cold layer is meant to be
        // highlights on top of the body, and at an even alpha it turns the
        // whole sky into grey fog instead.
        ctx.globalAlpha = (0.8 - i * 0.21) * (k ? 0.6 : 1) * mood * this.ready;
        ctx.drawImage(tile, -sc / 2, -sc / 2, sc, sc);
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

/* ================================================================== *
 *  Stars
 * ================================================================== */
const STAR_COLS = ['255,255,255', '186,214,255', '255,224,196'];

class Stars {
  constructor() { this.list = []; this.flares = []; this.flare = sprite('255,255,255', 96); }

  seed() {
    const n = reduced ? 260 : coarse ? 360 : 620;
    this.list = [];
    for (let i = 0; i < n; i++) {
      const z = Math.random();
      this.list.push({
        x: Math.random(), y: Math.random(), z,
        r: (0.6 + Math.random() * 1.4) * (0.55 + z * 0.85),
        a: 0.2 + Math.random() * 0.8,
        ph: Math.random() * 9, sp: 0.5 + Math.random() * 1.9,
        c: Math.random() < 0.18 ? 1 : Math.random() < 0.12 ? 2 : 0,
      });
    }
    // Grouped by colour so the whole field costs three fillStyle changes a
    // frame instead of six hundred.
    this.list.sort((p, q) => p.c - q.c);
    this.flares = this.list.filter(() => Math.random() < 0.018).slice(0, 14);
  }

  frame(ctx, t, w, h, px, py, mood) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    let col = -1;
    for (const s of this.list) {
      if (s.c !== col) { col = s.c; ctx.fillStyle = `rgb(${STAR_COLS[col]})`; }
      const par = 0.2 + s.z * 1.0;
      const x = s.x * w + px * par, y = s.y * h + py * par;
      const tw = reduced ? 0.85 : 0.5 + 0.5 * Math.sin(t * s.sp + s.ph);
      ctx.globalAlpha = s.a * tw * mood;
      ctx.fillRect(x - s.r * 0.5, y - s.r * 0.5, s.r, s.r);
    }

    // A few get a bloom and a cross. Diffraction spikes are what make a bright
    // star read as bright rather than as merely bigger.
    for (const s of this.flares) {
      const par = 0.2 + s.z * 1.0;
      const x = s.x * w + px * par, y = s.y * h + py * par;
      const tw = reduced ? 0.85 : 0.55 + 0.45 * Math.sin(t * s.sp * 0.7 + s.ph);
      const a = s.a * tw * mood;
      const R = 13 + s.z * 16;
      ctx.globalAlpha = a * 0.55;
      ctx.drawImage(this.flare, x - R, y - R, R * 2, R * 2);
      ctx.globalAlpha = a * 0.5;
      ctx.strokeStyle = `rgb(${STAR_COLS[s.c]})`;
      ctx.lineWidth = 0.7;
      const L = R * 2.1;
      ctx.beginPath();
      ctx.moveTo(x - L, y); ctx.lineTo(x + L, y);
      ctx.moveTo(x, y - L * 0.6); ctx.lineTo(x, y + L * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ================================================================== *
 *  StringField — six pluckable strings
 * ================================================================== */
const STRINGS = [
  { rgb: AMBER,  wob: 5.5 },
  { rgb: ROSE,   wob: 7.1 },
  { rgb: VIOLET, wob: 8.7 },
  { rgb: '120,150,255', wob: 10.3 },
  { rgb: CYAN,   wob: 11.9 },
  { rgb: '190,245,255', wob: 13.5 },
];

class StringField {
  constructor() {
    this.s = STRINGS.map((d) => ({ ...d, amp: 0, at: -9, px: 0.5 }));
    this.pointer = { x: -1, y: -1, px: -1, py: -1, on: false };
    this.w = 1; this.h = 1;
    // Faded down behind the shelf: six lines ruled across three cards is
    // texture on the hero and clutter anywhere else.
    this.alpha = 1; this.alphaTo = 1;
  }

  resize(w, h) { this.w = w; this.h = h; }

  /** Strings sit in the middle 60% of the viewport, bass lowest. */
  yOf(i) { return this.h * (0.2 + (5 - i) * 0.12); }

  /** @param at where along the string it was struck, 0..1 — the bulge goes there. */
  pluck(i, vel = 0.8, at = 0.5) {
    const s = this.s[i];
    if (!s) return;
    s.amp = clamp(Math.max(vel, s.amp * 0.6), 0.15, 1);
    s.at = performance.now() / 1000;
    s.px = clamp(at, 0.08, 0.92);
  }

  strumAll(vel = 0.85) {
    this.s.forEach((_, i) => setTimeout(() => this.pluck(i, vel, 0.5), i * 52));
  }

  /**
   * A drag plucks any string the pointer *crossed* since the last frame, not
   * merely one it is near: sweeping fast across all six has to fire all six, and
   * a proximity test at 60 fps drops the ones you jumped over.
   */
  movePointer(x, y) {
    const p = this.pointer;
    p.px = p.on ? p.x : x; p.py = p.on ? p.y : y;
    p.x = x; p.y = y; p.on = true;
    const speed = Math.hypot(x - p.px, y - p.py);
    if (speed < 0.6) return;
    for (let i = 0; i < 6; i++) {
      const yy = this.yOf(i);
      const crossed = (p.py - yy) * (y - yy) <= 0 && Math.abs(p.py - y) > 0.001;
      if (crossed && Math.abs(x - this.w / 2) < this.w * 0.62) {
        this.pluck(i, clamp(0.25 + speed / 40, 0.25, 0.95), x / this.w);
      }
    }
  }

  leave() { this.pointer.on = false; }

  frame(ctx, now, glow) {
    const { w, h } = this;
    this.alpha += (this.alphaTo - this.alpha) * 0.06;
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const s = this.s[i], y0 = this.yOf(i);
      const age = now - s.at;
      const a = s.amp > 0.002 ? s.amp * Math.exp(-age * 2.5) : 0;
      if (a < 0.002) s.amp = 0;
      // Idle breathing, so the field never looks like a dead screenshot.
      const idle = reduced ? 0 : Math.sin(now * 0.6 + i * 1.1) * 1.4;

      /* Suspended in the middle of the frame rather than ruled edge to edge.
       * Full-width lines over a nebula stop reading as strings and start
       * reading as scan lines, and the ends carried no information anyway —
       * the pluck test already ignores anything past 0.19w / 0.81w. */
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, `rgba(${s.rgb},0)`);
      g.addColorStop(0.26, `rgba(${s.rgb},${0.07 + a * 0.6})`);
      g.addColorStop(0.74, `rgba(${s.rgb},${0.07 + a * 0.6})`);
      g.addColorStop(1, `rgba(${s.rgb},0)`);

      ctx.beginPath();
      const N = 64;
      for (let k = 0; k <= N; k++) {
        const u = k / N, x = w * (0.13 + 0.74 * u);
        // A pluck bulges where it was struck, not always at the middle: two
        // straight segments meeting at s.px, smoothed by the sine.
        const env = u < s.px
          ? Math.sin((u / s.px) * Math.PI * 0.5)
          : Math.sin(((1 - u) / (1 - s.px)) * Math.PI * 0.5);
        const y = y0 + env * (idle + Math.sin(age * s.wob * Math.PI * 2) * a * h * 0.06);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineWidth = (1.9 - i * 0.19) * (1 + a * 0.9);
      ctx.strokeStyle = g;
      if (glow) { ctx.shadowColor = `rgb(${s.rgb})`; ctx.shadowBlur = 5 + a * 26; }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (a > 0.01) {                       // a bead of light where it was struck
        const bx = w * (0.13 + 0.74 * s.px);
        const bg = ctx.createRadialGradient(bx, y0, 0, bx, y0, 6 + a * 34);
        bg.addColorStop(0, `rgba(255,255,255,${a * 0.75})`);
        bg.addColorStop(0.35, `rgba(${s.rgb},${a * 0.5})`);
        bg.addColorStop(1, `rgba(${s.rgb},0)`);
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.arc(bx, y0, 6 + a * 34, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

/* ================================================================== *
 *  Dial — the score, drawn as an instrument
 * ================================================================== */
/* Tick colours run bass → treble around the ring, so the shape you see is the
 * shape of the chord. Bucketed into three so the whole dial costs three strokes
 * a frame rather than ninety-six. */
const DIAL_COLS = [AMBER, VIOLET, CYAN];

class Dial {
  constructor() {
    this.raw = new Float32Array(BANDS);
    this.sm = new Float32Array(BANDS);
    this.alpha = 0; this.alphaTo = 0;
    this.hit = 0;                         // kicked by every note
  }

  frame(ctx, t, w, h, level) {
    this.alpha += (this.alphaTo - this.alpha) * 0.05;
    // A ring only works if it can get *outside* the words. Below about 840 px
    // it cannot, and it starts cutting through the eyebrow and the lede instead
    // of framing them — so it stands down rather than shrinking into the copy.
    const room = clamp((w - 620) / 220, 0, 1);
    const alpha = this.alpha * room;
    if (alpha < 0.01) return;
    const cx = w / 2, cy = h * 0.44;
    const R = Math.min(w, h) * 0.315;
    this.hit *= 0.94;

    for (let b = 0; b < BANDS; b++) {
      // Silent, or muted: the dial idles rather than flatlining.
      const target = level > 0.004 ? this.raw[b]
        : reduced ? 0.1
        : 0.08 + 0.05 * Math.sin(t * 0.7 + b * 0.34) + 0.03 * Math.sin(t * 0.27 + b * 0.83);
      this.sm[b] += (target - this.sm[b]) * 0.22;
    }

    const rot = reduced ? 0 : t * 0.028;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // The track the ticks stand on.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.strokeStyle = `rgba(237,241,255,${0.055 * alpha})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    const N = 96;
    for (let bucket = 0; bucket < 3; bucket++) {
      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const u = i / N;
        // Mirror around the vertical axis: a dial with a seam reads as a bug.
        const m = u <= 0.5 ? u * 2 : (1 - u) * 2;
        if (Math.min(2, Math.floor(m * 3)) !== bucket) continue;
        const f = m * (BANDS - 1);
        const i0 = Math.floor(f), i1 = Math.min(BANDS - 1, i0 + 1);
        const v = lerp(this.sm[i0], this.sm[i1], f - i0);
        const a = u * TAU - Math.PI / 2 + rot;
        const ca = Math.cos(a), sa = Math.sin(a);
        const len = 3 + v * 36 + this.hit * 5;
        ctx.moveTo(cx + ca * R, cy + sa * R);
        ctx.lineTo(cx + ca * (R + len), cy + sa * (R + len));
      }
      ctx.strokeStyle = `rgba(${DIAL_COLS[bucket]},${0.6 * alpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ================================================================== *
 *  Stage
 * ================================================================== */
class Stage {
  constructor(canvas, field) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.field = field;
    this.nebula = new Nebula();
    this.stars = new Stars();
    this.dial = new Dial();
    this.waves = [];
    this.sprites = [sprite('255,255,255'), sprite(CYAN), sprite(VIOLET), sprite(AMBER)];

    this.maxDust = reduced ? 50 : coarse ? 90 : 190;
    this.dustN = this.maxDust;
    this.glow = !reduced;
    this.dt = 16; this.slow = 0; this.fast = 0;
    this.mood = 0.9; this.moodTo = 0.9;

    this.ptr = { x: -999, y: -999, sx: -999, sy: -999, in: false };
    this.stars.seed();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, coarse ? 1.5 : 2);
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.field.resize(this.w, this.h);
    this.seedDust();
  }

  seedDust() {
    this.dust = [];
    for (let i = 0; i < this.maxDust; i++) {
      const z = rnd(0.22, 1);
      this.dust.push({
        x: Math.random() * this.w, y: Math.random() * this.h, z,
        vx: rnd(-4, 4) * z, vy: rnd(-9, -1.5) * z,
        r: rnd(0.7, 2.4) * z, ph: Math.random() * 9,
        sp: this.sprites[(Math.random() * this.sprites.length) | 0],
      });
    }
  }

  point(x, y) { this.ptr.x = x; this.ptr.y = y; this.ptr.in = true; }
  leave() { this.ptr.in = false; }

  shock(x, y, { power = 1, rgb = CYAN } = {}) {
    // `r` starts at 0 rather than undefined: the dust reads it a frame before
    // waveFrame first writes it, and NaN there shoves every mote on screen.
    this.waves.push({ x, y, r: 0, t: 0, life: 1.15 * power, max: Math.max(this.w, this.h) * 0.75 * power, rgb, power });
    if (this.waves.length > 6) this.waves.shift();
  }

  /* ---- the frame ---- */
  frame(ms, level) {
    const t = ms / 1000;
    const dt = clamp(this.lastMs ? ms - this.lastMs : 16, 4, 50);
    this.lastMs = ms;
    this.govern(dt);
    this.mood += (this.moodTo - this.mood) * 0.045;

    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);

    // Parallax: the sky leans the other way from the pointer, which is what
    // makes it read as distant rather than as a picture stuck to the glass.
    const p = this.ptr;
    const parX = p.in && !coarse ? (p.sx - w / 2) * -0.022 : 0;
    const parY = p.in && !coarse ? (p.sy - h / 2) * -0.018 : 0;
    this.nebula.px = parX; this.nebula.py = parY;

    this.nebula.frame(ctx, t, w, h, this.mood);
    this.stars.frame(ctx, t, w, h, parX * 1.4, parY * 1.4, this.mood);
    this.horizon(ctx, w, h, this.mood);
    this.scrim(ctx, w, h);
    this.dial.frame(ctx, t, w, h, level);
    this.field.frame(ctx, t, this.glow);
    this.dustFrame(dt / 16);
    this.waveFrame(dt / 1000);
    this.cursorFrame();
  }

  /**
   * A planet's limb, low in the frame. This is the single element that stops
   * the page reading as content floating in the middle of nothing: once there
   * is a horizon, everything above it is *somewhere*.
   */
  horizon(ctx, w, h, mood) {
    const cy = h * 1.42, rx = w * 1.04, ry = h * 0.56;
    ctx.save();
    // Work in a circle and let the transform make it an ellipse, so a single
    // radial gradient can carry the whole limb. Stacked wide strokes were the
    // obvious way to do this and they banded: a 260 px stroke is a band with
    // two hard edges, and six of them are six hard edges.
    ctx.translate(w / 2, cy);
    ctx.scale(1, ry / rx);

    // The body first, and dark — a planet is a silhouette with a lit edge, and
    // without the silhouette the glow is just a smear at the bottom.
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.fillStyle = `rgba(3,2,9,${0.72 * mood + 0.2})`;
    ctx.fill();

    ctx.globalCompositeOperation = 'lighter';
    const R = rx * 1.55, limb = rx / R;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(limb - 0.06, `rgba(126,26,84,${0.05 * mood})`);
    g.addColorStop(limb - 0.008, `rgba(255,168,140,${0.34 * mood})`);
    g.addColorStop(limb, `rgba(255,242,224,${0.62 * mood})`);
    g.addColorStop(limb + 0.014, `rgba(255,146,150,${0.3 * mood})`);
    g.addColorStop(limb + 0.06, `rgba(226,80,168,${0.13 * mood})`);
    g.addColorStop(limb + 0.17, `rgba(150,60,200,${0.05 * mood})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** The price of a busy sky. Without it the lede is unreadable over the
   *  bright half of the nebula, and no amount of text-shadow fixes that. */
  scrim(ctx, w, h) {
    const g = ctx.createRadialGradient(w / 2, h * 0.44, 0, w / 2, h * 0.44, Math.min(w, h) * 0.62);
    const k = this.mood;
    g.addColorStop(0, `rgba(3,4,12,${0.6 * k})`);
    g.addColorStop(0.48, `rgba(3,4,12,${0.36 * k})`);
    g.addColorStop(1, 'rgba(3,4,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /** Spend the budget on particles first: dropping motes is invisible, dropping
   *  frames is not. */
  govern(dt) {
    this.dt = this.dt * 0.9 + dt * 0.1;
    if (this.dt > 21) { this.slow++; this.fast = 0; } else if (this.dt < 14) { this.fast++; this.slow = 0; }
    if (this.slow > 40) {
      this.slow = 0;
      if (this.dustN > 40) this.dustN = Math.max(40, this.dustN - 35);
      else this.glow = false;
    } else if (this.fast > 160 && this.dustN < this.maxDust) {
      this.fast = 0; this.dustN = Math.min(this.maxDust, this.dustN + 20);
    }
  }

  dustFrame(k) {
    const { ctx, w, h } = this;
    const p = this.ptr;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.dustN; i++) {
      const d = this.dust[i];
      if (!reduced) {
        d.x += (d.vx + Math.sin(this.lastMs * 0.0004 + d.ph) * 0.35 * d.z) * k * 0.06;
        d.y += d.vy * k * 0.06;

        // The cursor shoulders motes out of the way — nearer ones move more.
        if (p.in) {
          const dx = d.x - p.x, dy = d.y - p.y, dd = Math.hypot(dx, dy);
          if (dd < 170 && dd > 0.001) {
            const f = (1 - dd / 170) ** 2 * 2.6 * d.z * k;
            d.x += (dx / dd) * f; d.y += (dy / dd) * f;
          }
        }
        for (const wv of this.waves) {
          const dx = d.x - wv.x, dy = d.y - wv.y, dd = Math.hypot(dx, dy);
          const band = Math.abs(dd - wv.r);
          if (band < 70 && dd > 0.001) {
            const f = (1 - band / 70) * 5.5 * d.z * k * (1 - wv.t / wv.life);
            d.x += (dx / dd) * f; d.y += (dy / dd) * f;
          }
        }
        if (d.y < -20) { d.y = h + 20; d.x = Math.random() * w; }
        if (d.y > h + 20) d.y = -20;
        if (d.x < -20) d.x = w + 20; else if (d.x > w + 20) d.x = -20;
      }
      const tw = 0.55 + 0.45 * Math.sin(this.lastMs * 0.0011 + d.ph);
      const s = d.r * 11;
      ctx.globalAlpha = clamp(d.z * 0.4 * tw * this.mood, 0, 1);
      ctx.drawImage(d.sp, d.x - s / 2, d.y - s / 2, s, s);
    }
    ctx.restore();
  }

  waveFrame(dts) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const wv = this.waves[i];
      wv.t += dts;
      const u = wv.t / wv.life;
      if (u >= 1) { this.waves.splice(i, 1); continue; }
      // Fast out, slow to settle: an impact, not a balloon.
      wv.r = wv.max * (1 - Math.pow(1 - u, 2.6));
      const a = (1 - u) ** 1.8;
      ctx.beginPath();
      ctx.arc(wv.x, wv.y, wv.r, 0, TAU);
      ctx.strokeStyle = `rgba(${wv.rgb},${a * 0.5})`;
      ctx.lineWidth = 1 + 9 * a * wv.power;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(wv.x, wv.y, wv.r * 0.82, 0, TAU);
      ctx.strokeStyle = `rgba(255,255,255,${a * 0.16})`;
      ctx.lineWidth = 1 + 3 * a;
      ctx.stroke();
    }
    ctx.restore();
  }

  cursorFrame() {
    const p = this.ptr;
    // The spring runs even while the pointer is outside, or the parallax
    // snaps the moment it comes back.
    p.sx = p.sx < -900 ? p.x : lerp(p.sx, p.x, 0.16);
    p.sy = p.sy < -900 ? p.y : lerp(p.sy, p.y, 0.16);
    if (!p.in || coarse) return;
    const ctx = this.ctx, R = 220;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, R);
    g.addColorStop(0, `rgba(${CYAN},.085)`);
    g.addColorStop(0.4, `rgba(${VIOLET},.045)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.sx, p.sy, R, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

/* ================================================================== *
 *  Wiring
 * ================================================================== */
const field = new StringField();
const stage = new Stage($('bg'), field);
const audio = new IntroAudio();
const bandBuf = new Float32Array(BANDS);

let entered = false;

/* ---- the score drives the strings ----
 * Every note rings the string nearest its pitch, so what you hear and what you
 * see are the same event rather than two things that merely happen at once. */
audio.onNote((midi, vel) => {
  const i = clamp(Math.round((midi - 64) / 4.4), 0, 5);
  field.pluck(i, clamp(vel * 3.4, 0.18, 0.8), 0.3 + (i / 5) * 0.4);
  stage.dial.hit = Math.min(1, stage.dial.hit + vel * 2.4);
});

/* ---- sound toggle ----
 * Muting is remembered: someone who turned the music off once should not have
 * to do it again on every visit. */
const SOUND_KEY = 'air-studio.sound';
try { audio.on = localStorage.getItem(SOUND_KEY) !== 'off'; } catch {}
const soundBtn = $('sound');
const paintSound = () => {
  soundBtn.classList.toggle('off', !audio.on);
  soundBtn.setAttribute('aria-pressed', String(audio.on));
  soundBtn.title = audio.on ? 'Mute' : 'Unmute';
};
paintSound();
soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const on = audio.toggle();
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch {}
  paintSound();
  if (on) audio.tap(2);
});

/* ---- the loop ---- */
let raf = 0;
function loop(ms) {
  raf = requestAnimationFrame(loop);
  // The sky assembles over the first few frames rather than all at once.
  if (stage.nebula.build()) return;
  const level = audio.bands(bandBuf);
  if (level > 0) for (let i = 0; i < BANDS; i++) stage.dial.raw[i] = bandBuf[i];
  stage.frame(ms, level);
}
raf = requestAnimationFrame(loop);

/* ---- pointer: strings, dust, magnets, parallax ---- */
const magnets = [];
const addMagnet = (el, pull = 0.3, reach = 150) => el && magnets.push({ el, pull, reach });

function onMove(x, y) {
  field.movePointer(x, y);
  stage.point(x, y);

  for (const m of magnets) {
    const r = m.el.getBoundingClientRect();
    if (!r.width) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = x - cx, dy = y - cy;
    const near = Math.hypot(dx, dy) < r.width / 2 + m.reach;
    m.el.style.setProperty('--mx', (near ? dx * m.pull : 0).toFixed(1) + 'px');
    m.el.style.setProperty('--my', (near ? dy * m.pull : 0).toFixed(1) + 'px');
  }

  // The hero block leans a couple of degrees toward the pointer. Any more and
  // it stops reading as depth and starts reading as a bug.
  const hi = document.querySelector('.hero-inner');
  if (hi && !coarse && !reduced) {
    hi.style.setProperty('--px', (((y / innerHeight) - 0.5) * -3).toFixed(2) + 'deg');
    hi.style.setProperty('--py', (((x / innerWidth) - 0.5) * 3.6).toFixed(2) + 'deg');
  }
}

addEventListener('pointermove', (e) => onMove(e.clientX, e.clientY), { passive: true });
addEventListener('pointerdown', (e) => onMove(e.clientX, e.clientY), { passive: true });
document.body.addEventListener('pointerleave', () => { field.leave(); stage.leave(); });

/* A click on empty space rings the page. It is an instrument site; touching it
 * and getting nothing back would be a missed joke. */
addEventListener('pointerdown', (e) => {
  if (!entered || e.target?.closest?.('a,button,input,.card,.slot')) return;
  stage.shock(e.clientX, e.clientY, { power: 0.42, rgb: VIOLET });
  audio.hover();
});

/* ================================================================== *
 *  Scenes
 * ================================================================== */
function show(id) {
  for (const s of document.querySelectorAll('.scene')) {
    const on = s.id === id;
    s.classList.toggle('on', on);
    s.setAttribute('aria-hidden', String(!on));
  }
  // The dial and the strings belong to the hero. Behind three cards of prose
  // they stop being atmosphere and start being noise, and the sky itself has to
  // step back so the cards read — smoothly, because a light that snaps off
  // reads as a glitch.
  const hero = id === 'hero';
  stage.dial.alphaTo = hero ? 1 : 0;
  field.alphaTo = hero ? 1 : 0.3;
  stage.moodTo = hero ? 1 : 0.5;
}

const sweep = () => {
  if (reduced) return;
  document.body.classList.remove('sweeping');
  void document.body.offsetWidth;
  document.body.classList.add('sweeping');
  setTimeout(() => document.body.classList.remove('sweeping'), 1000);
};

/* ---- threshold → the page ---- */
const threshold = $('threshold');
const enterBtn = $('enter');
addMagnet(enterBtn, 0.24, 170);

function enterStudio() {
  if (entered) return;
  entered = true;

  audio.ensure();                 // a real gesture — the graph may exist now
  audio.start();                  // level first, so the flourish lands at full
  audio.flourish();

  const r = enterBtn.getBoundingClientRect();
  stage.shock(r.left + r.width / 2, r.top + r.height / 2, { power: 1.25 });
  field.strumAll(0.95);

  document.body.classList.add('wash');
  setTimeout(() => document.body.classList.remove('wash'), 700);

  threshold.classList.add('gone');
  // Out of the layout entirely once it has faded, not merely invisible: an
  // overlay that is still measurable is still in the way.
  setTimeout(() => { threshold.style.display = 'none'; }, reduced ? 0 : 1100);

  document.body.classList.add('entered');
  show(location.hash === '#apps' ? 'shelf' : 'hero');
}
enterBtn.addEventListener('click', enterStudio);

/* ---- hero → the shelf ---- */
const goBtn = $('to-studio');
addMagnet(goBtn, 0.2, 90);
goBtn.addEventListener('click', () => {
  audio.tap(1);
  const r = goBtn.getBoundingClientRect();
  stage.shock(r.left + r.width / 2, r.top + r.height / 2, { power: 0.7, rgb: VIOLET });
  // The sweep is hung off the hash change, not off this click, so arriving by
  // link, by back button or by keyboard all look the same.
  location.hash = '#apps';
});

/* ---- hide-my-face ---- */
const faceBtn = $('faceToggle');
const faceSub = $('faceToggleSub');
const paintFace = () => {
  const on = faceHidden();
  faceBtn.setAttribute('aria-pressed', String(on));
  faceSub.textContent = on
    ? 'Your face is blurred wherever you play'
    : 'Your face is visible in the camera view';
};
paintFace();
faceBtn.addEventListener('click', () => {
  const on = setFaceHidden(!faceHidden());
  audio.tap(on ? 3 : 1);
  paintFace();
});
onFaceHiddenChange(paintFace);

/* ---- the cards ---- */
for (const [i, card] of [...document.querySelectorAll('.card')].entries()) {
  card.addEventListener('pointerenter', () => audio.hover());

  // Tilt and the light pool are the same gesture: the card turning toward you.
  card.addEventListener('pointermove', (e) => {
    if (coarse || reduced) return;
    const r = card.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
    card.style.setProperty('--mx', (u * 100).toFixed(1) + '%');
    card.style.setProperty('--my', (v * 100).toFixed(1) + '%');
    card.style.setProperty('--ry', ((u - 0.5) * 9).toFixed(2) + 'deg');
    card.style.setProperty('--rx', ((v - 0.5) * -7).toFixed(2) + 'deg');
  });
  card.addEventListener('pointerleave', () => {
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
  });

  card.addEventListener('click', (e) => {
    e.preventDefault();
    audio.tap(i);
    const r = card.getBoundingClientRect();
    stage.shock(r.left + r.width / 2, r.top + r.height / 2, { power: 0.9 });
    // Hand the instrument a silent room: its own audio is the point.
    audio.stop({ fade: 0.45 });
    field.strumAll(1);
    sweep();
    document.body.classList.add('leaving');
    // Let the wash cover the navigation; the app boots behind a solid colour
    // rather than a half-faded shelf.
    setTimeout(() => { location.href = card.getAttribute('href'); }, reduced ? 0 : 560);
  });
}

/* ---- routing ---- */
const sync = () => show(location.hash === '#apps' ? 'shelf' : 'hero');
addEventListener('hashchange', () => { sync(); if (entered) sweep(); });
sync();
if (!entered) stage.moodTo = 0.85;    // the threshold sits a shade darker

addEventListener('keydown', (e) => {
  if (!entered) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enterStudio(); }
    return;
  }
  const onShelf = location.hash === '#apps';
  if (e.key === 'Enter' && !onShelf && document.activeElement === document.body) goBtn.click();
  if (e.key === 'Escape' && onShelf) location.hash = '';
});

document.addEventListener('visibilitychange', () => {
  cancelAnimationFrame(raf);
  if (!document.hidden) raf = requestAnimationFrame(loop);
});

window.airStudio = { field, audio, stage, show, get entered() { return entered; } };
