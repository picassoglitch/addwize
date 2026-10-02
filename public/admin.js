import { api, toast, fmtSec, esc } from '/api.js';

const $ = (id) => document.getElementById(id);
let pin = sessionStorage.getItem('adminPin') || '';
const A = (path, opts = {}) => api(path, { ...opts, admin: pin });

// ---------- login ----------

async function login() {
  pin = $('pinIn').value || pin;
  try {
    await A('/api/admin/stats');
  } catch (e) {
    $('loginErr').textContent = e.status === 401 ? 'PIN incorrecto' : e.message;
    return;
  }
  sessionStorage.setItem('adminPin', pin);
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  loadStats();
  setInterval(() => !document.hidden && current === 'stats' && loadStats(), 10_000);
}
$('loginBtn').onclick = login;
$('pinIn').onkeydown = (e) => e.key === 'Enter' && login();
if (pin) login();

// ---------- tabs ----------

let current = 'stats';
const loaders = { stats: loadStats, people: loadPeople, raffle: loadRaffle, scenes: loadScenes };
$('tabs').onclick = (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  current = tab;
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('[data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== tab);
  loaders[tab]?.();
};

// ---------- stats ----------

async function loadStats() {
  const s = await A('/api/admin/stats');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const kpi = (v, l) => `<div class="kpi glass"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $('kpis').innerHTML = [
    kpi(s.participants, 'Registros'),
    kpi(s.players, `Jugaron (${pct(s.players, s.participants)})`),
    kpi(s.found, `Encontraron al búho (${pct(s.found, s.plays)})`),
    kpi(s.avgMs ? `${fmtSec(s.avgMs)} s` : '–', 'Tiempo promedio'),
    kpi(`${s.prizesRedeemed}/${s.prizesGiven}`, `Premios entregados${s.prizeStock ? ` · stock ${s.prizeStock}` : ''}`),
    kpi(s.marketingConsent, 'Aceptan contacto comercial'),
    kpi(s.rafflePool, 'Elegibles para rifa'),
    ...s.tiers.map((t) => kpi(t.n, t.tier)),
  ].join('');
  const max = Math.max(1, ...s.byHour.map((h) => h.n));
  $('bars').innerHTML = s.byHour.slice(-24).map((h) => {
    const local = new Date(`${h.hour}:00:00Z`).getHours();
    return `<div style="height:${(h.n / max) * 100}%" title="${h.n}"><span>${local}h</span></div>`;
  }).join('') || '<span class="muted">Sin registros aún</span>';
  $('lb').innerHTML = '<tr><th>#</th><th>Nombre</th><th>Folio</th><th>Tiempo</th></tr>' +
    s.leaderboard.map((r) => `<tr><td>${r.rank}</td><td>${esc(r.name)}</td><td>${r.folio}</td><td>${fmtSec(r.ms)} s</td></tr>`).join('');
}

// ---------- people ----------

let qTimer;
$('q').oninput = () => { clearTimeout(qTimer); qTimer = setTimeout(loadPeople, 250); };
async function loadPeople() {
  const rows = await A(`/api/admin/participants?q=${encodeURIComponent($('q').value)}`);
  $('people').innerHTML = '<tr><th>Folio</th><th>Nombre</th><th>Correo</th><th>WhatsApp</th><th>Especialidad</th><th>Partidas</th><th>Mejor</th><th>Premio</th><th></th></tr>' +
    rows.map((r) => `<tr>
      <td><b>${r.folio}</b></td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td>
      <td>${esc(r.specialty)}</td><td>${r.plays}${r.extra_plays ? ` (+${r.extra_plays})` : ''}</td>
      <td>${r.best_ms ? `${fmtSec(r.best_ms)} s` : '–'}</td><td>${esc(r.prizes ?? '')}</td>
      <td><button class="btn ghost sm" data-extra="${r.folio}">+1 intento</button></td></tr>`).join('');
}
$('people').onclick = async (e) => {
  const folio = e.target.dataset.extra;
  if (!folio) return;
  await A('/api/admin/extra-play', { method: 'POST', body: { folio } });
  toast(`${folio}: intento extra habilitado`);
  loadPeople();
};

// ---------- prizes ----------

$('redeem').onclick = async () => {
  try {
    const r = await A('/api/admin/redeem', { method: 'POST', body: { code: $('code').value } });
    $('redeemOut').innerHTML = `<span class="ok">✔ ${r.code} entregado</span> — ${esc(r.name)} (${r.folio}), ${fmtSec(r.ms)} s · ${esc(r.tier)}`;
    $('code').value = '';
  } catch (e) {
    $('redeemOut').innerHTML = `<span class="bad">✖ ${esc(e.message)}</span>`;
  }
};
$('code').onkeydown = (e) => e.key === 'Enter' && $('redeem').click();

// ---------- raffle ----------

async function loadRaffle() {
  const r = await A('/api/admin/raffle');
  $('pool').textContent = r.poolSize;
  $('draws').innerHTML = r.draws.length
    ? '<tr><th>Hora</th><th>Etiqueta</th><th>Folio</th><th>Nombre</th><th>Pool</th></tr>' +
      r.draws.map((d) => `<tr><td>${new Date(d.drawn_at).toLocaleString()}</td><td>${esc(d.label)}</td><td><b>${d.folio}</b></td><td>${esc(d.name)}</td><td>${d.pool_size}</td></tr>`).join('')
    : '';
}
$('draw').onclick = async () => {
  if (!confirm('¿Sortear ahora? El resultado se mostrará en la pantalla touch.')) return;
  $('draw').disabled = true;
  try {
    const r = await A('/api/admin/raffle/draw', { method: 'POST', body: { label: $('rLabel').value, showName: $('rShow').checked } });
    $('drawOut').innerHTML = `<span class="ok">Ganador: ${r.folio} — ${esc(r.name)}</span> <span class="muted">(entre ${r.poolSize} · sha256 ${r.poolSha256.slice(0, 12)}…)</span>`;
    loadRaffle();
  } catch (e) {
    $('drawOut').innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  }
  $('draw').disabled = false;
};

// ---------- scenes ----------

let scenes = [];
let sel = null;
async function loadScenes() {
  scenes = await A('/api/admin/scenes');
  renderSceneList();
  if (!scenes.length) $('sceneEdit').textContent = 'No hay imágenes en public/scenes/. Mientras tanto se usan escenas generadas.';
}
function renderSceneList() {
  $('sceneList').innerHTML = scenes.map((s, i) =>
    `<li data-i="${i}" class="${s === sel ? 'on' : ''}">${s.enabled ? '🟢' : s.owl || s.spots ? '⚪' : '⚠️'} ${esc(s.image.replace('/scenes/', ''))}</li>`).join('');
}
$('sceneList').onclick = (e) => {
  const i = e.target.closest('li')?.dataset.i;
  if (i === undefined) return;
  sel = scenes[i];
  renderSceneList();
  editScene();
};
function editScene() {
  if (sel.spots) return editSpotScene();
  const owl = sel.owl ?? { x: 0.5, y: 0.5, r: 0.05 };
  $('sceneEdit').innerHTML = `
    <div class="calib" id="calib"><img src="${sel.image}"><div class="c" id="circ"></div></div>
    <div class="row" style="margin-top:12px">
      <label>Tamaño <input type="range" id="rad" min="0.01" max="0.2" step="0.002" value="${owl.r}"></label>
      <label class="row" style="gap:6px"><input type="checkbox" id="en" ${sel.enabled ? 'checked' : ''}> Activa</label>
      <button class="btn sm" id="saveScene">Guardar</button>
    </div>
    <p class="muted">Toca el centro del búho. El círculo es el área válida (la pantalla acepta ~35% extra de margen).</p>`;
  const draw = () => {
    const img = $('calib').querySelector('img');
    const w = img.clientWidth;
    Object.assign($('circ').style, { left: `${owl.x * 100}%`, top: `${owl.y * 100}%`, width: `${owl.r * 2 * w}px`, height: `${owl.r * 2 * w}px` });
  };
  $('calib').querySelector('img').onload = draw;
  $('calib').onclick = (e) => {
    const r = $('calib').getBoundingClientRect();
    owl.x = +((e.clientX - r.left) / r.width).toFixed(4);
    owl.y = +((e.clientY - r.top) / r.height).toFixed(4);
    draw();
  };
  $('rad').oninput = () => { owl.r = +$('rad').value; draw(); };
  $('saveScene').onclick = async () => {
    sel.owl = owl;
    sel.enabled = $('en').checked;
    await A('/api/admin/scenes', { method: 'POST', body: scenes.filter((s) => s.owl || s.spots) });
    toast('Escena guardada');
    renderSceneList();
  };
  draw();
}

// Variable scenes: the mascot is dropped into one of these spots per play (scripts/extract_deck_art.py).
function editSpotScene() {
  $('sceneEdit').innerHTML = `
    <div class="calib" id="calib"><img src="${sel.image}">${sel.spots.map(() => '<div class="c"></div>').join('')}</div>
    <div class="row" style="margin-top:12px">
      <label class="row" style="gap:6px"><input type="checkbox" id="en" ${sel.enabled ? 'checked' : ''}> Activa</label>
      <button class="btn sm" id="saveScene">Guardar</button>
    </div>
    <p class="muted">${sel.spots.length} escondites: en cada partida el búho aparece en uno al azar.</p>`;
  const draw = () => {
    const w = $('calib').querySelector('img').clientWidth;
    $('calib').querySelectorAll('.c').forEach((c, i) => {
      const p = sel.spots[i];
      Object.assign(c.style, { left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.r * 2 * w}px`, height: `${p.r * 2 * w}px` });
    });
  };
  $('calib').querySelector('img').onload = draw;
  $('saveScene').onclick = async () => {
    sel.enabled = $('en').checked;
    await A('/api/admin/scenes', { method: 'POST', body: scenes.filter((s) => s.owl || s.spots) });
    toast('Escena guardada');
    renderSceneList();
  };
  draw();
}

// ---------- export ----------

for (const b of document.querySelectorAll('[data-export]')) {
  b.onclick = async () => {
    const res = await fetch(`/api/admin/export?what=${b.dataset.export}`, { headers: { 'x-admin-pin': pin } });
    if (!res.ok) return toast('Error al exportar', { error: true });
    const name = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'export.csv';
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: name });
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
