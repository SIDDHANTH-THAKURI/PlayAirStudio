/**
 * scales.js — turning a spot on the desk into a note.
 *
 * The surface has no ridges, no edges and no feel. You cannot find middle C by
 * touch the way you can on a real keyboard, and hand tracking has a couple of
 * millimetres of slop on top of that. Laying out twelve chromatic semitones per
 * octave and asking people to hit them would be a guarantee of wrong notes.
 *
 * So the surface is scale-locked: each column is the *next degree of a scale*
 * rather than the next semitone. Every square you can hit is a note that
 * belongs, and an aim that is one column off is a neighbouring scale tone —
 * still consonant, still musical. That trades away chromatic freedom for the
 * ability to actually play, which is the right trade for an instrument with no
 * tactile reference. Chromatic is still available for anyone who wants it.
 *
 * Layout: `cols` columns of pitch running left→right like a keyboard, and
 * `rows` rows running away from the player, each row an octave above the one
 * nearer you. Two rows of eight is a comfortable default — a two-octave reach
 * on a patch of desk about the size of a real keyboard's playing area.
 *
 * Pure: no DOM, no audio.
 */

export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Semitone offsets from the root. Order matters — it is the column order. */
export const SCALES = {
  major:     { label: 'Major',            steps: [0, 2, 4, 5, 7, 9, 11] },
  minor:     { label: 'Natural minor',    steps: [0, 2, 3, 5, 7, 8, 10] },
  pentMajor: { label: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  pentMinor: { label: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  blues:     { label: 'Blues',            steps: [0, 3, 5, 6, 7, 10] },
  dorian:    { label: 'Dorian',           steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian:{ label: 'Mixolydian',       steps: [0, 2, 4, 5, 7, 9, 10] },
  lydian:    { label: 'Lydian',           steps: [0, 2, 4, 6, 7, 9, 11] },
  chromatic: { label: 'Chromatic',        steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const floorDiv = (a, b) => Math.floor(a / b);

/**
 * Scale degree → semitones above the root, wrapping into octaves so a degree
 * past the end of the scale simply continues upward instead of running out.
 * Negative degrees walk downward for the same reason.
 */
export function degreeToSemitone(scaleId, degree) {
  const steps = (SCALES[scaleId] || SCALES.major).steps;
  const n = steps.length;
  const oct = floorDiv(degree, n);
  return steps[degree - oct * n] + 12 * oct;
}

/** MIDI note number → name with octave, e.g. 60 → "C4". */
export function midiName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * The playing surface as a grid of notes.
 *
 * `octave` is the MIDI octave of the bottom-left key (4 ⇒ that key is around
 * middle C). `handOffset` shifts a whole hand by octaves, which is how the two
 * hands stay independent without carving the desk in half: both hands can use
 * the entire surface, the left simply sounds in the bass — the same division of
 * labour a pianist already has, rather than an artificial territory rule.
 */
export class Keyboard {
  constructor({ key = 0, scale = 'major', cols = 8, rows = 2, octave = 4 } = {}) {
    Object.assign(this, { key, scale, cols, rows, octave });
  }

  get cells() { return this.cols * this.rows; }

  /** Table coords (u across, v away-from-player) → { col, row } or null. */
  cellAt(t, margin = 0.06) {
    if (!t) return null;
    if (t.x < -margin || t.x > 1 + margin || t.y < -margin || t.y > 1 + margin) return null;
    const col = clamp(Math.floor(clamp(t.x, 0, 0.9999) * this.cols), 0, this.cols - 1);
    // v runs 0 = far, 1 = near. Rows are numbered from the player outward, so
    // row 0 is the near row and each row further away is an octave higher —
    // reaching away from yourself goes up, which is the way every instrument
    // with a neck or a keyboard already works.
    const vRow = clamp(Math.floor((1 - clamp(t.y, 0, 0.9999)) * this.rows), 0, this.rows - 1);
    return { col, row: vRow };
  }

  /** { col, row } → MIDI note. `handOffset` is in octaves. */
  midiAt(cell, handOffset = 0) {
    if (!cell) return null;
    const semis = degreeToSemitone(this.scale, cell.col);
    return clamp(12 * (this.octave + 1 + cell.row + handOffset) + this.key + semis, 12, 108);
  }

  /** Convenience for the renderer: every cell's note, in row-major order. */
  layout(handOffset = 0) {
    const out = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const midi = this.midiAt({ col, row }, handOffset);
        out.push({ col, row, midi, name: midiName(midi),
          root: degreeToSemitone(this.scale, col) % 12 === 0 });
      }
    }
    return out;
  }
}
