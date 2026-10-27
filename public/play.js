import { api, liveEvents, toast, fmtSec, esc, kioskMode } from '/api.js';
import { createOwl } from '/owl-rig.js';

kioskMode();

const HIT_SLOP = 1.35; // must match server.js
const IDLE = { ruleta: 120_000, pin: 30_000, confirm: 25_000, howto: 40_000, result: 25_000 };
const CLUTTER = ['📚', '📖', '✏️', '🖍️', '📐', '📏', '🎒', '🧸', '⚽', '🏀', '🚀', '🌵', '🪴', '🎨', '🧩', '🎲',
  '🔭', '🌍', '💡', '⏰', '🧃', '🍎', '🎈', '⭐', '🌙', '🔬', '🪁', '🦆', '🐤', '🐧', '🦜', '🐸', '🦊', '🐻',
  '🐼', '🐨', '🐱', '🦖', '🚗', '🎸', '📎', '🖌️', '🧦', '🍪', '🎁', '🐢', '🦔', '🐿️', '🍂', '🌻'];
const TIER_CLASS = ['t0', 't1', 't2'];

const $ = (id) => document.getElementById(id);
let state = 'attract';
let idleTimer;
let config = { timeLimitMs: 10_000, gamesPerRound: 3, tiers: [] };
let lastBoard = [];
let pendingRaffle = null;
let player = null; // { folio, name, playsLeft, round, game, rounds, bestMs }

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
let lastTap = 0;
document.addEventListener('pointerdown', (e) => {
  bump();
  unlockAudio();
  lastTap = performance.now();
  const owl = state === 'attract' ? attractOwl : hostOwl;
  owl.lookAt(e.clientX, e.clientY);
  // Every tap gets a reaction: tap the owl for a trick, tap empty space and it flies over to you.
  if (!['attract', 'confirm', 'howto', 'result', 'raffle'].includes(state) || !e.isPrimary) return;
  if (owl.hits(e.clientX, e.clientY)) {
    owl.react();
    if (state === 'attract') secretTap();
  }
  else if (!e.target.closest('button, a, input, #board')) owl.flyTo(e.clientX, e.clientY);
}, true);
addEventListener('pointermove', (e) => (state === 'attract' ? attractOwl : hostOwl).lookAt(e.clientX, e.clientY));

// When nobody's touching it, the attract owl takes laps around the screen to catch people walking by.
setInterval(() => {
  if (state !== 'attract' || document.hidden || attractOwl.busy || performance.now() - lastTap < 8000) return;
  attractOwl.tour();
}, 12_000);
for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => show(b.dataset.go);

// ---------- leaderboard ----------

function renderBoard(highlightFolio) {
  const rows = lastBoard.map((r) => `
    <li class="${r.folio === highlightFolio ? 'me' : ''}">
      <span class="r">${r.rank}</span><span>${esc(r.name)}</span><span class="t">${fmtSec(r.ms)} s</span>
    </li>`).join('');
  $('board').innerHTML = `<h2><span>🏆 LEADERBOARD</span><span>MEJOR RONDA · PROMEDIO</span></h2>
    ${rows ? `<ol>${rows}</ol>` : '<div class="empty">Sé el primero en encontrar al búho.</div>'}`;
  fitAttract();
}

// The kiosk page can't scroll: shrink the attract screen's text until it fits; the list scrolls itself.
function fitAttract() {
  const screen = $('attract');
  screen.style.fontSize = '';
  if (screen.classList.contains('hidden')) return;
  let px = parseFloat(getComputedStyle(screen).fontSize);
  const overflows = () => screen.scrollHeight > innerHeight + 1;
  while (overflows() && px > 9) screen.style.fontSize = `${(px -= 0.5)}px`;
}
addEventListener('resize', () => state === 'attract' && fitAttract());

// ---------- pin pad ----------

let pin = '';
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'];
$('keys').innerHTML = keys.map((k) => `<button data-k="${k}" class="${k === 'OK' ? 'ok' : ''}">${k}</button>`).join('');
$('keys').addEventListener('pointerdown', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (!k) return;
  e.preventDefault();
  $('pinErr').textContent = '';
  if (k === '⌫') { pin = pin.slice(0, -1); hostOwl.flap(2, 0.3, 6); }
  else if (k === 'OK') return lookup();
  else if (pin.length < 5) { pin += k; pin.length === 4 ? hostOwl.react() : hostOwl.hop(0.1 + pin.length * 0.03); }
  $('pinDigits').textContent = pin;
  beep(520, 0.03);
});

