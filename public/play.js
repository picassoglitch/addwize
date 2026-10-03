import { api, liveEvents, toast, fmtSec, esc, kioskMode } from '/api.js';
import { createOwl } from '/owl-rig.js';

kioskMode();

const HIT_SLOP = 1.35; // must match server.js
const IDLE = { pin: 30_000, confirm: 25_000, result: 15_000 };
const CLUTTER = ['📚', '📖', '✏️', '🖍️', '📐', '📏', '🎒', '🧸', '⚽', '🏀', '🚀', '🌵', '🪴', '🎨', '🧩', '🎲',
  '🔭', '🌍', '💡', '⏰', '🧃', '🍎', '🎈', '⭐', '🌙', '🔬', '🪁', '🦆', '🐤', '🐧', '🦜', '🐸', '🦊', '🐻',
  '🐼', '🐨', '🐱', '🦖', '🚗', '🎸', '📎', '🖌️', '🧦', '🍪', '🎁', '🐢', '🦔', '🐿️', '🍂', '🌻'];
const TIER_CLASS = ['t0', 't1', 't2'];

const $ = (id) => document.getElementById(id);
let state = 'attract';
let idleTimer;
let config = { timeLimitMs: 10_000, tiers: [] };
let lastBoard = [];
let pendingRaffle = null;
let player = null; // { folio, name, playsLeft, bestMs }

// Live mascots: one lives on the attract screen, the "host" moves between confirm/result/raffle.
const attractOwl = createOwl($('attractOwl'));
const hostOwl = createOwl($('confirmSlot'));
const hostTo = (slot) => hostOwl.mount(slot);
window.owls = { attractOwl, hostOwl }; // for poking at them from the console
window.debugScene = (scene) => { show('game'); return buildField(scene); }; // render a scene variant by hand

// ---------- screens ----------

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  state = id;
  clearTimeout(idleTimer);
  if (IDLE[id]) idleTimer = setTimeout(() => show('attract'), IDLE[id]);
  if (id === 'attract') {
    player = null;
    renderBoard();
    if (pendingRaffle) runRaffle(pendingRaffle);
  }
}
const bump = () => {
  if (IDLE[state]) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => show('attract'), IDLE[state]);
  }
};
document.addEventListener('pointerdown', (e) => {
  bump();
  unlockAudio();
  (state === 'attract' ? attractOwl : hostOwl).lookAt(e.clientX, e.clientY);
}, true);
addEventListener('pointermove', (e) => (state === 'attract' ? attractOwl : hostOwl).lookAt(e.clientX, e.clientY));

// Every so often the attract owl takes a lap around the screen to catch people walking by.
setInterval(() => {
  if (state !== 'attract' || document.hidden) return;
  const dir = Math.random() < 0.5 ? -1 : 1;
  attractOwl.flyBy(dir * innerWidth * (0.22 + Math.random() * 0.12), -innerHeight * (0.04 + Math.random() * 0.1));
}, 20_000);
for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => show(b.dataset.go);

// ---------- leaderboard ----------

function renderBoard(highlightFolio) {
  const rows = lastBoard.map((r) => `
    <li class="${r.folio === highlightFolio ? 'me' : ''}">
      <span class="r">${r.rank}</span><span>${esc(r.name)}</span><span class="t">${fmtSec(r.ms)} s</span>
    </li>`).join('');
  $('board').innerHTML = `<h2><span>🏆 LEADERBOARD</span><span>TOP ${lastBoard.length || ''}</span></h2>
    ${rows ? `<ol>${rows}</ol>` : '<div class="empty">Sé el primero en encontrar al búho.</div>'}`;
}

// ---------- pin pad ----------

let pin = '';
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
$('keys').innerHTML = keys.map((k) => `<button data-k="${k}" class="${k === 'OK' ? 'ok' : ''}">${k}</button>`).join('');
$('keys').addEventListener('pointerdown', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (!k) return;
  e.preventDefault();
  $('pinErr').textContent = '';
  if (k === '⌫') pin = pin.slice(0, -1);
  else if (k === 'OK') return lookup();
  else if (pin.length < 5) pin += k;
  $('pinDigits').textContent = pin;
  beep(520, 0.03);
});

$('playBtn').onclick = () => {
  pin = '';
  $('pinDigits').textContent = '';
  $('pinErr').textContent = '';
  show('pin');
};
$('attract').addEventListener('pointerdown', (e) => {
  if (e.target.closest('#playBtn')) return;
  $('playBtn').click();
});

