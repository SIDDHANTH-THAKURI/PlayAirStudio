/** main.js — wiring: camera → tracking → gestures → strings/patterns → audio + UI. */
import { Tracker, Camera, IS_MOBILE } from './tracking.js';
import { GestureEngine, SIGNS, STRUM_SIGNS, STRING_LABELS, GRID_Y0, GRID_Y1 } from './gestures.js';
import { FaceVeil, faceHidden, setFaceHidden, onFaceHiddenChange } from './privacy.js';
import { GuitarEngine } from './audio.js';
import { Overlay, SCOL } from './render.js';
import { STYLES, NOTE_NAMES, specToChord, diagramSVG,
  defaultGridSpecs, defaultSignSpecs } from './chords.js';
import { PatternPlayer, getPattern, stepsPerSecond, resolveString, bassString,
  altBassString } from './patterns.js';
import * as store from './store.js';
import { Editors } from './ui.js';
import { Tutorial } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), video: $('video'), canvas: $('overlay'), veil: $('veil'), veilCard: $('veilCard'),
  coach: $('coach'), strip: $('chordstrip'), chordName: $('chordName'), chordSub: $('chordSub'),
  diagram: $('diagram'), np: $('nowPlaying'), rhState: $('rhState'), dwellBar: $('dwellBar'),
  slotlist: $('slotlist'), lhState: $('lhState'),
  bStroke: $('badgeStroke'), bMute: $('badgeMute'), bExpr: $('badgeExpr'),
  pCam: $('pillCam'), pHands: $('pillHands'), pPerf: $('pillPerf'),
  pFace: $('pillFace'), pFaceLabel: $('pillFaceLabel'),
};

/* Persisted settings + the volatile bits that never outlive the tab. */
const S = Object.assign(store.load(), {
  slot: 0, running: false, sounds: 0, kbMute: false, kbDead: false, thumbAlt: false,
});
const persist = () => store.save(S);

/* The grid lives in the left half; `gridY` bounds keep it clear of the mode
 * captions at the top and the coach card at the bottom. */
/* gridY0/gridY1 come from gestures.js — see the note there for why the wall
   stops well short of the bottom edge. Both the hit test and `render.js` read
   the same two numbers, so the painted wall is exactly the detectable one. */
const layout = () => (S.lefty
  ? { neckX0: 0.52, neckX1: 0.97, strumX0: 0.03, strumX1: 0.48, gridY0: GRID_Y0, gridY1: GRID_Y1, lefty: true }
  : { neckX0: 0.03, neckX1: 0.48, strumX0: 0.52, strumX1: 0.97, gridY0: GRID_Y0, gridY1: GRID_Y1, lefty: false });

const cfg = () => ({
  chordMode: S.chordMode, playMode: S.playMode,
  cols: 4, rows: 3, signPatterns: S.signPatterns,
});

const tracker = new Tracker(), camera = new Camera(el.video),
      gestures = new GestureEngine(), guitar = new GuitarEngine(), overlay = new Overlay(el.canvas);

/* Face blur. Constructing it is free — no model, no DOM, no inference until
   `set(true)` — so it can be wired unconditionally and left off. */
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

/** The chord bank the fretting hand is currently aiming at. */
let bank = [];
const voicing = () => bank[S.slot]?.chord || null;

/* ---------------- pattern transports ---------------- */
const onStep = (step, when) => {
  const v = voicing();
  if (!v) return;
  const dead = deadNow();
  let res = null;
  if (step.k === 'd' || step.k === 'u') {
    res = guitar.strum({ voicing: v, direction: step.k === 'd' ? 'down' : 'up',
      dynamics: step.v, dead, palmMute: S.kbMute, strings: step.hi ? [3, 4, 5] : null, when });
  } else if (step.k === 'x') {
    res = guitar.strum({ voicing: v, direction: 'down', dynamics: step.v, dead: true, when });
  } else {
    const s = step.k === 'b' ? bassString(v) : step.k === 'ab' ? altBassString(v)
      : resolveString(v, step.s);
    res = guitar.pluckOne({ voicing: v, string: s, velocity: step.v, dead, when });
  }
  flashSound(res, when);
};
const player = new PatternPlayer({ now: () => guitar.now(), onStep });
const preview = new PatternPlayer({ now: () => guitar.now(), onStep });

