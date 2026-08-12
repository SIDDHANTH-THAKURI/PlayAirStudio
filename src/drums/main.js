/** main.js — wiring: camera → tracking → stroke detection → drums → audio + UI. */
import { Tracker, Camera } from '../tracking.js';
import { StickDetector } from './onset.js';
import { StickFilter, LENGTH } from './stick.js';
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
/* v2: the kit moved and the stick lengths changed, so a stored v1 setting
 * would describe a layout that no longer exists. */
const KEY = 'air-drums.v2';
const DEFAULTS = {
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

/* Detection rate *is* the latency, exactly as in the piano — a stroke cannot be
 * heard before the frame that shows the stick stopping — so the same tradeoffs
 * apply: no duty-cycle throttle, and a deliberately modest camera, because
 * inference cost tracks the source frame and MediaPipe downsamples hard
 * internally anyway.
 *
 * Drums are the least forgiving instrument here about this. A guitar strum has
 * internal spread to hide behind and a piano note blooms; a drum is nothing but
 * its attack, so timing error is the only thing you hear. */
tracker.duty = 1;
const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } };

let kit = new Kit({ scale: S.size, lefty: S.lefty });
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
 * Turn a detected stroke into a drum.
 *
 * Two pads answer to *where on them* they were struck, which is the only
 * expression a real kit gets from position and is worth having:
 *
 *  • **Hi-hat** — the top of the pad is the open hat, the bottom the closed
 *    one. There is no foot pedal to work with, and asking for a second gesture
 *    to hold the hats open would occupy a hand that is busy playing. The pad is
 *    drawn as two discs so the split is visible rather than folklore.
 *  • **Ride** — the middle is the bell, the outside is the bow, which is
 *    exactly where they are on a real cymbal.
 */
function strike(ev) {
  const pad = kit.hitAt(ev);
  if (!pad) return;

  let voice = pad.voice, tone;
  // Offsets across and up the pad, −1…1, from where the tip actually landed.
  const ox = clamp((ev.x - pad.x) / pad.rx, -1, 1);
  const oy = clamp((ev.y - pad.y) / pad.ry, -1, 1);
  if (pad.id === 'hihat' && oy < -0.15) voice = 'hihatOpen';
  if (pad.id === 'ride') tone = clamp(1 - Math.hypot(ox, oy) / 0.75, 0, 1);

  const at = drums.hit(voice, ev.velocity, { pan: ox, tone });
  overlay.onHit({
    pad: pad.id, x: ev.x, y: ev.y, hand: ev.id, velocity: ev.velocity,
    at: at ?? drums.now(), dir: detector.dir, open: voice === 'hihatOpen',
  });

  const name = voice === 'hihatOpen' ? 'Hi-hat open'
    : pad.id === 'ride' && tone > 0.55 ? 'Ride bell' : pad.label;
  el.hit.textContent = name;
  el.hit.style.color = HAND_COL[ev.id] || '';
  el.hitSub.textContent = `${ev.id} hand · ${Math.round(ev.velocity * 100)}%`;
  lastHitAt = performance.now();
}

