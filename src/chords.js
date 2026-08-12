/**
 * chords.js — guitar voicings built from real fretboard shapes.
 *
 * Everything downstream (audio, fret diagram) works in terms of a `Voicing`:
 *   { name, frets: [6 x fret|null], midi: [6 x note|null] }
 * index 0 = low E (6th string) … index 5 = high E (1st string); null = muted.
 *
 * Using genuine shapes (rather than stacking triads) is what makes the
 * synthesis sound like a guitar: correct octave doubling, correct string
 * assignment, and the low/high strings landing where a player would put them.
 */

export const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

const mod12 = (n) => ((n % 12) + 12) % 12;
const SUFFIX = { maj: '', min: 'm', dom7: '7', min7: 'm7', power: '5' };

/* Cowboy chords. Keyed by `${rootPitchClass}:${quality}` — these are absolute
 * fret positions, and they beat a barre chord for warmth whenever available. */
const OPEN_SHAPES = {
  '4:maj':  [0, 2, 2, 1, 0, 0],   '4:min':  [0, 2, 2, 0, 0, 0],
  '4:dom7': [0, 2, 0, 1, 0, 0],   '4:min7': [0, 2, 0, 0, 0, 0],
  '9:maj':  [null, 0, 2, 2, 2, 0], '9:min':  [null, 0, 2, 2, 1, 0],
  '9:dom7': [null, 0, 2, 0, 2, 0], '9:min7': [null, 0, 2, 0, 1, 0],
  '2:maj':  [null, null, 0, 2, 3, 2], '2:min':  [null, null, 0, 2, 3, 1],
  '2:dom7': [null, null, 0, 2, 1, 2], '2:min7': [null, null, 0, 2, 1, 1],
  '7:maj':  [3, 2, 0, 0, 0, 3],   '7:dom7': [3, 2, 0, 0, 0, 1],
  '0:maj':  [null, 3, 2, 0, 1, 0], '0:dom7': [null, 3, 2, 3, 1, 0],
  '11:dom7':[null, 2, 1, 2, 0, 2], '5:maj':  [1, 3, 3, 2, 1, 1],
};

/* Movable shapes, expressed as fret offsets from the barre. The E-shape roots
 * on the 6th string (open pitch class 4), the A-shape on the 5th (class 9). */
const BARRE = {
  E: { root: 4, maj: [0,2,2,1,0,0], min: [0,2,2,0,0,0], dom7: [0,2,0,1,0,0],
       min7: [0,2,0,0,0,0], power: [0,2,2,null,null,null] },
  A: { root: 9, maj: [null,0,2,2,2,0], min: [null,0,2,2,1,0], dom7: [null,0,2,0,2,0],
       min7: [null,0,2,0,1,0], power: [null,0,2,2,null,null] },
};

/**
 * Pick the shape/position a player would actually use for this chord.
 * Prefers the lower barre position, and prefers the fuller E-shape on ties.
 */
function barreVoicing(rootPc, quality) {
  const cands = ['E', 'A'].map((k) => ({ k, fret: mod12(rootPc - BARRE[k].root) }));
  const playable = cands.filter((c) => c.fret <= 8);
  const pool = playable.length ? playable : cands;
  pool.sort((a, b) => a.fret - b.fret || (a.k === 'E' ? -1 : 1));
  const { k, fret } = pool[0];
  const shape = BARRE[k][quality] || BARRE[k].maj;
  return shape.map((f) => (f === null ? null : f + fret));
}

export function buildChord(rootPc, quality) {
  rootPc = mod12(rootPc);
  const frets = (quality !== 'power' && OPEN_SHAPES[`${rootPc}:${quality}`])
    ? OPEN_SHAPES[`${rootPc}:${quality}`].slice()
    : barreVoicing(rootPc, quality);
  return {
    name: NOTE_NAMES[rootPc] + (SUFFIX[quality] ?? ''),
    quality,
    frets,
    midi: frets.map((f, i) => (f === null ? null : OPEN_STRING_MIDI[i] + f)),
  };
}

/* Six primary degrees per style plus six "extras" — together they fill the
 * twelve-cell chord grid the fretting hand points at. Primaries come first so
 * the top rows are always the money chords of the key. */
export const STYLES = {
  pop:    { label: 'Pop — I V vi IV',      roman: ['I','V','vi','IV','ii','iii'],
            degrees: [[0,'maj'],[7,'maj'],[9,'min'],[5,'maj'],[2,'min'],[4,'min']],
            extra:   [[0,'dom7'],[7,'dom7'],[2,'maj'],[9,'maj'],[5,'min'],[10,'maj']] },
  folk:   { label: 'Folk — I IV V vi',     roman: ['I','IV','V','vi','ii','V7'],
            degrees: [[0,'maj'],[5,'maj'],[7,'maj'],[9,'min'],[2,'min'],[7,'dom7']],
            extra:   [[0,'dom7'],[2,'maj'],[4,'min'],[9,'maj'],[10,'maj'],[5,'min']] },
  rock:   { label: 'Rock — power chords',  roman: ['I','♭VII','IV','V','♭III','♭VI'],
            degrees: [[0,'power'],[10,'power'],[5,'power'],[7,'power'],[3,'power'],[8,'power']],
            extra:   [[2,'power'],[9,'power'],[4,'power'],[11,'power'],[1,'power'],[6,'power']] },
  blues:  { label: 'Blues — dominant 7ths', roman: ['I7','IV7','V7','♭VII7','♭III7','♭VI7'],
            degrees: [[0,'dom7'],[5,'dom7'],[7,'dom7'],[10,'dom7'],[3,'dom7'],[8,'dom7']],
            extra:   [[0,'min7'],[5,'min7'],[7,'min7'],[2,'dom7'],[9,'dom7'],[4,'dom7']] },
  ballad: { label: 'Ballad — minor key',   roman: ['i','♭VI','♭III','♭VII','iv','v'],
            degrees: [[0,'min'],[8,'maj'],[3,'maj'],[10,'maj'],[5,'min'],[7,'min']],
            extra:   [[0,'min7'],[5,'min7'],[7,'dom7'],[10,'dom7'],[2,'min7'],[3,'maj']] },
};