/* ---------------- bank + panel painting ---------------- */
function rebuildBank() {
  const specs = S.chordMode === 'signs' ? S.signSpecs : S.gridSpecs;
  const force = S.voicing === 'power' ? 'power' : null;
  bank = specs.map((sp, i) => {
    const chord = specToChord(sp, force);
    return { spec: sp, chord, name: chord?.name || '', glyph: SIGNS[i]?.glyph || '' };
  });
  if (S.slot >= bank.length) S.slot = 0;
  paintStrip();
  paintChord();
}

function paintStrip() {
  const signs = S.chordMode === 'signs';
  // Four columns in grid mode so the strip is a true mini-map of the 4×3 wall:
  // cell 5 is row 2 column 1 in both places. Six columns made the strip's
  // numbering disagree with what the player sees on screen.
  el.strip.style.gridTemplateColumns = `repeat(${signs ? 5 : 4}, 1fr)`;
  el.strip.innerHTML = bank.map((c, i) =>
    `<div class="cs${c.chord ? '' : ' empty'}" data-i="${i}">
       <span class="n">${c.name || '·'}</span>
       <span class="i">${signs ? c.glyph : i + 1}</span>
     </div>`).join('');
  [...el.strip.children].forEach((n) => n.classList.toggle('on', +n.dataset.i === S.slot));
}

function paintChord() {
  const c = voicing();
  el.chordName.textContent = c?.name || '—';
  el.chordSub.textContent = c ? c.frets.map((f) => (f === null ? '×' : f)).join(' ') : 'empty slot';
  el.diagram.innerHTML = c ? diagramSVG(c) : '';
  [...el.strip.children].forEach((n) => n.classList.toggle('on', +n.dataset.i === S.slot));
  S.thumbAlt = false;
}

/* Fingerstyle legend: how many digits, which string. Deliberately numerals
 * rather than emoji — "four fingers" and "open palm" are one thumb apart and
 * no two hand glyphs make that difference readable at 17px. */
const COUNT_SLOTS = [
  ['1', '1 finger', 5], ['2', '2 fingers', 4], ['3', '3 fingers', 3],
  ['4', '4 fingers', 2], ['5', 'all five', 1], ['🤙', 'little only', 0],
];

/** The right-hand legend: sign→pattern chips, or count→string chips. */
function paintSlots() {
  if (S.playMode === 'strum') {
    el.slotlist.innerHTML = STRUM_SIGNS.map((s) => {
      const p = getPattern(S.signPatterns[s.id] || s.def);
      return `<div class="slot" data-s="${s.id}"><span class="sg">${s.glyph}</span><span>${p?.label || '—'}</span></div>`;
    }).join('') + `<div class="slot quiet"><span class="sg">✋</span><span>stop</span></div>`;
  } else {
    el.slotlist.innerHTML = COUNT_SLOTS.map(([badge, label, str]) =>
      `<div class="slot" data-str="${str}"><span class="sg" style="color:${SCOL[str]}">${badge}</span>
         <span>${label}</span><span class="ss">${STRING_LABELS[str].split(' · ')[1]}</span></div>`).join('');
  }
}

function paintModes() {
  [...$('segChordMode').children].forEach((b) => b.classList.toggle('on', b.dataset.v === S.chordMode));
  [...$('segPlayMode').children].forEach((b) => b.classList.toggle('on', b.dataset.v === S.playMode));
  el.lhState.textContent = S.chordMode === 'signs' ? 'sign chords' : 'chord grid';
}

function setChordMode(v) {
  if (S.chordMode === v) return;
  S.chordMode = v; S.slot = 0;
  rebuildBank(); paintModes(); persist();
}
function setPlayMode(v) {
  if (S.playMode === v) return;
  S.playMode = v; stopPattern();
  paintSlots(); paintModes(); persist();
}

/**
 * Tempo drives the metronome *and* every pattern, live. Running players get
 * re-anchored rather than restarted, so dragging the slider mid-strum speeds
 * the groove up under your hand instead of stuttering it back to beat one.
 */
function setTempo(bpm) {
  S.bpm = Math.max(40, Math.min(240, Math.round(bpm)));
  $('rngBpm').value = S.bpm; $('outBpm').value = S.bpm;
  guitar.ready && guitar.setMetronome(S.metro, S.bpm);
  player.setBpm(S.bpm); preview.setBpm(S.bpm);
  paintTempoNote();
  persist();
}

/** Spell out what the tempo means for the pattern actually bound to the hand. */
function paintTempoNote() {
  const id = activeSign
    ? S.signPatterns[activeSign] || STRUM_SIGNS.find((s) => s.id === activeSign)?.def
    : S.signPatterns[STRUM_SIGNS[0].id] || STRUM_SIGNS[0].def;
  const p = getPattern(id);
  if (!p) { $('rateNote').textContent = ''; return; }
  $('rateNote').innerHTML =
    `<b>${stepsPerSecond(p, S.bpm).toFixed(1)}</b> strums/sec · ${p.label}` +
    ((p.rate || 1) !== 1 ? ` at ${p.rate}×` : '');
}

