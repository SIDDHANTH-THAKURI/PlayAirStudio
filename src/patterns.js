/**
 * patterns.js — sign-armed strum/fingerpick patterns, built-in and user-made.
 *
 * A pattern is one bar of evenly-spaced steps that loops while its sign is
 * held. Steps are *abstract* (down-brush, bass pluck, single string…) and get
 * resolved against whatever chord the fretting hand is holding at the moment
 * each step is scheduled — so changing chords mid-pattern just works, exactly
 * like a strumming guitarist following the fretting hand.
 *
 * The bar is divided by `steps.length`, so an 8-step pattern is eighth notes
 * and a 16-step pattern is sixteenths. Nothing else has to know.
 *
 * The player is deliberately Tone-free: it takes a `now()` clock and an
 * `onStep(step, when)` callback, which keeps it unit-testable in Node and
 * lets main.js own all audio wiring. Scheduling runs a lookahead loop driven
 * from the render frame (~60 Hz), staying `AHEAD` seconds in front of the
 * audio clock so rAF jitter never lands on the beat.
 *
 * Step kinds:
 *   d / u  — down / up brush (up brushes catch only the treble strings)
 *   b / ab — bass note of the current voicing / alternating bass (the 5th),
 *            which is how one gesture covers strings 6 *and* 5
 *   s      — single string, `s:` = voicing string index 0..5 (resolved to the
 *            nearest sounding string if that one is muted)
 *   x      — muted chunk
 */

/** Everything the pattern editor is allowed to put in a step, in menu order. */
export const STEP_KINDS = [
  { k: null, label: '·',      hint: 'rest' },
  { k: 'd',  label: 'D',      hint: 'down strum' },
  { k: 'u',  label: 'U',      hint: 'up strum' },
  { k: 'uh', label: 'u',      hint: 'up, treble only' },
  { k: 'x',  label: 'X',      hint: 'muted chunk' },
  { k: 'b',  label: 'B',      hint: 'bass string' },
  { k: 'ab', label: 'A',      hint: 'alternating bass' },
  { k: 's0', label: '6',      hint: 'string 6 (low E)' },
  { k: 's1', label: '5',      hint: 'string 5 (A)' },
  { k: 's2', label: '4',      hint: 'string 4 (D)' },
  { k: 's3', label: '3',      hint: 'string 3 (G)' },
  { k: 's4', label: '2',      hint: 'string 2 (B)' },
  { k: 's5', label: '1',      hint: 'string 1 (high e)' },
];

/** Three dynamics per step — enough to feel like a real strumming hand. */
export const DYNAMICS = [
  { v: 0.45, label: '–', hint: 'soft' },
  { v: 0.7,  label: '•', hint: 'normal' },
  { v: 0.95, label: '▲', hint: 'accent' },
];

/**
 * Per-pattern feel. This is a *rate* multiplier, not a tempo change: the song
 * stays at one BPM (so the metronome and every other pattern still line up)
 * while this one bar runs at half or double speed. That's the difference
 * between "the whole song is faster" and "this strum is busier", and players
 * almost always mean the second one.
 */
export const RATES = [
  { r: 0.5,  label: '½×', hint: 'half time' },
  { r: 1,    label: '1×', hint: 'normal' },
  { r: 1.5,  label: '1½×', hint: 'triplet feel' },
  { r: 2,    label: '2×', hint: 'double time' },
];
const RATE_VALUES = RATES.map((x) => x.r);

/* --- editor form (a flat token per step) ⇄ engine form (step objects) --- */

/** `'d'|'u'|'uh'|'x'|'b'|'ab'|'s0'..'s5'|null` + velocity → engine step. */
export function tokenToStep(token, v = 0.7) {
  if (!token) return null;
  if (token === 'uh') return { k: 'u', v, hi: true };
  if (token[0] === 's' && token.length === 2) return { k: 's', s: +token[1], v };
  return { k: token, v };
}
/** Engine step → editor token (inverse of tokenToStep). */
export function stepToToken(step) {
  if (!step) return null;
  if (step.k === 'u' && step.hi) return 'uh';
  if (step.k === 's') return 's' + (step.s ?? 0);
  return step.k;
}

/* ================================================================== *
 *  Built-in patterns — always present, never editable in place.
 * ================================================================== */