/** The six chords currently under the neck. `force` = 'power' | 'open' | null. */
export function buildSet(keyPc, styleId, force) {
  const style = STYLES[styleId] || STYLES.pop;
  return style.degrees.map(([iv, q]) =>
    buildChord(keyPc + iv, force === 'power' ? 'power' : q));
}

/* ================================================================== *
 *  Chord banks — what the fretting hand actually points at.
 *
 *  A bank is a flat array of *specs* (`{ root, quality }` or null for an
 *  empty cell) rather than built voicings, because that's the form that
 *  survives a round-trip through localStorage and the chord-bank editor.
 * ================================================================== */

export const QUALITIES = [
  { id: 'maj',   label: 'major' },
  { id: 'min',   label: 'minor' },
  { id: 'dom7',  label: '7' },
  { id: 'min7',  label: 'm7' },
  { id: 'power', label: '5 (power)' },
];

export const GRID_COLS = 4, GRID_ROWS = 3;
export const GRID_CELLS = GRID_COLS * GRID_ROWS;   // 12 pointable cells
export const SIGN_CELLS = 5;                       // one chord per hand sign

/** Twelve-cell default bank: the style's six degrees, then six useful extras. */
export function defaultGridSpecs(keyPc, styleId) {
  const style = STYLES[styleId] || STYLES.pop;
  return [...style.degrees, ...style.extra]
    .slice(0, GRID_CELLS)
    .map(([iv, q]) => ({ root: mod12(keyPc + iv), quality: q }));
}

/** Five-sign default bank: the five strongest degrees of the style. */
export function defaultSignSpecs(keyPc, styleId) {
  const style = STYLES[styleId] || STYLES.pop;
  return style.degrees.slice(0, SIGN_CELLS).map(([iv, q]) => ({ root: mod12(keyPc + iv), quality: q }));
}

/** Spec → voicing. `force` mirrors buildSet's power-chord override. */
export function specToChord(spec, force) {
  if (!spec) return null;
  return buildChord(spec.root, force === 'power' ? 'power' : spec.quality);
}

/** Human name for a spec without paying for a full voicing build. */
export function specName(spec) {
  return spec ? NOTE_NAMES[mod12(spec.root)] + (SUFFIX[spec.quality] ?? '') : '—';
}

/** Compact SVG chord box for the HUD. */
export function diagramSVG(v) {
  if (!v) return '';
  const played = v.frets.filter((f) => f !== null && f > 0);
  const lo = played.length ? Math.min(...played) : 1;
  const base = lo > 3 ? lo : 1;              // window the neck when we're up high
  const W = 128, H = 92, X0 = 22, Y0 = 15, SW = 16, FH = 17, NF = 4;
  const p = [];
  p.push(`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${v.name} chord shape">`);
  if (base === 1) p.push(`<rect x="${X0 - 1}" y="${Y0 - 4}" width="${SW * 5 + 2}" height="4" rx="1.5" fill="#8B6A46"/>`);
  else p.push(`<text x="${X0 - 7}" y="${Y0 + 13}" font-size="9" fill="#9B8974" text-anchor="end" font-family="Inter,sans-serif">${base}</text>`);
  for (let f = 0; f <= NF; f++)
    p.push(`<line x1="${X0}" y1="${Y0 + f * FH}" x2="${X0 + SW * 5}" y2="${Y0 + f * FH}" stroke="#D9C9B2" stroke-width="1"/>`);
  for (let s = 0; s < 6; s++)
    p.push(`<line x1="${X0 + s * SW}" y1="${Y0}" x2="${X0 + s * SW}" y2="${Y0 + NF * FH}" stroke="#C9B79C" stroke-width="${1.4 - s * 0.12}"/>`);
  v.frets.forEach((f, i) => {
    const x = X0 + i * SW;                    // low E drawn on the left
    if (f === null) {
      p.push(`<path d="M${x - 3.5} ${Y0 - 11} l7 7 M${x + 3.5} ${Y0 - 11} l-7 7" stroke="#B9A88F" stroke-width="1.5" stroke-linecap="round"/>`);
    } else if (f === 0) {
      p.push(`<circle cx="${x}" cy="${Y0 - 7.5}" r="3.2" fill="none" stroke="#B08A55" stroke-width="1.5"/>`);
    } else {
      p.push(`<circle cx="${x}" cy="${Y0 + (f - base + 0.5) * FH}" r="5.4" fill="#C0631A"/>`);
    }
  });
  p.push('</svg>');
  return p.join('');
}
