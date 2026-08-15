/**
 * tutorial.js — the illustrated walkthrough for Air Piano.
 *
 * Same shell as the guitar's (see ../tutorial.js), same drawn hands (see
 * ../hand-art.js), a different deck. Nothing here is a screenshot: every scene
 * is painted from the same ideas the instrument runs on, so it cannot quietly
 * drift out of date the way a captured image does.
 *
 * The old version of this was five spotlights over the real controls. That is
 * the right shape for "where is the button", and the wrong one for "what is the
 * gesture" — and the gesture is the entire difficulty here. Two things about
 * this instrument are simply not guessable by poking at it: that a note fires
 * when a fingertip *stops*, so you strike rather than press, and that nothing
 * sounds at all until you have marked out where the keyboard is. Both are
 * motions, so both are shown as motions.
 */
import { pose, blend, landmarks, drawHand } from '../hand-art.js';

const INK = '#2C2118', AMBER = '#C0631A', SAGE = '#4E7B5C', WOOD = '#A8703F';

/** Timeline helper: hold each keyframe, then morph to the next, forever. */
function timeline(frames, hold = 1.2, morph = 0.45) {
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

/* ================================================================== *
 *  Scene painters — the miniature instrument each slide argues over
 * ================================================================== */

const rr = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);         ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/** The marked-out surface, drawn in perspective the way the overlay draws it. */
function surface(ctx, w, h, { lit = -1, glow = 0, corners = 4, dashed = false } = {}) {
  const midY = h * 0.66, topW = w * 0.44, botW = w * 0.80, depth = h * 0.24;
  const quad = [
    [w / 2 - topW / 2, midY - depth], [w / 2 + topW / 2, midY - depth],
    [w / 2 + botW / 2, midY + depth], [w / 2 - botW / 2, midY + depth],
  ];
  ctx.save();
  ctx.setLineDash(dashed ? [5, 5] : []);
  ctx.beginPath();
  ctx.moveTo(...quad[0]); for (const p of quad.slice(1)) ctx.lineTo(...p);
  ctx.closePath();
  ctx.fillStyle = 'rgba(224,172,107,.16)';
  ctx.fill();
  ctx.strokeStyle = dashed ? 'rgba(44,33,24,.45)' : WOOD;
  ctx.lineWidth = 1.8; ctx.stroke();
  ctx.setLineDash([]);

  // Keys: columns across the surface, each a scale degree.
  const N = 7;
  for (let i = 0; i < N; i++) {
    const u0 = i / N, u1 = (i + 1) / N;
    const edge = (u) => [
      [quad[0][0] + (quad[1][0] - quad[0][0]) * u, quad[0][1]],
      [quad[3][0] + (quad[2][0] - quad[3][0]) * u, quad[3][1]],
    ];
    const [a0, b0] = edge(u0), [a1, b1] = edge(u1);
    ctx.beginPath();
    ctx.moveTo(...a0); ctx.lineTo(...a1); ctx.lineTo(...b1); ctx.lineTo(...b0);
    ctx.closePath();
    if (i === lit) {
      ctx.fillStyle = `rgba(192,99,26,${0.10 + 0.24 * glow})`;
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(44,33,24,.16)'; ctx.lineWidth = 1; ctx.stroke();
  }

  if (corners) {
    for (let i = 0; i < corners; i++) {
      const [x, y] = quad[i];
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFCF6'; ctx.fill();
      ctx.strokeStyle = AMBER; ctx.lineWidth = 2.4; ctx.stroke();
      ctx.fillStyle = AMBER;
      ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 0.5);
    }
  }
  ctx.restore();
  return quad;
}

