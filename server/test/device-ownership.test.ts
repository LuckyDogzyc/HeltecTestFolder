import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initDatabase } from '../lib/db';
import { createUser } from '../lib/auth';
import { claimDevice, createPairingCode } from '../lib/pairing';
import { getDevice, registerDevice, saveDeviceConfig } from '../lib/store';

function freshDb() {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

test('a newly registered device receives a one-time pairing code and rejects a wrong key', () => {
  const db = freshDb();
  const device = registerDevice({ deviceId: 'device-a', deviceKey: 'device-secret', publicIp: '127.0.0.1' }, db);
  const code = createPairingCode(device.deviceId, db);

  assert.match(code, /^\d{6}$/);
  assert.throws(() => registerDevice({ deviceId: 'device-a', deviceKey: 'wrong-secret', publicIp: '127.0.0.1' }, db), /device key mismatch/);
  db.close();
});

test('only the claiming user can access or save a paired device', () => {
  const db = freshDb();
  registerDevice({ deviceId: 'device-a', deviceKey: 'device-secret', publicIp: '127.0.0.1' }, db);
  const owner = createUser({ email: 'owner@example.com', password: 'correct horse battery staple' }, db);
  const other = createUser({ email: 'other@example.com', password: 'correct horse battery staple' }, db);
  const code = createPairingCode('device-a', db);

  claimDevice(owner.id, 'device-a', code, db);
  assert.equal(getDevice('device-a', db, owner.id)?.deviceId, 'device-a');
  assert.equal(getDevice('device-a', db, other.id), null);
  assert.equal(saveDeviceConfig('device-a', 123, 'price', [], undefined, undefined, undefined, db, other.id), null);
  assert.equal(saveDeviceConfig('device-a', 123, 'price', [], undefined, undefined, undefined, db, owner.id)?.productId, 123);
  assert.throws(() => claimDevice(other.id, 'device-a', code, db), /invalid pairing code/);
  db.close();
});