export const PATTERNS = {
  drive: {                       // the classic D · D U · U D U campfire bar
    id: 'drive', label: 'Drive', glyph: '✊', builtin: true,
    steps: [
      { k: 'd', v: 0.92 }, null,
      { k: 'd', v: 0.72 }, { k: 'u', v: 0.58 },
      null,                { k: 'u', v: 0.62 },
      { k: 'd', v: 0.85 }, { k: 'u', v: 0.66 },
    ],
  },
  arp: {                         // gentle p-i-m-i-a-i-m-i arpeggio
    id: 'arp', label: 'Arpeggio', glyph: '✌️', builtin: true,
    steps: [
      { k: 'b', v: 0.72 },        { k: 's', s: 3, v: 0.55 },
      { k: 's', s: 4, v: 0.58 },  { k: 's', s: 3, v: 0.5 },
      { k: 's', s: 5, v: 0.62 },  { k: 's', s: 3, v: 0.5 },
      { k: 's', s: 4, v: 0.56 },  { k: 's', s: 3, v: 0.5 },
    ],
  },
  travis: {                      // alternating bass under offbeat brushes
    id: 'travis', label: 'Travis', glyph: '🤘', builtin: true,
    steps: [
      { k: 'b', v: 0.8 },  { k: 'u', v: 0.42, hi: true },
      { k: 'ab', v: 0.7 }, { k: 'u', v: 0.46, hi: true },
      { k: 'b', v: 0.78 }, { k: 'u', v: 0.42, hi: true },
      { k: 'ab', v: 0.7 }, { k: 'u', v: 0.5, hi: true },
    ],
  },
  ballad: {                      // sparse and wide — room to sing over
    id: 'ballad', label: 'Ballad', glyph: '🤙', builtin: true,
    steps: [
      { k: 'b', v: 0.78 }, null,
      { k: 'd', v: 0.6 },  null,
      { k: 'd', v: 0.5 },  null,
      { k: 'u', v: 0.5 },  { k: 'u', v: 0.44, hi: true },
    ],
  },
  march: {                       // percussive chuck on every offbeat
    id: 'march', label: 'March', glyph: '👌', builtin: true,
    steps: [
      { k: 'd', v: 0.9 },  { k: 'x', v: 0.5 },
      { k: 'd', v: 0.7 },  { k: 'x', v: 0.5 },
      { k: 'd', v: 0.88 }, { k: 'x', v: 0.5 },
      { k: 'u', v: 0.62 }, { k: 'x', v: 0.45 },
    ],
  },
};

/* ================================================================== *
 *  Registry — built-ins plus whatever the player has authored.
 * ================================================================== */

const custom = new Map();

/** Look a pattern up by id, custom first. Returns null for unknown ids. */
export function getPattern(id) { return custom.get(id) || PATTERNS[id] || null; }

/** Every pattern the UI may offer, built-ins first, then customs by name. */
export function listPatterns() {
  return [...Object.values(PATTERNS),
    ...[...custom.values()].sort((a, b) => a.label.localeCompare(b.label))];
}
export function customPatterns() { return [...custom.values()]; }

/** Insert or replace one user pattern. Built-in ids are never overwritten. */
export function saveCustom(p) {
  if (!p?.id || PATTERNS[p.id]) return null;
  const clean = {
    id: p.id,
    label: String(p.label || 'Custom').slice(0, 24),
    glyph: p.glyph || '🎚️',
    builtin: false,
    rate: RATE_VALUES.includes(p.rate) ? p.rate : 1,
    steps: (Array.isArray(p.steps) ? p.steps : []).map((s) => (s ? { ...s } : null)),
  };
  if (clean.steps.length !== 8 && clean.steps.length !== 16) return null;
  custom.set(clean.id, clean);
  return clean;
}
export function removeCustom(id) { return custom.delete(id); }
/** Replace the whole custom set (used when rehydrating from storage). */
export function loadCustom(list) {
  custom.clear();
  for (const p of list || []) saveCustom(p);
}
/** A fresh id that can't collide with a built-in or an existing custom. */
export function newPatternId() {
  let n = 1, id;
  do { id = `my${n++}`; } while (getPattern(id));
  return id;
}
/** A blank 8-step bar to start editing from. */
export function blankPattern(label = 'My pattern') {
  return { id: newPatternId(), label, glyph: '🎚️', builtin: false, rate: 1,
    steps: new Array(8).fill(null) };
}
/** Steps per second a pattern will actually fire at a given tempo. */
export function stepsPerSecond(p, bpm) {
  if (!p?.steps?.length) return 0;
  return (bpm * p.steps.length * (p.rate || 1)) / 240;
}

