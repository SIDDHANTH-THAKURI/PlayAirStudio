/**
 * ui.js — the two authoring popups: the chord bank and the strum maker.
 *
 * Both are plain DOM built from the same state objects the instrument plays
 * from, so there's no "apply" step and no second copy of the truth to drift:
 * every control writes straight into `S` and calls back so main.js can
 * re-render the stage and persist. Built-in patterns are never edited in
 * place — the editor duplicates them instead, which is why "switch back to
 * the defaults" is always a one-click operation.
 */
import { NOTE_NAMES, QUALITIES, GRID_CELLS, SIGN_CELLS, specName,
  defaultGridSpecs, defaultSignSpecs } from './chords.js';
import { SIGNS, STRUM_SIGNS } from './gestures.js';
import { STEP_KINDS, DYNAMICS, RATES, PATTERNS, listPatterns, getPattern, saveCustom,
  removeCustom, blankPattern, newPatternId, tokenToStep, stepToToken,
  stepsPerSecond } from './patterns.js';
import { defaultSignPatterns } from './store.js';

const $ = (id) => document.getElementById(id);
const h = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const opts = (list, sel) => list.map(([v, l]) =>
  `<option value="${v}"${String(v) === String(sel) ? ' selected' : ''}>${l}</option>`).join('');

export class Editors {
  /**
   * @param S      the live settings object (mutated in place)
   * @param hooks  { onBank, onPatterns, preview:{ start(p), stop(), player } }
   */
  constructor(S, hooks) {
    this.S = S; this.hooks = hooks;
    this.draft = null;              // pattern currently open in the editor
    this._bind();
  }

