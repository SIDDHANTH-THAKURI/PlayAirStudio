/** main.js — wiring: camera → tracking → tap detection → notes → audio + UI. */
import { Tracker, Camera, IS_MOBILE, drawLead } from '../tracking.js';
import { TapDetector, FINGER_NAMES, SURFACES, FINGER_SETS } from './onset.js';
import { TablePlane, defaultQuad, quadIsSane } from './geometry.js';
import { Keyboard, SCALES, NOTE_NAMES, midiName } from './scales.js';
import { PianoEngine, LOOKAHEAD } from './audio.js';
import { Overlay, HAND_COL } from './render.js';
import { Tutorial } from '../tutorial.js';
import { PIANO_SLIDES } from './tutorial.js';
import { FaceVeil, faceHidden, setFaceHidden, onFaceHiddenChange } from '../privacy.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const el = {
  stage: $('stage'), video: $('video'), canvas: $('overlay'),
  veil: $('veil'), veilCard: $('veilCard'),
  pCam: $('pillCam'), pHands: $('pillHands'), pPerf: $('pillPerf'),
  pFace: $('pillFace'), pFaceLabel: $('pillFaceLabel'),
  note: $('lastNote'), noteSub: $('lastNoteSub'), calBtn: $('calBtn'),
  calBar: $('calBar'), calUse: $('calUse'), calCancel: $('calCancel'), calReset: $('calReset'),
  calHint: $('calHint'), camRow: $('camRow'), selCam: $('selCam'), lat: $('latNote'),
};

/* ---------------- persisted state ---------------- */
const KEY = 'air-piano.v1';
const DEFAULTS = {
  /* One row by default, and plenty of keys in it. Two rows asks you to reach
   * to a second depth you cannot feel, which is far harder than simply having
   * a wider keyboard; three is unplayable. So the range comes from *width*. */
  key: 0, scale: 'major', cols: 12, rows: 1, octave: 4,
  split: true, vol: 0.8, room: 0.18, tone: 0.5, sustain: 0.55,
  names: true, corners: null, camId: '', damp: 'pedal', surface: 'air',
  /* The walkthrough runs once, on the first visit, and is replayable from the
   * panel afterwards. Stored so it doesn't greet a returning player. */
  toured: false,
  /* All ten by default — it is a piano. One index finger each is there for
   * anyone who finds the neighbouring fingers coming down with the one they
   * meant, which is the commonest complaint about playing this way. */
  fingers: 'all',
};
function load() {
  const S = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) S[k] = raw[k];
    }
  } catch {}
  if (!Array.isArray(S.corners) || !quadIsSane(S.corners)) S.corners = null;
  if (!SCALES[S.scale]) S.scale = 'major';
  if (!SURFACES[S.surface]) S.surface = 'air';
  if (!FINGER_SETS[S.fingers]) S.fingers = 'all';
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
const detector = new TapDetector();
const piano = new PianoEngine();
const overlay = new Overlay(el.canvas, el.video);

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

/* Detection rate *is* the latency here, so the piano spends everything on it.
 *
 * A note fires on the frame where the fingertip is seen to stop, so the delay
 * between hitting the desk and hearing it is essentially one sample interval.
 * At 20 looks/s that is 50 ms of dead feel before a single millisecond of audio
 * latency is counted; at 50 looks/s it is 20 ms and the thing comes alive.
 *
 * So: no duty-cycle throttle at all (the guitar needs one because its pattern
 * scheduler must not miss its lookahead window — the piano schedules each note
 * the instant it detects it, so a briefly starved rAF costs nothing but a
 * stuttery overlay), and a deliberately modest camera resolution, because
 * inference cost tracks the source frame and MediaPipe downsamples hard
 * internally anyway. 640×480 at 60 fps is the sweet spot: enough detail to
 * place a fingertip inside a key, half the pixels of the guitar's request. */
tracker.duty = 1;
const VIDEO = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } };

detector.setSurface(S.surface);
detector.setFingers(S.fingers);
let plane = new TablePlane(S.corners || defaultQuad());
let keyboard = new Keyboard(S);
let calibrating = false, draft = [];