/* ---------------- controls ---------------- */
function initControls() {
  const seg = (id, get, set) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...e.currentTarget.children].forEach((c) => c.classList.toggle('on', c === b));
      set(b.dataset.v);
    });
    [...$(id).children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  };
  const rebuild = () => { kit = new Kit({ scale: S.size, lefty: S.lefty }); };
  seg('segSize', () => S.size, (v) => { S.size = +v; rebuild(); persist(); });
  seg('segHand', () => (S.lefty ? 'left' : 'right'), (v) => { S.lefty = v === 'left'; rebuild(); persist(); });
  seg('segReach', () => S.reach, (v) => { S.reach = +v; detector.setReach(S.reach); persist(); });

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
  el.veilCard.innerHTML = `<h2>Point, and you're holding a stick</h2>
    <p>${msg || 'Sit back far enough that the camera can see both hands moving freely. Nothing is recorded and nothing leaves this tab.'}</p>
    <p><b>Point your index finger</b> and a drumstick appears along it — one in each hand. Swing at a drum and stop; that stop is the hit, and how fast you were going is how hard it lands.</p>
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
/* Per-hand display state. Kept here rather than in the detector because it is
 * purely cosmetic — how far the stick has been raised, and how fast the tip is
 * travelling for the trail — and the detector has no business knowing about
 * either. */
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
    for (const ev of detector.update(live.map((h) => ({ id: h.id, lm: h.lm })), handsAt)) strike(ev);
  }

  const sticks = [];
  const seen = new Set();
  for (const h of live) {
    let L = look.get(h.id);
    /* Lightly smoothed — a tenth of the detector's, because this stick has to
     * stay visibly glued to the finger it is drawn on, and lag there reads as
     * the stick coming loose. It only needs to take the shimmer off. */
    if (!L) { L = { hold: 0, speed: 0, vel: { x: 0, y: 0 }, prev: null, filter: new StickFilter(0.012) }; look.set(h.id, L); }
    const st = L.filter.update(h.lm, S.reach, dt);
    if (!st) continue;
    seen.add(h.id);

    // Picking a stick up and putting it down is eased rather than switched, so
    // it reads as a movement instead of a graphic appearing.
    const want = detector.state(h.id)?.holding ? 1 : 0;
    L.hold += (want - L.hold) * (1 - Math.exp(-dt / (want ? 0.07 : 0.14)));
    if (L.prev) {
      L.vel = { x: st.tip.x - L.prev.x, y: st.tip.y - L.prev.y };
      L.speed = L.speed * 0.6 + (Math.hypot(L.vel.x, L.vel.y) / st.span / dt) * 0.4;
    }
    L.prev = { x: st.tip.x, y: st.tip.y };
    // Which drum this stick is over, so the kit can say so before it is hit.
    sticks.push({ id: h.id, stick: st, hold: L.hold, speed: L.speed, vel: L.vel,
                  over: kit.hitAt(st.tip)?.id || null });
  }
  for (const id of look.keys()) if (!seen.has(id)) look.delete(id);

  const holding = sticks.some((s) => s.hold > 0.5);
  overlay.draw({
    now: drums.ready ? drums.now() : t, dt,
    pads: kit.pads(), sticks, labels: S.labels,
    armed: S.running && holding,
    hint: !S.running ? 'Press start'
      : live.length ? 'Point your index finger to pick up a stick' : 'Show me your hands',
  });

  if (++tick % 20 === 0) {
    rate = tracker.emaMs > 0 ? Math.min(1000 / tracker.emaMs * tracker.duty, 60) : 0;
    el.pPerf.textContent = `${Math.round(fps)} fps · track ${rate.toFixed(0)}/s · ${tracker.emaMs.toFixed(0)} ms ${tracker.delegate.toLowerCase()}`;
    el.pPerf.classList.toggle('bad', rate > 0 && rate < 20);
    if (el.lat) {
      // Be honest about where the delay comes from. A stroke cannot be detected
      // before the frame that shows the stick stopping, so one sample interval
      // is the floor and it dwarfs everything the audio path adds.
      const detect = rate > 0 ? 1000 / rate : 0;
      el.lat.innerHTML = rate === 0 ? '—'
        : `≈<b>${Math.round(detect + LOOKAHEAD * 1000)} ms</b> · ${Math.round(detect)} tracking + ${Math.round(LOOKAHEAD * 1000)} audio`
          + (tracker.delegate === 'CPU' ? ' · <span class="warn">GPU off — see How to play</span>' : '');
    }
    if (stageDrifted()) syncStage();
    overlay.resize();   // no-op unless the canvas actually moved
    if (S.running) {
      const n = live.length;
      setPill(el.pHands, holding ? 'ok' : n ? 'warn' : 'bad',
        holding ? (sticks.filter((s) => s.hold > 0.5).length === 2 ? 'both sticks' : 'one stick')
          : n ? 'not pointing' : 'no hands');
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