  _bind() {
    $('bankBtn').onclick = () => this.openBank();
    $('patBtn').onclick = () => this.openPatterns();
    for (const [modal, close] of [['bankModal', 'bankClose'], ['patModal', 'patClose']]) {
      $(close).onclick = () => this.close(modal);
      $(modal).onclick = (e) => { if (e.target === $(modal)) this.close(modal); };
    }
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      for (const m of ['bankModal', 'patModal']) if (!$(m).hidden) this.close(m);
    });
  }

  close(id) {
    $(id).hidden = true;
    if (id === 'patModal') this.stopPreview();
  }

  /* ================================================================ *
   *  Chord bank — twelve pointable cells and five sign chords
   * ================================================================ */

  openBank() {
    $('bankModal').hidden = false;
    this.renderBank();
  }

  renderBank() {
    const S = this.S;
    const wrap = $('bankBody');
    wrap.innerHTML = '';

    const tabs = h('div', 'seg tabs');
    for (const [id, label] of [['grid', `Chord grid · ${GRID_CELLS}`], ['signs', `Sign chords · ${SIGN_CELLS}`]]) {
      const b = h('button', S.chordMode === id ? 'on' : '', label);
      b.onclick = () => { S.chordMode = id; this.hooks.onBank(); this.renderBank(); };
      tabs.append(b);
    }
    wrap.append(tabs);

    const grid = S.chordMode !== 'signs';
    const specs = grid ? S.gridSpecs : S.signSpecs;
    const n = grid ? GRID_CELLS : SIGN_CELLS;

    wrap.append(h('p', 'modal-hint', grid
      ? 'Point your index finger at a cell to play it. Cells run left→right, top→bottom.'
      : 'Make the sign with your fretting hand to play its chord.'));

    const list = h('div', grid ? 'bank-grid' : 'bank-list');
    for (let i = 0; i < n; i++) {
      const spec = specs[i];
      const row = h('div', 'bank-cell');
      const tag = grid ? `${i + 1}` : `${SIGNS[i].glyph} ${SIGNS[i].label}`;
      row.append(h('div', 'bank-tag', tag));
      row.append(h('div', 'bank-name', specName(spec)));

      const root = h('select', 'mini');
      root.innerHTML = `<option value="">— empty —</option>` +
        opts(NOTE_NAMES.map((nm, k) => [k, nm]), spec ? spec.root : '');
      const qual = h('select', 'mini');
      qual.innerHTML = opts(QUALITIES.map((q) => [q.id, q.label]), spec?.quality || 'maj');
      qual.disabled = !spec;

      const write = () => {
        const r = root.value === '' ? null : +root.value;
        specs[i] = r === null ? null : { root: r, quality: qual.value };
        qual.disabled = r === null;
        row.querySelector('.bank-name').textContent = specName(specs[i]);
        this.hooks.onBank();
      };
      root.onchange = write; qual.onchange = write;
      row.append(root, qual);
      list.append(row);
    }
    wrap.append(list);

    const actions = h('div', 'modal-actions');
    const fill = h('button', 'btn sec', 'Refill from key & style');
    fill.onclick = () => {
      const fresh = grid ? defaultGridSpecs(S.key, S.style) : defaultSignSpecs(S.key, S.style);
      fresh.forEach((s, i) => { specs[i] = s; });
      this.hooks.onBank(); this.renderBank();
    };
    const clear = h('button', 'btn sec', 'Clear all');
    clear.onclick = () => { specs.fill(null); this.hooks.onBank(); this.renderBank(); };
    actions.append(fill, clear);
    wrap.append(actions);
  }

  /* ================================================================ *
   *  Strum maker — pattern list, step editor, sign bindings
   * ================================================================ */

  openPatterns() {
    $('patModal').hidden = false;
    if (!this.draft) this.draft = this._copyOf('drive');
    this.renderPatterns();
  }

  /** An editable clone of a pattern (built-ins can only be reached this way). */
  _copyOf(id) {
    const p = getPattern(id);
    if (!p) return blankPattern();
    if (!p.builtin) return { ...p, steps: p.steps.map((s) => (s ? { ...s } : null)) };
    return { id: newPatternId(), label: `${p.label} copy`, glyph: '🎚️', builtin: false,
      steps: p.steps.map((s) => (s ? { ...s } : null)) };
  }

  renderPatterns() {
    this.renderPatList();
    this.renderEditor();
    this.renderBindings();
  }

  renderPatList() {
    const box = $('patList');
    box.innerHTML = '';
    for (const p of listPatterns()) {
      const row = h('button', 'plitem' + (this.draft && p.id === this.draft.id ? ' on' : ''));
      row.innerHTML = `<span class="pl-name">${p.label}</span>` +
        `<span class="pl-kind">${p.builtin ? 'built-in' : 'custom'} · ${p.steps.length}</span>`;
      row.onclick = () => {
        this.stopPreview();
        // Opening a built-in hands you a copy; the original stays pristine.
        this.draft = p.builtin ? this._copyOf(p.id) : { ...p, steps: p.steps.map((s) => (s ? { ...s } : null)) };
        this.renderPatterns();
      };
      box.append(row);
    }
    const add = h('button', 'plitem ghost', '<span class="pl-name">+ New pattern</span>');
    add.onclick = () => { this.stopPreview(); this.draft = blankPattern(); this.renderPatterns(); };
    box.append(add);
  }

  renderEditor() {
    const d = this.draft, box = $('patEdit');
    box.innerHTML = '';
    if (!d) return;

    const head = h('div', 'pe-head');
    const name = h('input', 'pe-name');
    name.type = 'text'; name.value = d.label; name.maxLength = 24;
    name.oninput = () => { d.label = name.value; };
    head.append(name);

    const len = h('div', 'seg mini-seg');
    for (const n of [8, 16]) {
      const b = h('button', d.steps.length === n ? 'on' : '', n === 8 ? '8ths' : '16ths');
      b.onclick = () => {
        if (d.steps.length === n) return;
        // Growing interleaves rests so the groove survives; shrinking keeps the
        // downbeats, which is where the character of a strum lives.
        d.steps = n > d.steps.length
          ? d.steps.flatMap((s) => [s, null])
          : d.steps.filter((_, i) => i % 2 === 0);
        this.stopPreview(); this.renderEditor();
      };
      len.append(b);
    }
    head.append(len);

    // Feel: how fast this one bar runs against the song tempo.
    const rate = h('div', 'seg mini-seg rate-seg');
    for (const x of RATES) {
      const b = h('button', (d.rate || 1) === x.r ? 'on' : '', x.label);
      b.title = x.hint;
      b.onclick = () => {
        d.rate = x.r;
        // Restart rather than retime: a preview that jumps mid-bar reads as a
        // glitch, and the point of this control is hearing the new groove.
        const was = this.previewing;
        this.stopPreview(); this.renderEditor();
        if (was) this.startPreview();
      };
      rate.append(b);
    }
    head.append(rate);
    box.append(head);

    const steps = h('div', 'steps' + (d.steps.length === 16 ? ' steps-16' : ''));
    d.steps.forEach((step, i) => {
      const cell = h('div', 'step' + (i % (d.steps.length / 4) === 0 ? ' beat' : ''));
      cell.dataset.i = i;
      cell.append(h('span', 'sn', String(i + 1)));

      const kind = h('select', 'sk');
      kind.innerHTML = STEP_KINDS.map((k) =>
        `<option value="${k.k ?? ''}">${k.label}</option>`).join('');
      kind.value = stepToToken(step) ?? '';
      kind.title = STEP_KINDS.find((k) => (k.k ?? '') === kind.value)?.hint || '';

      const dyn = h('button', 'sd');
      const dynIndex = () => {
        const v = d.steps[i]?.v ?? 0.7;
        let best = 0;
        DYNAMICS.forEach((x, j) => { if (Math.abs(x.v - v) < Math.abs(DYNAMICS[best].v - v)) best = j; });
        return best;
      };
      const paintDyn = () => {
        const on = !!d.steps[i];
        dyn.textContent = on ? DYNAMICS[dynIndex()].label : '·';
        dyn.disabled = !on;
        dyn.title = on ? DYNAMICS[dynIndex()].hint : 'rest';
        cell.classList.toggle('filled', on);
      };
      kind.onchange = () => {
        const keep = d.steps[i]?.v ?? 0.7;
        d.steps[i] = tokenToStep(kind.value || null, keep);
        kind.title = STEP_KINDS.find((k) => (k.k ?? '') === kind.value)?.hint || '';
        paintDyn();
      };
      dyn.onclick = () => {
        if (!d.steps[i]) return;
        d.steps[i].v = DYNAMICS[(dynIndex() + 1) % DYNAMICS.length].v;
        paintDyn();
      };
      paintDyn();
      cell.append(kind, dyn);
      steps.append(cell);
    });
    box.append(steps);

    const bar = h('div', 'pe-actions');
    const play = h('button', 'btn', this.previewing ? '■ Stop' : '▶ Preview');
    play.onclick = () => (this.previewing ? this.stopPreview() : this.startPreview());
    const save = h('button', 'btn sec', 'Save');
    save.onclick = () => {
      const saved = saveCustom(this.draft);
      if (!saved) return;
      this.draft = { ...saved, steps: saved.steps.map((s) => (s ? { ...s } : null)) };
      this.hooks.onPatterns();
      this.renderPatterns();
    };
    const del = h('button', 'btn sec danger', 'Delete');
    del.disabled = !getPattern(d.id) || !!PATTERNS[d.id];
    del.onclick = () => {
      this.stopPreview();
      removeCustom(d.id);
      // Any sign left pointing at the deleted pattern falls back to its factory.
      for (const s of STRUM_SIGNS) if (this.S.signPatterns[s.id] === d.id) this.S.signPatterns[s.id] = s.def;
      this.draft = this._copyOf('drive');
      this.hooks.onPatterns();
      this.renderPatterns();
    };
    bar.append(play, save, del);
    box.append(bar);
    const sps = stepsPerSecond(d, this.S.bpm);
    box.append(h('p', 'modal-hint',
      `At ${this.S.bpm} BPM this fires <b>${sps.toFixed(1)} steps/sec</b> — ${d.steps.length === 8 ? '8ths' : '16ths'}
       at ${RATES.find((x) => x.r === (d.rate || 1))?.hint || 'normal'}. Feel is saved with the pattern;
       the Tempo slider moves everything at once.<br>
       Preview loops on the chord you have selected. Save it, then bind it to a hand sign below.`));
  }

  renderBindings() {
    const box = $('patBind');
    box.innerHTML = '';
    box.append(h('h3', null, 'Which sign plays what'));
    const all = listPatterns();
    for (const s of STRUM_SIGNS) {
      const row = h('div', 'bind-row');
      row.append(h('span', 'bind-sign', `${s.glyph} ${s.label}`));
      const sel = h('select', 'mini');
      sel.innerHTML = opts(all.map((p) => [p.id, p.label]), this.S.signPatterns[s.id] || s.def);
      sel.onchange = () => { this.S.signPatterns[s.id] = sel.value; this.hooks.onPatterns(); };
      row.append(sel);
      box.append(row);
    }
    const reset = h('button', 'btn sec', 'Restore default bindings');
    reset.onclick = () => {
      Object.assign(this.S.signPatterns, defaultSignPatterns());
      this.hooks.onPatterns(); this.renderBindings();
    };
    box.append(reset);
    box.append(h('p', 'modal-hint', '✋ open palm stops whatever is playing.'));
  }

  /* ---------------- preview transport ---------------- */

  startPreview() {
    if (!this.draft?.steps.some(Boolean)) return;
    this.previewing = this.hooks.preview.start(this.draft);
    this.renderEditor();
    if (this.previewing) this._followStep();
  }
  stopPreview() {
    if (!this.previewing) return;
    this.previewing = false;
    this.hooks.preview.stop();
    cancelAnimationFrame(this._raf);
    document.querySelectorAll('#patEdit .step.now').forEach((n) => n.classList.remove('now'));
    if (!$('patModal').hidden) this.renderEditor();
  }
  /** Walk the playhead across the step cells while the preview loops. */
  _followStep() {
    const tick = () => {
      if (!this.previewing) return;
      const i = this.hooks.preview.step();
      document.querySelectorAll('#patEdit .step').forEach((n) => n.classList.toggle('now', +n.dataset.i === i));
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}