function setPill(p, cls, text) { p.className = 'pill ' + cls; p.innerHTML = `<i class="dot"></i>${text}`; }
const deadNow = () => (gestures.fret.present && gestures.fret.dead) || S.kbDead;

/* ---------------- pointer play ----------------
 * A phone has no keyboard, so every fallback the keyboard offers needs a
 * tappable twin or the app is unplayable the moment tracking struggles. These
 * are live on desktop too — clicking the thing you are looking at is not a
 * worse way to pick a chord. */
function initPointerPlay() {
  el.strip.addEventListener('click', (e) => {
    const cell = e.target.closest('.cs');
    if (!cell) return;
    S.slot = +cell.dataset.i;
    paintChord();
  });

  el.slotlist.addEventListener('click', async (e) => {
    const n = e.target.closest('.slot');
    if (!n) return;
    try { await ensureAudio(); } catch { return; }
    if (n.classList.contains('quiet')) return stopPattern();      // the ✋ stop chip
    if (n.dataset.str !== undefined) return fireString(+n.dataset.str, 0.8);
    const sign = STRUM_SIGNS.find((s) => s.id === n.dataset.s);
    if (!sign) return;
    if (activeSign === sign.id) stopPattern();
    else startPattern(S.signPatterns[sign.id] || sign.def, sign.id);
  });

  for (const [id, dir] of [['tapDown', 'down'], ['tapUp', 'up']]) {
    $(id).addEventListener('click', async () => {
      try { await ensureAudio(); } catch { return; }
      fireStrum(dir, 0.82);
    });
  }
  $('tapDead').addEventListener('click', () => {
    S.kbDead = !S.kbDead;
    $('tapDead').classList.toggle('on', S.kbDead);
  });
}

/* ---------------- controls ---------------- */
function bindSeg(id, apply) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...e.currentTarget.children].forEach((c) => c.classList.toggle('on', c === b));
    apply(b.dataset.v);
  });
}

function initControls() {
  $('selKey').innerHTML = NOTE_NAMES.map((n, i) => `<option value="${i}"${i === S.key ? ' selected' : ''}>${n} major / relative minor</option>`).join('');
  $('selStyle').innerHTML = Object.entries(STYLES).map(([k, v]) => `<option value="${k}"${k === S.style ? ' selected' : ''}>${v.label}</option>`).join('');
  // Key and style rewrite both banks: they're the *source* the banks were
  // generated from, so silently keeping stale chords would be the surprise.
  const reseed = () => {
    S.gridSpecs = defaultGridSpecs(S.key, S.style);
    S.signSpecs = defaultSignSpecs(S.key, S.style);
    rebuildBank(); persist();
  };
  $('selKey').onchange = (e) => { S.key = +e.target.value; reseed(); };
  $('selStyle').onchange = (e) => { S.style = e.target.value; reseed(); };

  bindSeg('segTone', (v) => { S.sound = v; guitar.ready && guitar.setSound(v); persist(); });
  bindSeg('segVoicing', (v) => { S.voicing = v; rebuildBank(); persist(); });
  bindSeg('segHand', (v) => { S.lefty = v === 'left'; rebuildBank(); persist(); });
  bindSeg('segChordMode', (v) => { setChordMode(v); });
  bindSeg('segPlayMode', (v) => { setPlayMode(v); });

  $('rngVol').oninput = (e) => { S.vol = e.target.value / 100; $('outVol').value = e.target.value; guitar.ready && guitar.setVolume(S.vol); persist(); };
  $('rngRev').oninput = (e) => { S.room = e.target.value / 100; $('outRev').value = e.target.value; guitar.ready && guitar.setRoom(S.room); persist(); };
  const metro = () => guitar.ready && guitar.setMetronome(S.metro, S.bpm);
  $('chkMetro').onchange = (e) => { S.metro = e.target.checked; metro(); persist(); };
  $('rngBpm').oninput = (e) => setTempo(+e.target.value);
  /* Rotate prompt. CSS owns whether it shows; these two only offer a shortcut
   * and an escape. `orientation.lock` needs fullscreen and is unimplemented on
   * iOS, so both are best-effort and neither is required to proceed. */
  $('rotateGo').onclick = async () => {
    try { await document.documentElement.requestFullscreen?.(); } catch {}
    try { await screen.orientation?.lock?.('landscape'); } catch {}
  };
  $('rotateSkip').onclick = () => document.body.classList.add('portrait-ok');

  $('tourBtn').onclick = () => tutorial.open(0);
  $('helpBtn').onclick = () => ($('helpModal').hidden = false);
  $('helpClose').onclick = () => ($('helpModal').hidden = true);
  $('helpModal').onclick = (e) => { if (e.target === $('helpModal')) $('helpModal').hidden = true; };

  // Reflect persisted values onto the widgets that aren't rebuilt above.
  const seg = (id, v) => [...$(id).children].forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  seg('segTone', S.sound); seg('segVoicing', S.voicing); seg('segHand', S.lefty ? 'left' : 'right');
  $('rngVol').value = Math.round(S.vol * 100); $('outVol').value = Math.round(S.vol * 100);
  $('rngRev').value = Math.round(S.room * 100); $('outRev').value = Math.round(S.room * 100);
  $('chkMetro').checked = S.metro;
  $('rngBpm').value = S.bpm; $('outBpm').value = S.bpm;
  paintModes(); paintTempoNote();
}

