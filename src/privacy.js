/**
 * privacy.js — play without showing your face.
 *
 * A blur that follows your face around the camera feed, so the instrument can
 * be filmed, streamed or screen-shared without putting you in the shot. The
 * setting is chosen on the shelf and read by every instrument, so it is picked
 * once rather than per page.
 *
 * ── Two things this must never do ─────────────────────────────────────────
 *
 * **It must not cost anything when it is off.** The MediaPipe bundle and the
 * face model are pulled with a dynamic `import()` inside `enable()`, not a
 * static one at the top. A static import would drag the vision bundle into the
 * shelf — a page with no camera on it at all — and would download the face
 * model for every player whether or not they ever switch this on. Off means
 * off: no model, no inference, no veil element.
 *
 * **It must not fail open.** A privacy feature that silently stops protecting
 * is worse than one that over-protects, because you would not find out until
 * after you had been on camera. So every failure path blurs *more*, never
 * less: if the model will not load, if inference throws, or if the face is
 * simply lost for longer than `HOLD`, the veil expands to cover the whole
 * frame rather than snapping away. `state` reports which of those you are in
 * so the UI can say so honestly.
 *
 * ── Why it can't disturb the instrument ───────────────────────────────────
 *
 * Hand tracking reads the raw `<video>` element through `detectForVideo`, and
 * the veil is a sibling DOM node with a `backdrop-filter`. Compositing never
 * touches the decoded frames the tracker sees, so no amount of blurring can
 * move a landmark. The cost that *is* real is the second inference, and it is
 * held down three ways: it runs at `PERIOD` (5 Hz, not per frame — a face does
 * not move like a hand), it backs off on its own measured cost the way
 * `tracking.js` does, and it yields whenever hand inference is running slow,
 * because the hands are the instrument and the face is decoration.
 */

const KEY = 'air-studio.privacy';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const BUNDLE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

const PERIOD = 200;    // ms between face looks — 5 Hz is plenty for a head
const HOLD   = 1.2;    // s a lost face keeps its last box before we cover all
const SMOOTH = 0.35;   // EMA on the box; a jittering blur is worse than none
const PAD    = 0.34;   // grow the box by this much — detectors crop tight to
                       // the face, and a jaw or an ear left outside is a miss

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ================================================================== *
 *  The setting — shared by the shelf and all three instruments
 * ================================================================== */

/** @returns true if the player asked to have their face hidden. */
export function faceHidden() {
  try { return localStorage.getItem(KEY) === 'on'; } catch { return false; }
}

/** @returns the new state, so a caller can paint its own control. */
export function setFaceHidden(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
  // Same-tab listeners: `storage` only fires in *other* tabs, so a page with
  // both a toggle and a live veil would never hear its own switch.
  dispatchEvent(new CustomEvent('air-privacy', { detail: { on } }));
  return on;
}

/** Subscribe to changes from this tab or any other. @returns unsubscribe. */
export function onFaceHiddenChange(fn) {
  const local = (e) => fn(!!e.detail.on);
  const cross = (e) => { if (e.key === KEY) fn(faceHidden()); };
  addEventListener('air-privacy', local);
  addEventListener('storage', cross);
  return () => { removeEventListener('air-privacy', local); removeEventListener('storage', cross); };
}

/* ================================================================== *
 *  The veil
 * ================================================================== */

export class FaceVeil {
  /**
   * @param video the instrument's `<video>` — read, never modified
   * @param stage the positioned box the video fills; the veil mounts here
   */
  constructor(video, stage) {
    this.video = video; this.stage = stage;
    this.detector = null; this.el = null;
    this.on = false; this.loading = false;
    this.state = 'off';          // off | loading | tracking | searching | failed
    this.box = null;             // smoothed, display-normalised {x,y,w,h}
    this.seenAt = -9; this.lastRun = 0; this.lastTs = -1;
    this.emaMs = 0; this.runs = 0;
  }

  /** Build the veil element lazily — nothing exists in the DOM while off. */
  _mount() {
    if (this.el) return;
    const el = document.createElement('div');
    el.className = 'face-veil';
    el.setAttribute('aria-hidden', 'true');
    this.stage.append(el);
    this.el = el;
  }

