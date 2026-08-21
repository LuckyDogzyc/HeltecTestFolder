import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabaseForTests } from '../lib/db';
import { createSession, createUser } from '../lib/auth';
import { registerDevice } from '../lib/store';
import { POST as issueCode } from '../app/api/devices/[id]/pairing-code/route';
import { POST as claim } from '../app/api/me/devices/[id]/claim/route';

const context = (id: string) => ({ params: Promise.resolve({ id }) });

test('only an unclaimed physical device can request a short-lived pairing code', async () => {
  process.env.POKEMON_DISPLAY_DB_PATH = join(tmpdir(), `pokemon-display-pairing-${crypto.randomUUID()}.sqlite`);
  registerDevice({ deviceId: 'device-a', deviceKey: 'device-secret', publicIp: '127.0.0.1' });

  const missingAuth = await issueCode(new Request('http://localhost/api/devices/device-a/pairing-code', { method: 'POST' }), context('device-a'));
  assert.equal(missingAuth.status, 401);
  const wrongKey = await issueCode(new Request('http://localhost/api/devices/device-a/pairing-code', { method: 'POST', headers: { authorization: 'Bearer wrong' } }), context('device-a'));
  assert.equal(wrongKey.status, 401);

  const issued = await issueCode(new Request('http://localhost/api/devices/device-a/pairing-code', { method: 'POST', headers: { authorization: 'Bearer device-secret' } }), context('device-a'));
  assert.equal(issued.status, 200);
  const payload = await issued.json() as { ok: boolean; code: string; expiresInSeconds: number };
  assert.equal(payload.ok, true);
  assert.match(payload.code, /^\d{6}$/);
  assert.equal(payload.expiresInSeconds, 600);

  const owner = createUser({ email: 'owner@example.com', password: 'correct horse battery staple' });
  const claimed = await claim(new Request('http://localhost/api/me/devices/device-a/claim', { method: 'POST', headers: { cookie: `pokemon_display_session=${createSession(owner.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: payload.code }) }), context('device-a'));
  assert.equal(claimed.status, 200);

  const afterClaim = await issueCode(new Request('http://localhost/api/devices/device-a/pairing-code', { method: 'POST', headers: { authorization: 'Bearer device-secret' } }), context('device-a'));
  assert.equal(afterClaim.status, 409);
  closeDatabaseForTests();
  rmSync(process.env.POKEMON_DISPLAY_DB_PATH!, { force: true });
});
