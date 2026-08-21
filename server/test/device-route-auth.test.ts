import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests } from '../lib/db';
import { createSession, createUser } from '../lib/auth';
import { claimDevice, createPairingCode } from '../lib/pairing';
import { registerDevice } from '../lib/store';
import { GET as readDevice, PATCH as renameDevice } from '../app/api/devices/[id]/route';
import { POST as registerRoute } from '../app/api/devices/route';

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test('device details are private to the owner and registration requires Bearer deviceKey', async () => {
  process.env.POKEMON_DISPLAY_DB_PATH = join(tmpdir(), `pokemon-display-device-route-${crypto.randomUUID()}.sqlite`);
  const owner = createUser({ email: 'owner@example.com', password: 'correct horse battery staple' });
  const other = createUser({ email: 'other@example.com', password: 'correct horse battery staple' });
  registerDevice({ deviceId: 'device-a', deviceKey: 'device-secret', publicIp: '127.0.0.1' });
  claimDevice(owner.id, 'device-a', createPairingCode('device-a'));
  const ownerCookie = `pokemon_display_session=${createSession(owner.id)}`;
  const otherCookie = `pokemon_display_session=${createSession(other.id)}`;

  assert.equal((await readDevice(new Request('http://localhost/api/devices/device-a'), ctx('device-a'))).status, 401);
  assert.equal((await readDevice(new Request('http://localhost/api/devices/device-a', { headers: { cookie: otherCookie } }), ctx('device-a'))).status, 404);
  assert.equal((await renameDevice(new Request('http://localhost/api/devices/device-a', { method: 'PATCH', headers: { cookie: otherCookie, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: 'stolen' }) }), ctx('device-a'))).status, 404);
  assert.equal((await readDevice(new Request('http://localhost/api/devices/device-a', { headers: { cookie: ownerCookie } }), ctx('device-a'))).status, 200);

  const rejected = await registerRoute(new Request('http://localhost/api/devices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'browser-device', deviceKey: 'secret' }) }));
  assert.equal(rejected.status, 401);
  const accepted = await registerRoute(new Request('http://localhost/api/devices', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer device-secret-2' }, body: JSON.stringify({ deviceId: 'physical-device' }) }));
  assert.equal(accepted.status, 200);

  closeDatabaseForTests();
  rmSync(process.env.POKEMON_DISPLAY_DB_PATH!, { force: true });
});
