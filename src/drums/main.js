/** main.js — wiring: camera → tracking → contact detection → drums → audio + UI. */
import { Tracker, Camera } from '../tracking.js';
import { StickDetector } from './onset.js';
import { STICK, FINGER, LENGTH, BUTT } from './stick.js';
import { Kit } from './kit.js';
import { DrumEngine, LOOKAHEAD } from './audio.js';
import { Overlay, HAND_COL } from './render.js';
import { FaceVeil, faceHidden, setFaceHidden, onFaceHiddenChange } from '../privacy.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const el = {
  stage: $('stage'), video: $('video'), canvas: $('overlay'),
  veil: $('veil'), veilCard: $('veilCard'),
  pCam: $('pillCam'), pHands: $('pillHands'), pPerf: $('pillPerf'),
  pFace: $('pillFace'), pFaceLabel: $('pillFaceLabel'),
  hit: $('lastHit'), hitSub: $('lastHitSub'),
  camRow: $('camRow'), selCam: $('selCam'), lat: $('latNote'),
};

/* ---------------- persisted state ---------------- */
/* v4: there are two ways to play now, and the sticks changed shape again, so a
 * stored v3 setting describes an instrument that no longer exists. */
const KEY = 'air-drums.v4';
const DEFAULTS = {
  /* Fingertip by default. A stick has to have its direction *inferred* from the
   * hand, and every way of doing that is a projection that degrades as the hand
   * turns; a fingertip is a landmark the tracker hands over directly. The
   * sticks look better and the fingertip plays better, and playing wins. */
  mode: FINGER,
  size: 1, lefty: false, reach: LENGTH,
  vol: 0.8, room: 0.22, labels: true, camId: '',
};
function load() {
  const S = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) S[k] = raw[k];
    }
  } catch {}
  if (S.mode !== STICK && S.mode !== FINGER) S.mode = FINGER;
  return S;
}
let saveT = 0;
const persist = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }, 250);
};

const S = load();
S.running = false;

/* ---------------- engine ---------------- */
const tracker = new Tracker(), camera = new Camera(el.video);
const detector = new StickDetector();
const drums = new DrumEngine();
const overlay = new Overlay(el.canvas);

/* Face blur — free until switched on; see src/privacy.js. */
const faceVeil = new FaceVeil(el.video, el.stage);
function paintFacePriv() {
  const on = faceHidden();
  el.pFace?.setAttribute('aria-pressed', String(on));
  if (el.pFaceLabel) el.pFaceLabel.textContent = on ? 'face hidden' : 'face visible';
  if (el.pFace) el.pFace.title = on ? 'Show my face again' : 'Blur my face in the camera view';
}
el.pFace?.addEventListener('click', () => setFaceHidden(!faceHidden()));
onFaceHiddenChange((on) => { faceVeil.set(on); paintFacePriv(); });
faceVeil.set(faceHidden());
paintFacePriv();

/* Detection rate is most of the latency — a stroke cannot be heard before the
 * frame that shows the tip through the drum — so the tracker gets nearly all of
 * the wall clock. Not *all* of it: the pump is driven by the camera through
 * `requestVideoFrameCallback`, which paces inference to one frame in and makes
 * this all but non-binding, but browsers without it fall back to a timer, and
 * there a duty of 1 means the main thread never leaves MediaPipe and there is
 * nothing left to paint with. The frame loop extrapolates across the gap
 * between looks (see `frame`), so the tenth given up here is not visible. */
tracker.duty = 0.9;
const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } };

/**
 * How long after the moment of contact a hit is scheduled to sound.
 *
 * A *budget*, not latency for its own sake: the detector knows when the tip
 * crossed the head to well inside a frame, so if the hit can be handed to the
 * audio clock before that instant plus this, it lands at a fixed offset from
 * the stroke however irregularly the tracker happened to look.
 *
 * It used to be 22 ms on the argument that jitter is worse than latency, which
 * is true and was the wrong number twice over. Most of the jitter it was aimed
 * at is the *sampling* grid — up to a whole frame interval of it — and
 * interpolating the crossing between two samples (`onset.js`) already removes
 * that. What is left is delivery: inference, and the wait for the frame to be
 * handled, which measured 11–30 ms in a browser at 20 looks a second. So 22 ms
 * of budget was mostly spent before it could be used — measured, an average of
 * 5.6 ms of it actually reached the audio clock — while costing the full 22 ms
 * on any machine fast enough to arrive early. What is left here covers the
 * delivery jitter that a budget can still absorb, and nothing more.
 */