/**
 * Scheduling headroom over the audio clock.
 *
 * This has to exceed the longest stall between two `tick()` calls, or a step's
 * moment passes while the main thread is busy and the note arrives late (or,
 * worse, gets skipped by the catch-up guard). 120 ms covers ordinary rAF
 * jitter, but hand tracking on a phone blocks the thread for far longer than
 * that in one go — so `setLookahead` lets the app raise it to match whatever
 * the tracker is actually costing. Paid for in responsiveness to a *stop*, so
 * it stays as small as the device allows.
 */
const AHEAD = 0.12;

export class PatternPlayer {
  /** @param hooks { now:()=>seconds, onStep:(step, when)=>void } */
  constructor(hooks) { this.h = hooks; this.id = null; this.p = null; this.ahead = AHEAD; }

  /** Widen the scheduling window to survive main-thread stalls of `stallSec`. */
  setLookahead(stallSec) {
    this.ahead = Math.min(0.5, Math.max(AHEAD, stallSec * 1.6 + 0.05));
  }

  get playing() { return this.id !== null; }

  /** `which` is a pattern id, or a pattern object (an unsaved editor draft). */
  start(which, bpm, when) {
    const p = typeof which === 'string' ? getPattern(which) : which;
    if (!p || !p.steps?.length) return;
    this.id = p.id ?? which; this.p = p; this.bpm = bpm;
    this.t0 = when ?? this.h.now();
    this.next = 0;                       // next step index to schedule
  }

  /** Stop scheduling; already-scheduled notes ring out naturally. */
  stop() { this.id = null; this.p = null; }

  /** Seconds per step: one 4/4 bar split by its steps, then scaled by feel. */
  stepDur(bpm = this.bpm) {
    return 240 / (bpm * (this.p?.steps.length || 8) * (this.p?.rate || 1));
  }

  setBpm(bpm) {
    if (!this.playing || bpm === this.bpm) return;
    // Re-anchor so the *next* step keeps its position under the new tempo.
    const done = this.next;
    this.t0 = this.stepTime(done) - done * this.stepDur(bpm);
    this.bpm = bpm;
  }

  stepTime(i) { return this.t0 + i * this.stepDur(); }

  /** Call every frame. Schedules all steps due inside the lookahead window. */
  tick() {
    if (!this.playing) return;
    const p = this.p, t = this.h.now();
    // Catch-up guard: if the tab stalled, jump past the gap instead of
    // machine-gunning every missed step.
    while (this.stepTime(this.next) < t - 0.05) this.next++;
    while (this.stepTime(this.next) < t + (this.ahead ?? AHEAD)) {
      const step = p.steps[this.next % p.steps.length];
      if (step) this.h.onStep({ ...step, bar: this.next % p.steps.length }, this.stepTime(this.next));
      this.next++;
    }
  }

  /** 0..1 position inside the bar, for the UI step dots. */
  progress() {
    if (!this.playing) return 0;
    const len = this.p.steps.length * this.stepDur();
    const u = ((this.h.now() - this.t0) % len) / len;
    return u < 0 ? u + 1 : u;
  }
  /** Which step index is sounding right now (−1 when stopped). */
  activeStep() {
    if (!this.playing) return -1;
    return Math.floor(this.progress() * this.p.steps.length);
  }
}

/**
 * Resolve an abstract step target to a concrete voicing string index.
 * `wanted` may be muted in this voicing (power chords mute the trebles);
 * walk to the nearest sounding string so a pluck always sounds.
 */
export function resolveString(voicing, wanted) {
  if (voicing.midi[wanted] !== null) return wanted;
  for (let d = 1; d < 6; d++) {
    if (voicing.midi[wanted - d] !== undefined && voicing.midi[wanted - d] !== null) return wanted - d;
    if (voicing.midi[wanted + d] !== undefined && voicing.midi[wanted + d] !== null) return wanted + d;
  }
  return wanted;
}

/** Lowest sounding string of the voicing (the chord's actual bass). */
export function bassString(voicing) {
  for (let i = 0; i < 6; i++) if (voicing.midi[i] !== null) return i;
  return 0;
}

/** The alternating-bass partner: next sounding string above the bass. */
export function altBassString(voicing) {
  const b = bassString(voicing);
  for (let i = b + 1; i < 6; i++) if (voicing.midi[i] !== null) return i;
  return b;
}