$('playBtn').onclick = () => {
  pin = '';
  $('pinDigits').textContent = '';
  $('pinErr').textContent = '';
  hostTo($('pinPerch'));
  show('pin');
  hostOwl.hop();
};

async function lookup() {
  if (pin.length < 4) return ($('pinErr').textContent = 'El folio tiene 4 dígitos');
  try {
    player = await api(`/api/participant?folio=${pin}`);
  } catch (e) {
    $('pinErr').textContent = e.status === 404 ? 'No encontramos ese folio. Revísalo o regístrate en el iPad.' : e.message;
    beep(180, 0.15);
    hostOwl.sad();
    return;
  }
  const first = player.name.split(' ')[0];
  $('cHello').textContent = `¡Hola, ${player.name}!`;
  const G = config.gamesPerRound;
  const isNew = player.round === 1 && player.game === 1;
  if (player.playsLeft > 0) {
    $('cMsg').innerHTML = isNew
      ? `Folio <b>${esc(player.folio)}</b>. Tienes <b>${player.rounds} rondas</b> de ${G} búhos. Antes, una práctica rápida para que veas cómo se juega.`
      : `Folio <b>${esc(player.folio)}</b>. Vas en la <b>ronda ${player.round} de ${player.rounds}</b>, búho ${player.game} de ${G}.${player.bestMs ? ` Tu mejor promedio: <b>${fmtSec(player.bestMs)} s</b>.` : ''} ¿List@?`;
    $('cRow').innerHTML = `<button class="btn" id="go">¡SÍ, JUGAR!</button>${isNew ? '' : '<button class="btn ghost" id="demo">Ver demo</button>'}<button class="btn ghost" id="notMe">No soy ${esc(first)}</button>`;
    $('go').onclick = (e) => (isNew ? openHowto() : startGame(e.currentTarget));
    if (!isNew) $('demo').onclick = () => openHowto();
  } else {
    $('cMsg').innerHTML = `Ya jugaste tus ${player.rounds} rondas${player.bestMs ? ` — tu mejor promedio: <b>${fmtSec(player.bestMs)} s</b>` : ''}.<br>Tu folio sigue participando en la rifa final. 🎟️`;
    $('cRow').innerHTML = `<button class="btn" id="notMe">Terminar</button>`;
  }
  $('notMe').onclick = () => show('attract');
  hostTo($('confirmSlot'));
  show('confirm');
  hostOwl.trick('flip');
}

// ---------- demo: how to play + practice ----------
// Anyone can open it from the attract screen; a new folio goes through it before round 1.
// Practice plays never touch the server.

const HOW_STEPS = () => [
  { icon: '🦉', title: 'Encuentra al búho', text: 'Se esconde en una escena llena de cosas. Tócalo con el dedo lo más rápido que puedas.' },
  {
    icon: '⏱️', title: `${player?.rounds ?? 3} rondas × ${config.gamesPerRound} búhos`,
    text: `Cada búho aparece en una escena distinta y tienes <b>${config.timeLimitMs / 1000} segundos</b> para cada uno. Puedes jugar tus rondas cuando quieras.`,
    extra: `<div class="rounds">${Array.from({ length: player?.rounds ?? 3 }, (_, i) => `<div>RONDA ${i + 1}<b>${'🦉'.repeat(config.gamesPerRound)}</b></div>`).join('')}</div>`,
  },
  {
    icon: '🏆', title: 'Tu puntaje',
    text: `Es el <b>promedio</b> de la ronda (si no lo encuentras cuenta como ${config.timeLimitMs / 1000} s). Tu mejor ronda va al leaderboard, y si lo encuentras rápido ganas un <b>premio instantáneo</b>.`,
  },
  { icon: '👆', title: '¡Ahora pruébalo!', text: 'Una práctica sin reloj: busca al búho y tócalo. No cuenta para tu puntaje.' },
];

