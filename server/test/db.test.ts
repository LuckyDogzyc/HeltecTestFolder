import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase } from '../lib/db';

test('initializes the account, session, device, ownership, entitlement, and pairing schema', () => {
  const path = join(tmpdir(), `pokemon-display-${crypto.randomUUID()}.sqlite`);
  try {
    const db = new Database(path);
    initDatabase(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => (row as { name: string }).name);

    for (const table of ['users', 'sessions', 'devices', 'device_owners', 'entitlements', 'pairing_codes', 'assets']) {
      assert.ok(names.includes(table), `missing ${table}`);
    }
    db.close();
  } finally {
    rmSync(path, { force: true });
  }
});
