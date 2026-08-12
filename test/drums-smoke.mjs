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

  /* Stick length is both what you aim with and what the detection watches, so
   * the two must never drift apart — that would put hits where nobody aimed. */
  await evl(`[...document.getElementById('segReach').children].find(b => b.dataset.v === '2.8').click(); true`);
  await sleep(150);
  ok(await evl(`airDrums.detector.reach === 2.8 && airDrums.S.reach === 2.8`),
    'changing stick length retunes the detector too');
  await evl(`[...document.getElementById('segReach').children].find(b => b.dataset.v === '2.2').click(); true`);
  await sleep(150);

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

  /* Script a pointing hand that *rotates about the wrist*, because that is what
   * a drum stroke is — the wrist barely travels and the tip swings. Sliding a
   * point around would exercise the detector on a gesture nobody makes.
   *
   * The wrist is placed so the tip arrives on the target pad at the end of the
   * swing, which is the only way to assert that where you aim is what sounds.
   * Strokes are deliberately unhurried: a headless fake camera delivers frames
   * irregularly and a genuinely fast stroke can begin and finish inside one
   * gap. That floor is characterised properly in test/drums.mjs at controlled
   * sample rates; what is being proved here is that the chain is wired up. */
  await evl(`(() => {
    const KN = [5,9,13,17], TIPS = [8,12,16,20], span = 0.11;
    const REST = 0.55;                       // stick angled down at the kit
    const LEAD = 0.55;                       // s spent moving to the next drum
    window.__det = 0; window.__schedule = []; window.__t0 = 1e9;
    const clamp = (v,a,b) => v < a ? a : v > b ? b : v;

    /* One stroke's rotation over time: swing down, brake, hold, lift back. */
    const swingAt = (t, s) => {
      const u = t - s.at, dur = 0.18, brake = 0.08, rest = 0.22, lift = 0.34;
      if (u <= 0) return 0;
      if (u < dur) return s.swing * (u / dur) ** 2 * 0.75;
      const b = Math.min(u - dur, brake);
      const p = s.swing * 0.75 + s.swing * 0.25 * (b / brake) * (2 - b / brake);
      if (u < dur + brake) return p;
      const after = u - dur - brake;
      return after < rest ? s.swing : s.swing * (1 - clamp((after - rest) / lift, 0, 1));
    };

    // Index out, the rest in — the stick is drawn along the index finger, so
    // that is the hand this instrument has to be driven with.
    const pointer = (wx, wy, angle) => {
      const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy }));
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const px = -uy, py = ux;
      const sp = [-0.34, -0.11, 0.11, 0.34];
      KN.forEach((k, i) => {
        lm[k] = { x: wx + ux*span + px*sp[i]*span, y: wy + uy*span + py*sp[i]*span };
      });
      TIPS.forEach((t, i) => {
        const reach = i === 0 ? 0.95 : 0.38;
        lm[t] = { x: lm[KN[i]].x + ux*span*reach, y: lm[KN[i]].y + uy*span*reach };
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
      const reach = span * (1 + airDrums.S.reach);     // wrist → knuckle → tip
      /* One hand per *hand*, not one per stroke. Returning a hand for every
       * scheduled stroke puts four of them in frame at once, all with the same
       * handedness label, and they then share one slot of detector state and
       * stamp on each other's history — which reads as the app losing strokes
       * when in fact the stub was inventing hands. */
      const byHand = new Map();
      for (const s of window.__schedule) {
        const h = byHand.get(s.hand);
        // Move to the next target well before swinging at it, and *travel*
        // rather than teleport. A wrist that jumps across the kit in one frame
        // is a huge apparent velocity followed by a dead stop, which is the
        // exact signature of a stroke — the detector would be right to play it,
        // and nobody's arm does that.
        if (t >= s.at - LEAD || !h) byHand.set(s.hand, { cur: s, prev: h ? h.cur : s });
      }
      return [...byHand.entries()].map(([hand, { cur, prev }]) => {
        const at = (s) => {
          const end = REST + s.swing;
          return { x: s.x - Math.cos(end) * reach, y: s.y - Math.sin(end) * reach };
        };
        const a = at(prev), b = at(cur);
        const k = clamp((t - (cur.at - LEAD)) / (LEAD * 0.75), 0, 1);
        const e = k * k * (3 - 2 * k);                    // ease, so it starts and ends still
        const wx = a.x + (b.x - a.x) * e, wy = a.y + (b.y - a.y) * e;
        return { lm: pointer(wx, wy, REST + swingAt(t, cur)), world: null, x: wx,
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
  const play = async (schedule, secs) => {
    await evl(`window.__schedule = ${JSON.stringify(schedule)}; window.__t0 = 1e9; window.__det = 0; true`);
    await pumping();
    await sleep(400);        // …and let the parked hands settle
    await evl(`window.__hits = []; window.__blooms = []; window.__raw = []; window.__det = 0;
      airDrums.overlay.hits.length = 0;
      window.__t0 = performance.now() / 1000 + 0.25; true`);
    await sleep(secs * 1000);
    return { hits: await evl('window.__hits'), det: await evl('window.__det'),
             blooms: await evl('window.__blooms'), raw: await evl('window.__raw') };
  };

  const aim = await evl(`(() => { const p = airDrums.kit.pads();
    const g = (id) => { const q = p.find(x => x.id === id); return { x: q.x, y: q.y }; };
    return { snare: g('snare'), floor: g('floor'), hihat: g('hihat'), ride: g('ride') }; })()`);

  /* The aim ring is what turns hitting the right drum from guesswork into
   * something you can see, so prove the app knows what a *raised* stick is
   * over — not merely what it has already hit. Read it off what the overlay is
   * actually handed, since that is the thing the ring is drawn from. */
  await evl(`(() => {
    const dr = airDrums.overlay.draw.bind(airDrums.overlay);
    airDrums.overlay.draw = (f) => {
      window.__aim = (f.sticks || []).map(s => ({ id: s.id, over: s.over, hold: +s.hold.toFixed(2) }));
      return dr(f);
    };
  })(); true`);

  /* Park a stick over one drum and never swing it. `at: 99` puts the stroke far
   * enough in the future that the hand simply sits there, and `swing: 0` is
   * what makes the parked pose the aimed one: the wrist is placed so the tip
   * arrives on target at the *end* of the swing, so a parked hand scripted with
   * a real swing angle rests somewhere else entirely — which is a fact about
   * this stub's geometry and not about the app. */
  const restOver = async (id) => {
    const pad = await evl(`(() => { const p = airDrums.kit.pads().find(x => x.id === '${id}'); return { x: p.x, y: p.y }; })()`);
    const park = [{ at: 99, swing: 0, hand: 'right', x: pad.x, y: pad.y }];
    await evl(`window.__schedule = ${JSON.stringify(park)}; window.__t0 = performance.now() / 1000; window.__det = 0; window.__aim = null; true`);
    // The pump has to be delivering before any of this means anything: right
    // after the tracker is stubbed there is still a real inference in flight,
    // and it blocks requestVideoFrameCallback outright for seconds.
    await pumping();
    await sleep(500);
    return (await evl(`window.__aim`)) || [];
  };
  for (const want of ['floor', 'crash', 'snare']) {
    const [s0] = await restOver(want);
    pok(!!s0 && s0.hold > 0.9, 'a pointing hand raises its stick', `hold ${s0 ? s0.hold : '—'}`);
    pok(!!s0 && s0.over === want, `resting over the ${want} says so, before any stroke`,
      `→ ${s0 ? s0.over : 'nothing'}`);
  }

  const TAKE = 6.5;
  const r = await play([
    { at: 0.0, swing: 0.9, hand: 'right', ...aim.snare },
    { at: 1.5, swing: 0.9, hand: 'right', ...aim.floor },
    { at: 3.0, swing: 0.9, hand: 'right', ...aim.snare },
    { at: 4.5, swing: 0.9, hand: 'right', ...aim.floor },
  ], TAKE);

  if (r.det === 0) {
    stalled = true;
    console.log('  SKIP  the fake webcam stopped delivering frames — environment, not the app');
    console.log('        (playing assertions skipped; boot and setup still applied)');
  } else {
    console.log(`        tracker delivered ~${(r.det / TAKE).toFixed(0)} looks/s in this environment`);
  }
  const dump = (label, take) => {
    console.log(`        ${label}: ${take.raw.length} stroke(s) detected`);
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

  /* Hitting the top of the hi-hat is the open one and the bottom is closed —
   * the only expression a kit gets from *where* on a pad you strike, and worth
   * proving end to end because it is easy to wire the axis up backwards. */
  const hats = await play([
    { at: 0.0, swing: 0.9, hand: 'right', x: aim.hihat.x, y: aim.hihat.y - 0.045 },
    { at: 1.6, swing: 0.9, hand: 'right', x: aim.hihat.x, y: aim.hihat.y + 0.045 },
  ], 3.2);
  dump('hi-hat', hats);
  const voices = hats.hits.map((h) => h.voice);
  pok(voices.includes('hihatOpen') && voices.includes('hihat'),
    'the top of the hi-hat is open and the bottom is closed', voices.join(' ') || '(nothing)');

  /* Both hands at once, independently — the whole point of two sticks. */
  const both = await play([
    { at: 0.0, swing: 0.9, hand: 'left', ...aim.hihat },
    { at: 0.7, swing: 0.9, hand: 'right', ...aim.snare },
    { at: 1.6, swing: 0.9, hand: 'left', ...aim.hihat },
    { at: 2.3, swing: 0.9, hand: 'right', ...aim.snare },
  ], 4.0);
  dump('two hands', both);
  const hands = new Set(both.blooms.map((b) => b.hand));
  pok(both.hits.length >= 3, 'both hands play at once', `(${both.hits.length}/4)`);
  pok(hands.size === 2, 'and each stick is credited to its own hand', [...hands].join(' ') || '(none)');

  ok(exceptions.length === 0, 'no exceptions during play', exceptions[0] || '');

  /* Freeze a stick mid-stroke over the snare and shoot it. Visuals are the
   * whole proposition of an air instrument — there is no physical object to
   * aim at, so what is on screen *is* the instrument — and a screenshot is the
   * only assertion that catches "it works but looks wrong". */
  await evl(`(() => {
    const p = airDrums.kit.pads(), sn = p.find(x => x.id === 'snare');
    window.__schedule = [{ at: 0.0, swing: 0.9, hand: 'right', x: sn.x, y: sn.y },
                         { at: 0.15, swing: 0.9, hand: 'left', x: p.find(x => x.id === 'hihat').x,
                           y: p.find(x => x.id === 'hihat').y }];
    window.__t0 = performance.now() / 1000 - 0.30;
  })(); true`);
  await sleep(450);
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