async function lookup() {
  if (pin.length < 4) return ($('pinErr').textContent = 'El folio tiene 4 dígitos');
  try {
    player = await api(`/api/participant?folio=${pin}`);
  } catch (e) {
    $('pinErr').textContent = e.status === 404 ? 'No encontramos ese folio. Revísalo o regístrate en el iPad.' : e.message;
    beep(180, 0.15);
    return;
  }
  const first = player.name.split(' ')[0];
  $('cHello').textContent = `¡Hola, ${player.name}!`;
  if (player.playsLeft > 0) {
    $('cMsg').innerHTML = `Folio <b>${esc(player.folio)}</b>. Tienes <b>${config.timeLimitMs / 1000} segundos</b> para tocar al búho escondido. ¿List@?`;
    $('cRow').innerHTML = `<button class="btn" id="go">¡SÍ, JUGAR!</button><button class="btn ghost" id="notMe">No soy ${esc(first)}</button>`;
    $('go').onclick = startGame;
  } else {
    $('cMsg').innerHTML = `Ya jugaste con este folio${player.bestMs ? ` — tu mejor tiempo: <b>${fmtSec(player.bestMs)} s</b>` : ''}.<br>Tu folio sigue participando en la rifa final. 🎟️`;
    $('cRow').innerHTML = `<button class="btn" id="notMe">Terminar</button>`;
  }
  $('notMe').onclick = () => show('attract');
  hostTo($('confirmSlot'));
  show('confirm');
  hostOwl.hop();
}

// ---------- game ----------

let game = null;
let lastSceneId = null; // the server avoids repeating the previous scene / hiding spot

async function startGame() {
  $('go').disabled = true;
  hostOwl.flap(3, 0.6, 7);
  let start;
  try {
    start = await api('/api/play/start', { method: 'POST', body: { folio: player.folio, lastSceneId } });
    lastSceneId = start.scene.id;
  } catch (e) {
    toast(e.message, { error: true });
    return show('attract');
  }
  game = { ...start, misses: 0, done: false, cooldownUntil: 0 };
  show('game');
  await buildField(start.scene);
  await countdown();
  requestAnimationFrame((t) => {
    game.t0 = t;
    tick(t);
  });
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function buildField(scene) {
  const field = $('field');
  const W = innerWidth, H = innerHeight;
  field.innerHTML = '';
  field.className = '';
  $('bg').style.backgroundImage = '';
  $('stage').classList.toggle('artTimer', Boolean(scene.timerBox));

  if (scene.type === 'image') {
    const img = new Image();
    img.className = 'scene';
    img.src = scene.image;
    await img.decode().catch(() => {});
    const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const fw = img.naturalWidth * s, fh = img.naturalHeight * s;
    Object.assign(field.style, { left: `${(W - fw) / 2}px`, top: `${(H - fh) / 2}px`, width: `${fw}px`, height: `${fh}px` });
    $('bg').style.backgroundImage = `url("${scene.image}")`;
    field.append(img);
    if (scene.sprite) {
      // Variable scene: the mascot is dropped into the hiding spot the server picked.
      await placeOwl(field, scene.sprite, scene.owl.x * fw, scene.owl.y * fh, scene.owl.r * 2 * fw, 0);
    }
    if (scene.mood && scene.mood !== 'day') {
      // Lighting mood: the art is tinted (CSS) and lit from the lamp / window, which swap sides when mirrored.
      field.classList.add(`mood-${scene.mood}`);
      const light = document.createElement('div');
      light.className = 'light';
      const mx = (x) => `${(scene.mirror ? 1 - x : x) * 100}%`;
      const { lamp = [0.08, 0.07], win = [0.36, 0.34] } = scene.lights ?? {};
      light.style.setProperty('--lamp-x', mx(lamp[0]));
      light.style.setProperty('--lamp-y', `${lamp[1] * 100}%`);
      light.style.setProperty('--win-x', mx(win[0]));
      light.style.setProperty('--win-y', `${win[1] * 100}%`);
      field.append(light);
    }
    if (scene.timerBox) {
      // Live clock drawn over the readout baked into the artwork.
      const t = scene.timerBox;
      const box = document.createElement('div');
      box.className = 'artClock';
      box.style.cssText = `left:${t.x * 100}%;top:${t.y * 100}%;width:${t.w * 100}%;height:${t.h * 100}%;background:${t.bg};font-size:${t.h * fh * 0.62}px`;
      box.innerHTML = '<span class="clockText">10.0</span>';
      field.append(box);
    }
    return;
  }

  // Procedural placeholder: jittered grid of clutter with the owl hidden in it.
  Object.assign(field.style, { left: '0px', top: '0px', width: `${W}px`, height: `${H}px` });
  field.className = 'proc';
  const rnd = mulberry32(scene.seed);
  const D = scene.owl.r * 2 * W; // owl diameter in px
  const cell = D * 0.92;
  const ox = scene.owl.x * W, oy = scene.owl.y * H;
  const frag = document.createDocumentFragment();
  for (let y = cell / 2; y < H + cell / 2; y += cell * 0.9) {
    for (let x = cell / 2; x < W + cell / 2; x += cell) {
      const cx = x + (rnd() - 0.5) * cell * 0.5;
      const cy = y + (rnd() - 0.5) * cell * 0.5;
      if (Math.hypot(cx - ox, cy - oy) < D * 0.85) continue;
      const el = document.createElement('span');
      el.className = 'item';
      el.textContent = CLUTTER[Math.floor(rnd() * CLUTTER.length)];
      el.style.cssText = `left:${cx}px;top:${cy}px;font-size:${D * (0.75 + rnd() * 0.4)}px;transform:translate(-50%,-50%) rotate(${(rnd() - 0.5) * 50}deg)`;
      frag.append(el);
    }
  }
  field.append(frag);
  await placeOwl(field, '/img/owl.png', ox, oy, D, (rnd() - 0.5) * 40);
}

// The mascot art is portrait, so it's sized by height: the hit circle (radius r) spans the full sprite.
async function placeOwl(field, src, x, y, heightPx, rotateDeg) {
  const owl = document.createElement('img');
  owl.src = src;
  owl.className = 'owlSprite';
  owl.style.cssText = `left:${x}px;top:${y}px;height:${heightPx}px;transform:translate(-50%,-50%) rotate(${rotateDeg}deg)`;
  field.append(owl);
  await owl.decode().catch(() => {});
}

function countdown() {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'count';
    $('stage').append(el);
    const steps = ['3', '2', '1', '¡YA!'];
    let i = 0;
    const next = () => {
      if (i === steps.length) { el.remove(); return resolve(); }
      el.classList.toggle('go', i === 3);
      el.innerHTML = `<div>${steps[i]}</div>`;
      beep(i === 3 ? 880 : 440, 0.12);
      i++;
      setTimeout(next, i === steps.length ? 450 : 800);
    };
    next();
  });
}