function openHowto(step = 0) {
  const steps = HOW_STEPS();
  const s = steps[step];
  const last = step === steps.length - 1;
  $('howCard').outerHTML = `<div class="howCard glass" id="howCard"><div class="big">${s.icon}</div><h2>${s.title}</h2><p>${s.text}</p>${s.extra ?? ''}</div>`;
  $('howDots').innerHTML = steps.map((_, i) => `<i class="${i === step ? 'on' : ''}" data-step="${i}"></i>`).join('');
  $('howRow').innerHTML = last
    ? '<button class="btn" id="howNext">¡PRACTICAR!</button>'
    : `<button class="btn" id="howNext">Siguiente →</button>${player ? '<button class="btn ghost" id="howSkip">Saltar e ir a jugar</button>' : ''}`;
  $('howNext').onclick = () => (last ? practice() : openHowto(step + 1));
  if ($('howSkip')) $('howSkip').onclick = (e) => startGame(e.currentTarget);
  for (const d of $('howDots').children) d.onclick = () => openHowto(Number(d.dataset.step));
  if (state !== 'howto') {
    hostTo($('howtoSlot'));
    show('howto');
  }
  bump();
  hostOwl.hop(0.12);
}
$('demoBtn').onclick = () => { player = null; openHowto(); };
$('howtoBack').onclick = () => show(player ? 'confirm' : 'attract');

async function practice() {
  const scene = {
    type: 'procedural', seed: 1 + Math.floor(Math.random() * 2 ** 30),
    owl: { x: 0.2 + Math.random() * 0.6, y: 0.3 + Math.random() * 0.45, r: 0.05 }, // a bit bigger than the real thing
  };
  game = { practice: true, scene, misses: 0, done: false, cooldownUntil: 0 };
  show('game');
  await buildField(scene);
  for (const c of document.querySelectorAll('#clock, .clockText')) { c.textContent = '∞'; c.classList.remove('low'); }
  $('barFill').style.transform = 'scaleX(1)';
  const tag = document.createElement('div');
  tag.className = 'practiceTag';
  tag.innerHTML = '<span id="ptText">PRÁCTICA · Toca al búho 🦉</span><button class="btn ghost">Saltar</button>';
  tag.querySelector('button').onclick = () => practiceDone(false);
  $('stage').append(tag);
  game.t0 = performance.now();
  // Stuck? Point at it after a few seconds. Walked away? Back to the attract screen.
  game.hintTimer = setTimeout(() => {
    if (!game?.practice || game.done) return;
    const r = $('field').getBoundingClientRect();
    const hint = document.createElement('div');
    hint.className = 'hint';
    const d = scene.owl.r * 2 * r.width * 1.6;
    Object.assign(hint.style, { width: `${d}px`, height: `${d}px`, left: `${r.left + scene.owl.x * r.width}px`, top: `${r.top + scene.owl.y * r.height}px` });
    $('stage').append(hint);
    $('ptText').textContent = '¡Pista! Está dentro del círculo 👀';
  }, 6000);
  game.idleTimer = setTimeout(() => game?.practice && (clearPractice(), show('attract')), 45_000);
}

function clearPractice() {
  clearTimeout(game?.hintTimer);
  clearTimeout(game?.idleTimer);
  for (const el of $('stage').querySelectorAll('.practiceTag, .hint, .ring')) el.remove();
  game = null;
}

async function practiceDone(found) {
  game.done = true;
  if (found) {
    const ms = performance.now() - game.t0;
    ringOwl();
    beep(660, 0.1); setTimeout(() => beep(990, 0.18), 110);
    await new Promise((ok) => setTimeout(ok, 1100));
    clearPractice();
    $('howCard').outerHTML = `<div class="howCard glass" id="howCard"><div class="big">🎉</div><h2>¡Eso es!</h2>
      <p>Lo encontraste en <b>${fmtSec(ms)} s</b>. Así se juega: en el juego real tienes ${config.timeLimitMs / 1000} s por búho.</p></div>`;
    confetti(1500);
    setTimeout(() => hostOwl.happy(), 250);
  } else {
    clearPractice();
    $('howCard').outerHTML = `<div class="howCard glass" id="howCard"><div class="big">🦉</div><h2>¿List@?</h2><p>Recuerda: toca al búho lo más rápido que puedas.</p></div>`;
  }
  $('howDots').innerHTML = '';
  $('howRow').innerHTML = (player
    ? `<button class="btn" id="howGo">¡A JUGAR! RONDA ${player.round}</button>`
    : '<button class="btn" id="howGo">JUGAR CON MI FOLIO</button>') + '<button class="btn ghost" id="howAgain">Practicar otra vez</button>';
  $('howGo').onclick = (e) => (player ? startGame(e.currentTarget) : $('playBtn').onclick());
  $('howAgain').onclick = practice;
  hostTo($('howtoSlot'));
  show('howto');
}

// ---------- game ----------

let game = null;
let lastSceneId = null; // the server avoids repeating the previous scene / hiding spot

