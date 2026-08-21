import assert from 'node:assert/strict';
import test from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDatabaseForTests } from '../lib/db';
import { POST as register } from '../app/api/auth/register/route';
import { GET as me } from '../app/api/auth/me/route';
import { GET as devices } from '../app/api/me/devices/route';

test('account routes issue HttpOnly sessions and require one for my devices', async () => {
  process.env.POKEMON_DISPLAY_DB_PATH = join(tmpdir(), `pokemon-display-routes-${crypto.randomUUID()}.sqlite`);
  const unauthenticated = await devices(new Request('http://localhost/api/me/devices'));
  assert.equal(unauthenticated.status, 401);

  const registered = await register(new Request('http://localhost/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'trainer@example.com', password: 'correct horse battery staple' }),
  }));
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get('set-cookie') || '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=lax/i);

  const account = await me(new Request('http://localhost/api/auth/me', { headers: { cookie } }));
  assert.equal(account.status, 200);
  assert.deepEqual(await account.json(), { user: { email: 'trainer@example.com' }, plan: 'free' });

  const owned = await devices(new Request('http://localhost/api/me/devices', { headers: { cookie } }));
  assert.equal(owned.status, 200);
  assert.deepEqual(await owned.json(), { devices: [] });

  closeDatabaseForTests();
  rmSync(process.env.POKEMON_DISPLAY_DB_PATH!, { force: true });
});
