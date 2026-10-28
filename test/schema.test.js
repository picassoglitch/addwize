import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// A database created before visited_by_rep existed gets the column on the next cold start.
test('schema upgrade adds participants.visited_by_rep to an existing table', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'addwize-schema-'));
  try {
    const old = new PGlite(dir);
    await old.exec(`
      CREATE TABLE participants (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, folio text NOT NULL UNIQUE,
        name text NOT NULL, email text NOT NULL, phone text NOT NULL,
        company text NOT NULL DEFAULT '', specialty text NOT NULL DEFAULT '', subspecialty text NOT NULL DEFAULT '',
        consent_privacy boolean NOT NULL, consent_marketing boolean NOT NULL DEFAULT false,
        extra_plays integer NOT NULL DEFAULT 0, client_req_id text UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO participants (folio, name, email, phone, consent_privacy)
        VALUES ('ADD-0001', 'Dr. Previo', 'previo@hospital.mx', '5512345678', true);`);
    await old.close();

    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    process.env.PGLITE_DIR = dir;
    const { getDb } = await import('../lib/db.js');
    const db = await getDb();
    const rows = await db.query('SELECT folio, visited_by_rep FROM participants');
    assert.deepEqual(rows, [{ folio: 'ADD-0001', visited_by_rep: false }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
