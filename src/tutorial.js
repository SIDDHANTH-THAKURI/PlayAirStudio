/**
 * tutorial.js — the illustrated walkthrough shown on a player's first visit.
 *
 * Every slide animates a drawn hand (see hand-art.js) doing the real gesture
 * against a miniature of the real UI: the chord wall, the six strings, the
 * mode dial. Nothing here is a screenshot, so it can't drift out of date
 * silently — it's built from the same vocabulary constants the engine uses.
 *
 * First visit shows it automatically; after that a localStorage flag keeps it
 * out of the way, and the "How to play" button reopens it on demand.
 */
import { POSES, pose, blend, landmarks, drawHand, drawWrist } from './hand-art.js';

const SEEN = 'air-guitar.tutorial.v1';
const $ = (id) => document.getElementById(id);
const reduced = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();

const AMBER = '#C0631A', SAGE = '#4E7B5C';
/* String colours, bass→treble — identical to render.js so the tutorial and the
 * instrument agree about which colour means which string. */
const SCOL = ['#8B5E34', '#A85D96', '#4E7FA8', '#5E8C6A', '#D2604F', '#C0631A'];

/* ================================================================== *
 *  Slides. `scene` paints the mini-UI; `script` is the pose timeline.
 * ================================================================== */

/** Timeline helper: hold each keyframe, then morph to the next, forever. */
function timeline(frames, hold = 1.1, morph = 0.45) {
  const span = hold + morph;
  const total = frames.length * span;
  return (t) => {
    const u = (t % total) / span;
    const i = Math.floor(u), f = u - i;
    const a = frames[i % frames.length], b = frames[(i + 1) % frames.length];
    const state = blend(a.p, b.p, f < hold / span ? 0 : (f - hold / span) / (morph / span));
    return { state, key: a, next: b, phase: f < hold / span ? (f * span) / hold : 1 };
  };
}

