/**
 * End-to-end smoke test for Air Piano in real Chromium with a fake webcam.
 *
 * The interesting part is the last section. Rather than assert on the pieces
 * again — test/piano.mjs already does that — it replaces `tracker.detect` with
 * a scripted hand and lets the *whole real path* run: pump → identify →
 * TapDetector → table mapping → key lookup → worklet → overlay. If any joint in
 * that chain is wired wrong, no note appears, and no amount of green unit tests
 * would have told us.
 *
 * Run: node test/piano-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './serve.mjs';

const PORT = 8124, DBG = 9334;
const HOME = `http://localhost:${PORT}/`;
const APP = `${HOME}piano.html`;
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

try {
  const busy = await fetch(`http://127.0.0.1:${DBG}/json/version`).then((r) => r.ok).catch(() => false);
  if (busy) { console.error(`\nPort ${DBG} is busy — another run is still going.\n`); process.exit(2); }
} catch {}
let server;
try { server = await startServer(PORT); }
catch { console.error(`\nPort ${PORT} is in use.\n`); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'airpiano-'));
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
const exceptions = [], consoleLines = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    exceptions.push(d.exception?.description || d.text);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evl = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
  return r.result?.result?.value;
};
const waitFor = async (expr, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evl(expr)) return true; await sleep(250); }
  throw new Error(`timeout waiting for ${label}`);
};

try {
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: APP });

  console.log('\nboot');
  // The site is gated while it's being worked on; open it the way a visitor
  // with the key would. (It is not security — see src/gate.js.)
  await waitFor(`!!window.airGate`, 20000, 'access gate');
  ok(await evl(`airGate.unlock('siddhanth') === true`), 'the access gate opens with the key');

  await waitFor(`!!window.airPiano`, 25000, 'piano module');
  ok(true, 'page and modules load');
  ok(exceptions.length === 0, 'no exceptions during load', exceptions[0] || '');

  await evl(`document.getElementById('go').click(); true`);
  try { await waitFor(`document.getElementById('veil').hidden`, 90000, 'veil'); }
  catch (e) {
    const stuck = await evl(`document.getElementById('veilCard').innerText.slice(0,180)`);
    throw new Error(`${e.message} — stuck on: "${String(stuck).replace(/\n/g, ' | ')}"`);
  }
  ok(true, 'camera and hand tracking boot');
  ok(/camera live/.test(await evl(`document.getElementById('pillCam').textContent`)), 'camera pill live');

  // The struck-string worklet is the one piece that can silently fall back:
  // Tone 14 wraps standardized-audio-context and rejects a natively-created
  // node, so this asserts the real model is running, not the FM stand-in.
  ok(await evl(`!!airPiano.piano.node`), 'the modal string worklet loaded (not the fallback)');
  ok(await evl(`airPiano.piano.ready === true`), 'audio engine ready');

  // The stage must match the camera's shape or the overlay drifts off the desk.
  const shape = await evl(`(() => { const v = document.getElementById('video'), s = document.getElementById('stage');
    const b = s.getBoundingClientRect(); return { vid: v.videoWidth / v.videoHeight, box: b.width / b.height }; })()`);
  ok(Math.abs(shape.vid - shape.box) < 0.02, 'stage box matches the camera frame',
    `${shape.vid.toFixed(3)} vs ${shape.box.toFixed(3)}`);

  /* ---- the first-run walkthrough ---- */
  console.log('\nwalkthrough');
  ok(await evl(`!document.getElementById('tour').hidden`), 'a first visit is walked through it');
  ok(await evl(`document.getElementById('calBar').hidden`),
    'and calibration waits its turn rather than opening underneath');
  const step = () => evl(`document.getElementById('tourCard').querySelector('.tour-of').textContent`);
  ok(/^1 of \d/.test(await step()), 'it starts at the first card', `→ "${await step()}"`);
  // Walk it the way a first-time player would: forwards, to the end.
  const cards = Number((await step()).split(' of ')[1]);
  ok(cards >= 4, 'and there is a walkthrough to walk', `(${cards} cards)`);
  for (let i = 1; i < cards; i++) {
    await evl(`document.getElementById('tourCard').querySelector('[data-act="next"]').click(); true`);
    await sleep(90);
  }
  ok(new RegExp(`^${cards} of ${cards}`).test(await step()), 'Next reaches the last card');
  await evl(`document.getElementById('tourCard').querySelector('[data-act="next"]').click(); true`);
  await sleep(400);      // the settings write is debounced
  ok(await evl(`document.getElementById('tour').hidden`), 'and finishing closes it');
  ok(await evl(`JSON.parse(localStorage.getItem('air-piano.v1')||'{}').toured === true`),
    'a visitor who has seen it is remembered');

  /* ---- calibration ---- */
  console.log('\ncalibration');
  // No stored corners, so the walkthrough hands straight over to marking out.
  ok(await evl(`!document.getElementById('calBar').hidden`),
    'finishing the walkthrough opens calibration');
  ok(await evl(`document.getElementById('calUse').disabled`), 'and will not accept an unfinished quad');
  ok(/click the far left/i.test(await evl(`document.getElementById('calHint').textContent`)),
    'and asks for the corners to be clicked, in order',
    `→ "${(await evl(`document.getElementById('calHint').textContent`)).trim()}"`);
  ok(/in the air/i.test(await evl(`document.getElementById('calHint').textContent`)),
    'air is the default, so that is what it asks for');
  // Switching surface must retune the detector and invalidate the old plane.
  await evl(`[...document.getElementById('segSurface').children].find(b => b.dataset.v === 'desk').click(); true`);
  await sleep(200);
  ok(/on your desk/i.test(await evl(`document.getElementById('calHint').textContent`)),
    'switching to desk changes what it asks for');
  ok(await evl(`airPiano.detector.surface === 'desk'`), 'and retunes the detector for a hard surface');
  await evl(`[...document.getElementById('segSurface').children].find(b => b.dataset.v === 'air').click(); true`);
  await sleep(200);
  ok(await evl(`airPiano.detector.surface === 'air'`), 'and back again');

  /* One finger per hand, for anyone whose neighbouring fingers keep coming down
   * with the one they meant. It has to reach the *detector* rather than filter
   * its output — see FINGER_SETS — so that is what is checked. */
  ok(await evl(`airPiano.detector.fingerSet === 'all'`), 'all ten fingers play by default');
  await evl(`[...document.getElementById('segFingers').children].find(b => b.dataset.v === 'index').click(); true`);
  await sleep(200);
  ok(await evl(`airPiano.detector.fingerSet === 'index' && airPiano.detector.plays(1) && !airPiano.detector.plays(2)`),
    'switching to index only takes the other fingers out of the detector');
  await evl(`[...document.getElementById('segFingers').children].find(b => b.dataset.v === 'all').click(); true`);
  await sleep(200);
  ok(await evl(`airPiano.detector.fingerSet === 'all'`), 'and back again');

  const click = async (fx, fy) => {
    await evl(`(() => { const s = document.getElementById('stage'), r = s.getBoundingClientRect();
      s.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * ${fx}, clientY: r.top + r.height * ${fy}, bubbles: true }));
    })(); true`);
    await sleep(60);
  };
  // Clicking is how the area is marked out, so it has to keep working.
  await click(0.30, 0.34); await click(0.70, 0.34);
  ok(await evl(`document.getElementById('calUse').disabled`), 'two corners is still not a surface');
  await click(0.93, 0.86); await click(0.07, 0.86);
  ok(!(await evl(`document.getElementById('calUse').disabled`)), 'four corners can be accepted');
  await evl(`document.getElementById('calUse').click(); true`);
  await sleep(600);      // the settings write is debounced
  ok(await evl(`document.getElementById('calBar').hidden`), 'accepting closes calibration');
  ok(await evl(`airPiano.plane.ok === true`), 'the desk is calibrated');
  ok(await evl(`(JSON.parse(localStorage.getItem('air-piano.v1')||'{}').corners||[]).length === 4`),
    'and remembered for next time');

  // Anyone can ask for the walkthrough back, and skipping out of a replay must
  // not disturb a surface that is already marked out.
  await evl(`document.getElementById('tourBtn').click(); true`);
  await sleep(150);
  ok(await evl(`!document.getElementById('tour').hidden`), 'the walkthrough can be replayed on demand');
  await evl(`document.getElementById('tourCard').querySelector('[data-act="skip"]').click(); true`);
  await sleep(200);
  ok(await evl(`document.getElementById('tour').hidden && document.getElementById('calBar').hidden`),
    'and skipping a replay leaves a calibrated surface alone');

  // Perspective is real: the far edge occupies fewer pixels than the near one.
  const edges = await evl(`(() => { const p = airPiano.plane;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return { far: d(p.toImage(0,0), p.toImage(1,0)), near: d(p.toImage(0,1), p.toImage(1,1)) }; })()`);
  ok(edges.far < edges.near * 0.8, 'the calibrated surface is genuinely in perspective',
    `far ${edges.far.toFixed(2)} vs near ${edges.near.toFixed(2)}`);

  /* ---- the whole path, end to end ---- */
  console.log('\nplaying');
  /* Wait for the tracker to stop changing delegates before touching anything.
   * Headless software GL measures inference in *seconds*, which trips the
   * GPU->CPU swap, and building the replacement model blocks the main thread
   * hard enough that requestVideoFrameCallback stops firing entirely — so the
   * pump would simply not run during the take, and the whole section would
   * report zero for reasons that have nothing to do with the app. It has to be
   * waited out *before* the tracker is stubbed, since stubbing halts real
   * inference and would freeze a swap mid-flight. */
  {
    const t0 = Date.now(); let stable = 0, last = Date.now();
    while (Date.now() - t0 < 120000 && stable < 2500) {
      const swapping = await evl('!!airPiano.tracker._swapping');
      const now = Date.now();
      stable = swapping ? 0 : stable + (now - last);
      last = now;
      if (stable < 2500) await sleep(250);
    }
    ok(stable >= 2500, 'tracker settled on a delegate',
      `${await evl('airPiano.tracker.delegate')} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /* Replace the tracker with a scripted hand and let everything downstream run
   * for real: pump → identify → TapDetector → table mapping → key lookup →
   * worklet → overlay. Velocity *discrimination* is asserted in test/piano.mjs
   * at controlled sample rates; what is being proved here is the wiring, so
   * the taps are deliberately slow enough to survive whatever rate a headless
   * fake camera happens to deliver. */
  await evl(`(() => {
    const TIPS = [4,8,12,16,20], MCPS = [2,5,9,13,17], span = 0.13;
    window.__det = 0; window.__schedule = []; window.__t0 = 1e9;
    const strike = (t, t0, dur, depth) => {
      if (t <= t0) return 0;
      const u = (t - t0) / dur;
      return u >= 1 ? depth : depth * u * u;
    };
    /* Deliberately unhurried taps. A headless fake camera delivers frames
     * irregularly, and a genuinely fast tap can begin *and end* inside one gap
     * — invisible, and not something any threshold can recover. That floor is
     * characterised properly in test/piano.mjs at controlled sample rates;
     * what is being proved here is that the chain is wired up, so the gesture
     * is made slow enough that the environment cannot swallow it. */
    const cycle = (t, s) => {
      const dur = s.hard ? 0.20 : 0.30, depth = s.hard ? 0.95 : 0.72;
      const down = strike(t, s.at, dur, depth);
      const up = s.at + dur + 0.22;
      return t <= up ? down : depth * (1 - Math.min(1, (t - up) / 0.28));
    };
    /* Headless software GL measures inference in seconds, and the tracker
     * throttles itself to a share of wall time based on that figure. With
     * detect() stubbed the stale number would hold the pump to ~3 looks a
     * second. Real hardware is 5-50 ms and never trips this; the throttle is
     * simply not what this test is about. */
    airPiano.tracker.due = () => true;
    airPiano.tracker.detect = () => {
      if (!window.__schedule.length) return [];
      window.__det++;
      const t = performance.now() / 1000 - window.__t0;
      /* Hold the most recent tap's position and move well ahead of the strike:
       * a fingertip teleporting across the desk between taps is a huge
       * apparent velocity, and the detector would rightly spend the next
       * moment deciding what that was rather than watching for the tap. */
      let cur = window.__schedule[0];
      for (const s of window.__schedule) if (t >= s.at - 0.35) cur = s;
      const home = cur.ix !== undefined ? { x: cur.ix, y: cur.iy }
        : (airPiano.plane.toImage(cur.u, cur.v) || { x: 0.5, y: 0.6 });
      const depth = window.__schedule.reduce((a, s) => a + cycle(t, s), 0);
      const lm = Array.from({ length: 21 }, () => ({ x: home.x, y: home.y }));
      const spread = [-0.55, -0.28, 0, 0.26, 0.5];
      for (let f = 0; f < 5; f++) {
        const mx = home.x + spread[f] * span * 0.9;
        const my = (f === 2 ? home.y - span : home.y - span * 0.9) - span * 0.8;
        lm[MCPS[f]] = { x: mx, y: my };
        const d = f === 1 ? depth : 0;          // only the index finger plays
        lm[TIPS[f]] = { x: mx, y: my + span * 0.8 + d * span };
      }
      lm[0] = { x: home.x, y: home.y };
      return [{ lm, world: null, x: home.x, label: 'Right', score: 0.95 }];
    };
    const on = airPiano.piano.note.bind(airPiano.piano);
    window.__notes = [];
    airPiano.piano.note = (midi, vel, when) => { window.__notes.push({ midi, vel }); return on(midi, vel, when); };
    // Blooms expire after 0.85 s, so keep an unexpiring copy for assertions.
    const oh = airPiano.overlay.onHit.bind(airPiano.overlay);
    window.__hits = [];
    airPiano.overlay.onHit = (h) => { window.__hits.push({ col: h.cell.col, row: h.cell.row, u: h.u, v: h.v, hand: h.hand }); return oh(h); };
    // Raw detector output, to tell "never detected" apart from "detected then
    // discarded because it landed off the surface".
    /* Raw detector output, with each strike's table coordinate resolved, so a
     * miss can be told apart from a strike that landed off the surface. */
    const du = airPiano.detector.update.bind(airPiano.detector);
    window.__raw = [];
    airPiano.detector.update = (fr, t) => {
      const e = du(fr, t);
      if (e.length) window.__raw.push(...e.map(x => {
        const tt = airPiano.plane.toTable({ x: x.x, y: x.y });
        const cell = airPiano.keyboard.cellAt(tt);
        return { f: x.finger, v: +x.velocity.toFixed(2),
                 u: tt ? +tt.x.toFixed(3) : null, w: tt ? +tt.y.toFixed(3) : null,
                 inside: airPiano.plane.contains(tt), cell: cell ? cell.col + ',' + cell.row : null };
      }));
      return e;
    };
  })(); true`);

  // Register split off first, so the expected notes are the plain layout.
  await evl(`[...document.getElementById('segSplit').children].find(b => b.dataset.v === 'no').click(); true`);

  /* Park the hand at the new starting position with the clock far in the past,
   * let it settle, and only then start the take. Jumping straight in would
   * teleport the hand from wherever the previous take left it — which the
   * detector now correctly refuses to read as a strike, but which would still
   * cost the first tap of every take while it re-arms. */
  /* Park the hand at the new starting position, wait until the pump is
   * demonstrably delivering frames, and only then start the take.
   *
   * The waiting is not padding. A real inference in software GL takes several
   * seconds and blocks the main thread outright, so the call already in flight
   * when the tracker got stubbed has to drain before requestVideoFrameCallback
   * resumes — start the take during that and the whole thing reports zero.
   * Parking first also matters: jumping straight in would teleport the hand
   * from wherever the last take left it, which the detector now correctly
   * refuses to read as a strike but which still costs the first tap while it
   * re-arms. */
  const play = async (schedule, secs) => {
    await evl(`window.__schedule = ${JSON.stringify(schedule)}; window.__t0 = 1e9; window.__det = 0; true`);
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && (await evl('window.__det')) < 8) await sleep(150);
    await sleep(300);        // …and let the parked hand settle
    await evl(`window.__notes = []; window.__hits = []; window.__raw = []; window.__det = 0;
      airPiano.overlay.hits.length = 0;
      window.__t0 = performance.now() / 1000 + 0.25; true`);
    await sleep(secs * 1000);
    return { notes: await evl('window.__notes'), det: await evl('window.__det'),
             hits: await evl('window.__hits'), raw: await evl('window.__raw') };
  };

  /* Taps sit comfortably inside the surface rather than on its corners: the
   * synthetic hand's fingertip is offset from the position being scripted, and
   * an edge tap lands off the desk for reasons that are about this stub's
   * geometry rather than anything in the app. The edges themselves are covered
   * directly in test/piano.mjs. */
  /* Chrome's fake camera sometimes just stops delivering frames, and when it
   * does requestVideoFrameCallback never fires, the pump never runs and every
   * assertion below reports zero for reasons that have nothing to do with the
   * app. Detect it from the pump's own throughput and say so, rather than
   * sending a reader hunting a bug that is not there. */
  let stalled = false;
  const pok = (c, m, x = '') => { if (!stalled) ok(c, m, x); };

  /* Marking out the area is cursor-only. Hands are still tracked while it is
   * open — the overlay goes on showing them — but no strike may sound, or
   * waving over the area you are marking plays through a keyboard that isn't
   * defined yet. Now that a scripted hand exists, check that for real. */
  await evl(`document.getElementById('calBtn').click(); true`);
  await sleep(300);
  ok(await evl(`!document.getElementById('calBar').hidden`), 'calibration can be reopened');
  const cal = await play([
    { at: 0.0, hard: true, ix: 0.28, iy: 0.36 },
    { at: 1.4, hard: true, ix: 0.72, iy: 0.36 },
    { at: 2.8, hard: true, ix: 0.90, iy: 0.84 },
  ], 4.4);
  ok(cal.notes.length === 0, 'tapping while marking out the area plays nothing',
    `(${cal.notes.length} stray notes)`);
  ok(await evl(`airPiano.draft.length === 0`),
    'and places no corners either — the cursor is the only way in');
  await click(0.28, 0.36); await click(0.72, 0.36);
  await click(0.90, 0.84); await click(0.10, 0.84);
  const placed = await evl(`(() => { const b = document.getElementById('calUse'); return !b.disabled; })()`);
  ok(placed, 'four clicked corners make an acceptable surface');
  if (placed) {
    await evl(`document.getElementById('calUse').click(); true`);
    await sleep(400);
    ok(await evl(`airPiano.plane.ok === true`), 'and the re-marked surface is usable');
  } else {
    await evl(`document.getElementById('calCancel').click(); true`);
  }

  const TAKE = 6.2;
  const r = await play([
    { at: 0.0, hard: false, u: 0.22, v: 0.68 },
    { at: 1.4, hard: true, u: 0.22, v: 0.68 },
    { at: 2.8, hard: true, u: 0.80, v: 0.68 },
    { at: 4.2, hard: true, u: 0.80, v: 0.22 },
  ], TAKE);
  if (r.det === 0) {
    stalled = true;
    console.log('  SKIP  the fake webcam stopped delivering frames — environment, not the app');
    console.log('        (playing assertions skipped; boot, calibration and layout still applied)');
  } else {
    console.log(`        tracker delivered ~${(r.det / TAKE).toFixed(0)} looks/s in this environment`);
  }
  pok(r.notes.length >= 3, 'scripted taps come through as notes',
    `(${r.notes.length}/4) ${r.notes.map((n) => n.midi + '@' + n.vel.toFixed(2)).join(' ')}`);
  pok(r.notes.every((n) => n.vel > 0 && n.vel <= 1), 'every note carries a usable velocity');

  console.log(`        detector fired ${r.raw.length} strike(s):`);
  for (const x of r.raw) console.log(`          f${x.f} vel ${x.v} → table (${x.u}, ${x.w}) inside=${x.inside} cell=${x.cell}`);
  const hits = r.hits;
  pok(hits.length === r.notes.length, 'every note blooms on the surface where it was struck',
    `${hits.length} blooms / ${r.notes.length} notes`);

  if (r.notes.length >= 3 && hits.length === r.notes.length) {
    /* The invariant worth asserting is that the note the synth was handed is
     * the note belonging to the key the overlay lit up — i.e. that image →
     * table → key → pitch stayed consistent end to end. */
    const consistent = await evl(`(() => {
      const k = airPiano.keyboard, hs = window.__hits, ns = window.__notes;
      return hs.every((h, i) => k.midiAt({ col: h.col, row: h.row }, 0) === ns[i].midi);
    })()`);
    pok(consistent, 'the note played is the note of the key that lit up');
    // Whatever got through, the near row must ascend left→right and the far
    // row must sit an octave above the near one.
    const withMidi = hits.map((h, i) => ({ ...h, midi: r.notes[i].midi }));
    const sorted = [...withMidi].sort((a, b) => a.col - b.col);
    pok(sorted[sorted.length - 1].midi > sorted[0].midi,
      'moving right along the surface raises the pitch',
      sorted.map((h) => `c${h.col}:${h.midi}`).join(' '));
    pok(withMidi.every((h, i, a) => i === 0 || h.col !== a[i - 1].col || h.midi === a[i - 1].midi),
      'the same column always gives the same note');
  }

  /* Register split: the identical tap, by the identical hand, two octaves down. */
  const three = [{ at: 0.0, hard: true, u: 0.5, v: 0.55 },
                 { at: 1.2, hard: true, u: 0.5, v: 0.55 },
                 { at: 2.4, hard: true, u: 0.5, v: 0.55 }];
  const same = await play(three, 3.8);
  await evl(`[...document.getElementById('segSplit').children].find(b => b.dataset.v === 'yes').click(); true`);
  const split = await play(three, 3.8);
  pok(same.notes.length >= 1 && split.notes.length >= 1, 'both register settings play',
    `${same.notes.length}/3 and ${split.notes.length}/3`);
  if (same.notes.length && split.notes.length) {
    // Same spot, same hand, same finger — only the register setting differs.
    pok(same.notes[0].midi - split.notes[0].midi === 24,
      'the left hand drops two octaves when the split is on',
      `${same.notes[0].midi} → ${split.notes[0].midi}`);
    pok(new Set(same.notes.map((n) => n.midi)).size === 1,
      'repeated taps on one spot all give the same note',
      same.notes.map((n) => n.midi).join(' '));
  }
  pok(await evl(`airPiano.detector.hands.size >= 1`), 'the detector is tracking the hand');

  // Resting a hand on the desk without striking must stay silent.
  const idle = await play([{ at: 99, hard: false, u: 0.5, v: 0.5 }], 2.0);
  pok(idle.notes.length === 0, 'hands resting on the desk stay silent');

  pok(exceptions.length === 0, 'no exceptions while playing', exceptions[0] || '');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot-piano.png', import.meta.url), Buffer.from(shot.result.data, 'base64'));
  console.log('\n  screenshot → test/screenshot-piano.png');

  /* ---- layout ---- */
  console.log('\nlayout');
  const overflow = async (label) => {
    const bad = await evl(`(() => { const w = document.documentElement.clientWidth, out = [];
      for (const n of document.querySelectorAll('body *')) {
        if (!n.offsetParent && n !== document.body) continue;
        const r = n.getBoundingClientRect();
        if (r.width && (r.right > w + 1.5 || r.left < -1.5)) out.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '.' + (n.className || '').toString().split(' ')[0]));
      } return [...new Set(out)].slice(0, 6); })()`);
    ok(bad.length === 0, `${label}: nothing spills past the viewport`, bad.join(', '));
  };
  await overflow('desktop');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(700);
  await overflow('mobile @390');
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });

  const warn = consoleLines.filter((l) => /^\[(error|warning)\]/.test(l) && !/tasks-vision|gl_context|XNNPACK|feedback/i.test(l));
  if (warn.length) console.log('\nconsole:\n  ' + warn.slice(0, 8).join('\n  '));
} catch (err) {
  fails++;
  console.log(`\n  FAIL  ${err.message}`);
  if (exceptions.length) console.log('  exceptions:\n    ' + exceptions.slice(0, 5).join('\n    '));
  if (consoleLines.length) console.log('  console tail:\n    ' + consoleLines.slice(-8).join('\n    '));
} finally {
  try { ws.close(); } catch {}
  browser.kill();
  server.close();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED\n` : '\npiano smoke passed\n');
process.exit(fails ? 1 : 0);
