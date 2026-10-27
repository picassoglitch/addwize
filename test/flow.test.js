import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_PIN = '9999';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

let base;
let server;
before(async () => {
  ({ server } = await import('../server.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  server.closeAllConnections();
});

const call = async (path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const admin = { 'x-admin-pin': '9999' };

const person = (n) => ({
  name: `Dra. Ana Martínez ${n}`, email: `ana${n}@hospital.mx`, phone: '55 1234 5678',
  company: 'Hospital', specialty: 'Psiquiatría', consentPrivacy: true, reqId: `req-${n}`,
});

test('registration issues a unique folio and dedupes by email / retry', async () => {
  const a = await call('/api/register', person(1));
  assert.equal(a.status, 200);
  assert.match(a.data.folio, /^ADD-\d{4}$/);
  assert.equal(a.data.name, 'Ana M.');

  const retry = await call('/api/register', person(1));
  assert.equal(retry.data.folio, a.data.folio);

  const sameEmail = await call('/api/register', { ...person(1), reqId: 'other', email: 'ANA1@hospital.mx' });
  assert.equal(sameEmail.data.folio, a.data.folio);
  assert.equal(sameEmail.data.existing, true);

  const noConsent = await call('/api/register', { ...person(2), consentPrivacy: false });
  assert.equal(noConsent.status, 400);
});

test('play: found owl -> tier, prize, leaderboard; 3 rounds of 3 games, then blocked', async () => {
  const { data: reg } = await call('/api/register', person(3));
  const digits = reg.folio.slice(4);

  const look = await call(`/api/participant?folio=${digits}`);
  assert.equal(look.data.playsLeft, 9);
  assert.equal(look.data.round, 1);
  assert.equal(look.data.game, 1);

  const { data: start } = await call('/api/play/start', { folio: digits });
  const { owl } = start.scene;
  await new Promise((r) => setTimeout(r, 300));
  const fin = await call('/api/play/finish', { playId: start.playId, found: true, ms: 250, tap: { x: owl.x, y: owl.y }, aspect: 0.5625 });
  assert.equal(fin.data.found, true);
  assert.equal(fin.data.tier, 'ULTRA FOCUS');
  assert.match(fin.data.prizeCode, /^OWL-\d{4}$/);
  assert.equal(fin.data.rank, 1);
  assert.equal(fin.data.roundDone, false);
  assert.equal(fin.data.game, 1);
  assert.equal(fin.data.roundMs, Math.round((250 + 10_000 + 10_000) / 3), 'unplayed games count as misses');

  const again = await call('/api/play/finish', { playId: start.playId, found: true, ms: 100, tap: { x: owl.x, y: owl.y } });
  assert.equal(again.status, 409);

  // Games 2-3 of round 1: different scenes, no second prize; the round averages all three.
  const scenes = [start.scene.id];
  let last;
  for (let g = 2; g <= 3; g++) {
    const { data: s } = await call('/api/play/start', { folio: digits });
    assert.equal(s.round, 1);
    assert.equal(s.game, g);
    scenes.push(s.scene.id);
    await new Promise((r) => setTimeout(r, 300));
    last = (await call('/api/play/finish', { playId: s.playId, found: true, ms: 250, tap: { x: s.scene.owl.x, y: s.scene.owl.y }, aspect: 0.5625 })).data;
    assert.equal(last.prizeCode, null, 'one instant prize per folio');
  }
  assert.equal(new Set(scenes.map((id) => id.split(/[#~@]/)[0])).size, 3, 'each game in a round uses a different scene');
  assert.equal(last.roundDone, true);
  assert.equal(last.roundMs, 250);
  assert.equal(last.bestMs, 250);
  assert.equal(last.playsLeft, 6);

  // Rounds 2-3 (all misses) don't hurt the best round; then the folio is out of plays.
  for (let i = 0; i < 6; i++) {
    const { data: s } = await call('/api/play/start', { folio: digits });
    assert.equal(s.round, 2 + Math.floor(i / 3));
    await call('/api/play/finish', { playId: s.playId, found: false, ms: 10_000 });
  }
  assert.equal((await call('/api/play/start', { folio: digits })).status, 409);
  assert.equal((await call(`/api/participant?folio=${digits}`)).data.bestMs, 250);

  const lb = await call('/api/leaderboard');
  assert.equal(lb.data[0].folio, reg.folio);
  assert.equal(lb.data[0].email, undefined, 'leaderboard must not leak PII');

  const redeem = await call('/api/admin/redeem', { code: fin.data.prizeCode }, admin);
  assert.equal(redeem.status, 200);
  assert.equal((await call('/api/admin/redeem', { code: fin.data.prizeCode }, admin)).status, 409);
});

test('server rejects a "found" whose tap misses the owl or is faster than the clock allows', async () => {
  const { data: reg } = await call('/api/register', person(4));
  const { data: start } = await call('/api/play/start', { folio: reg.folio });
  const { owl } = start.scene;
  const fin = await call('/api/play/finish', { playId: start.playId, found: true, ms: 2000, tap: { x: owl.x > 0.5 ? 0.05 : 0.95, y: owl.y }, aspect: 0.5625 });
  assert.equal(fin.data.found, false);
  assert.equal(fin.data.prizeCode, null);
});

test('admin: auth, extra play, raffle, export', async () => {
  assert.equal((await call('/api/admin/stats')).status, 401);
  const stats = await call('/api/admin/stats', undefined, admin);
  assert.equal(stats.data.participants, 3);

  const { data: reg } = await call('/api/register', person(5));
  await call('/api/admin/extra-play', { folio: reg.folio }, admin);
  assert.equal((await call(`/api/participant?folio=${reg.folio}`)).data.playsLeft, 12, '+1 ronda = 3 more games');

  const d1 = await call('/api/admin/raffle/draw', { label: 'Premio' }, admin);
  assert.equal(d1.data.poolSize, 4);
  const d2 = await call('/api/admin/raffle/draw', {}, admin);
  assert.equal(d2.data.poolSize, 3, 'previous winner excluded');
  assert.notEqual(d1.data.folio, d2.data.folio);

  const csv = await call('/api/admin/export?what=participants', undefined, admin);
  assert.match(csv.data, /folio,name,email/);
  assert.equal(csv.data.trim().split('\n').length, 5);
});

test('state endpoint reports leaderboard, newest registration and raffle for polling screens', async () => {
  const s = await call('/api/state');
  assert.equal(s.status, 200);
  assert.ok(Array.isArray(s.data.leaderboard));
  assert.ok(s.data.lastRegistered.id > 0);
  assert.match(s.data.raffle.winner.folio, /^ADD-/);
  assert.ok(Array.isArray(s.data.raffle.reel));
});

test('ruleta: spins until nobody is left, then reset puts everyone back without erasing past draws', async () => {
  let names = (await call('/api/ruleta')).data.names;
  while (names.length) {
    assert.equal((await call('/api/ruleta/spin', {})).status, 200);
    names = (await call('/api/ruleta')).data.names;
  }
  assert.equal((await call('/api/ruleta/spin', {})).status, 409, 'empty pool');
  const before = (await call('/api/admin/raffle', undefined, admin)).data.draws.length;

  const r = await call('/api/ruleta/reset', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.names.length, 4, 'every registered player re-enters');
  assert.equal((await call('/api/ruleta')).data.names.length, 4);
  assert.equal((await call('/api/admin/raffle', undefined, admin)).data.draws.length, before, 'draw history kept');
  assert.equal((await call('/api/ruleta/spin', {})).data.poolSize, 4);
});

test('variable scene never repeats the previous hiding spot', async () => {
  let last = null;
  for (let n = 10; n < 16; n++) {
    const { data: reg } = await call('/api/register', person(n));
    const { data } = await call('/api/play/start', { folio: reg.folio, lastSceneId: last });
    assert.notEqual(data.scene.id, last);
    last = data.scene.id;
  }
});

test('plays vary: mirrored scenes, lighting moods and owl sizes, with the hit target mirrored too', async () => {
  const ids = new Set(), moods = new Set(), sizes = new Set();
  let sawMirror = false;
  for (let n = 20; n < 50; n++) {
    const { data: reg } = await call('/api/register', person(n));
    const { data } = await call('/api/play/start', { folio: reg.folio });
    ids.add(data.scene.id.split('@')[0]);
    moods.add(data.scene.mood);
    sizes.add(data.scene.owl.r);
    if (data.scene.mirror) {
      sawMirror = true;
      assert.match(data.scene.image, /-mirror\.jpg$/);
    }
    // Tapping exactly where the scene says the owl is must count, mirrored or not.
    const fin = await call('/api/play/finish', { playId: data.playId, found: true, ms: 200,
      tap: { x: data.scene.owl.x, y: data.scene.owl.y }, aspect: 0.6 });
    assert.equal(fin.data.found, true);
  }
  assert.ok(sawMirror, 'expected some mirrored scenes');
  assert.ok(moods.size >= 2, 'expected several lighting moods');
  assert.ok(ids.size >= 10, `expected many distinct variants, got ${ids.size}`);
  assert.ok(sizes.size >= 5, 'expected the owl size to vary');
});
