import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests } from '../lib/db';
import { createSession, createUser } from '../lib/auth';
import { grantPro } from '../lib/entitlements';
import { claimDevice, createPairingCode } from '../lib/pairing';
import { getDevice, registerDevice } from '../lib/store';
import { PATCH as saveConfig, GET as getConfig } from '../app/api/devices/[id]/config/route';

function context(id: string) { return { params: Promise.resolve({ id }) }; }

test('advanced configuration is forbidden to free users, allowed to owners on Pro, and bumps device config versions', async () => {
  process.env.POKEMON_DISPLAY_DB_PATH = join(tmpdir(), `pokemon-display-pro-${crypto.randomUUID()}.sqlite`);
  const owner = createUser({ email: 'owner@example.com', password: 'correct horse battery staple' });
  const other = createUser({ email: 'other@example.com', password: 'correct horse battery staple' });
  registerDevice({ deviceId: 'device-a', deviceKey: 'device-secret', publicIp: '127.0.0.1' });
  claimDevice(owner.id, 'device-a', createPairingCode('device-a'));
  const ownerCookie = `pokemon_display_session=${createSession(owner.id)}`;
  const otherCookie = `pokemon_display_session=${createSession(other.id)}`;
  const originalVersion = getDevice('device-a')!.configVersion;
  const advanced = { productId: 123, templateId: 'advanced', renderProgram: [] };

  const free = await saveConfig(new Request('http://localhost/api/devices/device-a/config', { method: 'PATCH', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify(advanced) }), context('device-a'));
  assert.equal(free.status, 403);
  const forbidden = await saveConfig(new Request('http://localhost/api/devices/device-a/config', { method: 'PATCH', headers: { cookie: otherCookie, 'content-type': 'application/json' }, body: JSON.stringify({ productId: 123, templateId: 'price', renderProgram: [] }) }), context('device-a'));
  assert.equal(forbidden.status, 403);

  // A generated black/red base frame is how every plan reaches the existing
  // ESP32 firmware; it is not itself a Pro feature.
  const freeBasic = await saveConfig(new Request('http://localhost/api/devices/device-a/config', { method: 'PATCH', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ productId: 123, templateId: 'price', renderProgram: [], frame: { blackB64: 'AA==', redB64: 'AA==', slots: [] } }) }), context('device-a'));
  assert.equal(freeBasic.status, 200);
  assert.equal(getDevice('device-a')!.configVersion, originalVersion + 1);

  grantPro(owner.id);
  assert.equal(getDevice('device-a')!.configVersion, originalVersion + 2);
  const pro = await saveConfig(new Request('http://localhost/api/devices/device-a/config', { method: 'PATCH', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify(advanced) }), context('device-a'));
  assert.equal(pro.status, 200);
  assert.equal(getDevice('device-a')!.configVersion, originalVersion + 3);

  const deviceResponse = await getConfig(new Request(`http://localhost/api/devices/device-a/config?version=${originalVersion + 2}`, { headers: { authorization: 'Bearer device-secret' } }), context('device-a'));
  assert.equal(deviceResponse.status, 200);
  assert.equal((await deviceResponse.json()).configVersion, originalVersion + 3);
  const unchanged = await getConfig(new Request(`http://localhost/api/devices/device-a/config?version=${originalVersion + 3}`, { headers: { authorization: 'Bearer device-secret' } }), context('device-a'));
  assert.equal(unchanged.status, 304);

  closeDatabaseForTests();
  rmSync(process.env.POKEMON_DISPLAY_DB_PATH!, { force: true });
});
