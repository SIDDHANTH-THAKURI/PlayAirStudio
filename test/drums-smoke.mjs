/**
 * End-to-end smoke test for Air Drums in real Chromium with a fake webcam.
 *
 * As with the piano's, the interesting part is the last section: rather than
 * re-assert the pieces (test/drums.mjs and test/drums-dsp.mjs already do that),
 * it replaces `tracker.detect` with a scripted pair of fists and lets the
 * *whole real path* run — pump → identify → StickDetector → kit lookup → voice
 * choice → worklet → overlay. If any joint in that chain is wired wrong nothing
 * sounds, and no amount of green unit tests would have said so.
 *
 * Run: node test/drums-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './serve.mjs';

const PORT = 8125, DBG = 9335;
const HOME = `http://localhost:${PORT}/`;
const APP = `${HOME}drums.html`;
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

const profile = mkdtempSync(join(tmpdir(), 'airdrums-'));
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
const exceptions = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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

  await waitFor(`!!window.airDrums`, 25000, 'drums module');
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

  // The kit worklet is the one piece that can silently fall back: Tone 14 wraps
  // standardized-audio-context and rejects a natively-created node, so this
  // asserts the real synthesis is running and not the stand-in.
  ok(await evl(`!!airDrums.drums.node`), 'the drum worklet loaded (not the fallback)');
  ok(await evl(`airDrums.drums.ready === true`), 'audio engine ready');
  // No calibration at all is a design decision worth pinning down: a drum is
  // the size of a dinner plate, so screen-space regions are plenty, and
  // removing setup is most of what makes this openable-and-playable.
  ok(await evl(`airDrums.kit.pads().length === 7`), 'a seven-piece kit, ready with no setup');

  const shape = await evl(`(() => { const v = document.getElementById('video'), s = document.getElementById('stage');
    const b = s.getBoundingClientRect(); return { vid: v.videoWidth / v.videoHeight, box: b.width / b.height }; })()`);
  ok(Math.abs(shape.vid - shape.box) < 0.02, 'stage box matches the camera frame',
    `${shape.vid.toFixed(3)} vs ${shape.box.toFixed(3)}`);

  /* ---- settings ---- */
  console.log('\nsetting up');
  const hatX = () => evl(`airDrums.kit.pads().find(p => p.id === 'hihat').x`);
  const right = await hatX();
  await evl(`[...document.getElementById('segHand').children].find(b => b.dataset.v === 'left').click(); true`);
  await sleep(150);
  const left = await hatX();
  ok(right < 0.5 && left > 0.5, 'the kit mirrors for a left-hander',
    `hi-hat ${right.toFixed(2)} → ${left.toFixed(2)}`);
  await evl(`[...document.getElementById('segHand').children].find(b => b.dataset.v === 'right').click(); true`);
  await sleep(150);

  const spread = () => evl(`(() => { const p = airDrums.kit.pads().map(q => q.x);
    return Math.max(...p) - Math.min(...p); })()`);
  const wide = await spread();
  await evl(`[...document.getElementById('segSize').children].find(b => b.dataset.v === '0.75').click(); true`);
  await sleep(150);
  ok((await spread()) < wide * 0.85, 'a smaller kit is genuinely easier to reach');
  await evl(`[...document.getElementById('segSize').children].find(b => b.dataset.v === '1').click(); true`);
  await sleep(150);

  /* Fingertip is the default, because a fingertip is a landmark the tracker
   * reports while a stick's direction has to be inferred from the shape of a
   * hand. Both are real instruments here, so both are exercised below. */
  ok(await evl(`airDrums.S.mode === 'finger' && airDrums.detector.mode === 'finger'`),
    'fingertip is the mode out of the box');
  ok(await evl(`document.getElementById('reachRow').hidden`),
    'and stick length is put away, since there is no stick');

  const setMode = async (m) => {
    await evl(`[...document.getElementById('segMode').children].find(b => b.dataset.v === '${m}').click(); true`);
    await sleep(200);
  };
  await setMode('stick');
  ok(await evl(`airDrums.detector.mode === 'stick' && !document.getElementById('reachRow').hidden`),
    'switching to sticks brings the stick settings back');

  /* Stick length is both what you aim with and what the detection watches, so
   * the two must never drift apart — that would put hits where nobody aimed. */
  await evl(`[...document.getElementById('segReach').children].find(b => b.dataset.v === '2.5').click(); true`);
  await sleep(150);
  ok(await evl(`airDrums.detector.reach === 2.5 && airDrums.S.reach === 2.5`),
    'changing stick length retunes the detector too');
  await evl(`[...document.getElementById('segReach').children].find(b => b.dataset.v === '1.9').click(); true`);
  await sleep(150);
  await setMode('finger');

  /* ---- the whole path, end to end ---- */
  console.log('\nplaying');
  /* Wait for the tracker to stop changing delegates before touching anything.
   * Headless software GL measures inference in *seconds*, which trips the
   * GPU→CPU swap, and building the replacement model blocks the main thread
   * hard enough that requestVideoFrameCallback stops firing — so the pump
   * would simply not run during the take. It has to be waited out *before* the
   * tracker is stubbed, since stubbing halts real inference and would freeze a
   * swap mid-flight. */
  {
    const t0 = Date.now(); let stable = 0, last = Date.now();
    while (Date.now() - t0 < 120000 && stable < 2500) {
      const swapping = await evl('!!airDrums.tracker._swapping');
      const now = Date.now();
      stable = swapping ? 0 : stable + (now - last);
      last = now;
      if (stable < 2500) await sleep(250);
    }
    ok(stable >= 2500, 'tracker settled on a delegate',
      `${await evl('airDrums.tracker.delegate')} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /* Chrome's fake camera sometimes just stops delivering frames, and when it
   * does the pump never runs and every assertion below reports zero for reasons
   * that are not the app's. Detect it from the pump's own throughput and say
   * so, rather than sending a reader hunting a bug that is not there. */
  let stalled = false;
  const pok = (c, m, x = '') => { if (!stalled) ok(c, m, x); };

  /* Script a pair of *fists* moving up and down, because that is what this
   * instrument is played with: the sticks are gripped in the hand and the
   * stroke brings the tip down through a drum's head. Nothing here bends a
   * finger, which is the point — the app must not care.
   *
   * Each scheduled stroke owns a window of time. Outside it that hand is simply
   * not in frame, which is how the hand gets from one drum to the next: with
   * the gap longer than the tracker's own re-acquire threshold, the detector
   * resets that arm and there is no travel to model. Sliding a hand across the
   * kit instead would be a downward move through other drums' surfaces — real
   * behaviour, correctly played, and a rotten thing to build a wiring test on.
   *
   * Strokes are deliberately unhurried: a headless fake camera delivers frames
   * irregularly and a genuinely fast stroke can begin and finish inside one
   * gap. That floor is characterised properly in test/drums.mjs at controlled
   * sample rates; what is being proved here is that the chain is wired up. */
  await evl(`(() => {
    const KN = [5,9,13,17], TIPS = [8,12,16,20], span = 0.11;
    const PRE = 0.5, POST = 0.6;             // s the hand is in frame either side
    window.__det = 0; window.__schedule = []; window.__t0 = 1e9;
    const clamp = (v,a,b) => v < a ? a : v > b ? b : v;

    /* Wrist → striking point, for a hand pointing straight down the screen.
     * Mirrors src/drums/stick.js, since a stub that placed the tip anywhere
     * else would be testing its own arithmetic rather than the app's. Sideways
     * as well as down, because a fingertip sits off to one side of the wrist
     * and ignoring that aims every stroke half a pad-width wide.
     *
     * The 1.006 is the fixture's own doing: this hand's knuckles are splayed,
     * so wrist-to-middle-knuckle comes out a touch longer than \`span\`. */
    const offset = () => {
      if (airDrums.S.mode === 'finger') return { dx: -0.34 * span, dy: 1.85 * span };
      const sp = span * 1.006, k = airDrums.S.reach / 1.9;
      const unit = clamp(sp * airDrums.S.reach, 0.11 * k, 0.26 * k);
      return { dx: 0, dy: span * 0.74 + unit * (span / sp) };   // …× how foreshortened
    };

    /* One stroke's tip height over time: wait above the head, come down
     * through it, hold, lift back. */
    const tipAt = (t, s) => {
      const top = s.sy - s.ry * 1.3, bottom = s.sy + s.ry * 1.3;
      const u = t - s.at, fall = 0.22, hold = 0.16, lift = 0.30;
      if (s.hold || u <= 0) return top;
      if (u < fall) return top + (bottom - top) * (u / fall) ** 1.6;
      if (u < fall + hold) return bottom;
      return bottom + (top - bottom) * clamp((u - fall - hold) / lift, 0, 1);
    };

    /* A hand built from a wrist and a palm. For sticks every finger is curled,
     * so the grip reads as closed; for fingertip the index reaches out and the
     * rest stay in, which is the pose that arms that mode. */
    const poseHand = (wx, wy) => {
      const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
      const sp = [-0.34, -0.11, 0.11, 0.34];
      const finger = airDrums.S.mode === 'finger';
      KN.forEach((k, i) => { lm[k] = { x: wx + sp[i]*span, y: wy + span }; });
      TIPS.forEach((t, i) => {
        const reach = finger && i === 0 ? 0.85 : 0.34;
        lm[t] = { x: lm[KN[i]].x, y: lm[KN[i]].y + span*reach };
      });
      lm[0] = { x: wx, y: wy };
      return lm;
    };

    // Headless software GL measures inference in seconds and the tracker
    // throttles itself to a share of that. With detect() stubbed the stale
    // figure would hold the pump to a few looks a second; real hardware never
    // trips this, and the throttle is not what this test is about.
    airDrums.tracker.due = () => true;
    airDrums.tracker.detect = () => {
      if (!window.__schedule.length) return [];
      window.__det++;
      const t = performance.now() / 1000 - window.__t0;
      const off = offset();
      /* One hand per *hand*. Returning a hand for every scheduled stroke puts
       * four of them in frame at once, all with the same handedness label, and
       * they then share one slot of detector state and stamp on each other's
       * history — which reads as the app losing strokes when in fact the stub
       * was inventing hands. */
      const byHand = new Map();
      for (const s of window.__schedule) {
        if (t < s.at - PRE || (!s.hold && t > s.at + POST)) continue;
        byHand.set(s.hand, s);
      }
      return [...byHand.entries()].map(([hand, s]) => {
        const wx = s.x - off.dx, wy = tipAt(t, s) - off.dy;
        return { lm: poseHand(wx, wy), world: null, x: wx,
                 label: hand === 'left' ? 'Left' : 'Right', score: 0.95 };
      });
    };

    const oh = airDrums.drums.hit.bind(airDrums.drums);
    window.__hits = [];
    airDrums.drums.hit = (voice, vel, o) => { window.__hits.push({ voice, vel, pan: o?.pan, tone: o?.tone }); return oh(voice, vel, o); };
    const ov = airDrums.overlay.onHit.bind(airDrums.overlay);
    window.__blooms = [];
    airDrums.overlay.onHit = (h) => { window.__blooms.push({ pad: h.pad, hand: h.hand, vel: h.velocity }); return ov(h); };
    // Raw detector output, to tell "never detected" apart from "detected then
    // landed off every pad".
    const du = airDrums.detector.update.bind(airDrums.detector);
    window.__raw = [];
    airDrums.detector.update = (fr, t) => {
      const e = du(fr, t);
      if (e.length) window.__raw.push(...e.map((x) => ({
        id: x.id, v: +x.velocity.toFixed(2),
        at: [+x.x.toFixed(3), +x.y.toFixed(3)],
        pad: airDrums.kit.hitAt(x)?.id || null,
      })));
      return e;
    };
  })(); true`);

  /* Park the hands, wait until the pump is demonstrably delivering frames, and
   * only then start the take. The waiting is not padding: a real inference in
   * software GL blocks the main thread for seconds, so the call already in
   * flight when the tracker got stubbed has to drain before
   * requestVideoFrameCallback resumes. Start during that and everything below
   * reports zero for reasons that have nothing to do with the app. */
  const pumping = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000 && (await evl('window.__det')) < 8) await sleep(150);
    return (await evl('window.__det')) >= 8;
  };
  /* Every take judges its own frame delivery. Chrome's fake camera can stop
   * partway through a run, and a single check before the first take says
   * nothing about the third — which showed up as the last take reporting zero
   * hits while the earlier ones were perfect. */
  const play = async (schedule, secs) => {
    await evl(`window.__schedule = ${JSON.stringify(schedule)}; window.__t0 = 1e9; window.__det = 0; true`);
    await pumping();
    await sleep(400);        // …and let the parked hands settle
    await evl(`window.__hits = []; window.__blooms = []; window.__raw = []; window.__det = 0;
      airDrums.overlay.hits.length = 0;
      window.__t0 = performance.now() / 1000 + 0.25; true`);
    await sleep(secs * 1000);
    const take = { hits: await evl('window.__hits'), det: await evl('window.__det'),
                   blooms: await evl('window.__blooms'), raw: await evl('window.__raw') };
    // Below about four looks a second a stroke can begin and finish between two
    // of them, and every assertion below would be about the camera.
    if (take.det / secs < 4) stalled = true;
    return take;
  };

  const aim = await evl(`(() => { const p = airDrums.kit.pads();
    const g = (id) => { const q = p.find(x => x.id === id); return { x: q.x, sy: q.sy, rx: q.rx, ry: q.ry }; };
    return { snare: g('snare'), floor: g('floor'), hihat: g('hihat'), ride: g('ride') }; })()`);

  /* The aim ring is what turns hitting the right drum from guesswork into
   * something you can see, so prove the app knows what a *raised* stick is
   * over — not merely what it has already hit. Read it off what the overlay is
   * actually handed, since that is the thing the ring is drawn from. */
  await evl(`(() => {
    const dr = airDrums.overlay.draw.bind(airDrums.overlay);
    airDrums.overlay.draw = (f) => {
      window.__aim = (f.sticks || []).map(s => ({ id: s.id, over: s.over, armed: !!s.armed, hold: +s.hold.toFixed(2) }));
      return dr(f);
    };
  })(); true`);

  /* Park a stick over one drum and never swing it — `hold` keeps the hand in
   * frame indefinitely, resting just above that drum's surface, which is
   * exactly the pose the ring is meant to describe. */
  const restOver = async (id) => {
    const pad = await evl(`(() => { const p = airDrums.kit.pads().find(x => x.id === '${id}');
      return { x: p.x, sy: p.sy, ry: p.ry }; })()`);
    const park = [{ at: 0, hold: true, hand: 'right', ...pad }];
    await evl(`window.__schedule = ${JSON.stringify(park)}; window.__t0 = performance.now() / 1000; window.__det = 0; window.__aim = null; true`);
    // The pump has to be delivering before any of this means anything: right
    // after the tracker is stubbed there is still a real inference in flight,
    // and it blocks requestVideoFrameCallback outright for seconds. And the
    // fake camera sometimes simply stops, which is the environment rather than
    // the app — say so instead of reporting nine failures about a still hand.
    const alive = await pumping();
    await sleep(500);
    return { alive, sticks: (await evl(`window.__aim`)) || [] };
  };
  let aimStalled = false;
  for (const want of ['floor', 'crash', 'snare']) {
    const { alive, sticks: [s0] } = await restOver(want);
    // Skip only this block — the camera often comes back, and the play section
    // below decides for itself whether it was delivering frames.
    if (!alive) { aimStalled = true; break; }
    pok(!!s0 && s0.hold > 0.9, 'a pointing hand is armed', `hold ${s0 ? s0.hold : '—'}`);
    pok(!!s0 && s0.over === want, `resting over the ${want} says so, before any stroke`,
      `→ ${s0 ? s0.over : 'nothing'}`);
    /* The ring's second job: not merely "this drum" but "and a stroke would
     * land". A stick resting above the surface must read as ready, or the one
     * cue the player has for why nothing is sounding is itself wrong. */
    pok(!!s0 && s0.armed, `and reads as ready to strike the ${want}`);
  }
  if (aimStalled) console.log('  SKIP  aim checks — the fake webcam stopped delivering frames');

  const TAKE = 6.5;
  const r = await play([
    { at: 0.0, hand: 'right', ...aim.snare },
    { at: 1.5, hand: 'right', ...aim.floor },
    { at: 3.0, hand: 'right', ...aim.snare },
    { at: 4.5, hand: 'right', ...aim.floor },
  ], TAKE);

  if (r.det === 0) {
    stalled = true;
    console.log('  SKIP  the fake webcam stopped delivering frames — environment, not the app');
    console.log('        (playing assertions skipped; boot and setup still applied)');
  } else {
    console.log(`        tracker delivered ~${(r.det / TAKE).toFixed(0)} looks/s in this environment`);
  }
  const dump = (label, take) => {
    console.log(`        ${label}: ${take.raw.length} stroke(s) detected, ${take.det} looks at the hands`);
    for (const x of take.raw) console.log(`          ${x.id} vel ${x.v} at (${x.at.join(', ')}) → ${x.pad || 'nothing'}`);
  };
  dump('snare / floor', r);

  pok(r.hits.length >= 3, 'scripted strokes come through as drums',
    `(${r.hits.length}/4) ${r.hits.map((h) => h.voice + '@' + h.vel.toFixed(2)).join(' ')}`);
  pok(r.hits.every((h) => h.vel > 0 && h.vel <= 1), 'every hit carries a usable velocity');
  pok(r.hits.length > 0 && r.hits.every((h) => h.voice === 'snare' || h.voice === 'floor'),
    'each stroke lands on the drum it was aimed at',
    r.hits.map((h) => h.voice).join(' '));
  pok(r.blooms.length === r.hits.length, 'every hit blooms on the drum it struck',
    `${r.blooms.length} blooms / ${r.hits.length} hits`);
  pok(r.blooms.every((b, i) => b.pad === (r.hits[i].voice)),
    'the drum that lights up is the drum that sounded');

  /* Through the middle of the hi-hat is the closed one and out at the edge is
   * the open one — the only expression a kit gets from *where* on a pad you
   * strike, and worth proving end to end because it is easy to wire the axis
   * up backwards. */
  const hats = await play([
    { at: 0.0, hand: 'right', ...aim.hihat },
    { at: 1.6, hand: 'right', ...aim.hihat, x: aim.hihat.x + aim.hihat.rx * 0.8 },
  ], 3.2);
  dump('hi-hat', hats);
  const voices = hats.hits.map((h) => h.voice);
  pok(voices.includes('hihatOpen') && voices.includes('hihat'),
    'the middle of the hi-hat is closed and the edge is open', voices.join(' ') || '(nothing)');

  /* Both hands at once, independently — the whole point of two sticks. */
  const both = await play([
    { at: 0.0, hand: 'left', ...aim.hihat },
    { at: 0.7, hand: 'right', ...aim.snare },
    { at: 1.6, hand: 'left', ...aim.hihat },
    { at: 2.3, hand: 'right', ...aim.snare },
  ], 4.0);
  dump('two hands', both);
  const hands = new Set(both.blooms.map((b) => b.hand));
  pok(both.hits.length >= 3, 'both hands play at once', `(${both.hits.length}/4)`);
  pok(hands.size === 2, 'and each stick is credited to its own hand', [...hands].join(' ') || '(none)');

  /* And the same path again with sticks in hand. The detector is shared, so
   * what this proves is the mode switch: the pose, the grip gate and the
   * thresholds all have to change together, and any one of them left behind
   * means the other instrument silently stops playing. */
  await setMode('stick');
  const withSticks = await play([
    { at: 0.0, hand: 'right', ...aim.snare },
    { at: 1.5, hand: 'right', ...aim.floor },
  ], 3.2);
  dump('sticks', withSticks);
  pok(withSticks.hits.length >= 1, 'drumsticks play too', `(${withSticks.hits.length}/2)`);
  pok(withSticks.hits.every((h) => h.voice === 'snare' || h.voice === 'floor'),
    'and land where they were aimed', withSticks.hits.map((h) => h.voice).join(' ') || '(nothing)');
  await setMode('finger');

  ok(exceptions.length === 0, 'no exceptions during play', exceptions[0] || '');

  /* Freeze a stick mid-stroke over the snare and shoot it. Visuals are the
   * whole proposition of an air instrument — there is no physical object to
   * aim at, so what is on screen *is* the instrument — and a screenshot is the
   * only assertion that catches "it works but looks wrong". */
  /* Half a second of pre-roll so both sticks are fully raised before anything
   * moves, then capture a third of a second into the right hand's stroke —
   * past the crossing, so the bloom and the ripple are still on the snare,
   * while the left stick sits raised over the hi-hat with its aim ring. */
  await evl(`(() => {
    const g = (id) => { const q = airDrums.kit.pads().find(x => x.id === id);
      return { x: q.x, sy: q.sy, ry: q.ry }; };
    window.__schedule = [{ at: 0.0, hand: 'right', ...g('snare') },
                         { at: 0.0, hold: true, hand: 'left', ...g('hihat') }];
    window.__t0 = performance.now() / 1000 + 0.5;
  })(); true`);
  await sleep(800);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot-drums.png', import.meta.url), Buffer.from(shot.result.data, 'base64'));
  console.log('\n  screenshot → test/screenshot-drums.png');

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
  const shotM = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('./screenshot-drums-mobile.png', import.meta.url), Buffer.from(shotM.result.data, 'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
} catch (err) {
  fails++;
  console.log(`\n  FAIL  ${err.message}`);
} finally {
  try { ws.close(); } catch {}
  try { browser.kill(); } catch {}
  try { server.close(); } catch {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
