// HTTP API. Runs as a single Vercel function (api/index.js) and under the local dev server.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { config, configProblems } from '../config.js';
import { getDb, lock, LOCK, newFolio, newPrizeCode, displayName } from './db.js';

const SCENES_DIR = new URL('../public/scenes/', import.meta.url);
// Fingers are fat: accept taps a bit outside the owl's drawn radius. Screens use the same value.
const HIT_SLOP = 1.35;

// ---------- helpers ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isStr ? body : JSON.stringify(body));
};

async function readJson(req) {
  if (req.body !== undefined && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body ?? {};
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new HttpError(413, 'Payload too large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b));
  return y.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

function requireAdmin(req) {
  if (!safeEq(req.headers['x-admin-pin'], config.adminPin)) throw new HttpError(401, 'PIN de staff incorrecto');
}

function requireKiosk(req) {
  if (config.kioskKey && !safeEq(req.headers['x-kiosk-key'], config.kioskKey)) {
    throw new HttpError(401, 'Dispositivo no autorizado');
  }
}

const str = (v, max = 120) => String(v ?? '').trim().slice(0, max);

function csv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    // Leading =,+,-,@ would be evaluated as formulas when opened in Excel.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

const tierFor = (ms) => config.tiers.find((t) => ms <= t.maxMs)?.label ?? null;

function normFolio(v) {
  return `ADD-${String(v ?? '').replace(/\D/g, '')}`;
}

// ---------- scenes ----------
// Defaults ship in public/scenes/scenes.default.json (built from the deck); staff
// edits from /admin are stored in the settings table.

const readDefaultScenes = () => {
  try {
    return JSON.parse(readFileSync(new URL('scenes.default.json', SCENES_DIR), 'utf8'));
  } catch {
    return [];
  }
};

async function loadScenes(q) {
  const [row] = await q.query("SELECT value FROM settings WHERE key = 'scenes'");
  return row ? row.value : readDefaultScenes();
}

const playable = (s) => s.enabled && (s.owl || (s.sprite && s.spots?.length));

async function pickScene(q, lastSceneId) {
  const scenes = (await loadScenes(q)).filter(playable);
  if (scenes.length) {
    // Alternate scenes and never reuse the previous hiding spot (the screen tells us what it showed last).
    const lastBase = lastSceneId?.split('#')[0];
    const pool = scenes.length > 1 ? scenes.filter((s) => s.id !== lastBase) : scenes;
    const s = pool[randomInt(pool.length)];
    const base = { id: s.id, type: 'image', image: s.image, timerBox: s.timerBox ?? null };
    if (s.owl) return { ...base, owl: s.owl };
    const idx = s.spots.map((_, i) => i).filter((i) => s.spots.length < 2 || `${s.id}#${i}` !== lastSceneId);
    const i = idx[randomInt(idx.length)];
    return { ...base, id: `${s.id}#${i}`, sprite: s.sprite, owl: s.spots[i] };
  }
  // No artwork: the screen draws a seeded clutter field. Owl kept away from the edges and the HUD.
  const seed = randomInt(1, 2 ** 31);
  return {
    id: `proc-${seed}`,
    type: 'procedural',
    seed,
    owl: { x: 0.08 + Math.random() * 0.84, y: 0.2 + Math.random() * 0.72, r: 0.034 },
  };
}

// ---------- queries ----------

const byFolio = async (q, folio) => (await q.query('SELECT * FROM participants WHERE folio = $1', [folio]))[0];

// A started-but-never-finished play (screen crashed, player walked away) only
// counts against the folio for 60 s, so staff don't need to intervene.
async function playsLeft(q, p) {
  const [{ n }] = await q.query(
    `SELECT count(*)::int AS n FROM plays WHERE participant_id = $1 AND (status = 'done' OR started_ms > $2)`,
    [p.id, Date.now() - 60_000],
  );
  return Math.max(0, config.maxPlaysPerFolio + p.extra_plays - n);
}

async function leaderboard(q) {
  const rows = await q.query(
    `SELECT p.folio, p.name, min(pl.ms) AS ms
     FROM plays pl JOIN participants p ON p.id = pl.participant_id
     WHERE pl.found
     GROUP BY p.id ORDER BY ms ASC, min(pl.finished_at) ASC LIMIT $1`,
    [config.leaderboardSize],
  );
  return rows.map((r, i) => ({ rank: i + 1, name: displayName(r.name), folio: r.folio, ms: r.ms }));
}

const rafflePool = (q) =>
  q.query(`SELECT p.id, p.folio, p.name FROM participants p
           WHERE p.consent_privacy
             AND p.id NOT IN (SELECT participant_id FROM raffle_draws)
             ${config.raffleRequiresPlay ? "AND EXISTS (SELECT 1 FROM plays WHERE participant_id = p.id AND status = 'done')" : ''}
           ORDER BY p.folio`);

const one = async (q, sql, params) => (await q.query(sql, params))[0];

// ---------- routes ----------

const routes = {
  'GET /api/config': () => ({
    timeLimitMs: config.timeLimitMs,
    tiers: config.tiers,
    kioskKeyRequired: Boolean(config.kioskKey),
  }),

  // The touch screen polls this (serverless has no shared connection to push from).
  'GET /api/state': async (req, url, db) => {
    requireKiosk(req);
    const [lb, draw, reg] = await Promise.all([
      leaderboard(db),
      one(db, `SELECT d.id, d.label, d.reel, d.folio, d.show_name, p.name FROM raffle_draws d
               JOIN participants p ON p.id = d.participant_id ORDER BY d.id DESC LIMIT 1`),
      one(db, 'SELECT id, name FROM participants ORDER BY id DESC LIMIT 1'),
    ]);
    return {
      leaderboard: lb,
      raffle: draw && {
        id: draw.id,
        label: draw.label,
        reel: draw.reel,
        winner: { folio: draw.folio, name: draw.show_name ? displayName(draw.name) : null },
      },
      lastRegistered: reg && { id: reg.id, name: displayName(reg.name) },
    };
  },

  'GET /api/leaderboard': (req, url, db) => leaderboard(db),

  'POST /api/register': async (req, url, db) => {
    requireKiosk(req);
    const b = await readJson(req);
    const data = {
      name: str(b.name),
      email: str(b.email).toLowerCase(),
      phone: str(b.phone, 30).replace(/[^\d+]/g, ''),
      company: str(b.company),
      specialty: str(b.specialty),
      subspecialty: str(b.subspecialty),
      reqId: str(b.reqId, 64) || null,
    };
    if (data.name.length < 3) throw new HttpError(400, 'Escribe tu nombre completo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new HttpError(400, 'Correo inválido');
    if (data.phone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'WhatsApp a 10 dígitos');
    if (b.consentPrivacy !== true) throw new HttpError(400, 'Debes aceptar el aviso de privacidad');

    return db.tx(async (t) => {
      await lock(t, LOCK.register);
      // Retries from a flaky connection return the same folio.
      const prior =
        (data.reqId && (await one(t, 'SELECT * FROM participants WHERE client_req_id = $1', [data.reqId]))) ||
        (await one(t, 'SELECT * FROM participants WHERE lower(email) = lower($1)', [data.email]));
      if (prior) return { folio: prior.folio, name: displayName(prior.name), existing: true };
      const folio = await newFolio(t);
      await t.query(
        `INSERT INTO participants (folio, name, email, phone, company, specialty, subspecialty,
           consent_privacy, consent_marketing, client_req_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)`,
        [folio, data.name, data.email, data.phone, data.company, data.specialty, data.subspecialty,
          b.consentMarketing === true, data.reqId],
      );
      return { folio, name: displayName(data.name), existing: false };
    });
  },

  'GET /api/participant': async (req, url, db) => {
    requireKiosk(req);
    const p = await byFolio(db, normFolio(url.searchParams.get('folio')));
    if (!p) throw new HttpError(404, 'Folio no encontrado');
    const best = await one(db, 'SELECT min(ms) AS ms FROM plays WHERE participant_id = $1 AND found', [p.id]);
    return { folio: p.folio, name: displayName(p.name), playsLeft: await playsLeft(db, p), bestMs: best.ms };
  },

  'POST /api/play/start': async (req, url, db) => {
    requireKiosk(req);
    const b = await readJson(req);
    return db.tx(async (t) => {
      const p = await byFolio(t, normFolio(b.folio));
      if (!p) throw new HttpError(404, 'Folio no encontrado');
      await lock(t, LOCK.player, p.id); // one start at a time per participant
      if ((await playsLeft(t, p)) <= 0) throw new HttpError(409, 'Este folio ya jugó');
      const scene = await pickScene(t, str(b.lastSceneId, 200) || null);
      const [{ id }] = await t.query(
        'INSERT INTO plays (participant_id, scene_id, owl_x, owl_y, owl_r, started_ms) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [p.id, scene.id, scene.owl.x, scene.owl.y, scene.owl.r, Date.now()],
      );
      return { playId: id, scene, timeLimitMs: config.timeLimitMs };
    });
  },

  'POST /api/play/finish': async (req, url, db) => {
    requireKiosk(req);
    const b = await readJson(req);
    return db.tx(async (t) => {
      await lock(t, LOCK.prize);
      const play = await one(t, 'SELECT * FROM plays WHERE id = $1 FOR UPDATE', [Number(b.playId) || 0]);
      if (!play) throw new HttpError(404, 'Partida no encontrada');
      if (play.status === 'done') throw new HttpError(409, 'Partida ya registrada');

      // The screen measures time locally (accurate to the frame), but it can
      // never exceed what the server saw plus network slack.
      const serverElapsed = Date.now() - Number(play.started_ms);
      let ms = Math.round(Number(b.ms));
      let found = b.found === true;
      if (!Number.isFinite(ms) || ms < 0) ms = config.timeLimitMs;
      if (ms > serverElapsed + 1500) ms = serverElapsed; // count-down + latency budget
      if (ms > config.timeLimitMs || ms < 150) found = false;

      // Verify the winning tap actually landed on the owl. Tap/owl coords are
      // 0..1 of the play area; owl r is a fraction of its width.
      if (found) {
        const aspect = Number(b.aspect) > 0 ? Number(b.aspect) : 1; // width / height
        const dx = Number(b.tap?.x) - play.owl_x;
        const dy = (Number(b.tap?.y) - play.owl_y) / aspect;
        if (!(Math.hypot(dx, dy) <= play.owl_r * HIT_SLOP)) found = false;
      }

      const tier = found ? tierFor(ms) : null;
      let prizeCode = null;
      if (found && ms <= config.prizeMaxMs) {
        const given = (await one(t, 'SELECT count(*)::int AS n FROM plays WHERE prize_code IS NOT NULL')).n;
        if (config.prizeStock === 0 || given < config.prizeStock) prizeCode = await newPrizeCode(t);
      }
      await t.query(
        `UPDATE plays SET status = 'done', found = $1, ms = $2, misses = $3, tier = $4, prize_code = $5,
           finished_at = now() WHERE id = $6`,
        [found, found ? ms : null, Math.min(999, Number(b.misses) || 0), tier, prizeCode, play.id],
      );
      const rank = found
        ? (await one(t, `SELECT count(*)::int + 1 AS rank FROM (
             SELECT min(ms) AS best FROM plays WHERE found GROUP BY participant_id) b WHERE best < $1`, [ms])).rank
        : null;
      return {
        found, ms: found ? ms : null, tier, prizeCode, rank,
        owl: { x: play.owl_x, y: play.owl_y, r: play.owl_r },
      };
    });
  },

  // ----- admin -----

  'GET /api/admin/stats': async (req, url, db) => {
    requireAdmin(req);
    const n = async (sql) => (await one(db, sql)).n;
    const [participants, marketingConsent, players, plays, found, avg, tiers, prizesGiven, prizesRedeemed, pool, byHour, lb] =
      await Promise.all([
        n('SELECT count(*)::int AS n FROM participants'),
        n('SELECT count(*)::int AS n FROM participants WHERE consent_marketing'),
        n("SELECT count(DISTINCT participant_id)::int AS n FROM plays WHERE status = 'done'"),
        n("SELECT count(*)::int AS n FROM plays WHERE status = 'done'"),
        n('SELECT count(*)::int AS n FROM plays WHERE found'),
        one(db, 'SELECT round(avg(ms))::int AS v FROM plays WHERE found'),
        db.query('SELECT tier, count(*)::int AS n FROM plays WHERE tier IS NOT NULL GROUP BY tier'),
        n('SELECT count(*)::int AS n FROM plays WHERE prize_code IS NOT NULL'),
        n('SELECT count(*)::int AS n FROM plays WHERE prize_redeemed_at IS NOT NULL'),
        rafflePool(db),
        db.query(`SELECT to_char(date_trunc('hour', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24') AS hour,
                    count(*)::int AS n FROM participants GROUP BY 1 ORDER BY 1`),
        leaderboard(db),
      ]);
    return {
      participants, marketingConsent, players, plays, found, avgMs: avg.v, tiers,
      prizesGiven, prizesRedeemed, prizeStock: config.prizeStock, rafflePool: pool.length, byHour, leaderboard: lb,
    };
  },

  'GET /api/admin/participants': async (req, url, db) => {
    requireAdmin(req);
    const like = `%${str(url.searchParams.get('q'))}%`;
    return db.query(
      `SELECT p.folio, p.name, p.email, p.phone, p.company, p.specialty, p.created_at, p.extra_plays,
         (SELECT count(*)::int FROM plays WHERE participant_id = p.id AND status = 'done') AS plays,
         (SELECT min(ms) FROM plays WHERE participant_id = p.id AND found) AS best_ms,
         (SELECT string_agg(prize_code, ',') FROM plays WHERE participant_id = p.id) AS prizes
       FROM participants p
       WHERE p.folio ILIKE $1 OR p.name ILIKE $1 OR p.email ILIKE $1
       ORDER BY p.created_at DESC LIMIT 200`,
      [like],
    );
  },

  'POST /api/admin/extra-play': async (req, url, db) => {
    requireAdmin(req);
    const { folio } = await readJson(req);
    const r = await db.query('UPDATE participants SET extra_plays = extra_plays + 1 WHERE folio = $1 RETURNING id', [normFolio(folio)]);
    if (!r.length) throw new HttpError(404, 'Folio no encontrado');
    return { ok: true };
  },

  'POST /api/admin/redeem': async (req, url, db) => {
    requireAdmin(req);
    const code = str((await readJson(req)).code, 20).toUpperCase().replace(/^(OWL)?-?/, 'OWL-');
    return db.tx(async (t) => {
      const row = await one(t, `SELECT pl.id, pl.prize_redeemed_at, pl.ms, pl.tier, p.folio, p.name
                                FROM plays pl JOIN participants p ON p.id = pl.participant_id
                                WHERE pl.prize_code = $1 FOR UPDATE OF pl`, [code]);
      if (!row) throw new HttpError(404, `Código ${code} no existe`);
      if (row.prize_redeemed_at) throw new HttpError(409, `${code} ya se entregó (${new Date(row.prize_redeemed_at).toLocaleString('es-MX')})`);
      await t.query('UPDATE plays SET prize_redeemed_at = now() WHERE id = $1', [row.id]);
      return { code, folio: row.folio, name: row.name, ms: row.ms, tier: row.tier };
    });
  },

  'GET /api/admin/raffle': async (req, url, db) => {
    requireAdmin(req);
    const [pool, draws] = await Promise.all([
      rafflePool(db),
      db.query(`SELECT d.id, d.folio, d.label, d.pool_size, d.pool_sha256, d.drawn_at, p.name
                FROM raffle_draws d JOIN participants p ON p.id = d.participant_id ORDER BY d.id`),
    ]);
    return { poolSize: pool.length, draws };
  },

  'POST /api/admin/raffle/draw': async (req, url, db) => {
    requireAdmin(req);
    const { label = '', showName = false } = await readJson(req);
    return db.tx(async (t) => {
      await lock(t, LOCK.raffle);
      const pool = await rafflePool(t);
      if (!pool.length) throw new HttpError(409, 'No hay participantes elegibles');
      // Hash of the full pool is stored with the draw as evidence of who was in it.
      const poolHash = createHash('sha256').update(pool.map((p) => p.folio).join(',')).digest('hex');
      const w = pool[randomInt(pool.length)];
      const reel = Array.from({ length: Math.min(40, pool.length) }, () => pool[randomInt(pool.length)].folio);
      await t.query(
        `INSERT INTO raffle_draws (participant_id, folio, label, pool_size, pool_sha256, reel, show_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [w.id, w.folio, str(label, 80), pool.length, poolHash, JSON.stringify(reel), showName === true],
      );
      return { folio: w.folio, name: w.name, poolSize: pool.length, poolSha256: poolHash };
    });
  },

  'GET /api/admin/export': async (req, url, db) => {
    requireAdmin(req);
    const what = url.searchParams.get('what');
    const sql = {
      participants: `SELECT p.folio, p.name, p.email, p.phone, p.company, p.specialty, p.subspecialty,
                       p.consent_privacy, p.consent_marketing, p.created_at,
                       (SELECT count(*)::int FROM plays WHERE participant_id = p.id AND status = 'done') AS plays,
                       (SELECT min(ms) FROM plays WHERE participant_id = p.id AND found) AS best_ms
                     FROM participants p ORDER BY p.created_at`,
      plays: `SELECT pl.id, p.folio, pl.scene_id, pl.found, pl.ms, pl.misses, pl.tier, pl.prize_code,
                pl.prize_redeemed_at, pl.started_at, pl.finished_at
              FROM plays pl JOIN participants p ON p.id = pl.participant_id
              WHERE pl.status = 'done' ORDER BY pl.id`,
      raffle: `SELECT d.drawn_at, d.label, d.folio, p.name, p.email, p.phone, d.pool_size, d.pool_sha256
               FROM raffle_draws d JOIN participants p ON p.id = d.participant_id ORDER BY d.id`,
    }[what];
    if (!sql) throw new HttpError(400, 'what = participants | plays | raffle');
    return { __csv: csv(await db.query(sql)), filename: `addwize-${what}-${new Date().toISOString().slice(0, 10)}.csv` };
  },

  'GET /api/admin/scenes': async (req, url, db) => {
    requireAdmin(req);
    const scenes = await loadScenes(db);
    const images = existsSync(SCENES_DIR)
      ? readdirSync(SCENES_DIR).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => `/scenes/${f}`)
      : [];
    // Every image in public/scenes shows up; ones not yet calibrated have owl = null.
    const listed = new Set(scenes.map((s) => s.image));
    return [...scenes, ...images.filter((i) => !listed.has(i)).map((image) => ({ id: image, image, owl: null, enabled: false }))];
  },

  'POST /api/admin/scenes': async (req, url, db) => {
    requireAdmin(req);
    const list = await readJson(req);
    if (!Array.isArray(list)) throw new HttpError(400, 'Se esperaba una lista');
    const circle = (c) => ({ x: +c.x, y: +c.y, r: +c.r });
    const clean = list.map((s) => {
      const out = { id: str(s.id || s.image, 200), image: str(s.image, 200), owl: s.owl ? circle(s.owl) : null };
      if (Array.isArray(s.spots) && s.sprite) {
        out.sprite = str(s.sprite, 200);
        out.spots = s.spots.map(circle);
      }
      if (s.timerBox) out.timerBox = { x: +s.timerBox.x, y: +s.timerBox.y, w: +s.timerBox.w, h: +s.timerBox.h, bg: str(s.timerBox.bg, 20) };
      out.enabled = Boolean(s.enabled) && playable({ ...out, enabled: true });
      return out;
    });
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('scenes', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(clean)],
    );
    return { ok: true };
  },
};

// ---------- handler ----------

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'No existe' });
    const problems = configProblems();
    if (problems.length) {
      console.error('Misconfigured:', problems.join('; '));
      return send(res, 503, { error: 'Servidor sin configurar (ADMIN_PIN)' });
    }
    const out = await route(req, url, await getDb());
    if (out?.__csv !== undefined) {
      return send(res, 200, out.__csv, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${out.filename}"`,
      });
    }
    return send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Error interno' });
  }
}