async function startGame(btn) {
  if (btn) btn.disabled = true;
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
  await countdown(`<small>RONDA ${start.round} DE ${start.rounds}</small>BÚHO ${start.game}/${config.gamesPerRound}`);
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

function countdown(label) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'count';
    $('stage').append(el);
    const steps = [label, '3', '2', '1', '¡YA!'];
    let i = 0;
    const next = () => {
      if (i === steps.length) { el.remove(); return resolve(); }
      el.classList.toggle('label', i === 0);
      el.classList.toggle('go', i === steps.length - 1);
      el.innerHTML = `<div>${steps[i]}</div>`;
      if (i > 0) beep(i === steps.length - 1 ? 880 : 440, 0.12);
      i++;
      setTimeout(next, i === 1 ? 1300 : i === steps.length ? 450 : 800);
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
  if (dist <= owl.r * HIT_SLOP) return game.practice ? practiceDone(true) : finish(true, now - game.t0, tap);
  if (game.practice && $('ptText') && !$('stage').querySelector('.hint')) $('ptText').textContent = '¡Casi! Sigue buscando 🔍';

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
  const G = config.gamesPerRound;
  const tierIdx = config.tiers.findIndex((t) => t.label === r.tier);
  if (!r.error) Object.assign(player, { playsLeft: r.playsLeft, round: r.round, game: r.game, rounds: r.rounds, bestMs: r.bestMs });
  const head = r.error ? '' : `<div class="round">RONDA ${r.round} DE ${r.rounds} · BÚHO ${r.game}/${G}</div>`;
  const body = r.found
    ? `<h2>¡Lo encontraste!</h2>
      <div class="time">${fmtSec(r.ms)}<small> s</small></div>
      <div class="tier ${TIER_CLASS[tierIdx] ?? 't2'}">${esc(r.tier)}</div>
      ${r.prizeCode ? `<div class="prize glass"><div class="muted">Código de premio instantáneo</div><div class="code">${esc(r.prizeCode)}</div><div class="muted">Muéstralo al staff del stand</div></div>` : ''}`
    : `<h2>El búho se escondió.</h2>
      ${r.error ? '<div class="sub">No pudimos guardar el resultado — avisa al staff.</div>' : `<div class="sub">Cuenta como ${config.timeLimitMs / 1000} s en el promedio de la ronda.</div>`}`;

  let summary = '';
  let buttons = '<button class="btn ghost" data-go="attract">Terminar</button>';
  if (r.error) {
    // nothing more to say
  } else if (!r.roundDone) {
    buttons = `<button class="btn" id="next">SIGUIENTE BÚHO (${r.game + 1}/${G}) →</button>` + buttons;
  } else {
    summary = `<div class="sub">Ronda ${r.round} completa · promedio <b>${fmtSec(r.roundMs)} s</b>.
      ${r.bestMs !== null ? `Tu mejor ronda: <b>${fmtSec(r.bestMs)} s</b> · lugar <b>#${r.rank}</b> en el leaderboard.` : ''}
      ${r.playsLeft > 0 ? `Te quedan <b>${Math.ceil(r.playsLeft / G)}</b> ronda(s): juega ahora o regresa más tarde con tu folio.` : `Usaste tus ${r.rounds} rondas. Tu folio <b>${esc(player.folio)}</b> sigue en la rifa final. 🎟️`}</div>`;
    if (r.playsLeft > 0) buttons = `<button class="btn" id="next">JUGAR RONDA ${r.round + 1}</button>` + buttons;
  }
  $('result').innerHTML = `${head}${body}${summary}<div class="row">${buttons}</div>`;
  $('result').prepend(slotFor());
  if (r.found) {
    confetti(r.roundDone ? 3500 : 1500);
    setTimeout(() => hostOwl.happy(), 250);
  } else setTimeout(() => hostOwl.sad(), 250);
  $('result').querySelector('[data-go]').onclick = () => show('attract');
  if ($('next')) $('next').onclick = (e) => startGame(e.currentTarget);
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

// ---------- ruleta (hidden) ----------

// Staff open it by tapping the attract owl 3 times within 1.5 s; visitors tap it once for a trick.
let taps = [], ownDrawId = 0, spinning = false;
function secretTap() {
  const now = performance.now();
  taps = [...taps.filter((t) => now - t < 1500), now];
  if (taps.length >= 3) { taps = []; openRuleta(); }
}

const ROW_ITEMS = 7, CENTER = 3; // rows visible in the wheel and which one is the winner's slot
let rtNames = [];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function fillStrip(names, winner) {
  const strip = $('rtStrip');
  const base = names.length ? names : ['—'];
  // Enough rows to spin through, then the winner lands in the centre slot.
  const rows = [];
  while (rows.length < (winner ? 60 : ROW_ITEMS)) rows.push(...shuffle([...base]));
  const list = winner ? [...rows.slice(0, 60), winner, ...shuffle([...base]).slice(0, CENTER + 1)] : rows.slice(0, ROW_ITEMS);
  strip.innerHTML = list.map((n) => `<li>${esc(n)}</li>`).join('');
  return winner ? 60 : -1;
}

// With nobody left, GIRAR turns into REINICIAR so staff can run the wheel again.
function syncRuletaButtons() {
  $('rtSpin').classList.toggle('hidden', !rtNames.length);
  $('rtReset').classList.toggle('hidden', Boolean(rtNames.length));
  $('rtSpin').disabled = !rtNames.length;
}

async function openRuleta() {
  show('ruleta');
  hostOwl.happy?.();
  $('rtWinner').textContent = '';
  $('rtSpin').textContent = 'GIRAR';
  $('rtStrip').style.transition = 'none';
  $('rtStrip').style.transform = 'translateY(0)';
  $('rtCount').textContent = 'Cargando participantes…';
  try {
    rtNames = (await api('/api/ruleta')).names;
    $('rtCount').textContent = rtNames.length ? `${rtNames.length} participantes registrados` : 'Ya salieron todos';
    syncRuletaButtons();
    fillStrip(rtNames);
  } catch (err) {
    $('rtCount').textContent = err.message;
  }
}

$('rtSpin').onclick = async () => {
  if (spinning) return;
  spinning = true;
  $('rtSpin').disabled = true;
  $('rtWinner').textContent = '';
  clearTimeout(idleTimer);
  try {
    const w = await api('/api/ruleta/spin', { method: 'POST', body: {} });
    ownDrawId = w.id;
    rtNames = rtNames.filter((n, i) => i !== rtNames.indexOf(w.name)); // winners don't re-enter
    const strip = $('rtStrip');
    strip.style.transition = 'none';
    strip.style.transform = 'translateY(0)';
    const idx = fillStrip([...rtNames, w.name], w.name);
    const row = strip.firstElementChild.getBoundingClientRect().height;
    const target = strip.children[idx].getBoundingClientRect().top - strip.getBoundingClientRect().top - CENTER * row;
    strip.style.transition = 'transform 6s cubic-bezier(0.12, 0.8, 0.1, 1)';
    strip.style.transform = `translateY(${-target}px)`;
    let last = 0;
    const tick = (t0) => (t) => { // a click per row passing the marker
      const y = -new DOMMatrix(getComputedStyle(strip).transform).m42 / row | 0;
      if (y !== last) { last = y; beep(320 + (y % 2) * 60, 0.02); }
      if (spinning) requestAnimationFrame(tick(t0));
    };
    requestAnimationFrame(tick());
    await new Promise((r) => strip.addEventListener('transitionend', r, { once: true }));
    spinning = false;
    strip.children[idx].classList.add('win'); // colour it only once the wheel has stopped on it
    $('rtWinner').innerHTML = `¡${esc(w.name)}!<small>Folio ${esc(w.folio)}</small>`;
    $('rtCount').textContent = `${rtNames.length} participantes restantes`;
    $('rtSpin').textContent = 'GIRAR OTRA VEZ';
    confetti(6000);
    beep(990, 0.4);
    hostOwl.happy?.();
  } catch (err) {
    spinning = false;
    toast(err.message, { error: true });
  }
  syncRuletaButtons();
  idleTimer = setTimeout(() => state === 'ruleta' && show('attract'), IDLE.ruleta);
};
$('rtReset').onclick = async () => {
  if (spinning) return;
  $('rtReset').disabled = true;
  try {
    rtNames = (await api('/api/ruleta/reset', { method: 'POST', body: {} })).names;
    $('rtWinner').textContent = '';
    $('rtSpin').textContent = 'GIRAR';
    $('rtCount').textContent = `${rtNames.length} participantes de nuevo en la ruleta`;
    fillStrip(rtNames);
  } catch (err) {
    toast(err.message, { error: true });
  }
  $('rtReset').disabled = false;
  syncRuletaButtons();
};
$('rtClose').onclick = () => { if (!spinning) show('attract'); };

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
  raffle: (d) => (d.id === ownDrawId || state === 'ruleta') ? null : (['attract', 'pin', 'confirm', 'raffle'].includes(state) ? runRaffle(d) : (pendingRaffle = d)),
});
api('/api/config').then((c) => (config = c)).catch(() => {});
show('attract');