/* ---------------- veil states ---------------- */
function showStart(msg) {
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<h2>Pick it up</h2>
    <p>${msg || 'Air Guitar needs your camera to watch your hands. Nothing is recorded and nothing leaves this tab.'}</p>
    <p><b>Point</b> at a chord with your fretting hand. <b>Hold a sign</b> with the other to run a strum pattern,
       or switch it to fingerstyle and open 1–5 fingers to pick single strings.</p>
    <p class="veil-hint">Hold 👍 for a second with either hand to open its mode dial — tilt to choose, open your palm to accept.</p>
    <div class="veil-actions"><button class="btn" id="go">Start playing</button></div>
    <p class="veil-hint kb-only">No webcam? Keys <kbd>1</kbd>–<kbd>=</kbd> pick chords, <kbd>Q</kbd>–<kbd>Y</kbd> pluck strings, <kbd>Z</kbd>–<kbd>B</kbd> run patterns.</p>`;
  $('go').onclick = boot;
}
function showBusy(txt) {
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<div class="spinner"></div><h2>${txt}</h2><p>One moment.</p>`;
}
const ERRORS = {
  denied: ['Camera permission was blocked', 'Click the camera icon in your browser\'s address bar, allow access for this page, then try again.'],
  none: ['No camera found', 'Plug one in or pick a different device, then try again.'],
  busy: ['The camera is in use', 'Another app (video call, recorder) has it. Close that app and try again.'],
  insecure: ['Needs a secure page', 'Browsers only expose cameras over <b>https://</b> or <b>localhost</b>. Serve the folder locally — e.g. <code>npm start</code> — and open <code>http://localhost:8000</code>.'],
  unsupported: ['This browser can\'t open a camera', 'Try a recent Chrome, Edge, or Safari.'],
  model: ['Couldn\'t load the hand-tracking model', 'It comes from a CDN on first run — check your connection or any blockers, then retry.'],
  unknown: ['Couldn\'t start the camera', 'Something went wrong opening the video device.'],
};
function showError(kind, detail) {
  const [hd, p] = ERRORS[kind] || ERRORS.unknown;
  el.veil.hidden = false;
  el.veilCard.innerHTML = `<h2>${hd}</h2><p>${p}</p>
    ${detail ? `<p class="err">${detail}</p>` : ''}
    <div class="veil-actions"><button class="btn" id="go">Try again</button>
      <button class="btn sec" id="kb">Play with keyboard</button></div>
    <p class="veil-hint kb-only"><kbd>1</kbd>–<kbd>=</kbd> chords · <kbd>Q</kbd>–<kbd>Y</kbd> strings · <kbd>Z</kbd>–<kbd>B</kbd> patterns</p>`;
  $('go').onclick = boot;
  $('kb').onclick = keyboardOnly;
  setPill(el.pCam, 'bad', 'camera error');
}