/* ---------------- hand identity ----------------
 * Which hand is which decides only the register split, but it has to be stable
 * or the bass wanders mid-phrase. MediaPipe's handedness is reliable; what is
 * *not* reliable is assuming which way round its labels mean, since that
 * depends on whether the pipeline mirrored the frame. So the meaning is locked
 * by observation: the first time two labelled hands are seen, whichever sits on
 * the left of the (mirrored) image is the player's left hand. After that the
 * label carries the role, and hands may cross without swapping registers. */
const roleOf = new Map();      // MediaPipe label → 'left' | 'right'

function identify(hands) {
  if (!hands.length) return [];
  const labelled = hands.filter((h) => h.label && (h.score ?? 0) > 0.6);

  // Two distinct labels in frame at once is the strongest evidence there is:
  // whichever sits further left in the (mirrored) image is the player's left
  // hand. This overwrites any earlier guess, and once set the *label* carries
  // the role, so hands may cross without swapping registers.
  if (labelled.length === 2 && labelled[0].label !== labelled[1].label) {
    const [a, b] = [...labelled].sort((p, q) => p.x - q.x);
    roleOf.set(a.label, 'left');
    roleOf.set(b.label, 'right');
  }

  const out = hands.map((h) => {
    const known = h.label && roleOf.get(h.label);
    if (known) return { ...h, id: known };
    // First sighting of a hand on its own: seed from which side of the frame it
    // is on, then *remember* it. Re-deciding this every frame — which is what
    // this did at first — means playing one-handed across the desk silently
    // changes register halfway, because the hand crossed the centre line.
    const guess = h.x < 0.5 ? 'left' : 'right';
    if (h.label && (h.score ?? 0) > 0.6) roleOf.set(h.label, guess);
    return { ...h, id: guess };
  });

  // MediaPipe occasionally labels both hands the same. Two hands sharing an id
  // would share one slot of detector state and stamp on each other's history,
  // so force them apart by position — being wrong about which is which costs
  // an octave, whereas colliding costs both hands their tap detection.
  if (out.length === 2 && out[0].id === out[1].id) {
    const [a, b] = [...out].sort((p, q) => p.x - q.x);
    a.id = 'left'; b.id = 'right';
  }
  return out;
}

/* ---------------- notes ---------------- */
let lastNoteAt = 0;
/* Which note each finger is currently holding down, so the damper can follow
 * it. A tap on a desk has no key-release of its own, so without this every
 * note has to ring to its natural end — which turns anything fast into mush.
 * With it, how long you leave the finger down is how long the note lasts, and
 * staccato becomes playable. */
const holding = new Map();
detector.onLift = ({ id, finger }) => {
  const key = `${id}:${finger}`;
  const midi = holding.get(key);
  if (midi == null) return;
  holding.delete(key);
  if (S.damp !== 'finger') return;
  // Two fingers can be holding the same note — the hands doubling an octave
  // apart lands on it, and so does one finger of each hand meeting in the
  // middle. Lifting one of them must not silence the other's note.
  for (const m of holding.values()) if (m === midi) return;
  piano.damp(midi);
};
function strike(ev) {
  const t = plane.toTable({ x: ev.x, y: ev.y });
  if (!plane.contains(t)) return;                 // a tap beside the desk is not a note
  const cell = keyboard.cellAt(t);
  if (!cell) return;
  const offset = S.split ? (ev.id === 'left' ? -2 : 0) : 0;
  const midi = keyboard.midiAt(cell, offset);
  if (midi == null) return;

  const at = piano.note(midi, ev.velocity);
  holding.set(`${ev.id}:${ev.finger}`, midi);
  // Line the flash up with the sound, not with the frame that detected it.
  const visualAt = performance.now() / 1000 + Math.max(0, (at ?? 0) - piano.now());
  overlay.onHit({ u: clamp(t.x, 0, 1), v: clamp(t.y, 0, 1), cell, hand: ev.id, velocity: ev.velocity, at: visualAt });

  el.note.textContent = midiName(midi);
  el.note.style.color = HAND_COL[ev.id];
  el.noteSub.textContent =
    `${ev.id} hand · ${FINGER_NAMES[ev.finger]} · vel ${Math.round(ev.velocity * 100)}`;
  lastNoteAt = performance.now();
}