  async enable() {
    if (this.on) return;
    this.on = true;
    this._mount();
    // Cover everything until the first face lands. Starting clear and
    // narrowing down would put the player on screen for the second or two the
    // model takes to arrive, which is exactly the moment they asked to avoid.
    this._paint(null);
    if (this.detector || this.loading) return;

    this.loading = true; this.state = 'loading';
    try {
      const { FilesetResolver, FaceDetector } = await import(/* @vite-ignore */ BUNDLE);
      const vision = await FilesetResolver.forVisionTasks(CDN);
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
      this.state = 'searching';
    } catch (err) {
      // Fail closed: no detector means the whole frame stays blurred.
      this.state = 'failed';
      console.warn('[air-studio] face blur unavailable, covering the whole frame', err);
    } finally {
      this.loading = false;
      if (this.on) this._paint(this.box);
    }
  }

  disable() {
    this.on = false;
    this.state = 'off';
    this.box = null;
    this.el?.remove();
    this.el = null;
    // The detector is kept: re-enabling should be instant, and it costs
    // nothing while `tick` is not calling it.
  }

  set(on) { return on ? this.enable() : this.disable(); }

  /**
   * Call once per rendered frame. Cheap on the frames it decides to skip.
   * @param now  performance.now()
   * @param busy true when hand inference is already over budget this frame
   */
  tick(now, busy = false) {
    if (!this.on) return;
    if (this.detector && this._due(now, busy)) this._detect(now);
    // Time out a lost face into a full cover rather than leaving a stale box
    // hanging over a frame the player has since moved out of.
    if (this.box && (now / 1000) - this.seenAt > HOLD) {
      this.box = null;
      if (this.state === 'tracking') this.state = 'searching';
    }
    this._paint(this.box);
  }

  /** 5 Hz, backed off by measured cost, and never while the hands are late. */
  _due(now, busy) {
    if (busy) return false;
    const gap = Math.max(PERIOD, this.emaMs * 4);
    return now - this.lastRun >= gap;
  }

  _detect(now) {
    const v = this.video;
    if (!v || v.readyState < 2 || !v.videoWidth) return;
    const ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;
    const t0 = performance.now();
    let res = null;
    try { res = this.detector.detectForVideo(v, ts); }
    catch { this.state = 'failed'; this.box = null; return; }
    finally { this.lastRun = now; }

    const ms = performance.now() - t0;
    this.emaMs = this.runs++ ? this.emaMs * 0.8 + ms * 0.2 : ms;

    const d = (res?.detections || [])[0];
    if (!d?.boundingBox) return;

    // boundingBox is in *pixels of the input frame*, and the video is drawn
    // mirrored, so x flips. The stage is held at the camera's own aspect ratio
    // (see tracking.js), which is what lets this be a plain scale with no
    // letterbox term.
    const b = d.boundingBox;
    const w = b.width / v.videoWidth, h = b.height / v.videoHeight;
    const x = 1 - (b.originX / v.videoWidth) - w;
    const y = b.originY / v.videoHeight;

    const grown = {
      x: x - w * PAD / 2, y: y - h * PAD / 2,
      w: w * (1 + PAD), h: h * (1 + PAD),
    };
    this.box = this.box
      ? { x: this.box.x + (grown.x - this.box.x) * SMOOTH,
          y: this.box.y + (grown.y - this.box.y) * SMOOTH,
          w: this.box.w + (grown.w - this.box.w) * SMOOTH,
          h: this.box.h + (grown.h - this.box.h) * SMOOTH }
      : grown;
    this.seenAt = now / 1000;
    this.state = 'tracking';
  }

  /** No box → cover the frame. A box → an ellipse over it, softly edged. */
  _paint(box) {
    const el = this.el;
    if (!el) return;
    if (!box) { el.classList.add('all'); el.style.cssText = ''; return; }
    el.classList.remove('all');
    const pc = (v) => (clamp(v, -0.5, 1.5) * 100).toFixed(2) + '%';
    el.style.left = pc(box.x);
    el.style.top = pc(box.y);
    el.style.width = pc(box.w);
    el.style.height = pc(box.h);
  }
}