function tick(now) {
  if (!game || game.done) return;
  const elapsed = now - game.t0;
  const left = Math.max(0, game.timeLimitMs - elapsed);
  for (const c of document.querySelectorAll('#clock, .clockText')) {
    c.textContent = (left / 1000).toFixed(1);
    c.classList.toggle('low', left < 3000);
  }
  $('barFill').style.transform = `scaleX(${left / game.timeLimitMs})`;
  if (left <= 0) return finish(false, game.timeLimitMs, null);
  requestAnimationFrame(tick);
}

$('stage').addEventListener('pointerdown', (e) => {
  if (!game || game.done || !game.t0 || !e.isPrimary) return;
  const now = performance.now();
  if (now < game.cooldownUntil) return;
  const r = $('field').getBoundingClientRect();
  const tap = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  const { owl } = game.scene;
  const dist = Math.hypot(tap.x - owl.x, (tap.y - owl.y) / (r.width / r.height));
  if (dist <= owl.r * HIT_SLOP) return finish(true, now - game.t0, tap);

  // Miss: brief lock-out so wiping the whole screen doesn't work.
  game.misses++;
  game.cooldownUntil = now + 350;
  const m = document.createElement('div');
  m.className = 'miss';
  m.style.left = `${e.clientX}px`;
  m.style.top = `${e.clientY}px`;
  $('stage').append(m);
  setTimeout(() => m.remove(), 500);
  beep(160, 0.08);
});

function ringOwl() {
  const r = $('field').getBoundingClientRect();
  const { owl } = game.scene;
  const ring = document.createElement('div');
  ring.className = 'ring';
  const d = owl.r * 2 * r.width * 1.4;
  Object.assign(ring.style, {
    width: `${d}px`, height: `${d}px`,
    left: `${r.left + owl.x * r.width}px`, top: `${r.top + owl.y * r.height}px`,
  });
  $('stage').append(ring);
}

