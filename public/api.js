// Shared client helpers for the kiosk screens.

// Kiosk key: open /register?k=KEY once and the device remembers it.
const params = new URLSearchParams(location.search);
if (params.get('k')) {
  try { localStorage.setItem('kioskKey', params.get('k')); } catch {}
  history.replaceState(null, '', location.pathname);
}
const kioskKey = () => { try { return localStorage.getItem('kioskKey') || ''; } catch { return ''; } };

export async function api(path, { method = 'GET', body, admin } = {}) {
  const headers = { 'x-kiosk-key': kioskKey() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (admin) headers['x-admin-pin'] = admin;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function toast(msg, { error = false, ms = 3500 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

// Live updates by polling /api/state (serverless has no shared connection to push from).
// Handlers: leaderboard(list) on change, registered({name}) and raffle(draw) for new events
// after the page loaded. Shows an "offline" badge while the server is unreachable.
export function liveEvents(handlers, everyMs = 2000) {
  const badge = document.createElement('div');
  badge.className = 'offline hidden';
  badge.textContent = 'Sin conexión — reintentando…';
  document.body.append(badge);
  let first = true, lastBoard = '', lastReg = 0, lastRaffle = 0;
  const poll = async () => {
    try {
      const s = await api('/api/state');
      badge.classList.add('hidden');
      const board = JSON.stringify(s.leaderboard);
      if (board !== lastBoard) { lastBoard = board; handlers.leaderboard?.(s.leaderboard); }
      const regId = s.lastRegistered?.id ?? 0, drawId = s.raffle?.id ?? 0;
      if (!first && regId > lastReg) handlers.registered?.(s.lastRegistered);
      if (!first && drawId > lastRaffle) handlers.raffle?.(s.raffle);
      lastReg = regId; lastRaffle = drawId; first = false;
    } catch {
      badge.classList.remove('hidden');
    }
    setTimeout(poll, everyMs);
  };
  poll();
}

export const fmtSec = (ms) => (ms / 1000).toFixed(2);

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Kiosk hygiene: no pinch zoom, no long-press menus, no accidental text selection.
export function kioskMode() {
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}