/* ---------------- calibration ----------------
 *
 * The corners are placed with the cursor. Marking them by tapping them was
 * tried first and is, on paper, the more correct thing to do: a homography maps
 * exactly one plane, and every point the instrument is later asked about is a
 * fingertip landmark sitting a centimetre or two above the desk, so fitting the
 * quad from taps puts it on the plane the fingertips are actually on and the
 * parallax cancels exactly. Clicking marks the desk's own surface instead, and
 * on a low camera reaching far across the desk that gap is worth up to two
 * keys.
 *
 * It was still the wrong trade. Placing a corner by tap requires the tap
 * detector to be working *before* there is any calibration to tell you whether
 * it is, so a marginal corner and a marginal detector are indistinguishable,
 * and marking out the area — the one step you cannot skip — became the least
 * reliable part of the instrument. A cursor puts the corner exactly where you
 * meant it, every time. The parallax is real but bounded, it only bites in Desk
 * mode (Air, the default, has no surface under the fingertips at all), and the
 * cure is a sentence of instruction: click where your *fingertips* will be, not
 * where the desk's corner is.
 *
 * The pinhole test in test/piano.mjs still models the parallax, and is what
 * would tell us how much a future tap-assisted mode would buy back.
 */
const CORNER_NAMES = ['far left', 'far right', 'near right', 'near left'];

function startCalibration() {
  calibrating = true; draft = [];
  el.calBar.hidden = false;
  el.calUse.disabled = true;
  el.calBtn.classList.add('on');
  el.stage.classList.add('picking');
  paintCalHint(); paintCalBtn();
}

function paintCalHint() {
  const n = draft.length;
  const where = S.surface === 'air' ? 'in the air in front of you' : 'on your desk';
  el.calHint.innerHTML = n < 4
    ? `<b>Click the ${CORNER_NAMES[n]} corner</b> of your playing area ${where} — ${n}/4.`
    : 'Looks right? Use this area. Click any corner to nudge it.';
}
function endCalibration(commit) {
  if (commit && draft.length === 4 && quadIsSane(draft)) {
    const p = new TablePlane(draft);
    if (p.ok) { plane = p; S.corners = p.toJSON(); persist(); }
  }
  calibrating = false; draft = [];
  el.calBar.hidden = true;
  el.calBtn.classList.remove('on');
  el.stage.classList.remove('picking');
  paintCalBtn();
}

el.stage.addEventListener('click', (e) => {
  if (!calibrating) return;
  const r = el.stage.getBoundingClientRect();
  const p = { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  if (draft.length < 4) draft.push(p);
  else {
    // All four placed: a further click grabs the nearest corner and moves it,
    // so a slightly-off corner is a nudge rather than a restart.
    let best = 0, bd = Infinity;
    draft.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = i; } });
    draft[best] = p;
  }
  el.calUse.disabled = !(draft.length === 4 && quadIsSane(draft));
  paintCalHint();
});

/* ---------------- walkthrough ----------------
 *
 * Air Piano has one genuinely unguessable idea in it — that a note fires when
 * your fingertip is *stopped*, so you strike rather than press — and one step
 * you cannot skip, marking out where the keyboard is. Neither is discoverable
 * by poking at the thing, and both are cheap to say in a sentence. That is the
 * whole scope of this: five cards on first run, and a way back to them.
 *
 * It runs after the camera is live, so every step points at something real and
 * the player can try each one as it is described.
 */
const tour = new Tutorial({
  slides: PIANO_SLIDES,
  seenKey: 'air-piano.tutorial.v1',
  onDone: () => {
    S.toured = true; persist();
    // The reason the walkthrough exists is to arrive here knowing what this is
    // for, so it hands straight over to marking out the playing area.
    if (!S.corners) startCalibration();
  },
});

/* ---------------- controls ---------------- */
function rebuild() { keyboard = new Keyboard(S); paintRange(); paintCalBtn(); }
/** The button says what you'd actually be marking out. */
function paintCalBtn() {
  el.calBtn.textContent = calibrating ? 'Marking out…'
    : S.surface === 'air' ? 'Mark out my keyboard…' : 'Mark out my desk…';
}
function paintRange() {
  const lo = keyboard.midiAt({ col: 0, row: 0 }, S.split ? -2 : 0);
  const hi = keyboard.midiAt({ col: S.cols - 1, row: S.rows - 1 }, 0);
  $('rangeNote').textContent = `${midiName(lo)} – ${midiName(hi)}`;
}