const SLIDES = [
  {
    id: 'welcome',
    title: 'Two hands, one guitar',
    lede: 'Your webcam watches both hands. One picks the chord, the other plays it. Nothing is recorded and nothing leaves this tab.',
    bullets: [
      ['✋', 'Sit an arm\'s length back so both hands fit in frame'],
      ['💡', 'Front-on light helps; a bright window behind you hurts'],
      ['🔇', 'It never listens to your mic — camera only'],
    ],
    script: timeline([{ p: pose('point', { x: 0.29, y: 0.55, scale: 0.78, roll: 12 }) }]),
    second: timeline([
      { p: pose('open', { x: 0.72, y: 0.52, scale: 0.78, roll: -10 }) },
      { p: pose('peace', { x: 0.72, y: 0.52, scale: 0.78, roll: -10 }) },
      { p: pose('fist', { x: 0.72, y: 0.55, scale: 0.78, roll: -10 }) },
    ]),
    scene: (ctx, w, h) => {
      splitScene(ctx, w, h, 'CHORDS', 'STRINGS & PATTERNS');
    },
  },
  {
    id: 'grid',
    title: 'Point at a chord',
    lede: 'Your fretting hand aims at a wall of twelve chords. Point at one and hold for a moment — the ring fills, and the chord is yours.',
    bullets: [
      ['👉', 'Only the index finger out — that\'s the aiming shape'],
      ['⏱️', 'A short hold confirms, so a wandering hand never changes chord'],
      ['🎛️', 'Every cell is editable: put your own song\'s chords in it'],
    ],
    script: timeline([
      { p: pose('point', { x: 0.30, y: 0.62, scale: 0.62, roll: 14 }), cell: 4 },
      { p: pose('point', { x: 0.52, y: 0.40, scale: 0.62, roll: 6 }), cell: 1 },
      { p: pose('point', { x: 0.70, y: 0.66, scale: 0.62, roll: -6 }), cell: 10 },
    ], 1.5),
    scene: (ctx, w, h, s) => grid(ctx, w, h, s?.key?.cell ?? 0, s?.phase ?? 0),
  },
  {
    id: 'strum',
    title: 'Hold a sign, get a groove',
    lede: 'Your playing hand holds one of five signs. Each runs a strum pattern in time, and keeps running while you hold it — so your other hand is free to change chords.',
    bullets: [
      ['✊', 'Fist — Drive, the classic campfire strum'],
      ['✌️', 'Peace — Arpeggio · 🤘 Horns — Travis picking'],
      ['🤙', 'Call — Ballad · 👌 OK — March'],
      ['✋', 'Open your palm to stop'],
    ],
    script: timeline([
      { p: pose('fist', { x: 0.5, y: 0.52, scale: 0.72 }), sign: 0 },
      { p: pose('peace', { x: 0.5, y: 0.52, scale: 0.72 }), sign: 1 },
      { p: pose('horns', { x: 0.5, y: 0.52, scale: 0.72 }), sign: 2 },
      { p: pose('call', { x: 0.5, y: 0.52, scale: 0.72 }), sign: 3 },
      { p: pose('ok', { x: 0.5, y: 0.52, scale: 0.72 }), sign: 4 },
      { p: pose('open', { x: 0.5, y: 0.52, scale: 0.72 }), sign: -1 },
    ], 1.3),
    scene: (ctx, w, h, s) => signRail(ctx, w, h, s?.key?.sign ?? -1, s?.phase ?? 0),
  },
  {
    id: 'finger',
    title: 'Or pick single strings',
    lede: 'Switch that hand to Fingerstyle and it counts instead: how many fingers you open chooses which string sounds. Open the shape, hold briefly, and it plucks.',
    bullets: [
      ['1️⃣', 'One finger → string 1, the high e'],
      ['5️⃣', 'All five → string 5, the A'],
      ['🤙', 'Little finger alone → string 6, the low E'],
      ['🎵', 'Whatever chord you\'re holding decides the note'],
    ],
    script: timeline([
      { p: pose('one', { x: 0.5, y: 0.52, scale: 0.7 }), str: 5 },
      { p: pose('two', { x: 0.5, y: 0.52, scale: 0.7 }), str: 4 },
      { p: pose('three', { x: 0.5, y: 0.52, scale: 0.7 }), str: 3 },
      { p: pose('four', { x: 0.5, y: 0.52, scale: 0.7 }), str: 2 },
      { p: pose('five', { x: 0.5, y: 0.52, scale: 0.7 }), str: 1 },
      { p: pose('pinky', { x: 0.5, y: 0.52, scale: 0.7 }), str: 0 },
    ], 1.15),
    scene: (ctx, w, h, s) => strings(ctx, w, h, s?.key?.str ?? -1, s?.phase ?? 0),
  },
  {
    id: 'dial',
    title: 'Switch modes without touching anything',
    lede: 'Hold a thumbs-up for a second with either hand to open its mode dial. Tilt your hand to choose, then open your palm to accept.',
    bullets: [
      ['👍', 'Fretting hand → chord grid ⇄ sign chords'],
      ['👍', 'Playing hand → strum patterns ⇄ fingerstyle'],
      ['↔️', 'Tilt left or right to pick; open palm to confirm'],
      ['🖱️', 'The side panel has the same switches if you\'d rather tap'],
    ],
    script: timeline([
      { p: pose('thumb', { x: 0.5, y: 0.55, scale: 0.7, roll: -22 }), dial: 0 },
      { p: pose('thumb', { x: 0.5, y: 0.55, scale: 0.7, roll: 22 }), dial: 1 },
      { p: pose('open', { x: 0.5, y: 0.55, scale: 0.7, roll: 0 }), dial: 2 },
    ], 1.25),
    scene: (ctx, w, h, s) => dial(ctx, w, h, s?.key?.dial ?? 0),
  },
  {
    id: 'more',
    title: 'The rest of it',
    lede: 'Everything above is the core. These are the things worth finding once it feels natural.',
    bullets: [
      ['〰️', 'Shake your fretting hand for vibrato; pinch to bend up a step'],
      ['✊', 'Fretting fist deadens the strings for percussive chunks'],
      ['🎚️', 'Edit any chord cell, and build your own strum patterns'],
      ['⌨️', 'Keys and taps do everything the hands do, any time'],
    ],
    script: timeline([
      { p: pose('open', { x: 0.5, y: 0.5, scale: 0.72, roll: -14 }) },
      { p: pose('open', { x: 0.5, y: 0.5, scale: 0.72, roll: 14 }) },
      { p: pose('fist', { x: 0.5, y: 0.52, scale: 0.72, roll: 0 }) },
    ], 0.9, 0.55),
    scene: (ctx, w, h) => splitScene(ctx, w, h, 'EXPRESSION', 'YOUR SETUP'),
  },
];

