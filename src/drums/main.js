/** main.js — wiring: camera → tracking → contact detection → drums → audio + UI. */
import { Tracker, Camera } from '../tracking.js';
import { StickDetector } from './onset.js';
import { stickFrom, fingerFrom, STICK, FINGER, LENGTH } from './stick.js';
import { Kit } from './kit.js';
import { DrumEngine, LOOKAHEAD } from './audio.js';
import { Overlay, HAND_COL } from './render.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const el = {
  stage: $('stage'), video: $('video'), canvas: $('overlay'),
  veil: $('veil'), veilCard: $('veilCard'),
  pCam: $('pillCam'), pHands: $('pillHands'), pPerf: $('pillPerf'),
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

/* Detection rate is most of the latency — a stroke cannot be heard before the
 * frame that shows the tip through the drum — so the tracker gets nearly all of
 * the wall clock. Not *all* of it, which is the change: at a duty of 1 the main
 * thread never leaves MediaPipe, painting gets whatever is left over, and the
 * sticks stutter along at the tracking rate. The last tenth buys a steady 60fps
 * canvas, and the frame loop interpolates across the gap between looks (see
 * `frame`), so the small loss of detections costs far less than it returns. */
tracker.duty = 0.9;
const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } };

/**
 * How long after the moment of contact a hit is scheduled to sound.
 *
 * Not latency for its own sake — a *budget*, and the difference matters. The
 * detector knows when the tip crossed the head to well inside a frame, but
 * that instant has usually just passed by the time the frame is handled, and by
 * a different amount every time. Playing each hit immediately therefore smears
 * a steady roll by however irregularly the tracker happened to look. Holding a
 * couple of dozen milliseconds in hand lets every hit be placed at its true
 * moment instead. Constant latency is something a player adapts to in seconds;
 * jitter is something nobody ever adapts to.
 */
const WINDOW = 0.022;

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
let hands = [], handsSeq = 0, handsAt = 0;
function pump() {
  const step = () => {
    if (S.running && !document.hidden && tracker.due()) {
      hands = tracker.detect(el.video, performance.now());
      // Stamp the landmarks with when they were *captured*: handing the
      // detector a render timestamp measures the wrong interval entirely and
      // corrupts every velocity. See the note in the piano's frame loop.
      handsAt = performance.now() / 1000;
      handsSeq++;
    }
    schedule();
  };
  const schedule = () => {
    if (el.video.requestVideoFrameCallback) el.video.requestVideoFrameCallback(step);
    else setTimeout(step, 16);
  };
  schedule();
}

/* ---------------- frame loop ---------------- */
let fps = 60, lastF = performance.now(), tick = 0, lastSeq = -1, rate = 0, live = [];

/**
 * Critically damped follower — the standard implicit spring, which is stable at
 * any step size and cannot overshoot.
 *
 * This is what makes the sticks look like objects rather than like tracking
 * data. Landmarks arrive whenever inference finishes, which on a laptop is
 * twenty-something times a second and never evenly; the canvas paints sixty
 * times a second. Drawing the latest sample means the stick stands still and
 * then jumps, and the eye reads that as the *instrument* being slow even when
 * the detection underneath is fine. A spring keeps moving between samples, so
 * what you see is continuous motion.
 *
 * It costs a few milliseconds of visual lag and buys none of it back in
 * timing: contact is measured off the raw tip, and the flashes are scheduled
 * against the audio clock, so neither goes anywhere near this.
 */
function spring(p, v, target, tau, dt) {
  const w = 1 / Math.max(tau, 1e-4);
  const f = 1 + 2 * dt * w;
  const oo = w * w, hoo = dt * oo, hhoo = dt * hoo;
  const det = 1 / (f + hhoo);
  return [(f * p + dt * v + hhoo * target) * det, (v + hoo * (target - p)) * det];
}
const FOLLOW = 0.038;   // s for the drawn stick to settle onto the tracked one

/* Per-hand display state: where the drawn stick has got to, how far it has been
 * raised, and how fast the tip is travelling for the trail. Kept here rather
 * than in the detector because all of it is cosmetic. */
const look = new Map();

function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now(), t = nowMs / 1000;
  const dt = clamp((nowMs - lastF) / 1000, 0.001, 0.1);
  fps = fps * 0.93 + (1 / dt) * 0.07; lastF = nowMs;

  // Detection-rate driven: feeding the detector the same landmarks twice would
  // read as zero motion and flatten every stroke.
  if (S.running && handsSeq !== lastSeq) {
    lastSeq = handsSeq;
    live = identify(hands);
    for (const ev of detector.update(live.map((h) => ({ id: h.id, lm: h.lm, world: h.world })), handsAt)) strike(ev);
  }

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
      L = { hold: 0, speed: 0, vel: { x: 0, y: 0 }, prev: null,
            x: st.grip.x, y: st.grip.y, vx: 0, vy: 0,
            ax: st.axis.x, ay: st.axis.y, dax: 0, day: 0, span: st.span };
      look.set(h.id, L);
    }
    let drawn;
    if (S.mode === STICK) {
      [L.x, L.vx] = spring(L.x, L.vx, st.grip.x, FOLLOW, dt);
      [L.y, L.vy] = spring(L.y, L.vy, st.grip.y, FOLLOW, dt);
      // The axis is sprung as a vector rather than as an angle: the stick can
      // point anywhere, and an angle would have to be unwrapped at every turn.
      [L.ax, L.dax] = spring(L.ax, L.dax, st.axis.x, FOLLOW * 1.4, dt);
      [L.ay, L.day] = spring(L.ay, L.day, st.axis.y, FOLLOW * 1.4, dt);
      L.span += (st.span - L.span) * (1 - Math.exp(-dt / 0.12));
      drawn = stickFrom({ grip: { x: L.x, y: L.y }, axis: { x: L.ax, y: L.ay, conf: st.conf }, span: L.span }, S.reach);
    } else {
      /* A fingertip is drawn exactly where the tracker says it is. The spring
       * exists because a *derived* pose stutters between looks at the hands;
       * a landmark does too, but smoothing it would move the striking point
       * away from the one the detector is using, and on the tip of the finger
       * you are aiming with that is worse than a little stutter. */
      drawn = fingerFrom(h.lm, st.span);
    }

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

  if (++tick % 20 === 0) {
    rate = tracker.emaMs > 0 ? Math.min(1000 / tracker.emaMs * tracker.duty, 60) : 0;
    el.pPerf.textContent = `${Math.round(fps)} fps · track ${rate.toFixed(0)}/s · ${tracker.emaMs.toFixed(0)} ms ${tracker.delegate.toLowerCase()}`;
    el.pPerf.classList.toggle('bad', rate > 0 && rate < 20);
    if (el.lat) {
      /* Be honest about where the delay comes from. Contact is caught on the
       * frame it happens rather than after the stroke has finished, so the
       * tracking share is now the average wait for the *next* look — half a
       * sample interval — rather than a whole stroke's braking distance. */
      const detect = rate > 0 ? 500 / rate : 0;
      el.lat.innerHTML = rate === 0 ? '—'
        : `≈<b>${Math.round(detect + (WINDOW + LOOKAHEAD) * 1000)} ms</b> · ${Math.round(detect)} tracking + ${Math.round((WINDOW + LOOKAHEAD) * 1000)} audio`
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
