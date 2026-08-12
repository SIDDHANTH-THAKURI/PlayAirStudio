/**
 * gate.js — a temporary "not yet, thanks" screen for the whole site.
 *
 * ⚠ THIS IS NOT SECURITY, AND MUST NOT BE RELIED ON AS SECURITY.
 *
 * The site is static: every file is served to anyone who asks, and this check
 * runs on their machine, not ours. The key is in this file, which is a
 * two-second look in devtools; the overlay is a DOM node anyone can delete; and
 * the pages work perfectly well if it never runs at all. It stops a casual
 * visitor wandering in while the thing is half-built. It stops nothing else.
 *
 * If real protection is ever needed, it has to happen before the bytes leave
 * the server — Vercel's own deployment protection, or an auth layer in front of
 * the origin. Do not add more client-side cleverness here and mistake it for a
 * lock.
 *
 * Deliberately self-contained: one file, one script tag per page, its own
 * styles. Deleting those tags and this file removes it completely, which is the
 * right shape for something that is meant to be temporary.
 */

const STORE = 'air-studio.access';
const SECRET = 'siddhanth';
const norm = (s) => String(s || '').trim().toLowerCase();

let unlocked = false;
try { unlocked = localStorage.getItem(STORE) === SECRET; } catch {}

/** Hide the page underneath rather than merely covering it. */
function veilStyles() {
  const css = document.createElement('style');
  css.id = 'gate-style';
  css.textContent = `
    html[data-locked] body > *:not(.gate) { visibility: hidden !important; }
    .gate { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
      padding: 24px; font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      background:
        radial-gradient(900px 520px at 20% -10%, #FFF6E4 0%, transparent 60%),
        radial-gradient(760px 460px at 90% 4%, #FDEEDC 0%, transparent 58%),
        linear-gradient(180deg, #FBF6EC 0%, #F1E5D3 100%); }
    .gate-card { width: min(420px, 100%); text-align: center; background: #FFFCF6;
      border: 1px solid rgba(44,33,24,.10); border-radius: 18px; padding: 30px 28px;
      box-shadow: 0 2px 6px rgba(80,55,30,.08), 0 22px 50px -18px rgba(90,60,25,.32); }
    .gate-mark { font-size: 26px; line-height: 1; }
    .gate-card h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 23px;
      letter-spacing: -.02em; margin: 12px 0 6px; color: #2C2118; }
    .gate-card p { margin: 0; font-size: 13.5px; line-height: 1.6; color: #6E5C49; }
    .gate-row { display: flex; gap: 8px; margin-top: 20px; }
    .gate-row input { flex: 1; min-width: 0; font: inherit; font-size: 14px; color: #2C2118;
      background: #fff; border: 1px solid rgba(44,33,24,.18); border-radius: 10px; padding: 11px 13px; }
    .gate-row input:focus { outline: 2px solid rgba(224,147,47,.5); outline-offset: 1px; }
    .gate-row button { font: inherit; font-size: 14px; font-weight: 600; color: #fff; cursor: pointer;
      border: 0; border-radius: 10px; padding: 11px 20px;
      background: linear-gradient(180deg, #EFA544, #D97F23);
      box-shadow: 0 1px 0 rgba(255,255,255,.4) inset, 0 6px 16px -6px rgba(193,99,26,.7); }
    .gate-msg { min-height: 18px; margin-top: 12px; font-size: 12.5px; color: #D2604F; }
    .gate.wrong .gate-card { animation: gate-shake .32s ease-out; }
    @keyframes gate-shake { 25% { transform: translateX(-6px) } 75% { transform: translateX(6px) } }
    @media (prefers-reduced-motion: reduce) { .gate.wrong .gate-card { animation: none } }
  `;
  document.head.appendChild(css);
}

function show() {
  document.documentElement.setAttribute('data-locked', '');
  veilStyles();

  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <div class="gate-card" role="dialog" aria-modal="true" aria-label="Restricted">
      <div class="gate-mark" aria-hidden="true">🔒</div>
      <h1>Restricted for now</h1>
      <p>Air Studio is being worked on and isn't open yet. If you've been given the key, enter it below.</p>
      <form class="gate-row" autocomplete="off">
        <input type="password" id="gate-key" aria-label="Access key" placeholder="Access key" autofocus />
        <button type="submit">Enter</button>
      </form>
      <div class="gate-msg" role="status" aria-live="polite"></div>
    </div>`;

  const mount = () => {
    document.body.appendChild(gate);
    const input = gate.querySelector('#gate-key');
    const msg = gate.querySelector('.gate-msg');
    gate.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!unlock(input.value)) {
        msg.textContent = "That isn't it.";
        gate.classList.remove('wrong'); void gate.offsetWidth; gate.classList.add('wrong');
        input.select();
      }
    });
    setTimeout(() => input?.focus(), 40);
  };
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
}

/** @returns true if the key was right and the page is now open. */
export function unlock(key) {
  if (norm(key) !== SECRET) return false;
  unlocked = true;
  try { localStorage.setItem(STORE, SECRET); } catch {}
  document.documentElement.removeAttribute('data-locked');
  document.querySelector('.gate')?.remove();
  document.getElementById('gate-style')?.remove();
  return true;
}

/** Put the gate back — handy for checking what a visitor sees. */
export function lock() {
  try { localStorage.removeItem(STORE); } catch {}
  unlocked = false;
  if (!document.querySelector('.gate')) show();
}

if (!unlocked) show();

window.airGate = { unlock, lock, get locked() { return !unlocked; } };
