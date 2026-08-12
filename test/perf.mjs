/**
 * Checks the two things that decide whether a phone is playable: the
 * inference duty-cycle throttle, and the verified GPU/CPU delegate choice.
 * Both are pure logic, so they run headlessly with a stubbed landmarker.
 * Run: node test/perf.mjs
 */
let fails = 0;
const ok = (c, m, x = '') => { if (!c) { fails++; console.log(`  FAIL  ${m} ${x}`); } else console.log(`  ok    ${m} ${x}`); };

/* --- shims: tracking.js reads matchMedia/innerWidth at import time, and
       imports MediaPipe from a CDN the loader hook stubs out --- */
import { register } from 'node:module';
register('./cdn-hooks.mjs', import.meta.url);

let clock = 0;
globalThis.performance = { now: () => clock };
globalThis.matchMedia = () => ({ matches: true });      // pretend to be a phone
globalThis.innerWidth = 390;
const { Tracker } = await import('../src/tracking.js');

/** A Tracker with the CDN work replaced by a stub costing `cost()` ms. */
function stub(cost, delegates = {}) {
  const t = new Tracker();
  t._make = async (d) => ({ close() {}, _d: d });
  t.landmarker = { close() {}, _d: 'GPU' };
  t.detectStub = () => {
    const d = t.landmarker._d;
    const c = delegates[d] ?? cost;
    clock += c;
    t.lastEnd = clock;
    t.emaMs = t.frames === 0 ? c : t.emaMs * 0.85 + c * 0.15;
    t.frames++;
    t._maybeDowngrade();
  };
  return t;
}

/** Drive `secs` of wall clock in 1 ms ticks, detecting whenever due. */
async function simulate(t, secs, camHz = 30) {
  const end = clock + secs * 1000;
  let detects = 0, blocked = 0, nextFrame = clock;
  while (clock < end) {
    if (clock >= nextFrame) {
      nextFrame += 1000 / camHz;
      if (t.due(clock)) {
        const before = clock;
        t.detectStub();
        blocked += clock - before;
        detects++;
        await Promise.resolve();          // let any delegate swap resolve
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
    }
    clock += 1;
  }
  return { detects, blocked, secs };
}

console.log('\nduty-cycle throttle');
{
  // A slow phone: 200 ms per inference, camera offering 30 fps.
  const t = stub(200);
  const r = await simulate(t, 10);
  const duty = r.blocked / (r.secs * 1000);
  ok(duty < 0.62, 'inference stays inside its time budget', `${(duty * 100).toFixed(0)}% of wall clock`);
  ok(r.detects >= 20, 'and still tracks several times a second', `${(r.detects / r.secs).toFixed(1)}/s`);
  const free = (1 - duty) * 100;
  ok(free > 35, 'leaves real time for painting + audio scheduling', `${free.toFixed(0)}% free`);
}
{
  // Desktop: 5 ms inference must not be throttled at all.
  const t = stub(5);
  t.duty = 0.8;
  const r = await simulate(t, 5, 60);
  ok(r.detects > 250, 'a fast machine is never throttled', `${(r.detects / r.secs).toFixed(0)}/s of 60 available`);
}
{
  // Pathological: 2 s per inference. The cap must still let a look through.
  const t = stub(2000);
  const r = await simulate(t, 20);
  ok(r.detects >= 8, 'even a catastrophic device gets sampled', `${r.detects} in 20 s`);
}

console.log('\ndelegate choice');
{
  // Mobile GPU at 120 ms: slower than the desktop bar, but fine for a phone —
  // must NOT downgrade, since mobile CPU would be far worse.
  const t = stub(120);
  await simulate(t, 6);
  ok(t.delegate === 'GPU', 'a merely-mediocre mobile GPU is left alone', `${t.delegate} @ ${t.emaMs.toFixed(0)} ms`);
}
{
  // Software GL: seconds per frame. Must bail out fast, and CPU is better.
  const t = stub(0, { GPU: 1500, CPU: 90 });
  await simulate(t, 12);
  ok(t.delegate === 'CPU', 'software GL is abandoned for CPU', `${t.delegate} @ ${t.emaMs.toFixed(0)} ms`);
  ok(t._pinned, 'and the winner is pinned so it stops flapping');
}
{
  // The regression this rewrite exists for: GPU slow-ish, CPU *worse*.
  // The old one-way swap stranded the player on the worse delegate forever.
  const t = stub(0, { GPU: 300, CPU: 900 });
  await simulate(t, 25);
  ok(t.delegate === 'GPU', 'a worse CPU is rejected and GPU restored', `${t.delegate} @ ${t.emaMs.toFixed(0)} ms`);
  ok(t._pinned, 'and pinned, so it never swaps again');
}

console.log('\npattern scheduling under main-thread stalls');
{
  const { PatternPlayer } = await import('../src/patterns.js');
  // Replay a phone: `tick()` only gets to run between 200 ms inference blocks.
  const run = (stallMs, useAdaptive) => {
    let t = 0;
    const fired = [];
    const p = new PatternPlayer({ now: () => t, onStep: (s, when) => fired.push(when) });
    if (useAdaptive) p.setLookahead(stallMs / 1000);
    p.start('drive', 120, 0);
    for (let i = 0; i < 60; i++) { p.tick(); t += stallMs / 1000; }
    return fired;
  };
  const eighth = 0.25;                       // 8th note at 120 bpm
  const gaps = (f) => f.slice(1).map((w, i) => +(w - f[i]).toFixed(4));
  const bad = run(200, false), good = run(200, true);
  // A missed step shows up as a gap that is not a whole number of 8ths.
  const offGrid = (f) => gaps(f).filter((g) => Math.abs(g / eighth - Math.round(g / eighth)) > 0.01).length;
  ok(offGrid(good) === 0, 'adaptive lookahead keeps every step on the grid',
    `${good.length} steps, ${offGrid(good)} off-grid`);
  ok(good.length >= bad.length, 'and never schedules fewer notes than the fixed window',
    `${bad.length} → ${good.length}`);
  const p2 = new PatternPlayer({ now: () => 0, onStep: () => {} });
  p2.setLookahead(0.004);
  ok(p2.ahead === 0.12, 'a fast machine keeps the tight 120 ms window', `${p2.ahead}`);
  p2.setLookahead(2);
  ok(p2.ahead === 0.5, 'and the window is capped so stopping stays responsive', `${p2.ahead}`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