async function finish(found, ms, tap) {
  game.done = true;
  const r = $('field').getBoundingClientRect();
  ringOwl();
  if (found) { beep(660, 0.1); setTimeout(() => beep(990, 0.18), 110); } else beep(200, 0.3);

  const body = { playId: game.playId, found, ms: Math.round(ms), tap, aspect: r.width / r.height, misses: game.misses };
  let res = null;
  for (let i = 0; i < 6 && !res; i++) {
    try {
      res = await api('/api/play/finish', { method: 'POST', body });
    } catch (e) {
      if (e.status) break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
  await new Promise((ok) => setTimeout(ok, found ? 900 : 1800)); // let them see where the owl was
  for (const el of $('stage').querySelectorAll('.ring')) el.remove();
  showResult(res ?? { found: false, error: true });
  game = null;
}

function showResult(r) {
  const tierIdx = config.tiers.findIndex((t) => t.label === r.tier);
  if (r.found) {
    $('result').innerHTML = `
      <h2>¡Lo encontraste!</h2>
      <div class="time">${fmtSec(r.ms)}<small> s</small></div>
      <div class="tier ${TIER_CLASS[tierIdx] ?? 't2'}">${esc(r.tier)}</div>
      ${r.prizeCode ? `<div class="prize glass"><div class="muted">Código de premio instantáneo</div><div class="code">${esc(r.prizeCode)}</div><div class="muted">Muéstralo al staff del stand</div></div>` : ''}
      <div class="sub">Lugar <b>#${r.rank}</b> en el leaderboard. Tu folio <b>${esc(player.folio)}</b> participa en la rifa final.</div>
      <button class="btn ghost" data-go="attract">Terminar</button>`;
    confetti();
    $('result').prepend(slotFor());
    setTimeout(() => hostOwl.happy(), 250);
  } else {
    $('result').innerHTML = `
      <h2>El búho se escondió.</h2>
      <div class="sub">${r.error ? 'No pudimos guardar el resultado — avisa al staff. ' : ''}¡Gracias por jugar, ${esc(player.name)}! Tu folio <b>${esc(player.folio)}</b> sigue en la rifa final. 🎟️</div>
      <button class="btn ghost" data-go="attract">Terminar</button>`;
  }
  if (!r.found) {
    $('result').prepend(slotFor());
    setTimeout(() => hostOwl.sad(), 250);
  }
  $('result').querySelector('[data-go]').onclick = () => show('attract');
  show('result');
}

function slotFor() {
  const slot = document.createElement('div');
  slot.className = 'hostSlot';
  hostTo(slot);
  return slot;
}

// ---------- raffle ----------

function runRaffle(data) {
  pendingRaffle = null;
  hostTo($('raffleSlot'));
  show('raffle');
  $('rLabel').textContent = data.label ? `THE ADDWIZE DRAW · ${data.label.toUpperCase()}` : 'THE ADDWIZE DRAW';
  $('rName').textContent = '';
  const reel = $('reel');
  reel.classList.remove('win');
  let i = 0, delay = 50;
  const spin = () => {
    if (delay > 420 || !data.reel.length) {
      reel.textContent = data.winner.folio;
      reel.classList.add('win');
      $('rName').textContent = data.winner.name ? `¡Felicidades, ${data.winner.name}!` : '¡Felicidades!';
      confetti(6000);
      beep(990, 0.4);
      hostOwl.happy();
      setTimeout(() => state === 'raffle' && show('attract'), 90_000);
      return;
    }
    reel.textContent = data.reel[i++ % data.reel.length];
    beep(300 + (i % 2) * 60, 0.02);
    delay *= 1.09;
    setTimeout(spin, delay);
  };
  spin();
}
$('raffle').addEventListener('pointerdown', () => $('reel').classList.contains('win') && show('attract'));

// ---------- fx ----------

let actx;
function unlockAudio() {
  if (!actx) try { actx = new AudioContext(); } catch {}
}
function beep(freq, dur) {
  if (!actx) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = freq;
  o.type = 'triangle';
  g.gain.setValueAtTime(0.15, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
  o.connect(g).connect(actx.destination);
  o.start();
  o.stop(actx.currentTime + dur);
}

function confetti(ms = 3500) {
  const c = $('confetti'), ctx = c.getContext('2d');
  c.width = innerWidth; c.height = innerHeight;
  const colors = ['#ff9f1c', '#7b4fd6', '#38bdf8', '#34d399', '#fff'];
  const parts = Array.from({ length: 220 }, () => ({
    x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.5,
    vx: (Math.random() - 0.5) * 4, vy: 3 + Math.random() * 5, s: 6 + Math.random() * 10,
    a: Math.random() * 6, va: (Math.random() - 0.5) * 0.3, col: colors[Math.floor(Math.random() * colors.length)],
  }));
  const end = performance.now() + ms;
  const frame = (t) => {
    ctx.clearRect(0, 0, c.width, c.height);
    if (t > end) return;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.a += p.va;
      if (p.y > c.height + 20) { p.y = -20; p.x = Math.random() * c.width; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.col;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------- boot ----------

liveEvents({
  leaderboard: (b) => { lastBoard = b; if (state === 'attract') renderBoard(); },
  registered: ({ name }) => {
    if (state !== 'attract') return;
    toast(`¡Bienvenid@, ${name}! Toca JUGAR e ingresa tu folio.`);
    attractOwl.hop();
  },
  raffle: (d) => (['attract', 'pin', 'confirm', 'raffle'].includes(state) ? runRaffle(d) : (pendingRaffle = d)),
});
api('/api/config').then((c) => (config = c)).catch(() => {});
show('attract');
