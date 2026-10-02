// Postgres access. Production (Vercel): Neon — HTTP for single queries, a short-lived
// WebSocket client for transactions. Tests / local dev without DATABASE_URL: PGlite.
import { randomInt } from 'node:crypto';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS participants (
    id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    folio             text NOT NULL UNIQUE,
    name              text NOT NULL,
    email             text NOT NULL,
    phone             text NOT NULL,
    company           text NOT NULL DEFAULT '',
    specialty         text NOT NULL DEFAULT '',
    subspecialty      text NOT NULL DEFAULT '',
    consent_privacy   boolean NOT NULL,
    consent_marketing boolean NOT NULL DEFAULT false,
    extra_plays       integer NOT NULL DEFAULT 0,
    client_req_id     text UNIQUE,
    created_at        timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS participants_email ON participants (lower(email));

  CREATE TABLE IF NOT EXISTS plays (
    id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    participant_id    integer NOT NULL REFERENCES participants(id),
    scene_id          text NOT NULL,
    owl_x             double precision NOT NULL,
    owl_y             double precision NOT NULL,
    owl_r             double precision NOT NULL,
    status            text NOT NULL DEFAULT 'started',  -- started | done
    found             boolean,
    ms                integer,
    misses            integer,
    tier              text,
    prize_code        text UNIQUE,
    prize_redeemed_at timestamptz,
    started_at        timestamptz NOT NULL DEFAULT now(),
    started_ms        bigint NOT NULL,
    finished_at       timestamptz
  );
  CREATE INDEX IF NOT EXISTS plays_participant ON plays (participant_id);

  CREATE TABLE IF NOT EXISTS raffle_draws (
    id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    participant_id integer NOT NULL REFERENCES participants(id),
    folio          text NOT NULL,
    label          text NOT NULL DEFAULT '',
    pool_size      integer NOT NULL,
    pool_sha256    text NOT NULL,
    reel           jsonb NOT NULL DEFAULT '[]',
    show_name      boolean NOT NULL DEFAULT false,
    drawn_at       timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
  );
`;

// Advisory-lock namespaces for the read-then-write sections (folio allocation, prize stock,
// raffle, per-player start).
export const LOCK = { register: 101, prize: 102, raffle: 103, player: 104 };

let dbPromise;
export function getDb() {
  dbPromise ??= open().then(async (db) => {
    await db.exec(SCHEMA);
    return db;
  });
  return dbPromise;
}

async function open() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (url) return openNeon(url);
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite(process.env.PGLITE_DIR || 'memory://');
  const wrap = (c) => ({ query: async (text, params) => (await c.query(text, params)).rows });
  return {
    ...wrap(pg),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
  };
}

async function openNeon(url) {
  const { neon, Client } = await import('@neondatabase/serverless');
  const sql = neon(url);
  return {
    query: (text, params) => sql.query(text, params),
    exec: async (script) => {
      const client = new Client(url);
      await client.connect();
      try { await client.query(script); } finally { await client.end(); }
    },
    tx: async (fn) => {
      const client = new Client(url);
      await client.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async (text, params) => (await client.query(text, params)).rows });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        await client.end();
      }
    },
  };
}

export const lock = (t, ns, id = 0) => t.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [ns, id]);

// Random (not sequential) folios so neighbours can't guess each other's PIN.
// 4 digits until the space gets crowded, then 5. Caller holds LOCK.register.
export async function newFolio(t) {
  const [{ n }] = await t.query('SELECT count(*)::int AS n FROM participants');
  const [lo, hi] = n < 6000 ? [1000, 10_000] : [10_000, 100_000];
  for (;;) {
    const folio = `ADD-${randomInt(lo, hi)}`;
    if (!(await t.query('SELECT 1 FROM participants WHERE folio = $1', [folio])).length) return folio;
  }
}

export async function newPrizeCode(t) {
  for (;;) {
    const code = `OWL-${randomInt(1000, 10_000)}`;
    if (!(await t.query('SELECT 1 FROM plays WHERE prize_code = $1', [code])).length) return code;
  }
}

// "Juan Pérez López" -> "Juan P." — what the public screens show.
export function displayName(name) {
  const parts = name.trim().replace(/^(dr|dra)\.?\s+/i, '').split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
}