function initControls() {
  $('selKey').innerHTML = NOTE_NAMES.map((n, i) => `<option value="${i}"${i === S.key ? ' selected' : ''}>${n}</option>`).join('');
  $('selScale').innerHTML = Object.entries(SCALES).map(([k, v]) =>
    `<option value="${k}"${k === S.scale ? ' selected' : ''}>${v.label}</option>`).join('');
  $('selKey').onchange = (e) => { S.key = +e.target.value; rebuild(); persist(); };
  $('selScale').onchange = (e) => { S.scale = e.target.value; rebuild(); persist(); };

  const seg = (id, get, set) => {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      [...e.currentTarget.children].forEach((c) => c.classList.toggle('on', c === b));
      set(b.dataset.v);
    });
    [...$(id).children].forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  };
  seg('segCols', () => S.cols, (v) => { S.cols = +v; rebuild(); persist(); });
  seg('segRows', () => S.rows, (v) => { S.rows = +v; rebuild(); persist(); });
  seg('segOct', () => S.octave, (v) => { S.octave = +v; rebuild(); persist(); });
  seg('segSplit', () => (S.split ? 'yes' : 'no'), (v) => { S.split = v === 'yes'; rebuild(); persist(); });

  const rng = (id, out, get, set) => {
    $(id).value = Math.round(get() * 100);
    if (out) $(out).value = Math.round(get() * 100);
    $(id).oninput = (e) => { const v = e.target.value / 100; if (out) $(out).value = e.target.value; set(v); persist(); };
  };
  rng('rngVol', 'outVol', () => S.vol, (v) => { S.vol = v; piano.ready && piano.setVolume(v); });
  rng('rngSus', 'outSus', () => S.sustain, (v) => { S.sustain = v; piano.ready && piano.setSustain(v); });
  rng('rngTone', 'outTone', () => S.tone, (v) => { S.tone = v; piano.ready && piano.setTone(v); });
  rng('rngRoom', 'outRoom', () => S.room, (v) => { S.room = v; piano.ready && piano.setRoom(v); });

  el.selCam.onchange = (e) => switchCamera(e.target.value);
  seg('segDamp', () => S.damp, (v) => { S.damp = v; persist(); });
  seg('segFingers', () => S.fingers, (v) => {
    S.fingers = v; detector.setFingers(v); piano.ready && piano.allOff(); holding.clear(); persist();
  });
  seg('segSurface', () => S.surface, (v) => {
    S.surface = v; detector.setSurface(v); persist(); paintCalHint(); paintCalBtn();
    // The plane you marked out on a desk is not the plane you mime in the air,
    // so the old corners describe somewhere that no longer exists.
    if (S.corners) startCalibration();
  });

  $('chkNames').checked = S.names;
  $('chkNames').onchange = (e) => { S.names = e.target.checked; persist(); };

  el.calBtn.onclick = () => (calibrating ? endCalibration(false) : startCalibration());
  el.calUse.onclick = () => endCalibration(true);
  el.calCancel.onclick = () => endCalibration(false);
  el.calReset.onclick = () => {
    plane = new TablePlane(defaultQuad());
    S.corners = null; persist();
    draft = []; el.calUse.disabled = true;
  };
  $('tourBtn').onclick = () => {
    // Replaying it from a half-marked-out area would leave the calibration bar
    // open behind the cards and finish by reopening it, so close that first.
    if (calibrating) endCalibration(false);
    $('helpModal').hidden = true;
    tour.open(0);
  };
  $('helpBtn').onclick = () => ($('helpModal').hidden = false);
  $('helpClose').onclick = () => ($('helpModal').hidden = true);
  $('helpModal').onclick = (e) => { if (e.target === $('helpModal')) $('helpModal').hidden = true; };
  paintRange(); paintCalBtn();
}

