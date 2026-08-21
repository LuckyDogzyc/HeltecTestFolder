import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests } from '../lib/db';
import { createSession, createUser } from '../lib/auth';
import { createPairingCode } from '../lib/pairing';
import { registerDevice } from '../lib/store';
import { POST as claim } from '../app/api/me/devices/[id]/claim/route';

test('an authenticated user claims a device with its one-time pairing code', async () => {
  process.env.POKEMON_DISPLAY_DB_PATH = join(tmpdir(), `pokemon-display-claim-${crypto.randomUUID()}.sqlite`);
  const user = createUser({ email: 'owner@example.com', password: 'correct horse battery staple' });
  registerDevice({ deviceId: 'device-a', deviceKey: 'device-secret', publicIp: '127.0.0.1' });
  const code = createPairingCode('device-a');
  const response = await claim(new Request('http://localhost/api/me/devices/device-a/claim', { method: 'POST', headers: { cookie: `pokemon_display_session=${createSession(user.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ code }) }), { params: Promise.resolve({ id: 'device-a' }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  closeDatabaseForTests();
  rmSync(process.env.POKEMON_DISPLAY_DB_PATH!, { force: true });
});