/* ---------------- boot ---------------- */
function applyAudioSettings() {
  guitar.setSound(S.sound); guitar.setVolume(S.vol); guitar.setRoom(S.room);
  guitar.setMetronome(S.metro, S.bpm);
}
async function ensureAudio() {
  if (guitar.ready) return true;
  await guitar.init();
  applyAudioSettings();
  return true;
}
async function keyboardOnly() {
  try { showBusy('Warming up the strings'); await ensureAudio(); }
  catch (e) { return showError('unknown', e.message); }
  el.veil.hidden = true; setPill(el.pCam, 'warn', 'keyboard mode');
  setPill(el.pHands, 'warn', 'no tracking');
}
async function boot() {
  try { showBusy('Warming up the strings'); await ensureAudio(); }
  catch (e) { return showError('unknown', e.message); }

  try {
    showBusy('Opening your camera');
    await camera.start();
    setPill(el.pCam, 'ok', 'camera live');
  } catch (e) { return showError(e.kind || 'unknown', e.name); }

  try {
    showBusy('Loading hand tracking');
    await tracker.preload();
  } catch (e) { return showError('model', e.message); }

  syncStage();
  el.veil.hidden = true;
  el.coach.hidden = false;
  S.running = true;
  pump();                       // the render loop is already running
}

/**
 * Match the stage box to the camera's true shape.
 *
 * This has to be re-run whenever the video's dimensions change, not just once
 * at boot. The video is `object-fit: cover` and the overlay maps normalised
 * landmarks onto the *displayed* box, so the two only line up while the box and
 * the frame are the same shape. Let them diverge and `cover` crops — the feed
 * appears to zoom, and every drawn hand slides toward the centre away from the
 * real one.
 *
 * A live stream can change shape under you: `applyConstraints` renegotiating
 * for throughput (a camera whose nearest small mode is 640×360 rather than
 * 480×360), a phone rotating, a different device being picked. `resize` is the
 * event for all of those — but it is still just an event, and not every
 * browser/camera pairing is guaranteed to fire it for every renegotiation.
 * The periodic check below is the safety net: cheap, and it catches anything
 * the event misses instead of leaving a mismatch to sit there indefinitely.
 */
function syncStage() {
  const ar = el.video.videoWidth / el.video.videoHeight;
  if (ar > 0.2) el.stage.style.aspectRatio = String(ar);
  overlay.resize();
}
el.video.addEventListener('resize', syncStage);

/* Watch the stage itself rather than guessing which events imply it moved.
 *
 * The overlay multiplies every normalised landmark by its cached width and
 * height, so those must never lag the canvas — stale ones draw every hand in
 * the wrong place, and stay wrong until something happens to re-measure.
 * A window resize is only one of the ways the stage changes size: a scrollbar
 * appearing as the panel grows, the breakpoint that stacks the panel under the
 * video, browser zoom, a webfont finally arriving, devtools opening. Listening
 * for particular events means enumerating that list correctly forever, which
 * is how this bug survived two previous fixes — each addressed one cause and
 * left the others. A ResizeObserver just watches the box. */
if (window.ResizeObserver) new ResizeObserver(() => overlay.resize()).observe(el.stage);

/** True if the stage box has drifted out of shape with the camera frame. */
function stageDrifted() {
  const vr = el.video.videoWidth / el.video.videoHeight;
  const br = el.stage.clientWidth / el.stage.clientHeight;
  return vr > 0.2 && br > 0 && Math.abs(vr - br) / vr > 0.02;
}

/* ---------------- detection pump (runs per camera frame) ---------------- */
let hands = [], handsSeq = 0, lastDetectMs = 0;
function pump() {
  const step = () => {
    // `tracker.due()` is the throttle: inference only gets a slice of wall
    // time, so painting and the pattern scheduler always have some left. On a
    // phone this is the difference between a frozen page and a playable one.
    if (S.running && !document.hidden && tracker.due()) {
      hands = tracker.detect(el.video, performance.now());
      handsSeq++; lastDetectMs = performance.now();
    }
    schedule();
  };
  const schedule = () => {
    if (el.video.requestVideoFrameCallback) el.video.requestVideoFrameCallback(step);
    else setTimeout(step, 16);
  };
  schedule();
}

/* ---------------- sound event → UI feedback ---------------- */
function flashSound(res, when) {
  if (!res) return;
  const visT = performance.now() / 1000 + Math.max(0, when ? when - guitar.now() : 0);
  overlay.onStrum(res, visT);
  el.np.classList.remove('pulse'); void el.np.offsetWidth; el.np.classList.add('pulse');
  const cell = el.strip.querySelector(`[data-i="${S.slot}"]`);
  if (cell) { cell.classList.remove('hit'); void cell.offsetWidth; cell.classList.add('hit'); }
  if (++S.sounds === 4) { el.coach.classList.add('fade'); setTimeout(() => (el.coach.hidden = true), 700); }
}

/** One fingerstyle string. `string` is already a voicing index, 0 = low E. */
function fireString(string, velocity) {
  const v = voicing();
  if (!v) return;
  const s = resolveString(v, string);
  const res = guitar.pluckOne({ voicing: v, string: s, velocity, dead: deadNow() });
  flashSound(res, null);
  el.bStroke.textContent = `string ${STRING_LABELS[s]}`;
  el.bStroke.className = 'badge hot';
}

