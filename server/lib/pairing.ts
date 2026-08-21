import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb, type SqliteDatabase } from './db';

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function createPairingCode(deviceId: string, db: SqliteDatabase = getDb()) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  db.prepare('UPDATE pairing_codes SET used_at = ? WHERE device_id = ? AND used_at IS NULL').run(now.toISOString(), deviceId);
  db.prepare('INSERT INTO pairing_codes (id, device_id, code_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
    .run(randomBytes(16).toString('hex'), deviceId, hash(code), expiresAt, now.toISOString());
  return code;
}

export function claimDevice(userId: string, deviceId: string, code: string, db: SqliteDatabase = getDb()) {
  const now = new Date().toISOString();
  const pairing = db.prepare(`SELECT id, code_hash FROM pairing_codes
    WHERE device_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`).get(deviceId, now) as { id: string; code_hash: string } | undefined;
  const actual = pairing ? Buffer.from(hash(code)) : Buffer.alloc(64);
  const expected = pairing ? Buffer.from(pairing.code_hash) : Buffer.alloc(64);
  if (!pairing || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid pairing code');

  const claim = db.transaction(() => {
    const device = db.prepare('SELECT device_id FROM devices WHERE device_id = ?').get(deviceId);
    if (!device) throw new Error('device not found');
    const owner = db.prepare('SELECT user_id FROM device_owners WHERE device_id = ?').get(deviceId) as { user_id: string } | undefined;
    if (owner && owner.user_id !== userId) throw new Error('device is already claimed');
    db.prepare('INSERT INTO device_owners (device_id, user_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO NOTHING')
      .run(deviceId, userId, now);
    db.prepare('UPDATE pairing_codes SET used_at = ? WHERE id = ?').run(now, pairing.id);
  });
  claim();
}

export function ownsDevice(userId: string, deviceId: string, db: SqliteDatabase = getDb()) {
  return Boolean(db.prepare('SELECT 1 FROM device_owners WHERE device_id = ? AND user_id = ?').get(deviceId, userId));
}

export function isClaimed(deviceId: string, db: SqliteDatabase = getDb()) {
  return Boolean(db.prepare('SELECT 1 FROM device_owners WHERE device_id = ?').get(deviceId));
}