/* ================================================================== *
 *  Mini-scenes
 * ================================================================== */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function splitScene(ctx, w, h, left, right) {
  ctx.save();
  ctx.setLineDash([3, 9]); ctx.strokeStyle = 'rgba(120,90,60,.35)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(w / 2, h * 0.06); ctx.lineTo(w / 2, h * 0.94); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '600 10.5px Inter, sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(110,80,55,.75)';
  ctx.fillText(left, w * 0.25, h * 0.1);
  ctx.fillText(right, w * 0.75, h * 0.1);
  ctx.restore();
}

const GRID_NAMES = ['G', 'D', 'Em', 'C', 'Am', 'Bm', 'F', 'A', 'E', 'Dm', 'A7', 'D7'];
function grid(ctx, w, h, active, phase) {
  const cols = 4, rows = 3;
  const x0 = w * 0.07, y0 = h * 0.14, gw = w * 0.86, gh = h * 0.72;
  const cw = gw / cols, chh = gh / rows;
  ctx.save();
  for (let i = 0; i < cols * rows; i++) {
    const cx = x0 + (i % cols) * cw, cy = y0 + Math.floor(i / cols) * chh;
    const on = i === active;
    roundRect(ctx, cx + 4, cy + 4, cw - 8, chh - 8, 9);
    ctx.fillStyle = on ? 'rgba(255,238,208,.95)' : 'rgba(168,112,63,.13)';
    ctx.fill();
    ctx.lineWidth = on ? 2.2 : 1;
    ctx.strokeStyle = on ? AMBER : 'rgba(150,115,80,.3)';
    ctx.stroke();
    ctx.font = `600 ${on ? 15 : 12.5}px Fraunces, Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? '#7A3D10' : 'rgba(110,85,60,.75)';
    ctx.fillText(GRID_NAMES[i], cx + cw / 2, cy + chh / 2);
    // dwell ring on the cell being aimed at — same idea as the real overlay
    if (on && phase < 1) {
      const rx = cx + cw - 15, ry = cy + chh - 14;
      ctx.beginPath(); ctx.arc(rx, ry, 6, -Math.PI / 2, -Math.PI / 2 + Math.min(1, phase * 1.6) * Math.PI * 2);
      ctx.strokeStyle = AMBER; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.stroke();
    }
  }
  ctx.restore();
}

const SIGN_RAIL = [
  ['✊', 'Drive'], ['✌️', 'Arpeggio'], ['🤘', 'Travis'], ['🤙', 'Ballad'], ['👌', 'March'],
];
function signRail(ctx, w, h, active, phase) {
  const n = SIGN_RAIL.length, bw = w * 0.17, gap = w * 0.015;
  const total = n * bw + (n - 1) * gap, x0 = (w - total) / 2, y = h * 0.80;
  ctx.save();
  ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (bw + gap), on = i === active;
    roundRect(ctx, x, y, bw, h * 0.16, 9);
    ctx.fillStyle = on ? 'rgba(255,238,208,.95)' : 'rgba(168,112,63,.12)';
    ctx.fill();
    ctx.lineWidth = on ? 2 : 1;
    ctx.strokeStyle = on ? AMBER : 'rgba(150,115,80,.28)'; ctx.stroke();
    ctx.font = '13px Inter, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillText(SIGN_RAIL[i][0], x + bw / 2, y + h * 0.055);
    ctx.font = `${on ? 600 : 400} 9.5px Inter, sans-serif`;
    ctx.fillStyle = on ? '#7A3D10' : 'rgba(110,85,60,.7)';
    ctx.fillText(SIGN_RAIL[i][1], x + bw / 2, y + h * 0.115);
  }
  // beat pulse so "it keeps playing while held" reads as motion, not a label
  if (active >= 0) {
    const bx = x0 + active * (bw + gap) + bw / 2;
    for (let b = 0; b < 4; b++) {
      const lit = Math.floor(phase * 8) % 4 === b;
      ctx.beginPath(); ctx.arc(bx + (b - 1.5) * 9, y - 13, lit ? 3.4 : 2, 0, 7);
      ctx.fillStyle = lit ? AMBER : 'rgba(150,115,80,.32)'; ctx.fill();
    }
  }
  ctx.restore();
}

const STR_NAMES = ['6 · low E', '5 · A', '4 · D', '3 · G', '2 · B', '1 · high e'];
function strings(ctx, w, h, active, phase) {
  ctx.save();
  const x0 = w * 0.2, x1 = w * 0.94;
  for (let i = 5; i >= 0; i--) {
    const y = h * (0.2 + (5 - i) * 0.115);
    const on = i === active;
    ctx.beginPath();
    if (on) {
      const amp = Math.max(0, 1 - phase) * 7;
      for (let k = 0; k <= 24; k++) {
        const u = k / 24, x = x0 + (x1 - x0) * u;
        const yy = y + Math.sin(u * Math.PI) * Math.sin(phase * 46) * amp;
        k ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
      }
    } else { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.lineWidth = on ? 3.4 : 1.6 + (5 - i) * 0.22;
    ctx.strokeStyle = on ? SCOL[i] : 'rgba(150,115,80,.34)';
    ctx.shadowColor = SCOL[i]; ctx.shadowBlur = on ? 12 : 0;
    ctx.stroke(); ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(x0 - 9, y, on ? 5.5 : 3.4, 0, 7);
    ctx.fillStyle = on ? SCOL[i] : 'rgba(150,115,80,.4)'; ctx.fill();
    ctx.font = `${on ? 600 : 400} 9.5px Inter, sans-serif`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillStyle = on ? SCOL[i] : 'rgba(120,92,64,.6)';
    ctx.fillText(STR_NAMES[i], x0 - 17, y);
  }
  ctx.restore();
}

function dial(ctx, w, h, stage) {
  const cx = w / 2, cy = h * 0.2, r = w * 0.2;
  const labels = ['Chord grid', 'Sign chords'];
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < 2; i++) {
    const x = cx + (i ? r : -r), sel = stage === 2 ? i === 1 : stage === i;
    roundRect(ctx, x - w * 0.14, cy - 15, w * 0.28, 30, 15);
    ctx.fillStyle = sel ? 'rgba(255,238,208,.96)' : 'rgba(168,112,63,.12)'; ctx.fill();
    ctx.lineWidth = sel ? 2 : 1;
    ctx.strokeStyle = sel ? AMBER : 'rgba(150,115,80,.3)'; ctx.stroke();
    ctx.font = `${sel ? 600 : 400} 11px Inter, sans-serif`;
    ctx.fillStyle = sel ? '#7A3D10' : 'rgba(110,85,60,.72)';
    ctx.fillText(labels[i], x, cy);
  }
  if (stage === 2) {
    ctx.font = '600 11px Inter, sans-serif'; ctx.fillStyle = SAGE;
    ctx.fillText('✓ accepted', cx, cy + 32);
  }
  ctx.restore();
}

/* ================================================================== *
 *  The overlay
 * ================================================================== */

export class Tutorial {
  constructor({ onDone } = {}) {
    this.onDone = onDone || (() => {});
    this.i = 0; this.t0 = 0; this.raf = 0;
    this.build();
  }

  static seen() {
    try { return localStorage.getItem(SEEN) === '1'; } catch { return false; }
  }
  static markSeen() {
    try { localStorage.setItem(SEEN, '1'); } catch {}
  }

  build() {
    const root = document.createElement('div');
    root.className = 'tut';
    root.hidden = true;
    root.innerHTML = `
      <div class="tut-card" role="dialog" aria-modal="true" aria-label="How to play Air Guitar">
        <button class="tut-skip" data-act="skip">Skip</button>
        <div class="tut-body">
          <div class="tut-stage">
            <canvas class="tut-canvas"></canvas>
            <span class="tut-badge"></span>
          </div>
          <div class="tut-text">
            <div class="tut-step"></div>
            <h2></h2>
            <p class="tut-lede"></p>
            <ul class="tut-list"></ul>
          </div>
        </div>
        <div class="tut-foot">
          <div class="tut-dots"></div>
          <div class="tut-nav">
            <button class="btn sec" data-act="back">Back</button>
            <button class="btn" data-act="next">Next</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.cv = root.querySelector('.tut-canvas');
    this.ctx = this.cv.getContext('2d');
    this.badge = root.querySelector('.tut-badge');

    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'skip') this.close();
      else if (act === 'next') this.go(this.i + 1);
      else if (act === 'back') this.go(this.i - 1);
      else if (e.target === root) this.close();
      const dot = e.target.closest('[data-dot]');
      if (dot) this.go(+dot.dataset.dot);
    });
    this._keys = (e) => {
      if (this.root.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.go(this.i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.i - 1); }
    };
    addEventListener('keydown', this._keys);
    addEventListener('resize', () => this.resize());

    root.querySelector('.tut-dots').innerHTML =
      SLIDES.map((_, i) => `<button class="tut-dot" data-dot="${i}" aria-label="Step ${i + 1}"></button>`).join('');
  }

  open(from = 0) {
    this.root.hidden = false;
    document.body.classList.add('tut-open');
    this.go(from, true);
    this.resize();
    if (!this.raf) this.loop();
  }

  close() {
    Tutorial.markSeen();
    this.root.hidden = true;
    document.body.classList.remove('tut-open');
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.onDone();
  }

  go(i, force = false) {
    if (i >= SLIDES.length) return this.close();
    const n = Math.max(0, Math.min(SLIDES.length - 1, i));
    if (n === this.i && !force) return;
    this.i = n; this.t0 = performance.now() / 1000;
    const s = SLIDES[n];
    const r = this.root;
    r.querySelector('.tut-step').textContent = `Step ${n + 1} of ${SLIDES.length}`;
    r.querySelector('h2').textContent = s.title;
    r.querySelector('.tut-lede').textContent = s.lede;
    r.querySelector('.tut-list').innerHTML = s.bullets
      .map(([g, t]) => `<li><span class="tut-g">${g}</span><span>${t}</span></li>`).join('');
    [...r.querySelectorAll('.tut-dot')].forEach((d, k) => d.classList.toggle('on', k === n));
    r.querySelector('[data-act="back"]').disabled = n === 0;
    r.querySelector('[data-act="next"]').textContent = n === SLIDES.length - 1 ? 'Start playing' : 'Next';
    const text = r.querySelector('.tut-text');
    text.classList.remove('in'); void text.offsetWidth; text.classList.add('in');
  }

  resize() {
    if (this.root.hidden) return;
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (!r.width) return;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
  }

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    if (this.root.hidden || !this.w) return;
    const { ctx, w, h } = this;
    // Reduced motion: freeze each slide on its first keyframe rather than
    // cycling. The pose still teaches the shape; the movement is the garnish.
    const t = reduced ? 0.4 : performance.now() / 1000 - this.t0;
    const s = SLIDES[this.i];

    ctx.clearRect(0, 0, w, h);
    const frame = s.script(t);
    s.scene?.(ctx, w, h, frame);
    if (s.second) {
      const f2 = s.second(t);
      const lm2 = landmarks(f2.state, w, h);
      drawWrist(ctx, lm2, SAGE, 0.8); drawHand(ctx, lm2, { color: SAGE, scale: 0.8 });
    }
    const lm = landmarks(frame.state, w, h);
    drawWrist(ctx, lm, AMBER, 0.9);
    drawHand(ctx, lm, { color: AMBER, scale: 0.9, tips: s.id === 'finger' ? tipColours(frame) : null });

    this.badge.textContent = badgeFor(s, frame);
    this.badge.classList.toggle('show', !!this.badge.textContent);
  }

  destroy() { removeEventListener('keydown', this._keys); this.root.remove(); }
}

/** Light the fingertips that are actually out, in the target string's colour. */
function tipColours(frame) {
  const str = frame.key?.str ?? -1;
  if (str < 0) return null;
  return frame.state.curls.map((c) => (c < 0.4 ? SCOL[str] : null));
}

function badgeFor(s, frame) {
  if (s.id === 'grid') return `chord · ${GRID_NAMES[frame.key?.cell ?? 0]}`;
  if (s.id === 'strum') {
    const i = frame.key?.sign ?? -1;
    return i < 0 ? 'stopped' : `${SIGN_RAIL[i][0]} ${SIGN_RAIL[i][1]}`;
  }
  if (s.id === 'finger') {
    const i = frame.key?.str ?? -1;
    return i < 0 ? '' : `string ${STR_NAMES[i]}`;
  }
  if (s.id === 'dial') return ['tilt left', 'tilt right', 'open palm to accept'][frame.key?.dial ?? 0];
  return '';
}