const WINDOW = 0.010;

let kit = new Kit({ scale: S.size, lefty: S.lefty });
detector.setKit(kit);
detector.setMode(S.mode);
detector.setReach(S.reach);

/* ---------------- hand identity ----------------
 * Which hand is which decides only colour and stereo placement, but it has to
 * be stable or the two sticks swap sides mid-fill. MediaPipe's handedness is
 * reliable; what is *not* reliable is assuming which way round its labels mean,
 * since that depends on whether the pipeline mirrored the frame. So the meaning
 * is locked by observation, as in the piano — see the long note there. */
const roleOf = new Map();

function identify(hands) {
  if (!hands.length) return [];
  const labelled = hands.filter((h) => h.label && (h.score ?? 0) > 0.6);
  if (labelled.length === 2 && labelled[0].label !== labelled[1].label) {
    const [a, b] = [...labelled].sort((p, q) => p.x - q.x);
    roleOf.set(a.label, 'left');
    roleOf.set(b.label, 'right');
  }
  const out = hands.map((h) => {
    const known = h.label && roleOf.get(h.label);
    if (known) return { ...h, id: known };
    const guess = h.x < 0.5 ? 'left' : 'right';
    if (h.label && (h.score ?? 0) > 0.6) roleOf.set(h.label, guess);
    return { ...h, id: guess };
  });
  // Two hands sharing an id would share one slot of detector state and stamp on
  // each other's history, so force them apart by position: being wrong about
  // which is which costs a colour, colliding costs both hands their detection.
  if (out.length === 2 && out[0].id === out[1].id) {
    const [a, b] = [...out].sort((p, q) => p.x - q.x);
    a.id = 'left'; b.id = 'right';
  }
  return out;
}

/* ---------------- strokes ---------------- */
let lastHitAt = 0;

/**
 * Turn a detected contact into a drum.
 *
 * Two pads answer to *where across them* they were struck, which is the only
 * expression a real kit gets from position and is worth having. It has to be
 * across rather than up-and-down now: a stroke comes down through the surface,
 * so it always arrives at the top of the head and the vertical offset carries
 * no information at all. Sideways, it carries plenty.
 *
 *  • **Hi-hat** — through the middle is the closed hat, out at the edge is the
 *    open one. There is no foot pedal to work with, and asking for a second
 *    gesture to hold the hats open would occupy a hand that is busy playing.
 *  • **Ride** — the middle is the bell, the outside is the bow, which is
 *    exactly where they are on a real cymbal.
 */
function strike(ev) {
  const pad = kit.byId(ev.pad);
  if (!pad) return;

  const ox = ev.ox;
  let voice = pad.voice, tone;
  if (pad.id === 'hihat' && Math.abs(ox) > 0.55) voice = 'hihatOpen';
  if (pad.id === 'ride') tone = clamp(1 - Math.abs(ox) / 0.55, 0, 1);

  // Place it at the moment of contact plus the window, so long as that moment
  // has not already gone past — see WINDOW. When the tracker is slow the budget
  // is simply spent and the hit goes out as soon as it can.
  const lag = performance.now() / 1000 - ev.t;
  const when = drums.ready ? drums.now() + Math.max(LOOKAHEAD, WINDOW - lag) : null;

  const at = drums.hit(voice, ev.velocity, { when, pan: ox, tone });
  const m = Math.hypot(ev.vx, ev.vy) || 1;
  overlay.onHit({
    pad: pad.id, x: ev.x, y: ev.y, hand: ev.id, velocity: ev.velocity,
    at: at ?? drums.now(), dir: { x: ev.vx / m, y: ev.vy / m }, open: voice === 'hihatOpen',
  });

  const name = voice === 'hihatOpen' ? 'Hi-hat open'
    : pad.id === 'ride' && tone > 0.55 ? 'Ride bell' : pad.label;
  el.hit.textContent = name;
  el.hit.style.color = HAND_COL[ev.id] || '';
  el.hitSub.textContent = `${ev.id} hand · ${Math.round(ev.velocity * 100)}%`;
  lastHitAt = performance.now();
}

