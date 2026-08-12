/**
 * End-to-end smoke test: real Chromium, fake webcam, CDP over Node's built-in
 * WebSocket (no npm deps). Verifies the whole boot path — CDN modules, audio
 * init, camera, MediaPipe model, AudioWorklet, render loop — then drives the
 * keyboard fallback and saves a screenshot.
 *
 * Run: node test/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './serve.mjs';

const PORT = 8123, DBG = 9333;
const HOME = `http://localhost:${PORT}/`;
const APP = `${HOME}play.html`;
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const bin = BROWSERS.find(existsSync);
if (!bin) { console.error('no Chrome/Edge found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m, x = '') => { if (!c) fails++; console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m} ${x}`); };

// Two smoke runs at once fight over the port and the DevTools endpoint, and the
// symptom is a scatter of unrelated-looking failures. Say so instead.
try {
  const live = await fetch(`http://127.0.0.1:${DBG}/json/version`).then((r) => r.ok).catch(() => false);
  if (live) throw new Error('busy');
} catch (e) {
  if (e.message === 'busy') {
    console.error(`\nAnother smoke run already owns port ${DBG}. Wait for it to finish.\n`);
    process.exit(2);
  }
}
let server;
try { server = await startServer(PORT); }
catch { console.error(`\nPort ${PORT} is in use — another smoke run is probably still going.\n`); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), 'airguitar-'));
const browser = spawn(bin, [
  `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--headless=new', '--window-size=1400,920', '--hide-scrollbars',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  'about:blank',
], { stdio: 'ignore' });

async function targetWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('DevTools endpoint never came up');
}

const ws = new WebSocket(await targetWs());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let id = 0;
const pending = new Map();
const consoleLines = [], exceptions = [], netErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    consoleLines.push(`[${m.params.type}] ${txt}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push(d.exception?.description || d.text);
  }
  if (m.method === 'Log.entryAdded') {
    const en = m.params.entry;
    if (en.level === 'error' && !/favicon/.test(en.text)) netErrors.push(`${en.source}: ${en.text}`);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

const evl = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};
const waitFor = async (expr, timeoutMs, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evl(expr)) return true;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
};

try {
  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable');

  /* ---- landing page: hero → shelf → the app ---- */
  console.log('\nlanding');
  await send('Page.navigate', { url: HOME });
  // Wait for the module, not the markup — the DOM exists before intro.js runs.
  await waitFor(`!!window.airGate`, 20000, 'access gate');
  /* The temporary access gate. Worth testing that it does what it claims —
   * and worth being clear that what it claims is small: it is a client-side
   * check on a static site, so it keeps a casual visitor out and nothing else.
   * See the note at the top of src/gate.js. */
  ok(await evl(`airGate.locked === true`), 'the site is gated');
  ok(await evl(`!!document.querySelector('.gate')`), 'and says so');
  ok(await evl(`getComputedStyle(document.getElementById('hero')).visibility === 'hidden'`),
    'the page underneath is hidden, not merely covered');
  ok(await evl(`airGate.unlock('nope') === false && airGate.locked === true`), 'a wrong key is refused');
  ok(await evl(`airGate.unlock('  Siddhanth ') === true`), 'the right key opens it, trimmed and case-insensitive');
  ok(await evl(`!document.querySelector('.gate') && airGate.locked === false`), 'and the gate goes away');
  ok(await evl(`localStorage.getItem('air-studio.access') === 'siddhanth'`), 'and is remembered');

  await waitFor(`!!window.airStudio`, 20000, 'intro module');
  ok(true, 'intro loads');
  // `visibility` is transitioned on .scene, so it is mid-flight for half a
  // second after the gate lets go of it — wait for the value rather than race it.
  await waitFor(`getComputedStyle(document.getElementById('hero')).visibility === 'visible'`,
    4000, 'hero to fade in');
  ok(true, 'hero scene is the one showing once the gate releases it');
  ok(await evl(`document.getElementById('bg').width > 0`), 'the string canvas sized itself');
  // The landing page must stay silent — count every AudioContext ever built.
  await evl(`(() => { window.__ac = 0;
    for (const k of ['AudioContext','webkitAudioContext']) {
      const C = window[k]; if (!C) continue;
      window[k] = function (...a) { window.__ac++; return new C(...a); };
    } })(); true`);
  // Dragging through a string must pluck it — that's the whole conceit.
  await evl(`(() => { const f = airStudio.field, y = f.yOf(3);
    f.movePointer(f.w/2, y - 40); f.movePointer(f.w/2, y + 40); })(); true`);
  ok(await evl(`airStudio.field.s[3].amp > 0.1`), 'dragging across a string plucks it (visually)',
    `amp=${(await evl(`airStudio.field.s[3].amp`)).toFixed(2)}`);
  // A mousemove is not user activation: nothing may build an audio graph until
  // something is actually pressed.
  ok(await evl(`window.__ac === 0 && airStudio.audio.ctx === null`),
    'a drag alone builds no audio graph (autoplay-safe)', `→ ${await evl(`window.__ac`)} context(s)`);

  await evl(`document.getElementById('enter').click(); true`);
  await sleep(400);
  ok(await evl(`!!airStudio.audio.ctx && airStudio.audio.playing`),
    'Enter starts the music');
  ok(await evl(`window.__ac === 1`), 'exactly one audio context, reused for everything',
    `→ ${await evl(`window.__ac`)}`);
  await sleep(700);
  ok(await evl(`location.hash === '#apps'`), 'Enter opens the shelf');
  ok(await evl(`getComputedStyle(document.getElementById('shelf')).visibility === 'visible'`),
    'shelf scene is showing');
  ok(await evl(`document.querySelectorAll('.card').length === 3
    && document.querySelectorAll('.card.live').length === 3
    && document.querySelectorAll('.card[data-soon]').length === 0`),
    'three instruments listed, all playable');
  ok(await evl(`[...document.querySelectorAll('.card.live')].map(c => c.getAttribute('href')).sort().join(' ')
    === './drums.html ./piano.html ./play.html'`), 'each one points at its app');
  await sleep(1400);
  const rowTops = await evl(`(() => [...document.querySelectorAll('.card')]
    .map(n => Math.round(n.getBoundingClientRect().top)))()`);
  ok(new Set(rowTops).size === 1, 'every card in a row settles on the same line',
    `→ tops ${rowTops.join(', ')}`);
  /* The rejection shake is still in the stylesheet for whenever the shelf next
   * has something unfinished on it, and it once had a real bug: replacing the
   * entrance animation dropped the card back to its pre-entry offset, which is
   * invisible in review and obvious on screen. Trigger it directly rather than
   * losing the coverage along with the last coming-soon card. */
  await evl(`document.querySelector('.card').classList.add('nudge'); true`);
  await sleep(600);
  const shakenT = await evl(`getComputedStyle(document.querySelector('.card.nudge')).translate`);
  ok(!/22px/.test(shakenT), 'a shaken card keeps its settled offset, not its pre-entry one',
    `→ translate: ${shakenT}`);
  // The music must be muteable, and the choice must survive a reload.
  await evl(`document.getElementById('sound').click(); true`);
  await sleep(300);
  ok(await evl(`!airStudio.audio.on && !airStudio.audio.playing`), 'the sound toggle mutes the music');
  ok(await evl(`localStorage.getItem('air-studio.sound') === 'off'`), 'muting is remembered');
  await evl(`document.getElementById('sound').click(); true`);
  await sleep(300);
  ok(await evl(`airStudio.audio.on && airStudio.audio.playing`), 'and unmutes again');

  // Back button returns to the hero rather than leaving the site.
  await evl(`location.hash = ''; true`);
  await sleep(400);
  ok(await evl(`getComputedStyle(document.getElementById('hero')).visibility === 'visible'`),
    'clearing the hash returns to the hero');
  ok(exceptions.length === 0, 'no exceptions on the landing page', exceptions[0] || '');

  const homeShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot-home.png', import.meta.url), Buffer.from(homeShot.result.data, 'base64'));
  await evl(`location.hash = '#apps'; true`);
  await sleep(1800);          // card stagger runs ~1.05 s; let it settle before shooting
  const shelfShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot-shelf.png', import.meta.url), Buffer.from(shelfShot.result.data, 'base64'));
  console.log('  screenshots → test/screenshot-home.png, test/screenshot-shelf.png');

  await send('Page.navigate', { url: APP });

  console.log('\nboot');
  // The instrument must own the room: no interface sound, no music, nothing
  // competing with the strings the player is actually here for.
  await evl(`(() => { window.__ac = 0;
    for (const k of ['AudioContext','webkitAudioContext']) {
      const C = window[k]; if (!C) continue;
      const W = function (...a) { window.__ac++; return new C(...a); };
      W.prototype = C.prototype; window[k] = W;
    } })(); true`);
  await waitFor(`!!document.getElementById('go')`, 20000, 'start card');
  ok(true, 'page + modules load, start card shows');
  ok(exceptions.length === 0, 'no exceptions during module load', exceptions[0] || '');

  console.log('\nfirst-run tutorial');
  await waitFor(`!document.querySelector('.tut')?.hidden`, 8000, 'tutorial to open');
  ok(true, 'opens unprompted on a first visit');
  const slides = await evl(`document.querySelectorAll('.tut-dot').length`);
  ok(slides >= 5, 'has a full deck of slides', `${slides} steps`);
  const t1 = await evl(`document.querySelector('.tut-text h2').textContent`);
  await evl(`document.querySelector('[data-act="next"]').click(); true`);
  await sleep(200);
  const t2 = await evl(`document.querySelector('.tut-text h2').textContent`);
  ok(t1 !== t2 && !!t2, 'Next advances the deck', `"${t1}" → "${t2}"`);
  await evl(`document.querySelector('[data-act="back"]').click(); true`);
  await sleep(200);
  ok(await evl(`document.querySelector('.tut-text h2').textContent`) === t1, 'Back returns');
  ok(await evl(`document.querySelector('[data-act="back"]').disabled`), 'Back is disabled on slide 1');
  // The hand is drawn, so the canvas must have actually painted something.
  const painted = await evl(`(() => { const c = document.querySelector('.tut-canvas');
    const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < x.length; i += 4) if (x[i] > 8) n++;
    return n; })()`);
  ok(painted > 2000, 'the animated hand actually renders', `${painted} lit pixels`);

  const tutShot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot-tutorial.png', import.meta.url), Buffer.from(tutShot.result.data, 'base64'));

  await evl(`document.querySelector('[data-act="skip"]').click(); true`);
  await sleep(250);
  ok(await evl(`document.querySelector('.tut').hidden`), 'Skip closes it');
  ok(await evl(`localStorage.getItem('air-guitar.tutorial.v1') === '1'`), 'and records that it was seen');
  ok(await evl(`!document.getElementById('veil').hidden`), 'skipping lands on the start card, camera still off');
  await evl(`document.getElementById('tourBtn').click(); true`);
  await sleep(200);
  ok(await evl(`!document.querySelector('.tut').hidden`), '"Take the tour" reopens it on demand');
  await evl(`document.querySelector('[data-act="skip"]').click(); true`);
  await sleep(200);

  await evl(`document.getElementById('go').click(); true`);
  // Full pipeline: Tone init → fake camera → MediaPipe WASM + model from CDN.
  try {
    await waitFor(`document.getElementById('veil').hidden`, 90000, 'veil to clear');
  } catch (e) {
    const stage = await evl(`document.getElementById('veilCard').innerText.slice(0, 200)`);
    throw new Error(`${e.message} — stuck on veil: "${stage.replace(/\n/g, ' | ')}"`);
  }
  ok(true, 'camera + model boot, veil clears');

  // Headless GL is software-emulated and pathologically slow, so this also
  // exercises the live GPU→CPU downgrade. Wait for tracking to stabilise.
  /* Chrome's fake camera occasionally never produces a frame. Nothing
   * downstream can work when that happens, and reporting it as an app failure
   * sends you hunting a bug that isn't there — so check the <video> element
   * itself first and name the real culprit. */
  const videoLive = async () => {
    const a = await evl(`document.getElementById('video').currentTime`);
    await sleep(1200);
    return (await evl(`document.getElementById('video').currentTime`)) > a;
  };
  let live = false;
  for (let i = 0; i < 8 && !live; i++) live = await videoLive();
  if (!live) {
    console.log('  SKIP  the fake webcam produced no frames — environment, not the app');
    console.log('        (tracking assertions skipped; the rest of the run still applies)');
  }

  // Wait for a *settled* tracker. A delegate swap resets frames and emaMs to
  // zero, so sampling mid-swap reads "0 ms/frame" and looks like a dead pump —
  // which is exactly how this used to flake. Require it to be between swaps
  // with a real sample before believing any number it reports.
  const t0 = Date.now();
  let del = 'GPU', ema = 0, frames = 0;
  while (live && Date.now() - t0 < 90000) {
    const st = await evl(`(({ delegate, emaMs, frames, _swapping }) =>
      ({ delegate, emaMs, frames, swapping: !!_swapping }))(airGuitar.tracker)`);
    ({ delegate: del, emaMs: ema, frames } = st);
    if (!st.swapping && frames > 10 && ema > 0) break;
    await sleep(700);
  }
  const cam = await evl(`document.getElementById('pillCam').textContent`);
  ok(/camera live/.test(cam), 'camera pill live', `→ "${cam}"`);
  const perf = await evl(`document.getElementById('pillPerf').textContent`);
  ok(/fps/.test(perf), 'perf counter ticking', `→ "${perf}"`);
  // Headless runs everything in software, so the absolute number means nothing
  // about real hardware; what matters is that inference is actually happening
  // and the duty cycle left the rest of the page some time.
  if (live) ok(ema > 0 && frames > 10, 'inference runs and settles on a delegate',
    `→ ${del} @ ${ema.toFixed(1)} ms/frame over ${frames} frames`);
  const rvfc = !live ? 'skipped' : await evl(`new Promise((r) => { const v = document.getElementById('video');
    if (!v.requestVideoFrameCallback) return r('no-rvfc');
    v.requestVideoFrameCallback(() => r('fires')); setTimeout(() => r('silent'), 15000); })`);
  if (live) ok(rvfc === 'fires' || rvfc === 'no-rvfc', 'video frames reach the detection pump', `→ ${rvfc}`);
  const handsPill = await evl(`document.getElementById('pillHands').textContent`);
  ok(/no hands/.test(handsPill), 'tracking loop runs (fake feed has no hands)', `→ "${handsPill}"`);

  console.log('\nkeyboard path (drives the whole audio engine)');
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'3'})); true`);
  await sleep(150);
  const chord = await evl(`document.getElementById('chordName').textContent`);
  ok(chord && chord !== '—', 'key 3 selects a chord', `→ ${chord}`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'})); true`);
  await sleep(250);
  const stroke = await evl(`document.getElementById('badgeStroke').textContent`);
  ok(/↓/.test(stroke), 'downstroke fires through the audio engine', `→ "${stroke}"`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp'})); true`);
  await sleep(250);
  const stroke2 = await evl(`document.getElementById('badgeStroke').textContent`);
  ok(/↑/.test(stroke2), 'upstroke fires', `→ "${stroke2}"`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'q'})); true`);
  await sleep(250);
  const pluck = await evl(`document.getElementById('badgeStroke').textContent`);
  ok(/high e/.test(pluck), 'Q picks the 1st string on its own', `→ "${pluck}"`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'y'})); true`);
  await sleep(250);
  ok(/low E/.test(await evl(`document.getElementById('badgeStroke').textContent`)), 'Y picks the 6th string');

  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z'})); true`);
  await sleep(1200);
  const rh = await evl(`document.getElementById('rhState').textContent`);
  const stepsRan = await evl(`airGuitar.player.playing && airGuitar.player.next > 1`);
  ok(stepsRan, 'Z starts the ✊ pattern, steps schedule', `→ "${rh}"`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z'})); true`);
  await sleep(200);
  ok(await evl(`!airGuitar.player.playing`), 'Z again stops the pattern');
  ok(exceptions.length === 0, 'no exceptions after strums + pattern', exceptions[0] || '');

  console.log('\nmodes + editors');
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'g'})); true`);
  await sleep(200);
  ok(await evl(`airGuitar.S.chordMode === 'signs'`), 'G flips the fretting hand to sign chords');
  ok(await evl(`document.querySelectorAll('#chordstrip .cs').length === 5`),
    'the chord strip follows the mode', `→ ${await evl(`document.querySelectorAll('#chordstrip .cs').length`)}`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'g'})); true`);
  await sleep(200);
  ok(await evl(`document.querySelectorAll('#chordstrip .cs').length === 12`), 'and back to the 12-cell grid');
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f'})); true`);
  await sleep(200);
  ok(await evl(`airGuitar.S.playMode === 'finger'`), 'F flips the plucking hand to fingerstyle');
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f'})); true`);
  await sleep(200);

  await evl(`document.getElementById('bankBtn').click(); true`);
  await sleep(300);
  ok(await evl(`!document.getElementById('bankModal').hidden
    && document.querySelectorAll('#bankBody .bank-cell').length === 12`), 'chord bank opens with 12 editable cells');
  await evl(`(() => { const s = document.querySelector('#bankBody .bank-cell select');
    s.value = '0'; s.dispatchEvent(new Event('change')); })(); true`);
  await sleep(200);
  ok(await evl(`airGuitar.S.gridSpecs[0].root === 0`), 'editing a cell rewrites the bank');
  await evl(`document.getElementById('bankClose').click(); true`);

  await evl(`document.getElementById('patBtn').click(); true`);
  await sleep(300);
  const stepCount = await evl(`document.querySelectorAll('#patEdit .step').length`);
  ok(stepCount === 8, 'strum maker opens on an 8-step bar', `→ ${stepCount}`);
  ok(await evl(`document.querySelectorAll('#patBind .bind-row').length === 5`), 'all five signs are bindable');
  await evl(`(() => { const b = [...document.querySelectorAll('#patEdit .mini-seg button')].find(x => x.textContent === '16ths'); b.click(); })(); true`);
  await sleep(200);
  ok(await evl(`document.querySelectorAll('#patEdit .step').length === 16`), 'switching to 16ths regrows the bar');
  await evl(`(() => { const s = document.querySelector('#patEdit .step .sk'); s.value = 'd'; s.dispatchEvent(new Event('change')); })(); true`);
  await evl(`[...document.querySelectorAll('#patEdit .btn')].find(b => /Preview/.test(b.textContent)).click(); true`);
  await sleep(900);
  ok(await evl(`airGuitar.preview.playing && airGuitar.preview.next > 0`), 'preview plays the unsaved draft');
  await evl(`[...document.querySelectorAll('#patEdit .btn')].find(b => /Stop/.test(b.textContent)).click(); true`);
  await sleep(200);
  ok(await evl(`!airGuitar.preview.playing`), 'preview stops');
  // Feel multiplier: same tempo, twice the strums.
  const spsBefore = await evl(`airGuitar.stepsPerSecond(airGuitar.editors.draft, airGuitar.S.bpm)`);
  await evl(`[...document.querySelectorAll('#patEdit .rate-seg button')].find(b => b.textContent === '2×').click(); true`);
  await sleep(200);
  const spsAfter = await evl(`airGuitar.stepsPerSecond(airGuitar.editors.draft, airGuitar.S.bpm)`);
  ok(Math.abs(spsAfter - spsBefore * 2) < 1e-6, '2× doubles the draft strum rate',
    `${spsBefore} → ${spsAfter}`);
  await evl(`[...document.querySelectorAll('#patEdit .btn')].find(b => b.textContent === 'Save').click(); true`);
  await sleep(300);
  ok(await evl(`document.querySelectorAll('#patList .plitem').length === 7`),
    'saving adds the custom pattern to the list (5 built-in + 1 custom + new)',
    `→ ${await evl(`document.querySelectorAll('#patList .plitem').length`)}`);
  await evl(`document.getElementById('patClose').click(); true`);
  await sleep(400);
  const blob = await evl(`JSON.parse(localStorage.getItem('air-guitar.v2'))`);
  ok(blob.patterns.length === 1 && blob.patterns[0].rate === 2,
    'the custom pattern and its feel are persisted', `rate=${blob.patterns[0]?.rate}`);

  console.log('\ntempo');
  const bpm0 = await evl(`airGuitar.S.bpm`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:']'})); true`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:']'})); true`);
  await sleep(200);
  ok(await evl(`airGuitar.S.bpm`) === bpm0 + 8, '] nudges the tempo up',
    `${bpm0} → ${await evl(`airGuitar.S.bpm`)}`);
  ok(/strums\/sec/.test(await evl(`document.getElementById('rateNote').textContent`)),
    'the panel spells out the actual strum rate',
    `→ "${await evl(`document.getElementById('rateNote').textContent`)}"`);
  await evl(`(() => { const r = document.getElementById('rngBpm');
    r.value = 240; r.dispatchEvent(new Event('input')); })(); true`);
  await sleep(200);
  ok(await evl(`airGuitar.S.bpm === 240`), 'the tempo slider now reaches 240 BPM');
  // Speeding up mid-strum must not stutter the groove back to beat one.
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z'})); true`);
  await sleep(600);
  const n0 = await evl(`airGuitar.player.next`);
  await evl(`(() => { const r = document.getElementById('rngBpm');
    r.value = 60; r.dispatchEvent(new Event('input')); })(); true`);
  await sleep(400);
  ok(await evl(`airGuitar.player.playing && airGuitar.player.next >= ${n0}`),
    'retempo mid-pattern keeps playing without rewinding', `next ${n0} → ${await evl(`airGuitar.player.next`)}`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'z'})); true`);
  ok(exceptions.length === 0, 'no exceptions from the editors or tempo', exceptions[0] || '');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot.png', import.meta.url), Buffer.from(shot.result.data, 'base64'));
  console.log('\n  screenshot → test/screenshot.png');

  /* ---- pointer play: everything the keyboard does must be tappable ---- */
  // The gesture engine must run once per *detection*, not once per repaint:
  // re-feeding identical landmarks reads as zero motion and flattens dynamics.
  await evl(`(() => {
    const g = airGuitar.gestures, orig = g.update.bind(g);
    window.__gu = 0; window.__raf = 0;
    g.update = (...a) => { window.__gu++; return orig(...a); };
    const tick = () => { window.__raf++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })(); true`);
  await sleep(2500);
  const gu = await evl(`window.__gu`), rafs = await evl(`window.__raf`);
  ok(gu > 0 && gu < rafs * 0.8, 'the gesture engine runs per detection, not per repaint',
    `→ ${gu} updates vs ${rafs} frames`);

  /* The overlay only lines up with the feed while the stage box and the camera
   * frame are the same shape. A live stream can change shape under you — a
   * throughput renegotiation, a phone rotating — and when it does, `cover`
   * crops and every drawn hand slides toward the centre. */
  const shape = async () => await evl(`(() => {
    const v = document.getElementById('video'), s = document.getElementById('stage');
    const box = s.getBoundingClientRect();
    return { vid: v.videoWidth / v.videoHeight, box: box.width / box.height };
  })()`);
  const before = await shape();
  ok(Math.abs(before.vid - before.box) < 0.02, 'stage box matches the camera frame',
    `video ${before.vid.toFixed(3)} vs box ${before.box.toFixed(3)}`);
  // Knock the box out of shape the way a renegotiated stream would, then fire
  // the one signal the fix listens for. Driving it directly keeps the test
  // honest: the fake webcam only ever offers 16:9, so asking it to change
  // resolution proves nothing.
  const skewed = await evl(`(() => {
    const s = document.getElementById('stage'), v = document.getElementById('video');
    s.style.aspectRatio = '1.2';
    const b = s.getBoundingClientRect();   // forces layout before any rAF runs
    return { vid: v.videoWidth / v.videoHeight, box: b.width / b.height };
  })()`);
  ok(Math.abs(skewed.vid - skewed.box) > 0.2, 'a mismatched box is detectable at all',
    `video ${skewed.vid.toFixed(3)} vs box ${skewed.box.toFixed(3)}`);
  await evl(`document.getElementById('video').dispatchEvent(new Event('resize')); true`);
  await sleep(200);
  const after = await shape();
  ok(Math.abs(after.vid - after.box) < 0.02,
    'the stage re-matches the frame when the video reports a new size',
    `video ${after.vid.toFixed(3)} vs box ${after.box.toFixed(3)}`);
  // …and the overlay's backing store must follow, or hands land on stale pixels.
  ok(await evl(`(() => { const c = document.getElementById('overlay');
    const r = c.getBoundingClientRect();
    return Math.abs(c.width / Math.min(devicePixelRatio || 1, 2) - r.width) < 2; })()`),
    'the overlay canvas resizes with it');

  /* Regression: the `resize` event is the right signal, but relying on it
   * alone means one missed event — a browser/camera pairing that doesn't fire
   * it for a given renegotiation, or a delegate swap landing at an awkward
   * moment — leaves the feed looking zoomed and every hand displaced until
   * the page reloads. There is now a periodic self-heal that needs no event
   * at all, so prove that path directly instead of only the happy one. */
  const skewedNoEvent = await evl(`(() => {
    const s = document.getElementById('stage'), v = document.getElementById('video');
    s.style.aspectRatio = '1.2';
    const b = s.getBoundingClientRect();
    return { vid: v.videoWidth / v.videoHeight, box: b.width / b.height };
  })()`);
  ok(Math.abs(skewedNoEvent.vid - skewedNoEvent.box) > 0.2,
    'the box can be knocked out of shape with no resize event fired');
  // The self-heal lives in the ~333 ms perf tick; give it a couple of passes.
  await sleep(900);
  const healed = await shape();
  ok(Math.abs(healed.vid - healed.box) < 0.02,
    'and it heals on its own — nothing had to fire the resize event',
    `video ${healed.vid.toFixed(3)} vs box ${healed.box.toFixed(3)}`);

  /* Regression: the overlay caches the canvas width and height and maps every
   * normalised landmark through them, but it was only told to re-measure on a
   * window resize, a video resize, or an aspect-ratio drift. A layout change
   * that resizes the stage while *keeping its shape* — a scrollbar appearing as
   * the panel grows, the breakpoint that stacks the panel, a font finishing
   * loading — matches none of those, so the cache silently goes stale and every
   * hand gets drawn in the wrong place until the page is reloaded. Distinct
   * from the aspect-ratio bugs: here the box and the frame agree perfectly. */
  const measure = async () => await evl(`(() => {
    const c = document.getElementById('overlay'), r = c.getBoundingClientRect();
    return { css: Math.round(r.width), cached: Math.round(airGuitar.overlay.w),
             backing: Math.round(c.width / Math.min(devicePixelRatio || 1, 2)) };
  })()`);
  const sz0 = await measure();
  ok(sz0.css === sz0.cached, 'overlay starts in step with its canvas',
    `css ${sz0.css} vs cached ${sz0.cached}`);
  // Resize the stage without touching the window: widen the side panel's grid
  // track. Same shape, different size — exactly the case that slipped through.
  await evl(`document.querySelector('.layout').style.gridTemplateColumns = 'minmax(0,1fr) 520px'; true`);
  await sleep(500);
  const sz1 = await measure();
  ok(sz1.css !== sz0.css, 'the stage really did change size', `${sz0.css} → ${sz1.css}`);
  ok(sz1.css === sz1.cached && sz1.css === sz1.backing,
    'the overlay re-measures after a layout-only resize',
    `css ${sz1.css}, cached ${sz1.cached}, backing ${sz1.backing}`);
  /* The likeliest real-world trigger, and worth its own case: content growing
   * tall enough to summon a scrollbar narrows the layout viewport, which
   * narrows the stage — at a constant aspect ratio, so none of the old checks
   * noticed. Also records whether a window resize even fires for it. */
  await evl(`window.__rs = 0; addEventListener('resize', () => window.__rs++);
    const t = document.createElement('div'); t.id = 'tall';
    t.style.cssText = 'height:4000px'; document.body.appendChild(t); true`);
  await sleep(600);
  const bar = await measure();
  const firedResize = await evl('window.__rs');
  ok(bar.css === bar.cached && bar.css === bar.backing,
    'a scrollbar appearing does not desync the overlay',
    `css ${bar.css}, cached ${bar.cached}, window resize fired: ${firedResize > 0}`);
  await evl(`document.getElementById('tall')?.remove(); true`);
  await sleep(500);

  await evl(`document.querySelector('.layout').style.gridTemplateColumns = ''; true`);
  await sleep(400);
  const restored = await measure();
  ok(restored.css === restored.cached, 'and again when the layout comes back',
    `css ${restored.css} vs cached ${restored.cached}`);

  ok(await evl(`!('audio' in (window.airStudio || {}))`), 'the instrument page ships no intro audio module');
  ok(await evl(`window.__ac <= 1`), 'the instrument opens one audio context — its own, for the strings',
    `→ ${await evl(`window.__ac`)}`);

  console.log('\npointer play (no keyboard needed)');
  await evl(`document.querySelector('#chordstrip [data-i="4"]').click(); true`);
  await sleep(200);
  ok(await evl(`airGuitar.S.slot === 4`), 'tapping a chord cell selects it',
    `→ ${await evl(`document.getElementById('chordName').textContent`)}`);
  await evl(`document.querySelector('#slotlist [data-s="horns"]').click(); true`);
  await sleep(900);
  ok(await evl(`airGuitar.player.playing && airGuitar.player.next > 1`),
    'tapping a pattern chip starts it');
  await evl(`document.querySelector('#slotlist .slot.quiet').click(); true`);
  await sleep(250);
  ok(await evl(`!airGuitar.player.playing`), 'tapping the ✋ chip stops it');
  await evl(`document.getElementById('tapDown').click(); true`);
  await sleep(300);
  ok(/↓/.test(await evl(`document.getElementById('badgeStroke').textContent`)),
    'the touch strum button plays a downstroke');
  // Pick a chord whose low E actually sounds. Am, C and D all mute the 6th
  // string, and a step aimed at a muted string correctly resolves inward — so
  // asserting "low E" on one of those would be testing the wrong thing. Cell 2
  // is Em (022000), which rings all six.
  await evl(`document.querySelector('#chordstrip [data-i="2"]').click(); true`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f'})); true`);
  await sleep(200);
  await evl(`document.querySelector('#slotlist [data-str="0"]').click(); true`);
  await sleep(300);
  ok(/low E/.test(await evl(`document.getElementById('badgeStroke').textContent`)),
    'in fingerstyle, tapping a string chip plucks it',
    `→ "${await evl(`document.getElementById('badgeStroke').textContent`)}"`);
  await evl(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f'})); true`);

  /* ---- mobile viewport: nothing may overflow sideways ---- */
  console.log('\nmobile layout');
  const overflow = async (label) => {
    const bad = await evl(`(() => {
      const w = document.documentElement.clientWidth, out = [];
      for (const n of document.querySelectorAll('body *')) {
        if (!n.offsetParent && n !== document.body) continue;
        const r = n.getBoundingClientRect();
        if (r.width && (r.right > w + 1.5 || r.left < -1.5)) {
          out.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '.' + (n.className || '').toString().split(' ')[0]));
        }
      }
      return [...new Set(out)].slice(0, 6);
    })()`);
    ok(bad.length === 0, `${label}: nothing spills past the viewport`, bad.join(', '));
    ok(await evl(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
      `${label}: no horizontal scroll`,
      `→ ${await evl(`document.documentElement.scrollWidth`)} vs ${await evl(`document.documentElement.clientWidth`)}`);
  };

  // iPhone-class portrait viewport with a touch pointer.
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // Device metrics alone do not flip the `pointer`/`hover` media features —
  // touch emulation is what makes `pointer: coarse` match.
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  await sleep(700);
  ok(await evl(`matchMedia('(pointer: coarse)').matches`), 'the emulated device reports a coarse pointer');
  await overflow('app @390');
  ok(await evl(`getComputedStyle(document.querySelector('.touchbar')).display === 'grid'`),
    'the touch transport appears on a coarse pointer');

  // Portrait phone → ask for landscape. Both hands have to fit in frame.
  ok(await evl(`getComputedStyle(document.getElementById('rotate')).display === 'grid'`),
    'a portrait phone is asked to rotate');
  await evl(`document.getElementById('rotateSkip').click(); true`);
  await sleep(200);
  ok(await evl(`getComputedStyle(document.getElementById('rotate')).display === 'none'`),
    '…and can decline and carry on');
  await evl(`document.body.classList.remove('portrait-ok'); true`);
  // Rotating must dismiss it with no JS at all — the visibility is pure CSS.
  await send('Emulation.setDeviceMetricsOverride',
    { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  ok(await evl(`getComputedStyle(document.getElementById('rotate')).display === 'none'`),
    'rotating to landscape dismisses it by itself');
  await overflow('app @844 landscape');
  await send('Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await evl(`document.body.classList.add('portrait-ok'); true`);
  await sleep(400);
  ok(await evl(`getComputedStyle(document.querySelector('.foot-keys')).display === 'none'`),
    'keyboard-only hints are hidden where there is no keyboard');
  ok(await evl(`getComputedStyle(document.querySelector('.layout')).gridTemplateColumns.split(' ').length === 1`),
    'the panel stacks under the stage');
  const mShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(new URL('./screenshot-mobile.png', import.meta.url), Buffer.from(mShot.result.data, 'base64'));

  // The editors are the densest thing in the app — check them at 390 too.
  await evl(`document.getElementById('patBtn').click(); true`);
  await sleep(400);
  await overflow('strum maker @390');
  await evl(`document.getElementById('patClose').click(); true`);
  await evl(`document.getElementById('bankBtn').click(); true`);
  await sleep(400);
  await overflow('chord bank @390');
  await evl(`document.getElementById('bankClose').click(); true`);
  await sleep(200);

  // …and the landing page.
  await send('Page.navigate', { url: HOME });
  await waitFor(`!!window.airStudio`, 20000, 'intro on mobile');
  await sleep(600);
  await overflow('intro @390');
  await evl(`location.hash = '#apps'; true`);
  await sleep(1600);
  await overflow('shelf @390');
  ok(await evl(`getComputedStyle(document.querySelector('.cards')).gridTemplateColumns.split(' ').length === 1`),
    'the shelf stacks to one column');
  const hShot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(new URL('./screenshot-mobile-shelf.png', import.meta.url), Buffer.from(hShot.result.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  ok(exceptions.length === 0, 'no exceptions at mobile width', exceptions[0] || '');
  console.log('  screenshots → test/screenshot-mobile.png, test/screenshot-mobile-shelf.png');

  const warn = consoleLines.filter((l) => /^\[(error|warning)\]/.test(l));
  if (warn.length) console.log('\nconsole (error/warn):\n  ' + warn.slice(0, 12).join('\n  '));
  if (netErrors.length) { console.log('\nnetwork/log errors:\n  ' + netErrors.slice(0, 8).join('\n  ')); }
  ok(exceptions.length === 0 && netErrors.length === 0, 'clean console overall');
} catch (err) {
  fails++;
  console.log(`\n  FAIL  ${err.message}`);
  if (exceptions.length) console.log('  exceptions:\n    ' + exceptions.slice(0, 6).join('\n    '));
  if (consoleLines.length) console.log('  console tail:\n    ' + consoleLines.slice(-10).join('\n    '));
} finally {
  try { ws.close(); } catch {}
  browser.kill();
  server.close();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED\n` : '\nsmoke passed\n');
process.exit(fails ? 1 : 0);