/** Full strum (keyboard only — the hands drive patterns instead). */
function fireStrum(direction, dynamics) {
  const v = voicing();
  if (!v) return;
  const res = guitar.strum({ voicing: v, direction, dynamics, dead: deadNow(), palmMute: S.kbMute });
  flashSound(res, null);
  el.bStroke.textContent = `stroke ${direction === 'down' ? '↓' : '↑'}`;
  el.bStroke.className = 'badge hot';
}

let activeSign = null;
function startPattern(patternId, sign) {
  if (editors.previewing) editors.stopPreview();
  activeSign = sign || null;
  player.start(patternId, S.bpm, guitar.now() + 0.08);
  paintActiveSlot(); paintTempoNote();
}
function stopPattern() { activeSign = null; player.stop(); paintActiveSlot(); paintTempoNote(); }
/** Light the legend chip that's sounding (`arming` = the one filling its dwell). */
function paintActiveSlot(arming, string = -1) {
  [...el.slotlist.children].forEach((n) => {
    const isStr = n.dataset.str !== undefined;
    n.classList.toggle('on', isStr ? +n.dataset.str === string : !!activeSign && n.dataset.s === activeSign);
    n.classList.toggle('arming', !isStr && !!arming && n.dataset.s === arming);
  });
}

/* ---------------- render + play loop ---------------- */
let fps = 60, lastF = performance.now(), perfTick = 0, lastHandsSeq = -1, lastStall = 0;
function frame() {
  requestAnimationFrame(frame);
  const nowMs = performance.now(), t = nowMs / 1000;
  fps = fps * 0.93 + (1000 / Math.max(1, nowMs - lastF)) * 0.07; lastF = nowMs;

  const L = layout(), C = cfg();
  /* Run the gesture engine once per *detection*, not once per repaint.
   *
   * The camera delivers 15–30 fps and rAF fires at 60, so feeding the engine
   * every frame handed it the same landmarks two or three times in a row. That
   * is not just wasted work competing with MediaPipe for the main thread — it
   * is wrong: curl velocity is (now − previous)/dt, so a repeated sample reads
   * as *zero motion* and quietly flattened the dynamics of every pluck.
   *
   * If detection stalls outright the engine still needs to hear about it, or a
   * running pattern would loop forever with nobody holding the sign. */
  let events = [];
  if (S.running) {
    if (handsSeq !== lastHandsSeq) { lastHandsSeq = handsSeq; lastStall = 0; events = gestures.update(hands, t, L, C); }
    else if (nowMs - lastDetectMs > 250 && nowMs - lastStall > 250) {
      // Detection has gone quiet (a delegate swap, a stalled camera). Tell the
      // engine the hands are gone so a held pattern can't loop forever — but
      // at the detection cadence, not at 60 Hz, or a stall silently becomes
      // the most expensive thing on the frame.
      lastStall = nowMs;
      events = gestures.update([], t, L, C);
    }
  }
  const fret = gestures.fret, pluck = gestures.pluck;

  for (const ev of events) {
    if (ev.type === 'chord') { S.slot = ev.index; paintChord(); }
    else if (ev.type === 'pluck') fireString(ev.string, ev.velocity);
    else if (ev.type === 'pattern') ev.action === 'start' ? startPattern(ev.pattern, ev.sign) : stopPattern();
    else if (ev.type === 'mode') {
      if (ev.hand === 'fret') setChordMode(ev.value); else setPlayMode(ev.value);
    }
  }
  player.tick(); preview.tick();

  if (guitar.ready) {
    guitar.update({
      pickup: pluck.present ? pluck.pickup ?? 0.5 : 0.5,
      palmMute: S.kbMute,
      bend: fret.present ? fret.bend || 0 : 0,
      vibrato: fret.present ? fret.vibrato || 0 : 0,
      vibRate: fret.rate || 5.4,
      power: S.voicing === 'power' || S.style === 'rock',
    });
  }

  const armingSign = S.playMode === 'strum' && pluck.cand >= 0 ? STRUM_SIGNS[pluck.cand].id : null;
  const patternLabel = activeSign
    ? getPattern(S.signPatterns[activeSign] || STRUM_SIGNS.find((s) => s.id === activeSign)?.def)?.label
    : armingSign
      ? getPattern(S.signPatterns[armingSign] || STRUM_SIGNS.find((s) => s.id === armingSign)?.def)?.label
      : '';

  overlay.draw({
    now: t, layout: L, cfg: C, bank, slot: S.slot, voicing: voicing(),
    fret, pluck, fretLm: gestures.fretLm, pluckLm: gestures.pluckLm,
    wheelLabels: { fret: ['Chord grid', 'Sign chords'], pluck: ['Fingerstyle', 'Strumming'] },
    patternLabel, stringLabel: pluck.target >= 0 ? STRING_LABELS[pluck.target] : '',
  });

  // The face blur yields whenever hand inference is already over its slice —
  // the hands are the instrument, the face is decoration.
  faceVeil.tick(nowMs, tracker.emaMs > 60);

  /* ---- HUD ---- */
  if (S.running) {
    el.lhState.textContent = fret.mode === 'wheel' ? 'choosing mode…'
      : S.chordMode === 'signs' ? 'sign chords' : 'chord grid';
    if (pluck.mode === 'wheel') {
      el.rhState.textContent = 'choosing mode…';
      el.dwellBar.style.width = ((pluck.wheel.arm01 || 0) * 100).toFixed(0) + '%';
      paintActiveSlot(null);
    } else if (!pluck.present) {
      el.rhState.textContent = player.playing ? 'playing (keys)' : '—';
      el.dwellBar.style.width = (player.playing ? player.progress() * 100 : 0).toFixed(0) + '%';
    } else if (S.playMode === 'finger') {
      el.rhState.textContent = pluck.target >= 0 ? `string ${STRING_LABELS[pluck.target]}` : 'ready';
      el.dwellBar.style.width = ((pluck.target >= 0 ? pluck.hold01 : 0) * 100).toFixed(0) + '%';
      paintActiveSlot(null, pluck.target);
    } else if (activeSign) {
      el.rhState.textContent = `playing ${patternLabel || ''}`.trim();
      el.dwellBar.style.width = (player.progress() * 100).toFixed(0) + '%';
      paintActiveSlot(null);
    } else if (armingSign) {
      el.rhState.textContent = `hold for ${patternLabel || ''}…`;
      el.dwellBar.style.width = (pluck.hold01 * 100).toFixed(0) + '%';
      paintActiveSlot(armingSign);
    } else {
      el.rhState.textContent = 'ready';
      el.dwellBar.style.width = '0%';
      paintActiveSlot(null);
    }
  } else if (player.playing || preview.playing) {
    const p = preview.playing ? preview : player;
    el.dwellBar.style.width = (p.progress() * 100).toFixed(0) + '%';
  }

  if (++perfTick % 20 === 0) {
    // Tracking rate is what the player actually feels, so show that rather
    // than only the cost of one inference.
    const hz = tracker.emaMs > 0 ? Math.min(1000 / tracker.emaMs * tracker.duty, 60) : 0;
    el.pPerf.textContent = `${Math.round(fps)} fps · track ${hz.toFixed(0)}/s · ${tracker.emaMs.toFixed(0)} ms ${tracker.delegate.toLowerCase()}`;
    // Settled on a delegate and still slow: the only lever left is handing the
    // model a smaller picture. The bar is deliberately higher than the
    // GPU→CPU trip point (55 ms flat used to fire on plenty of desktops that
    // had already landed on a perfectly playable CPU delegate) — shrinking
    // renegotiates the live stream, which is exactly the moment a shape
    // mismatch can slip in, so it should only happen when actually needed.
    if (tracker.frames > 60 && tracker.emaMs > (IS_MOBILE ? 180 : 120)) camera.shrink();
    // Self-heal: `resize` is the right signal, but not every browser/camera
    // pairing is guaranteed to fire it for every renegotiation, and a missed
    // event would otherwise leave the feed looking zoomed and every drawn
    // hand pulled off the real one until the page reloads.
    if (stageDrifted()) syncStage();
    // Belt and braces behind the ResizeObserver. `resize()` returns immediately
    // unless the canvas actually moved, so this costs one measurement three
    // times a second — cheap insurance for a fault whose only symptom is every
    // hand being drawn somewhere it isn't, with nothing to correct it.
    overlay.resize();
    // One inference blocks the main thread outright, so the pattern scheduler
    // must plan further ahead than that stall or notes land late on a phone.
    const stall = tracker.emaMs / 1000;
    player.setLookahead(stall); preview.setLookahead(stall);
    if (S.running) {
      const f = fret.present, p = pluck.present;
      setPill(el.pHands, f && p ? 'ok' : f || p ? 'warn' : 'bad',
        f && p ? 'both hands' : f ? 'show plucking hand' : p ? 'show fretting hand' : 'no hands');
    }
  }
  const dead = deadNow();
  el.bMute.className = 'badge' + (dead ? ' hot' : S.kbMute ? ' cool' : '');
  el.bMute.textContent = dead ? 'dead / chunk' : S.kbMute ? 'palm mute' : 'open';
  const ex = [];
  if (fret.vibrato > 0.12) ex.push(`vibrato ${Math.round(fret.vibrato * 100)}%`);
  if (fret.bend > 0.05) ex.push(`bend +${fret.bend.toFixed(2)}`);
  el.bExpr.textContent = ex.length ? ex.join(' · ') : '·';
  el.bExpr.className = 'badge' + (ex.length ? ' hot' : '');
}