/* ---------------- veil ---------------- */
function showStart(msg) {
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<h2>Point the camera at your desk</h2>
    <p>${msg || 'Tilt your screen down so the camera sees the desk in front of you, and the desk becomes the keyboard. Nothing is recorded and nothing leaves this tab.'}</p>
    <p>Rest your hands on the surface and <b>tap it like keys</b>. How hard you strike is how loud the note is.</p>
    <div class="veil-actions"><button class="btn" id="go">Start playing</button></div>
    <p class="veil-hint">You'll mark out your playing area once — it takes four clicks.</p>`;
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

/* ---------------- cameras ----------------
 * A desk rig is very often *not* the built-in webcam — that is the whole point
 * of pointing something down at the desk — so the choice has to be offered.
 * Labels only exist once permission has been granted, which is why this runs
 * after the stream is up rather than at load. */
async function fillCameras() {
  let devs = [];
  try { devs = await camera.devices(); } catch {}
  if (devs.length < 2) { el.camRow.hidden = true; return; }
  el.camRow.hidden = false;
  const current = camera.stream?.getVideoTracks?.()[0]?.getSettings?.().deviceId || S.camId;
  el.selCam.innerHTML = devs.map((d, i) =>
    `<option value="${d.deviceId}"${d.deviceId === current ? ' selected' : ''}>${d.label || `Camera ${i + 1}`}</option>`).join('');
}

// Someone plugging a webcam in mid-session is exactly the person this list is
// for, so keep it live rather than snapshotting it once at boot.
try { navigator.mediaDevices?.addEventListener?.('devicechange', () => fillCameras()); } catch {}

async function switchCamera(id) {
  S.camId = id; persist();
  try {
    showBusy('Switching camera');
    await camera.start(id || undefined, VIDEO);
    syncStage();
    el.veil.hidden = true;
    setPill(el.pCam, 'ok', 'camera live');
    // A different camera is a different viewpoint, so the old corners describe
    // a desk that is no longer there. Say so rather than letting the keys sit
    // silently in the wrong place.
    if (S.corners) startCalibration();
  } catch (e) { showError(e.kind || 'unknown', e.name); }
}

/* ---------------- boot ---------------- */
async function boot() {
  try {
    showBusy('Warming up the strings');
    if (!piano.ready) await piano.init();
    piano.setVolume(S.vol); piano.setRoom(S.room); piano.setTone(S.tone); piano.setSustain(S.sustain);
  } catch (e) { return showError('unknown', e.message); }

  try {
    showBusy('Opening your camera');
    await camera.start(S.camId || undefined, VIDEO);
    setPill(el.pCam, 'ok', 'camera live');
    fillCameras();
  } catch (e) { return showError(e.kind || 'unknown', e.name); }

  try { showBusy('Loading hand tracking'); await tracker.preload(); }
  catch (e) { return showError('model', e.message); }

  syncStage();
  el.veil.hidden = true;
  S.running = true;
  pump();
  /* First run: walk through it, and let the walkthrough hand over to marking
   * out the area when it finishes or is skipped. After that the default quad is
   * only a guess at where the desk is, so send people straight into marking it
   * out rather than letting them wonder why the keys are in the wrong place. */
  if (!S.toured) tour.open(0);
  else if (!S.corners) startCalibration();
}

/**
 * Keep the stage box the same shape as the camera frame.
 *
 * The video is `object-fit: cover` and the overlay maps normalised landmarks
 * onto the displayed box, so any mismatch crops the feed and slides everything
 * drawn away from the hands it belongs to. A live stream can change shape
 * underneath you, and `resize` is not guaranteed to fire for every case, so the
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
/* Watch the box rather than guessing which events imply it moved. A window
 * resize is only one way the stage changes size — a scrollbar appearing, the
 * breakpoint that stacks the panel, zoom, a webfont arriving — and every one
 * of them silently misplaces the whole keyboard if the overlay's cached size
 * lags. See the same note in the guitar's main.js. */
if (window.ResizeObserver) new ResizeObserver(() => overlay.resize()).observe(el.stage);

/* ---------------- detection pump ---------------- */
let hands = [], handsSeq = 0, handsAt = 0;
function pump() {
  const step = () => {
    if (S.running && !document.hidden && tracker.due()) {
      hands = tracker.detect(el.video, performance.now());
      // Stamp the landmarks with when they were *captured*. See the frame loop:
      // handing the detector a render timestamp instead measures the wrong
      // interval entirely.
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
function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now(), t = nowMs / 1000;
  fps = fps * 0.93 + (1000 / Math.max(1, nowMs - lastF)) * 0.07; lastF = nowMs;

  /* Detection-rate driven: feeding the detector the same landmarks twice would
   * read as zero motion and flatten every strike.
   *
   * The timestamp handed over is when the frame was *captured*, not now. The
   * two differ — the pump runs on video frames and this loop on repaints, so
   * they drift in and out of phase — and the detector divides displacement by
   * it. Using the render clock measures how long ago we got round to *looking*
   * at the motion rather than how long the motion took, which corrupts every
   * velocity and, because the strike test is built on velocity, silently loses
   * taps. It cost three of four notes here before it was caught. */
  if (S.running && handsSeq !== lastSeq) {
    lastSeq = handsSeq;
    live = identify(hands);
    const events = detector.update(live.map((h) => ({ id: h.id, lm: h.lm })), handsAt);
    /* The detector keeps running while the corners are being placed — it stays
     * warm, and the overlay goes on showing which fingers it can see — but
     * nothing sounds. Waving a hand over the area you are marking out should
     * not play a note through the keyboard you have not finished defining. */
    if (!calibrating) for (const ev of events) strike(ev);
  }

  const overlayHands = live.map((h) => ({
    id: h.id,
    // Where this pose will be by the time it is painted. Drawing only — the
    // detector above has already run on the measured landmarks. See `drawLead`.
    lead: drawLead(h, t),
    tips: [4, 8, 12, 16, 20].map((i) => h.lm[i]),
    states: [0, 1, 2, 3, 4].map((f) => detector.state(h.id, f)),
    // Which fingers can actually play, so the ones that can't say so rather
    // than sitting there looking armed and never sounding.
    plays: [0, 1, 2, 3, 4].map((f) => detector.plays(f)),
  }));

  overlay.draw({
    now: t, plane, keyboard, calibrating, draft,
    hands: overlayHands, showNames: S.names,
    rate, lowRate: rate > 0 && rate < 20,
  });

  // The piano spends everything on detection rate, so the face yields harder
  // here than anywhere else — see the latency note in the README.
  faceVeil.tick(nowMs, tracker.emaMs > 45);

  if (++tick % 20 === 0) {
    rate = tracker.emaMs > 0 ? Math.min(1000 / tracker.emaMs * tracker.duty, 60) : 0;
    el.pPerf.textContent = `${Math.round(fps)} fps · track ${rate.toFixed(0)}/s · ${tracker.emaMs.toFixed(0)} ms ${tracker.delegate.toLowerCase()}`;
    el.pPerf.classList.toggle('bad', rate > 0 && rate < 20);
    /* Be honest about where the delay actually comes from. A note cannot be
     * detected before the frame that shows the finger stopping, so one sample
     * interval is the floor, and it dwarfs everything the audio path adds. */
    if (el.lat) {
      const detect = rate > 0 ? 1000 / rate : 0;
      const total = detect + LOOKAHEAD * 1000;
      el.lat.innerHTML = rate === 0 ? '—'
        : `≈<b>${Math.round(total)} ms</b> · ${Math.round(detect)} tracking + ${Math.round(LOOKAHEAD * 1000)} audio`
          + (tracker.delegate === 'CPU' ? ' · <span class="warn">GPU off — see How to play</span>' : '');
    }
    if (stageDrifted()) syncStage();
    overlay.resize();   // no-op unless the canvas actually moved
    if (S.running) {
      const n = live.length;
      setPill(el.pHands, n === 2 ? 'ok' : n ? 'warn' : 'bad',
        n === 2 ? 'both hands' : n === 1 ? 'one hand' : 'no hands');
    }
    if (nowMs - lastNoteAt > 4000 && el.note.textContent !== '—') {
      el.note.textContent = '—'; el.note.style.color = '';
      el.noteSub.textContent = 'tap the desk';
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && piano.ready) piano.allOff();
});

/* ---------------- go ---------------- */
initControls();
overlay.resize();
showStart();
window.airPiano = { tracker, detector, piano, overlay, S, get plane() { return plane; }, get keyboard() { return keyboard; }, get draft() { return draft; }, tour };
tracker.preload().catch(() => {});
requestAnimationFrame(frame);
