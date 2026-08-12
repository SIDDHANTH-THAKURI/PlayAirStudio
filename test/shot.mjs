/** Screenshot one local page. Usage: node test/shot.mjs <path> <out.png> [w] [h] */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './serve.mjs';

// Git Bash mangles a bare leading-slash argument into a Windows path, so the
// path is accepted without one and normalised here.
const [rawPath = 'test/poses.html', out = 'shot.png', W = 1000, H = 620] = process.argv.slice(2);
const pagePath = '/' + String(rawPath).replace(/^.*?[/\\](?=test\/|src\/|play\.html|index\.html)/, '').replace(/^\/+/, '');
const PORT = 8144, DBG = 9355;
const bin = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
if (!bin) { console.error('no browser'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await startServer(PORT);
const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const br = spawn(bin, [`--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--headless=new', `--window-size=${W},${H}`, '--hide-scrollbars', '--no-first-run',
  '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    const p = l.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(200);
}
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    console.error('PAGE ERROR:', m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  }
});
const url = `http://localhost:${PORT}${pagePath}`;
const nav = await send('Page.navigate', { url });
console.log('navigate', url, '→', JSON.stringify(nav.result || nav.error));
await sleep(2200);
const diag = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ ready: !!window.__ready, cells: document.querySelectorAll('canvas').length, title: document.title })`,
  returnByValue: true,
});
console.log('page:', diag.result?.result?.value);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(new URL('./' + out, import.meta.url), Buffer.from(shot.result.data, 'base64'));
console.log('wrote test/' + out);
ws.close(); br.kill(); server.close();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