/* ---------------- keyboard fallback ----------------
 * Chords on the number row, strings on QWERTY's top row (left→right = high e
 * down to low E, matching the on-screen stack), patterns on ZXCVB. */
const CHORD_KEYS = ['1','2','3','4','5','6','7','8','9','0','-','='];
const STRING_KEYS = { q: 5, w: 4, e: 3, r: 2, t: 1, y: 0 };
const PATTERN_KEYS = ['z', 'x', 'c', 'v', 'b'];

addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input,select,textarea')) return;
  if (!$('patModal').hidden || !$('bankModal').hidden) return;
  const k = e.key.toLowerCase();

  const ci = CHORD_KEYS.indexOf(e.key);
  if (ci >= 0) { if (ci < bank.length) { S.slot = ci; paintChord(); } return; }
  if (k === ',' || k === '.') {
    S.slot = (S.slot + (k === ',' ? -1 : 1) + bank.length) % bank.length; paintChord(); return;
  }
  if (k === '[' || k === ']') { setTempo(S.bpm + (k === '[' ? -4 : 4)); return; }
  if (k === 'g') { setChordMode(S.chordMode === 'grid' ? 'signs' : 'grid'); return; }
  if (k === 'f') { setPlayMode(S.playMode === 'finger' ? 'strum' : 'finger'); return; }
  if (k === 'm') { S.kbMute = !S.kbMute; return; }
  if (k === 'n') { S.kbDead = !S.kbDead; return; }

  if (!guitar.ready) return;
  if (k in STRING_KEYS && !e.repeat) { fireString(STRING_KEYS[k], e.shiftKey ? 0.95 : 0.75); return; }

  const pi = PATTERN_KEYS.indexOf(k);
  if (pi >= 0 && !e.repeat) {
    const sign = STRUM_SIGNS[pi];
    const id = S.signPatterns[sign.id] || sign.def;
    player.playing && activeSign === sign.id ? stopPattern() : startPattern(id, sign.id);
    return;
  }
  const dir = e.key === 'ArrowUp' ? 'up' : (e.key === 'ArrowDown' || e.code === 'Space') ? 'down' : null;
  if (!dir) return;
  e.preventDefault();
  if (e.repeat) return;
  fireStrum(dir, e.shiftKey ? 0.98 : 0.72);
});