/* ---------------- controls ---------------- */
/** Stick length is meaningless without a stick, so it goes away with one. */
function paintMode() {
  const row = $('reachRow');
  if (row) row.hidden = S.mode !== STICK;
}

function initControls() {
  const seg = (id, get, set) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...e.currentTarget.children].forEach((c) => c.classList.toggle('on', c === b));
      set(b.dataset.v);
    });
    [...$(id).children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  };
  const rebuild = () => {
    kit = new Kit({ scale: S.size, lefty: S.lefty });
    detector.setKit(kit);
  };
  seg('segMode', () => S.mode, (v) => {
    S.mode = v; detector.setMode(v); detector.setReach(S.reach);
    look.clear(); paintMode(); persist();
  });
  seg('segSize', () => S.size, (v) => { S.size = +v; rebuild(); persist(); });
  seg('segHand', () => (S.lefty ? 'left' : 'right'), (v) => { S.lefty = v === 'left'; rebuild(); persist(); });
  seg('segReach', () => S.reach, (v) => { S.reach = +v; detector.setReach(S.reach); persist(); });
  paintMode();

  const rng = (id, out, get, set) => {
    $(id).value = Math.round(get() * 100);
    if (out) $(out).value = Math.round(get() * 100);
    $(id).oninput = (e) => { const v = e.target.value / 100; if (out) $(out).value = e.target.value; set(v); persist(); };
  };
  rng('rngVol', 'outVol', () => S.vol, (v) => { S.vol = v; drums.ready && drums.setVolume(v); });
  rng('rngRoom', 'outRoom', () => S.room, (v) => { S.room = v; drums.ready && drums.setRoom(v); });

  el.selCam.onchange = (e) => switchCamera(e.target.value);
  $('chkLabels').checked = S.labels;
  $('chkLabels').onchange = (e) => { S.labels = e.target.checked; persist(); };
  $('helpBtn').onclick = () => ($('helpModal').hidden = false);
  $('helpClose').onclick = () => ($('helpModal').hidden = true);
  $('helpModal').onclick = (e) => { if (e.target === $('helpModal')) $('helpModal').hidden = true; };
}

