/**
 * tour.js — the walkthrough that runs the first time you open Air Piano.
 *
 * Its single job is to point at things. Each step names an element, and the
 * tour dims everything except that element and parks a card next to it.
 *
 * The dimming is done with one fixed-position "hole" carrying a very large
 * spread box-shadow, rather than by putting a dark sheet behind a raised
 * target. Raising the target means giving it a z-index, and every element worth
 * pointing at here — the stage, the calibration bar, a segmented control inside
 * the panel — lives in a different stacking context, so that approach fails
 * differently in each case. A hole in a shadow needs nothing from the element
 * at all: it never touches it, so it cannot break its layout, and the target
 * stays fully interactive underneath. The tour is advisory, not modal — you can
 * carry on clicking the thing being described while it is open.
 */

/** How far the card sits from the thing it is describing. */
const GAP = 14;
const PAD = 8;         // breathing room around the spotlight
const EDGE = 12;       // keep the card off the viewport edge

export class Tour {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root  the fixed overlay container
   * @param {HTMLElement} o.hole  the spotlight element
   * @param {HTMLElement} o.card  the step card
   * @param {() => void} [o.onDone]  fires on finish *and* on skip
   */
  constructor({ root, hole, card, onDone }) {
    this.root = root; this.hole = hole; this.card = card;
    this.onDone = onDone || (() => {});
    this.steps = []; this.i = -1;
    this._place = () => this.reposition();
    this._key = (e) => {
      if (!this.running) return;
      if (e.key === 'Escape') { e.preventDefault(); this.stop(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.go(this.i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.i - 1); }
    };
  }

  get running() { return this.i >= 0; }

  /** @param {Array<{title:string, body:string, target?:string}>} steps */
  start(steps) {
    this.steps = steps.filter(Boolean);
    if (!this.steps.length) return;
    this.root.hidden = false;
    addEventListener('resize', this._place);
    addEventListener('scroll', this._place, true);
    addEventListener('keydown', this._key);
    this.go(0);
  }

  stop() {
    if (!this.running) return;
    this.i = -1;
    this.root.hidden = true;
    removeEventListener('resize', this._place);
    removeEventListener('scroll', this._place, true);
    removeEventListener('keydown', this._key);
    this.onDone();
  }

  go(n) {
    if (n < 0) return;
    if (n >= this.steps.length) return this.stop();
    this.i = n;
    this.paint();
    /* Scrolling happens *before* measuring, and the measure is deferred a frame
     * so the card is placed against where the target ended up rather than where
     * it was when the button was clicked. */
    const t = this.target();
    if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    requestAnimationFrame(() => this.reposition());
    setTimeout(this._place, 260);
  }

  target() {
    const id = this.steps[this.i]?.target;
    const t = id && document.getElementById(id);
    // A step may point at something that is not on screen right now — the
    // calibration bar when it is closed, the camera picker on a one-camera
    // machine. Those steps simply become untargeted rather than pointing at a
    // zero-sized box in the corner.
    return t && t.offsetParent !== null && !t.hidden ? t : null;
  }

  paint() {
    const s = this.steps[this.i];
    const last = this.i === this.steps.length - 1;
    this.card.innerHTML = `
      <div class="tour-of">${this.i + 1} of ${this.steps.length}</div>
      <h3>${s.title}</h3>
      <p>${s.body}</p>
      <div class="tour-actions">
        <button class="btn sec" data-act="skip">${last ? 'Close' : 'Skip'}</button>
        <span class="tour-spacer"></span>
        ${this.i > 0 ? '<button class="btn sec" data-act="back">Back</button>' : ''}
        <button class="btn" data-act="next">${last ? 'Start playing' : 'Next'}</button>
      </div>`;
    for (const b of this.card.querySelectorAll('button')) {
      b.onclick = () => {
        const a = b.dataset.act;
        if (a === 'skip') this.stop();
        else this.go(this.i + (a === 'back' ? -1 : 1));
      };
    }
  }

  reposition() {
    if (!this.running) return;
    const t = this.target();
    const vw = innerWidth, vh = innerHeight;

    if (!t) {
      // Nothing to point at: dim the lot and centre the card.
      this.root.classList.add('nospot');
      this.hole.style.cssText = '';
      const c = this.card.getBoundingClientRect();
      this.card.style.left = `${Math.max(EDGE, (vw - c.width) / 2)}px`;
      this.card.style.top = `${Math.max(EDGE, (vh - c.height) / 2)}px`;
      return;
    }

    this.root.classList.remove('nospot');
    const r = t.getBoundingClientRect();
    this.hole.style.left = `${r.left - PAD}px`;
    this.hole.style.top = `${r.top - PAD}px`;
    this.hole.style.width = `${r.width + PAD * 2}px`;
    this.hole.style.height = `${r.height + PAD * 2}px`;

    const c = this.card.getBoundingClientRect();
    // Below the target if it fits, above if it doesn't, and if neither fits
    // (a target taller than the viewport) sit over its bottom edge — anywhere
    // is better than off-screen.
    const below = r.bottom + GAP, above = r.top - GAP - c.height;
    let top = below + c.height + EDGE <= vh ? below
      : above >= EDGE ? above
        : Math.max(EDGE, Math.min(vh - c.height - EDGE, r.bottom - c.height - GAP));
    const left = Math.max(EDGE, Math.min(vw - c.width - EDGE, r.left + r.width / 2 - c.width / 2));
    this.card.style.left = `${left}px`;
    this.card.style.top = `${top}px`;
  }
}
