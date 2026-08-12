/**
 * intro.js — the front door: a pluckable string field, then the app shelf.
 *
 * Sound lives in `audio-intro.js` and is deliberately *not* tied to the string
 * field. Sonifying the strings was the first attempt and it was wrong twice
 * over: it rang metallic, and hanging audio off a mousemove means the page
 * makes noise before you have asked it for anything. Instead nothing sounds
 * until you actually press something, and the music starts when you enter.
 *
 * The instrument page loads none of this — UI sound inside Air Guitar would
 * fight the thing you are playing.
 */
import { IntroAudio } from './audio-intro.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Six strings, bass at the bottom. `wob` is a *visual* wobble rate — a real
 * 82 Hz oscillation would just render as a blur. */
const STRINGS = [
  { col: '#8B5E34', wob: 5.5 },
  { col: '#A85D96', wob: 7.1 },
  { col: '#4E7FA8', wob: 8.7 },
  { col: '#5E8C6A', wob: 10.3 },
  { col: '#D2604F', wob: 11.9 },
  { col: '#C0631A', wob: 13.5 },
];

/* ================================================================== *
 *  StringField — six pluckable strings behind everything
 * ================================================================== */
class StringField {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.s = STRINGS.map((d) => ({ ...d, amp: 0, at: -9 }));
    this.pointer = { x: -1, y: -1, px: -1, py: -1, on: false };
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = Math.round(this.w * dpr); this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = this.w + 'px'; this.cv.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Strings sit in the middle 60% of the viewport, bass lowest. */
  yOf(i) { return this.h * (0.2 + (5 - i) * 0.12); }

  pluck(i, vel = 0.8) {
    const s = this.s[i];
    if (!s) return;
    s.amp = clamp(vel, 0.15, 1); s.at = performance.now() / 1000;
  }
  strumAll(vel = 0.85) {
    this.s.forEach((_, i) => setTimeout(() => this.pluck(i, vel), i * 55));
  }

  /**
   * A drag plucks any string the pointer *crossed* since the last frame, not
   * merely one it's near: sweeping fast across all six has to fire all six, and
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
        this.pluck(i, clamp(0.25 + speed / 40, 0.25, 0.95));
      }
    }
  }
  leave() { this.pointer.on = false; }

  frame(now) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < 6; i++) {
      const s = this.s[i], y0 = this.yOf(i);
      const age = now - s.at;
      const a = s.amp > 0.002 ? s.amp * Math.exp(-age * 2.6) : 0;
      if (a < 0.002) s.amp = 0;
      // Idle breathing so the field never looks like a dead screenshot.
      const idle = reduced ? 0 : Math.sin(now * 0.7 + i * 1.1) * 1.6;

      ctx.beginPath();
      const N = 60;
      for (let k = 0; k <= N; k++) {
        const u = k / N, x = w * (0.02 + 0.96 * u);
        const env = Math.sin(u * Math.PI);
        const y = y0 + env * (idle + Math.sin(age * s.wob * Math.PI * 2) * a * h * 0.055);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineWidth = (3.6 - i * 0.42) * (1 + a * 0.5);
      ctx.strokeStyle = `rgba(140,96,56,${0.16 + a * 0.32})`;
      ctx.shadowColor = s.col; ctx.shadowBlur = a * 26;
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (a > 0.01) {                       // a bead of light at the peak
        ctx.beginPath();
        ctx.arc(w / 2, y0, 2 + a * 7, 0, Math.PI * 2);
        ctx.fillStyle = s.col;
        ctx.globalAlpha = a * 0.6; ctx.fill(); ctx.globalAlpha = 1;
      }
    }
  }
}

/* ================================================================== *
 *  Scenes
 * ================================================================== */
const field = new StringField($('bg'));
const audio = new IntroAudio();

/* Muting is remembered: someone who turned the music off once should not have
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

let raf = 0;
function loop() {
  raf = requestAnimationFrame(loop);
  field.frame(performance.now() / 1000);
}
loop();

/* Pointer plucking works across both scenes — the strings are always live. */
const stage = document.body;
stage.addEventListener('pointermove', (e) => field.movePointer(e.clientX, e.clientY));
stage.addEventListener('pointerleave', () => field.leave());
stage.addEventListener('pointerdown', (e) => field.movePointer(e.clientX, e.clientY));

/** Cross-fade between the hero and the shelf. */
function show(id) {
  for (const s of document.querySelectorAll('.scene')) {
    const on = s.id === id;
    s.classList.toggle('on', on);
    s.setAttribute('aria-hidden', String(!on));
  }
}

/* ---- hero → shelf ---- */
$('enter').addEventListener('click', () => {
  audio.ensure();              // a real gesture — the graph may exist now
  audio.flourish();
  audio.start();
  field.strumAll(0.9);
  document.body.classList.add('wash');
  setTimeout(() => document.body.classList.remove('wash'), 900);
  setTimeout(() => { show('shelf'); location.hash = '#apps'; }, reduced ? 0 : 320);
});

/* ---- shelf ---- */
for (const [i, card] of [...document.querySelectorAll('.card')].entries()) {
  card.addEventListener('pointerenter', () => { if (!card.dataset.soon) audio.hover(); });
  card.addEventListener('click', (e) => {
    if (card.dataset.soon) {
      // Nothing to open, so say so in the one place the eye already is.
      card.classList.remove('nudge'); void card.offsetWidth; card.classList.add('nudge');
      audio.deny();
      e.preventDefault();
      return;
    }
    e.preventDefault();
    audio.tap(i);
    // Hand the instrument a silent room: its own audio is the point.
    audio.stop({ fade: 0.45 });
    field.strumAll(1);
    document.body.classList.add('leaving');
    // Let the wash cover the navigation; the app boots behind a solid colour
    // rather than a half-faded shelf.
    setTimeout(() => { location.href = card.getAttribute('href'); }, reduced ? 0 : 520);
  });
}

/* Deep link + back button: #apps lands straight on the shelf. */
const sync = () => show(location.hash === '#apps' ? 'shelf' : 'hero');
addEventListener('hashchange', sync);
sync();

/* Keyboard: Enter opens the shelf, Escape goes back. */
addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && location.hash !== '#apps' && document.activeElement === document.body) $('enter').click();
  if (e.key === 'Escape' && location.hash === '#apps') { location.hash = ''; }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) cancelAnimationFrame(raf);
  else { cancelAnimationFrame(raf); loop(); }
});

window.airStudio = { field, audio, show };