addEventListener('resize', () => overlay.resize());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPattern(); editors.stopPreview(); guitar.ready && guitar.allOff(); }
});

/* ---------------- editors ---------------- */
const editors = new Editors(S, {
  onBank: () => { rebuildBank(); paintModes(); persist(); },
  onPatterns: () => { paintSlots(); paintActiveSlot(); paintTempoNote(); persist(); },
  preview: {
    start: (p) => {
      stopPattern();
      const go = () => preview.start(p, S.bpm, guitar.now() + 0.1);
      guitar.ready ? go() : ensureAudio().then(go).catch(() => {});
      return true;
    },
    stop: () => preview.stop(),
    step: () => preview.activeStep(),
  },
});

/* ---------------- tutorial ----------------
 * Shown unprompted only on a first visit. Coming out of it lands on the start
 * card rather than auto-booting the camera: "I read the guide" is not the same
 * consent as "turn my camera on", and conflating the two is how a page ends up
 * asking for a permission the player didn't expect. */
const tutorial = new Tutorial({ onDone: () => { if (!S.running) showStart(); } });

/* ---------------- go ---------------- */
initControls();
initPointerPlay();
rebuildBank();
paintSlots();
overlay.resize();
showStart();
if (!Tutorial.seen()) tutorial.open(0);
window.airGuitar = { tracker, gestures, guitar, overlay, player, preview, editors, S, store, stepsPerSecond };
tracker.preload().catch(() => {});   // warm the model while the user reads
requestAnimationFrame(frame);
