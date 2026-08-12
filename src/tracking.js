/**
 * tracking.js — camera + MediaPipe HandLandmarker.
 * Emits hands already converted to DISPLAY-normalised coords (mirrored),
 * so nothing downstream has to think about the raw camera frame.
 */
import { FilesetResolver, HandLandmarker }
  from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Phones: coarse pointer or a small window. Decides every perf default. */
export const IS_MOBILE = (() => {
  try { return matchMedia('(pointer: coarse)').matches || innerWidth < 820; }
  catch { return false; }
})();

export class Tracker {
  constructor() {
    this.landmarker = null; this.lastTs = -1;
    this.delegate = 'GPU'; this.emaMs = 0; this.frames = 0; this._swapping = false;
    this.gpuMs = 0; this._triedCpu = false; this._pinned = false;
    // Share of wall-clock time inference is allowed to occupy. The rest is for
    // painting and for scheduling audio — see `due()`.
    this.duty = IS_MOBILE ? 0.5 : 0.8;
    this.lastEnd = 0; this.skipped = 0;
  }

  /**
   * Should we run inference right now?
   *
   * This is the single most important thing for phones. `detectForVideo` is
   * synchronous and, on a mid-range phone, costs 80–250 ms — far longer than
   * the 33 ms between camera frames. Running it on every frame (which is what
   * requestVideoFrameCallback invites you to do) means the main thread is
   * essentially never outside MediaPipe: rAF starves so the canvas looks
   * frozen, and the pattern scheduler misses its lookahead window so the audio
   * stutters. The tracker being "fast" is worthless if nothing else can run.
   *
   * So: spend at most `duty` of wall time inferring and idle the remainder.
   * At 200 ms/frame and duty 0.5 that is ~2.5 detections a second — the hands
   * respond slower, but the instrument stays at 60 fps and in time, which is
   * the trade every player actually wants. Gesture dwell times are in seconds
   * and the One Euro filters are dt-aware, so the engine copes natively.
   *
   * On desktop, inference is ~5 ms and this never blocks anything.
   */
  due(now = performance.now()) {
    if (!this.landmarker || this._swapping) return false;
    if (!this.frames) return true;
    const idle = this.emaMs * (1 / this.duty - 1);
    // Cap the enforced gap: even a pathologically slow device should get a
    // look at the hands about three times a second.
    return now - this.lastEnd >= Math.min(idle, 300);
  }