/** The speed trace that explains why a strike sounds and a press does not. */
function strikeGraph(ctx, w, h, phase, kind) {
  const x0 = w * 0.12, x1 = w * 0.88, y0 = h * 0.16, y1 = h * 0.44;
  ctx.save();
  ctx.strokeStyle = 'rgba(44,33,24,.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    // A strike accelerates then stops dead; a press eases off over a fifth of
    // a second. The discontinuity is the whole signal.
    const v = kind === 'strike'
      ? (u < 0.62 ? u / 0.62 : Math.max(0, 1 - (u - 0.62) / 0.06))
      : Math.sin(Math.min(1, u / 0.9) * Math.PI) * 0.55;
    const x = x0 + (x1 - x0) * u, y = y1 - v * (y1 - y0);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = kind === 'strike' ? AMBER : 'rgba(44,33,24,.4)';
  ctx.lineWidth = 2.4; ctx.stroke();

  if (kind === 'strike') {
    const bx = x0 + (x1 - x0) * 0.66;
    // `arc` throws on a negative radius, and this one is driven by a phase that
    // legitimately runs past the pulse — so clamp rather than assume.
    const r = Math.max(2, 4 + 5 * (1 - Math.abs(phase - 0.7) * 3));
    ctx.beginPath(); ctx.arc(bx, y1, r, 0, Math.PI * 2);
    ctx.fillStyle = AMBER; ctx.globalAlpha = phase > 0.55 ? 1 : 0.25; ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = 'rgba(44,33,24,.5)';
  ctx.font = '600 9.5px Inter, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(kind === 'strike' ? 'STRIKE — speed stops dead → note'
                                 : 'PRESS — speed fades away → silence', x0, y0 - 4);
  ctx.restore();
}

/** Two hands over the surface, showing where the bass half lives. */
function splitScene(ctx, w, h) {
  ctx.save();
  ctx.setLineDash([4, 5]);
  ctx.beginPath(); ctx.moveTo(w / 2, h * 0.34); ctx.lineTo(w / 2, h * 0.94);
  ctx.strokeStyle = 'rgba(44,33,24,.3)'; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = '600 10px Inter, sans-serif'; ctx.textAlign = 'center';
  ctx.fillStyle = SAGE;  ctx.fillText('LEFT — two octaves down', w * 0.26, h * 0.30);
  ctx.fillStyle = AMBER; ctx.fillText('RIGHT — as written', w * 0.74, h * 0.30);
  ctx.restore();
}

/* ================================================================== *
 *  The deck
 * ================================================================== */

