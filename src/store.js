/**
 * store.js — everything the player has customised, in one JSON blob.
 *
 * Chord banks, sign bindings and hand-made strum patterns are work, not
 * settings: losing them on a refresh would be the difference between a toy
 * and an instrument. Persistence is deliberately total-and-dumb (one key, one
 * write, debounced) — there's no schema migration beyond "if it doesn't look
 * right, fall back to the factory value", which is the correct trade for a
 * single-file app with no server.
 */
import { GRID_CELLS, SIGN_CELLS, QUALITIES, defaultGridSpecs, defaultSignSpecs } from './chords.js';
import { STRUM_SIGNS } from './gestures.js';
import { loadCustom, customPatterns, getPattern } from './patterns.js';

const KEY = 'air-guitar.v2';
const QUAL_IDS = QUALITIES.map((q) => q.id);

export function defaultSignPatterns() {
  return Object.fromEntries(STRUM_SIGNS.map((s) => [s.id, s.def]));
}

/** The factory state, also the shape every loaded blob is validated against. */
export function defaults() {
  return {
    key: 7, style: 'pop', voicing: 'open', sound: 'acoustic', lefty: false,
    vol: 0.8, room: 0.2, metro: false, bpm: 96,
    chordMode: 'grid', playMode: 'strum',
    gridSpecs: defaultGridSpecs(7, 'pop'),
    signSpecs: defaultSignSpecs(7, 'pop'),
    signPatterns: defaultSignPatterns(),
  };
}

const isSpec = (s) => s && Number.isInteger(s.root) && s.root >= 0 && s.root < 12 && QUAL_IDS.includes(s.quality);
/** Coerce a stored bank to exactly `n` slots, dropping anything malformed. */
function bank(list, n, fallback) {
  if (!Array.isArray(list)) return fallback;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (isSpec(list[i])) out[i] = { root: list[i].root, quality: list[i].quality };
  return out;
}

/**
 * Read persisted state, merged over the factory defaults. Custom patterns are
 * pushed straight into the pattern registry as a side effect, because every
 * other module looks them up by id rather than holding the list.
 */
export function load() {
  const S = defaults();
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return S;

  const num = (v, lo, hi, d) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
  S.key = num(raw.key, 0, 11, S.key);
  if (typeof raw.style === 'string') S.style = raw.style;
  if (raw.voicing === 'open' || raw.voicing === 'power') S.voicing = raw.voicing;
  if (raw.sound === 'acoustic' || raw.sound === 'electric') S.sound = raw.sound;
  S.lefty = !!raw.lefty;
  S.vol = num(raw.vol, 0, 1, S.vol);
  S.room = num(raw.room, 0, 1, S.room);
  S.metro = !!raw.metro;
  S.bpm = num(raw.bpm, 40, 240, S.bpm);
  if (raw.chordMode === 'grid' || raw.chordMode === 'signs') S.chordMode = raw.chordMode;
  if (raw.playMode === 'finger' || raw.playMode === 'strum') S.playMode = raw.playMode;

  S.gridSpecs = bank(raw.gridSpecs, GRID_CELLS, S.gridSpecs);
  S.signSpecs = bank(raw.signSpecs, SIGN_CELLS, S.signSpecs);

  // Patterns must land in the registry *before* the sign bindings are checked,
  // or every binding pointing at a custom pattern would look dangling.
  loadCustom(Array.isArray(raw.patterns) ? raw.patterns : []);
  if (raw.signPatterns && typeof raw.signPatterns === 'object') {
    for (const s of STRUM_SIGNS) {
      const id = raw.signPatterns[s.id];
      if (typeof id === 'string' && getPattern(id)) S.signPatterns[s.id] = id;
    }
  }
  return S;
}

let pending = 0;
/** Debounced write — sliders fire this dozens of times a second. */
export function save(S) {
  clearTimeout(pending);
  pending = setTimeout(() => {
    const blob = {
      key: S.key, style: S.style, voicing: S.voicing, sound: S.sound, lefty: S.lefty,
      vol: S.vol, room: S.room, metro: S.metro, bpm: S.bpm,
      chordMode: S.chordMode, playMode: S.playMode,
      gridSpecs: S.gridSpecs, signSpecs: S.signSpecs, signPatterns: S.signPatterns,
      patterns: customPatterns(),
    };
    try { localStorage.setItem(KEY, JSON.stringify(blob)); } catch {}
  }, 250);
}

export function reset() {
  try { localStorage.removeItem(KEY); } catch {}
}