  /** Kick this off at page load so the model is warm before the user clicks. */
  preload() {
    if (!this._p) this._p = (async () => {
      const vision = await FilesetResolver.forVisionTasks(CDN);
      this._make = (delegate) => HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.55,
      });
      // Machines without usable WebGL2 (old iGPUs, some VMs) reject the GPU
      // delegate outright; CPU (XNNPACK/WASM) still tracks two hands ~realtime.
      try { this.landmarker = await this._make('GPU'); }
      catch { this.landmarker = await this._make('CPU'); this.delegate = 'CPU'; }
    })().catch((e) => { this._p = null; throw e; });
    return this._p;
  }

  /**
   * Some machines *accept* the GPU delegate but then run it on emulated GL
   * (SwiftShader, remote desktops) at 100× real cost, blocking the main thread.
   * If sustained inference time says that's happening, swap to CPU live.
   */
  _maybeDowngrade() {
    if (this._pinned || this._swapping) return;

    /* GPU → CPU, but only on evidence.
     *
     * The old rule ("GPU slower than 80 ms ⇒ CPU") is right for a desktop
     * falling back to software GL, and wrong for a phone: a mobile GPU
     * delegate at 90 ms is still comfortably better than mobile XNNPACK at
     * 250 ms, and the swap used to be one-way. So the threshold now scales
     * with the device, and — more importantly — the swap is *verified*:
     * whichever delegate actually measured faster is the one we keep. */
    if (this.delegate === 'GPU' && !this._triedCpu) {
      // Sustained sluggishness needs a sample to be sure. Catastrophe doesn't:
      // even a bad mobile GPU lands under ~400 ms, so a single frame past a
      // second is software GL or a dying device — and waiting for a second
      // sample costs the player another whole frozen second.
      const bad = IS_MOBILE ? 220 : 80;
      const slow = (this.frames >= 8 && this.emaMs > bad) || (this.frames >= 1 && this.emaMs > 1000);
      if (!slow) return;
      this.gpuMs = this.emaMs;
      this._triedCpu = true; this._swapping = true;
      console.warn(`[air-guitar] GPU inference ~${this.emaMs.toFixed(0)} ms/frame — trying the CPU delegate`);
      this._swap('CPU');
      return;
    }

    // We are on CPU because GPU looked slow. Give it a fair sample, then keep
    // the winner; if CPU turned out worse, go back and stop experimenting.
    if (this.delegate === 'CPU' && this.gpuMs && this.frames >= 10) {
      if (this.emaMs > this.gpuMs * 1.15) {
        console.warn(`[air-guitar] CPU ~${this.emaMs.toFixed(0)} ms is worse than GPU ~${this.gpuMs.toFixed(0)} ms — going back`);
        this._swapping = true;
        this._swap('GPU', true);
      } else {
        this._pinned = true;      // CPU won, stop measuring
      }
    }
  }

  _swap(delegate, pin = false) {
    this._make(delegate).then((lm) => {
      const old = this.landmarker;
      this.landmarker = lm; this.delegate = delegate;
      this.emaMs = 0; this.frames = 0; this._swapping = false; this._pinned = pin;
      try { old.close(); } catch {}
    }).catch(() => { this._swapping = false; this._pinned = true; });
  }

  detect(video, tsMs) {
    if (!this.landmarker || this._swapping) return [];
    if (tsMs <= this.lastTs) tsMs = this.lastTs + 1;   // must be strictly increasing
    this.lastTs = tsMs;
    let r;
    const t0 = performance.now();
    try { r = this.landmarker.detectForVideo(video, tsMs); } catch { return []; }
    this.lastEnd = performance.now();
    const cost = this.lastEnd - t0;
    this.emaMs = this.frames === 0 ? cost : this.emaMs * 0.85 + cost * 0.15;
    this.frames++;
    this._maybeDowngrade();
    const lms = r?.landmarks || [];
    const worlds = r?.worldLandmarks || [];
    const handed = r?.handednesses || r?.handedness || [];
    return lms.map((lm, i) => {
      // Mirror X so screen-space matches the mirrored <video> the player sees.
      const flipped = lm.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z }));
      const w = worlds[i] ? worlds[i].map((p) => ({ x: -p.x, y: p.y, z: p.z })) : null;
      // Raw MediaPipe label — the gesture engine locks its anatomical meaning
      // by observation, so no mirroring convention is assumed here.
      const cat = handed[i]?.[0];
      return {
        lm: flipped, world: w,
        x: (flipped[0].x + flipped[5].x + flipped[17].x) / 3,
        label: cat?.categoryName || null, score: cat?.score ?? 0,
      };
    });
  }
}

export class Camera {
  constructor(video) { this.video = video; this.stream = null; }