export const PIANO_SLIDES = [
  {
    id: 'what',
    title: 'The keyboard is wherever you say it is',
    lede: 'There is no keyboard. You mark out a rectangle — in the air in front of you, or on your desk — and that rectangle becomes the keys.',
    bullets: [
      ['🎯', 'Air needs no surface and keeps the screen in view'],
      ['🪵', 'A desk gives you something to feel, but wants the lid tilted down'],
      ['🔒', 'The video is read in this tab and thrown away frame by frame'],
    ],
    script: timeline([
      { p: pose('five', { x: 0.36, y: 0.60, scale: 0.72, roll: 8 }) },
      { p: pose('five', { x: 0.60, y: 0.56, scale: 0.72, roll: -6 }) },
    ], 1.6),
    scene: (ctx, w, h) => surface(ctx, w, h, { corners: 0 }),
  },
  {
    id: 'calibrate',
    title: 'Mark the four corners first',
    lede: 'Nothing sounds until the instrument knows where the keys are. Click the four corners of your playing area in the camera view — far-left, far-right, near-right, near-left — then Use this area.',
    bullets: [
      ['🖱️', 'Click them, don\'t tap them — the cursor is exact, a tap is a guess'],
      ['📐', 'Click where your fingertips will be, not the desk\'s own corner'],
      ['💾', 'Remembered, so it is a once-per-setup job — redo it if the camera moves'],
    ],
    script: timeline([
      { p: pose('point', { x: 0.30, y: 0.44, scale: 0.66, roll: 14 }) },
      { p: pose('point', { x: 0.70, y: 0.44, scale: 0.66, roll: -8 }) },
      { p: pose('point', { x: 0.80, y: 0.74, scale: 0.66, roll: -14 }) },
      { p: pose('point', { x: 0.20, y: 0.74, scale: 0.66, roll: 16 }) },
    ], 0.85),
    scene: (ctx, w, h) => surface(ctx, w, h, { dashed: true }),
  },
  {
    id: 'strike',
    title: 'Strike it — don\'t press it',
    lede: 'A note fires the instant your fingertip is stopped, which is exactly when a real key would speak. That is why a crisp tap sounds and slowly lowering your hand does not — so you can rest between phrases without playing anything.',
    bullets: [
      ['⚡', 'The stop is the note. Not the height, not the touch — the stop'],
      ['🔊', 'How fast you were going is how loud it is'],
      ['🖐️', 'Lower your hand gently and nothing sounds at all'],
    ],
    script: timeline([
      { p: pose('one', { x: 0.5, y: 0.50, scale: 0.7, roll: 6 }), lit: 3 },
      { p: pose('one', { x: 0.5, y: 0.70, scale: 0.7, roll: 6 }), lit: 3, hit: true },
    ], 0.7, 0.18),
    scene: (ctx, w, h, s) => {
      strikeGraph(ctx, w, h, s?.phase ?? 0, 'strike');
      surface(ctx, w, h, { corners: 0, lit: s?.key?.lit ?? -1, glow: s?.key?.hit ? 1 : 0 });
    },
  },
  {
    id: 'press',
    title: 'Which is why resting is safe',
    lede: 'The same fingertip, lowered gently, produces no note. The detector is looking for speed that climbs and then stops abruptly — a hand simply being put down eases off over a fifth of a second, and never crosses the line.',
    bullets: [
      ['😌', 'Park your hands on the desk between phrases — it stays quiet'],
      ['🎚️', 'It is a shape in the motion, not a height threshold'],
      ['🚫', 'So no amount of hovering will set it off'],
    ],
    script: timeline([
      { p: pose('five', { x: 0.5, y: 0.52, scale: 0.7 }) },
      { p: pose('five', { x: 0.5, y: 0.72, scale: 0.7 }) },
    ], 1.5, 1.0),
    scene: (ctx, w, h, s) => {
      strikeGraph(ctx, w, h, s?.phase ?? 0, 'press');
      surface(ctx, w, h, { corners: 0 });
    },
  },
  {
    id: 'fingers',
    title: 'One finger, if ten is too many',
    lede: 'Tap one finger and its neighbours come down with it — the hand dips, and every finger shows the same stop. On All fingers the instrument works out which one actually reached for the key. On Index only there is nothing to work out.',
    bullets: [
      ['☝️', 'Start on Index only if notes keep arriving in pairs'],
      ['🖐️', 'All fingers is the real instrument, and gets it right most of the time'],
      ['👻', 'Fingers that are switched off are drawn as faint outlines, not lost'],
    ],
    script: timeline([
      { p: pose('one', { x: 0.42, y: 0.56, scale: 0.7, roll: 8 }), lit: 2 },
      { p: pose('five', { x: 0.58, y: 0.56, scale: 0.7, roll: -6 }), lit: 4 },
    ], 1.5),
    scene: (ctx, w, h, s) => surface(ctx, w, h, { corners: 0, lit: s?.key?.lit ?? -1, glow: 0.5 }),
  },
  {
    id: 'layout',
    title: 'Every column is the next note of the scale',
    lede: 'The surface is scale-locked, so neighbouring columns are neighbouring scale degrees rather than semitones. An aim that is one column out is a note that still belongs in the key — not a wrong note.',
    bullets: [
      ['🎼', 'Pick the key and scale in the panel; the columns follow'],
      ['📏', 'Up to fifteen columns — the range comes from width, not depth'],
      ['🎹', 'One row by default: a second depth is one you cannot feel'],
    ],
    script: timeline([
      { p: pose('one', { x: 0.30, y: 0.62, scale: 0.66, roll: 10 }), lit: 1 },
      { p: pose('one', { x: 0.50, y: 0.62, scale: 0.66, roll: 0 }), lit: 3 },
      { p: pose('one', { x: 0.70, y: 0.62, scale: 0.66, roll: -10 }), lit: 5 },
    ], 1.0),
    scene: (ctx, w, h, s) => surface(ctx, w, h, { corners: 0, lit: s?.key?.lit ?? -1, glow: 0.7 }),
  },
  {
    id: 'split',
    title: 'Both hands get the whole surface',
    lede: 'With the register split on, your left hand sounds two octaves down over the same rectangle — so you are not dividing one small keyboard in half, you are getting the division of labour a pianist already has.',
    bullets: [
      ['🤝', 'Which hand is which is locked on first sighting — crossing is safe'],
      ['🔈', 'Bass sits left in the stereo image, treble right, as it does under your hands'],
      ['⚙️', 'Turn it off in the panel if you would rather both hands matched'],
    ],
    script: timeline([
      { p: pose('five', { x: 0.30, y: 0.62, scale: 0.66, roll: 10 }) },
      { p: pose('one', { x: 0.30, y: 0.68, scale: 0.66, roll: 10 }) },
    ], 1.1),
    second: timeline([
      { p: pose('one', { x: 0.70, y: 0.68, scale: 0.66, roll: -10 }) },
      { p: pose('five', { x: 0.70, y: 0.62, scale: 0.66, roll: -10 }) },
    ], 1.1),
    scene: (ctx, w, h) => { surface(ctx, w, h, { corners: 0 }); splitScene(ctx, w, h); },
  },
  {
    id: 'latency',
    title: 'If it feels late, look at the pill',
    lede: 'A note cannot be detected before the frame that shows your finger stopping, so the rate your hands are being looked at is the floor on how tight this can feel. The header reports it live.',
    bullets: [
      ['⚡', 'Below about 20 looks a second, short hard taps start being missed'],
      ['🖥️', 'If the pill reads cpu, inference is five to ten times slower than it should be'],
      ['🪟', 'Close other GPU-heavy tabs; hardware acceleration matters more here than anywhere'],
    ],
    script: timeline([
      { p: pose('one', { x: 0.5, y: 0.52, scale: 0.66 }), lit: 3 },
      { p: pose('one', { x: 0.5, y: 0.70, scale: 0.66 }), lit: 3, hit: true },
    ], 0.45, 0.14),
    scene: (ctx, w, h, s) => {
      surface(ctx, w, h, { corners: 0, lit: s?.key?.lit ?? -1, glow: s?.key?.hit ? 1 : 0 });
      ctx.save();
      rr(ctx, w * 0.30, h * 0.10, w * 0.40, 24, 12);
      ctx.fillStyle = '#FFFCF6'; ctx.fill();
      ctx.strokeStyle = 'rgba(44,33,24,.16)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = SAGE; ctx.beginPath(); ctx.arc(w * 0.345, h * 0.10 + 12, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = INK; ctx.font = '600 10px Inter, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('60 fps · track 42/s · 9 ms gpu', w * 0.365, h * 0.10 + 12.5);
      ctx.restore();
    },
  },
  {
    id: 'ready',
    title: 'Mark your area and play',
    lede: 'That is the whole instrument. Key, scale, how many columns, note length, the register split and how hard it listens are all down the right-hand panel — and Show me around replays this whenever you want it.',
    bullets: [
      ['▶️', 'Next takes you straight to marking out your playing area'],
      ['🎛️', 'The panel scrolls on its own, so the camera stays in view'],
      ['🙈', 'Hide my face blurs you in the camera view, if you would rather'],
    ],
    script: timeline([
      { p: pose('five', { x: 0.36, y: 0.58, scale: 0.68, roll: 8 }) },
      { p: pose('one', { x: 0.36, y: 0.66, scale: 0.68, roll: 8 }), lit: 1 },
    ], 0.9),
    second: timeline([
      { p: pose('one', { x: 0.66, y: 0.66, scale: 0.68, roll: -8 }), lit: 5 },
      { p: pose('five', { x: 0.66, y: 0.58, scale: 0.68, roll: -8 }) },
    ], 0.9),
    scene: (ctx, w, h, s) => surface(ctx, w, h, { corners: 0, lit: s?.key?.lit ?? -1, glow: 0.8 }),
  },
];