/* ---------------- veil ---------------- */
function showStart(msg) {
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<h2>Point a finger and play</h2>
    <p>${msg || 'Sit back far enough that the camera can see both hands moving freely. Nothing is recorded and nothing leaves this tab.'}</p>
    <p><b>Point one index finger in each hand</b>, the other fingers tucked in, and the fingertip is what
    strikes. Bring it down <b>through</b> a drum and it sounds, right as the tip goes through the head.
    Prefer drumsticks? Switch to them under <b>Play with</b>.</p>
    <div class="veil-actions"><button class="btn" id="go">Start playing</button></div>
    <p class="veil-hint">No setting up — the kit is already where it needs to be.</p>`;
  $('go').onclick = boot;
}
function showBusy(t) {
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<div class="spinner"></div><h2>${t}</h2><p>One moment.</p>`;
}
const ERRORS = {
  denied: ['Camera permission was blocked', 'Click the camera icon in your address bar, allow this page, then try again.'],
  none: ['No camera found', 'Plug one in, then try again.'],
  busy: ['The camera is in use', 'Another app has it. Close that app and try again.'],
  insecure: ['Needs a secure page', 'Cameras are only available over <b>https://</b> or <b>localhost</b>.'],
  unsupported: ['This browser can\'t open a camera', 'Try a recent Chrome, Edge or Safari.'],
  model: ['Couldn\'t load the hand-tracking model', 'It comes from a CDN on first run — check your connection, then retry.'],
  unknown: ['Couldn\'t start the camera', 'Something went wrong opening the video device.'],
};
function showError(kind, detail) {
  const [h, p] = ERRORS[kind] || ERRORS.unknown;
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<h2>${h}</h2><p>${p}</p>${detail ? `<p class="err">${detail}</p>` : ''}
    <div class="veil-actions"><button class="btn" id="go">Try again</button></div>`;
  $('go').onclick = boot;
  setPill(el.pCam, 'bad', 'camera error');
}
const setPill = (p, cls, text) => { p.className = 'pill ' + cls; p.innerHTML = `<i class="dot"></i>${text}`; };

/* ---------------- cameras ---------------- */
async function fillCameras() {
  let devs = [];
  try { devs = await camera.devices(); } catch {}
  if (devs.length < 2) { el.camRow.hidden = true; return; }
  el.camRow.hidden = false;
  const current = camera.stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId || S.camId;
  el.selCam.innerHTML = devs.map((d, i) =>
    `<option value="${d.deviceId}"${d.deviceId === current ? ' selected' : ''}>${d.label || `Camera ${i + 1}`}</option>`).join('');
}
try { navigator.mediaDevices?.addEventListener?.('devicechange', () => fillCameras()); } catch {}

async function switchCamera(id) {
  S.camId = id; persist();
  try {
    showBusy('Switching camera');
    await camera.start(id || undefined, VIDEO);
    // Wait for the element to actually report the *new* camera's size. Without
    // this the old dimensions are still on the element and the stage is shaped
    // to a camera that is no longer connected — which is exactly the
    // displacement people reported after switching. See Camera.settled().
    await camera.settled();
    syncStage();
    el.veil.hidden = true;
    setPill(el.pCam, 'ok', 'camera live');
    detector.reset();
  } catch (e) { showError(e.kind || 'unknown', e.name); }
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    showBusy('Warming up the kit');
    if (!drums.ready) await drums.init();
    drums.setVolume(S.vol); drums.setRoom(S.room);
  } catch (e) { return showError('unknown', e.message); }

  try {
    showBusy('Opening your camera');
    await camera.start(S.camId || undefined, VIDEO);
    await camera.settled();
    setPill(el.pCam, 'ok', 'camera live');
    fillCameras();
  } catch (e) { return showError(e.kind || 'unknown', e.name); }

  try { showBusy('Loading hand tracking'); await tracker.preload(); }
  catch (e) { return showError('model', e.message); }

  syncStage();
  el.veil.hidden = true;
  S.running = true;
  pump();
}

/**
 * Keep the stage box the same shape as the camera frame.
 *
 * The video is `object-fit: cover` and the overlay maps normalised landmarks
 * onto the displayed box, so any mismatch crops the feed and slides the whole
 * kit away from the hands it belongs to. A live stream can change shape
 * underneath you and `resize` is not guaranteed to fire for every case, so the
 * frame loop re-checks cheaply as a safety net.
 */
function syncStage() {
  const ar = el.video.videoWidth / el.video.videoHeight;
  if (ar > 0.2) el.stage.style.aspectRatio = String(ar);
  overlay.resize();
}
function stageDrifted() {
  const vr = el.video.videoWidth / el.video.videoHeight;
  const br = el.stage.clientWidth / el.stage.clientHeight;
  return vr > 0.2 && br > 0 && Math.abs(vr - br) / vr > 0.02;
}
el.video.addEventListener('resize', syncStage);
addEventListener('resize', () => overlay.resize());
/* Watch the box rather than guessing which events imply it moved — a window
 * resize is only one of the ways it changes, and every other one silently
 * misplaces the whole kit if the overlay's cached size lags. */
if (window.ResizeObserver) new ResizeObserver(() => overlay.resize()).observe(el.stage);

/* ---------------- detection pump ---------------- */
let hands = [], handsSeq = 0, handsAt = 0, looks = 0, looksAt = 0, looksRate = 0;

/**
 * When the camera actually took this frame.
 *
 * This was `performance.now()` sampled *after* `detect()` returned, which is a
 * whole inference late — 18 ms on a middling laptop, and a different 18 ms
 * every frame. Every velocity was measured over a slightly wrong interval, and
 * worse, the moment of contact the audio clock was handed was that far in the
 * past before the hit was even computed, so the scheduling budget below was
 * being spent on bookkeeping error rather than on jitter.
 *
 * `requestVideoFrameCallback` hands over the frame's own capture time in the
 * same clock as `performance.now()`, which is the honest answer. Believe it
 * only if it looks like that clock: a stamp from the future or from a quarter
 * of a second ago is a driver reporting something else entirely, and a wrong
 * timestamp is far more damaging than a slightly late one.
 */
function frameTime(meta, now) {
  const t = meta?.captureTime ?? meta?.presentationTime;
  return typeof t === 'number' && t <= now + 1 && now - t < 250 ? t : now;
}

function pump() {
  const step = (nowMs, meta) => {
    const now = typeof nowMs === 'number' ? nowMs : performance.now();
    if (S.running && !document.hidden && tracker.due()) {
      const cap = frameTime(meta, now);
      hands = tracker.detect(el.video, cap);
      handsAt = cap / 1000;
      handsSeq++;
      looks++;
      // Detect and strike in the same turn. Handing the landmarks to the frame
      // loop instead put a whole rAF between seeing a stroke and sounding it,
      // and dropped the sample outright whenever two looks fell inside one
      // paint — a lost sample being a lost stroke, silently.
      consume();
    }
    schedule();
  };
  const schedule = () => {
    if (el.video.requestVideoFrameCallback) el.video.requestVideoFrameCallback(step);
    else setTimeout(step, 16);
  };
  schedule();
}

let lastSeq = -1, live = [];
function consume() {
  if (handsSeq === lastSeq) return;
  lastSeq = handsSeq;
  live = identify(hands);
  for (const ev of detector.update(live.map((h) => ({ id: h.id, lm: h.lm, world: h.world })), handsAt)) strike(ev);
}

/* ---------------- frame loop ---------------- */
let fps = 60, lastF = performance.now(), tick = 0, rate = 0;

/**
 * Critically damped follower — the standard implicit spring, which is stable at
 * any step size and cannot overshoot.
 */
function spring(p, v, target, tau, dt) {
  const w = 1 / Math.max(tau, 1e-4);
  const f = 1 + 2 * dt * w;
  const oo = w * w, hoo = dt * oo, hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  return [(f * p + dt * v + hhoo * target) * det, (v + hoo * (target - p)) * det];
}

/**
 * How the drawn stick keeps up with the tracked one — and why it is not simply
 * sprung at it.
 *
 * The problem is real: landmarks arrive whenever inference finishes, twenty-odd
 * times a second and never evenly, while the canvas paints sixty times a
 * second. Drawing the newest sample means the stick stands still and then
 * jumps, and the eye reads that as the *instrument* being slow even when the
 * detection underneath is fine.
 *
 * A spring fixes the stutter and introduces something worse. A critically
 * damped one settles behind a moving target by `2·tau` — at the 38 ms this used
 * to run at, that is 76 ms of lag on the position and 106 ms on the angle,
 * during a gesture whose whole point is a fast wrist flick. So the stick on
 * screen was three or four frames behind the tip that was actually striking
 * drums: hits fired while the drawn stick was still visibly above the head. On
 * an air instrument the drawn stick *is* the instrument, and that reads exactly
 * as "it doesn't move with my hand".
 *
 * So: **extrapolate rather than lag**. The last two detector poses give a
 * velocity; the drawn pose is that carried forward to now — which is what the
 * hand is doing between looks, not where it was at the last one. The spring
 * stays, at a fraction of the time constant, purely to take the corner off each
 * new sample, and the target is led by its own settling time so the two cancel.
 * Net lag against the tracked tip is about zero instead of 76 ms.
 *
 * None of it touches timing: contact is measured off the raw tip in the pump,
 * and flashes are scheduled against the audio clock.
 */
const FOLLOW = 0.014;          // s of smoothing on the drawn pose…
const LEAD = 2 * FOLLOW;       // …and the lead that cancels its lag
const COAST = 1.8;             // sample intervals the extrapolation may run for

/** Carry a point forward past `b` by `k` of the interval that got it there. */
const coast = (a, b, k) => ({ x: b.x + (b.x - a.x) * k, y: b.y + (b.y - a.y) * k });

/* Per-hand display state: where the drawn stick has got to, how far it has been
 * raised, and how fast the tip is travelling for the trail. Kept here rather
 * than in the detector because all of it is cosmetic. */
const look = new Map();

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now(), t = nowMs / 1000;
  const dt = clamp((nowMs - lastF) / 1000, 0.001, 0.1);
  fps = fps * 0.93 + (1 / dt) * 0.07; lastF = nowMs;

  const sticks = [];
  const seen = new Set();
  for (const h of live) {
    /* Drawn from the detector's own stick rather than recomputed alongside it.
     * Two filters on the same landmarks drift apart, and when they do the stick
     * you aim with is not the stick that hits — which is unplayable in a way
     * that is very hard to diagnose from the outside. */
    const A = detector.state(h.id);
    const st = A?.stick;
    if (!st) continue;
    seen.add(h.id);

    let L = look.get(h.id);
    if (!L) {
      L = { hold: 0, speed: 0, vel: { x: 0, y: 0 }, prev: null, seq: -1, p0: null, p1: null,
            gx: st.grip.x, gy: st.grip.y, gvx: 0, gvy: 0,
            tx: st.tip.x, ty: st.tip.y, tvx: 0, tvy: 0 };
      look.set(h.id, L);
    }
    /* Two poses and their stamps are all the extrapolation needs. Both come
     * from the detector, so the drawn stick is still the detector's own stick
     * and not a second opinion computed from the same landmarks — two filters
     * on one hand drift apart, and then the stick you aim with is not the stick
     * that hits. */
    if (L.seq !== handsSeq) {
      L.seq = handsSeq;
      L.p1 = L.p0 || { t: handsAt, grip: st.grip, tip: st.tip };
      L.p0 = { t: handsAt, grip: st.grip, tip: st.tip };
    }
    const gap = L.p0.t - L.p1.t;
    const k = gap > 1e-4 ? clamp((t + LEAD - L.p0.t) / gap, 0, COAST) : 0;
    const wantG = coast(L.p1.grip, L.p0.grip, k), wantT = coast(L.p1.tip, L.p0.tip, k);
    [L.gx, L.gvx] = spring(L.gx, L.gvx, wantG.x, FOLLOW, dt);
    [L.gy, L.gvy] = spring(L.gy, L.gvy, wantG.y, FOLLOW, dt);
    [L.tx, L.tvx] = spring(L.tx, L.tvx, wantT.x, FOLLOW, dt);
    [L.ty, L.tvy] = spring(L.ty, L.tvy, wantT.y, FOLLOW, dt);

    /* Rebuilt around those two points rather than re-derived from the pose, so
     * whatever the geometry did — including a stick shrinking through the
     * degenerate angle — is carried through exactly. */
    const rx = L.tx - L.gx, ry = L.ty - L.gy;
    const reach = Math.hypot(rx, ry), m = reach || 1;
    const drawn = {
      ...st, reach,
      grip: { x: L.gx, y: L.gy }, tip: { x: L.tx, y: L.ty },
      axis: { x: rx / m, y: ry / m },
      butt: st.mode === STICK
        ? { x: L.gx - (rx / m) * reach * BUTT, y: L.gy - (ry / m) * reach * BUTT }
        : { x: L.gx, y: L.gy },
    };

    // Picking a stick up and putting it down is eased rather than switched, so
    // it reads as a movement instead of a graphic appearing.
    const want = A.holding ? 1 : 0;
    L.hold += (want - L.hold) * (1 - Math.exp(-dt / (want ? 0.07 : 0.14)));
    if (L.prev) {
      L.vel = { x: drawn.tip.x - L.prev.x, y: drawn.tip.y - L.prev.y };
      L.speed = L.speed * 0.6 + (Math.hypot(L.vel.x, L.vel.y) / drawn.unit / dt) * 0.4;
    }
    L.prev = { x: drawn.tip.x, y: drawn.tip.y };

    sticks.push({
      id: h.id, stick: drawn, hold: L.hold, speed: L.speed, vel: L.vel,
      // Which drum this stick would sound, and whether it is high enough to do
      // it — both straight from the detector, so the ring on screen is a
      // promise rather than a second opinion.
      over: A.over, armed: A.ready,
    });
  }
  for (const id of look.keys()) if (!seen.has(id)) look.delete(id);

  const holding = sticks.some((s) => s.hold > 0.5);
  overlay.draw({
    now: drums.ready ? drums.now() : t, dt,
    pads: kit.pads(), sticks, labels: S.labels,
    armed: S.running && holding,
    hint: !S.running ? 'Press start'
      : !live.length ? 'Show me your hands'
        : S.mode === STICK ? 'Close your hands to pick up the sticks'
          : 'Point one index finger, the others tucked in',
  });

  // Timing is the whole performance here, so the face yields to the hands.
  faceVeil.tick(nowMs, tracker.emaMs > 45);

  if (++tick % 20 === 0) {
    /* Counted, not inferred. `1000 / emaMs × duty` is how often inference
     * *could* finish; what the detector actually gets is bounded by the camera
     * on top of that, and quoting the wrong one of the two flatters the figure
     * exactly when the instrument is struggling. */
    if (looksAt) looksRate = looksRate ? looksRate * 0.7 + (looks / ((nowMs - looksAt) / 1000)) * 0.3
      : looks / ((nowMs - looksAt) / 1000);
    looksAt = nowMs; looks = 0;
    rate = looksRate;
    el.pPerf.textContent = `${Math.round(fps)} fps · track ${rate.toFixed(0)}/s · ${tracker.emaMs.toFixed(0)} ms ${tracker.delegate.toLowerCase()}`;
    el.pPerf.classList.toggle('bad', rate > 0 && rate < 20);
    if (el.lat) {
      /* Be honest about where the delay comes from, all of it. Contact is
       * caught on the frame it happens, so the tracker's share is the average
       * wait for the look that reveals the crossing — half a sample interval —
       * plus the inference that look then costs before anything can be done
       * with it. That second term was quietly missing, and it is the larger of
       * the two on a machine without a usable GPU. */
      const detect = rate > 0 ? 500 / rate + tracker.emaMs : 0;
      /* The window is a *budget*, not a delay, so quoting all of it overstates
       * the figure on every machine that spends it before it can be used —
       * which is most of them. What is actually added is whatever is left of it
       * once the stroke has waited this long to be seen. */
      const audio = Math.max(LOOKAHEAD, WINDOW - detect / 1000) * 1000;
      el.lat.innerHTML = rate === 0 ? '—'
        : `≈<b>${Math.round(detect + audio)} ms</b> · ${Math.round(detect)} tracking + ${Math.round(audio)} audio`
          + (tracker.delegate === 'CPU' ? ' · <span class="warn">GPU off — see How to play</span>' : '');
    }
    if (stageDrifted()) syncStage();
    overlay.resize();   // no-op unless the canvas actually moved
    if (S.running) {
      const n = live.length, up = sticks.filter((s) => s.hold > 0.5).length;
      const what = S.mode === STICK ? 'stick' : 'finger';
      setPill(el.pHands, holding ? 'ok' : n ? 'warn' : 'bad',
        holding ? (up === 2 ? `both ${what}s` : `one ${what}`)
          : n ? (S.mode === STICK ? 'hands open' : 'not pointing') : 'no hands');
    }
    if (nowMs - lastHitAt > 4000 && el.hit.textContent !== '—') {
      el.hit.textContent = '—'; el.hit.style.color = '';
      el.hitSub.textContent = 'swing at a drum';
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && drums.ready) drums.allOff();
});

/* ---------------- go ---------------- */
initControls();
overlay.resize();
showStart();
window.airDrums = { tracker, detector, drums, overlay, S, get kit() { return kit; } };
tracker.preload().catch(() => {});
requestAnimationFrame(frame);