  /**
   * @param deviceId pick a specific camera (from `devices()`); omit for the default.
   * @param want     override the resolution/frame-rate request. Air Piano asks
   *                 for something smaller and faster than the guitar does,
   *                 because tap detection is bounded by how often inference
   *                 finishes rather than by how sharp each frame is.
   */
  async start(deviceId, want = null) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('unsupported'), { kind: 'unsupported' });
    }
    if (!window.isSecureContext) {
      throw Object.assign(new Error('insecure'), { kind: 'insecure' });
    }
    this.stop();
    // Constraint ladder: ask for what we'd like, then take whatever exists.
    // Everything in the first attempt is a soft `ideal` on purpose — a hard
    // `min` makes the whole request mandatory, and plenty of real webcams
    // (and headless fakes) reject it with OverconstrainedError.
    // Inference cost tracks the source frame, and a phone is both the slowest
    // device and the one most likely to hand back a 1080p stream if asked
    // vaguely. 640×480 is ample for hand tracking at arm's length and roughly
    // halves the per-frame upload versus 960×540.
    // Inference cost tracks the source frame area, and 480×360 is still ample
    // for two hands at arm's length — it more than halves the work versus
    // 640×480 before a single landmark is computed.
    const wanted = want || (IS_MOBILE
      ? { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 60 } });
    // With an explicit device, ask for the resolution too — an external webcam
    // left to its own devices will happily hand back 1080p, which is inference
    // time spent on detail the model immediately throws away.
    const attempts = deviceId
      ? [{ video: { deviceId: { exact: deviceId }, ...wanted } },
         { video: { deviceId: { exact: deviceId } } }, { video: true }]
      : [{ video: { facingMode: 'user', ...wanted } }, { video: { ...wanted } }, { video: true }];
    let err = null;
    for (const c of attempts) {
      try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, ...c }); err = null; break; }
      catch (e) { err = e; if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; }
    }
    if (err) {
      const map = { NotAllowedError: 'denied', SecurityError: 'denied', NotFoundError: 'none',
        OverconstrainedError: 'none', DevicesNotFoundError: 'none',
        NotReadableError: 'busy', TrackStartError: 'busy', AbortError: 'busy' };
      throw Object.assign(err, { kind: map[err.name] || 'unknown' });
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await this.settled();
    return this.stream;
  }

  /**
   * Wait until the element actually reports the *new* stream's dimensions.
   *
   * The old check was `if (!videoWidth) wait`, which is right for the first
   * camera and wrong for every switch after it: the element keeps reporting the
   * previous camera's size until the new metadata lands, so the wait was
   * skipped and the caller went on to size the stage from dimensions belonging
   * to a camera that is no longer running. With `object-fit: cover` the feed is
   * then cropped, and every landmark is drawn somewhere the hand isn't —
   * which is exactly what switching cameras looked like.
   *
   * The track knows its own size immediately, so that is what we wait to see
   * reflected. Two cameras with identical dimensions need no wait at all.
   */
  async settled(timeout = 2500) {
    const want = this.stream?.getVideoTracks?.()[0]?.getSettings?.() || {};
    const ready = () => this.video.videoWidth > 0
      && (!want.width || Math.abs(this.video.videoWidth - want.width) <= 1);
    if (ready()) return;
    await new Promise((res) => {
      const stop = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', check);
        this.video.removeEventListener('resize', check);
        res();
      };
      const check = () => { if (ready()) stop(); };
      const timer = setTimeout(stop, timeout);   // never hang on a shy device
      this.video.addEventListener('loadedmetadata', check);
      this.video.addEventListener('resize', check);
    });
  }

  /**
   * Last-resort throughput lever: shrink the live stream.
   *
   * The CPU delegate is already the floor for *how* we infer, so when it is
   * still slow the only thing left is to give it less to chew on. Runs once —
   * `applyConstraints` renegotiates the track and briefly stutters the feed,
   * which is worth paying a single time and never in a loop.
   *
   * The shrink must preserve the frame's *shape*. Ask for a flat 480×360 and a
   * camera whose nearest small mode is 640×360 will happily hand back a
   * different aspect ratio; the stage box then no longer matches the frame,
   * `object-fit: cover` starts cropping, and every drawn hand slides away from
   * the real one. So scale the current dimensions and pin the ratio, and let
   * `syncStage` catch it anyway if the driver ignores us.
   */
  async shrink(scale = 0.75) {
    if (this._shrunk || !this.stream) return false;
    const track = this.stream.getVideoTracks()[0];
    if (!track) return false;
    this._shrunk = true;
    const s = track.getSettings?.() || {};
    if (!s.width || !s.height) return false;
    const width = Math.max(320, Math.round((s.width * scale) / 2) * 2);
    const height = Math.round(width * (s.height / s.width) / 2) * 2;
    try {
      await track.applyConstraints({
        width: { ideal: width }, height: { ideal: height },
        aspectRatio: { ideal: s.width / s.height },
        frameRate: { ideal: 24 },
      });
      console.warn(`[air-guitar] tracking still slow — dropped the camera to ${width}×${height}`);
      return true;
    } catch { return false; }
  }

  async devices() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch { return []; }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
