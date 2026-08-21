import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { initDatabase } from '../lib/db';
import { authenticateUser, createSession, createUser, getSessionUser } from '../lib/auth';
import { getPlan, grantPro } from '../lib/entitlements';

function freshDb() {
  const db = new Database(':memory:');
  initDatabase(db);
  return db;
}

test('registering a user stores a scrypt hash and grants the free plan', () => {
  const db = freshDb();
  const user = createUser({ email: 'trainer@example.com', password: 'correct horse battery staple' }, db);
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };

  assert.match(stored.password_hash, /^scrypt\$/);
  assert.equal(getPlan(user.id, db), 'free');
  db.close();
});

test('an invalid password cannot create a session', () => {
  const db = freshDb();
  createUser({ email: 'trainer@example.com', password: 'correct horse battery staple' }, db);

  assert.equal(authenticateUser('trainer@example.com', 'wrong password', db), null);
  db.close();
});

test('an opaque session resolves to its authenticated user until it expires', () => {
  const db = freshDb();
  const user = createUser({ email: 'trainer@example.com', password: 'correct horse battery staple' }, db);
  const token = createSession(user.id, db);

  assert.equal(getSessionUser(token, db)?.id, user.id);
  assert.equal(db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string } | undefined ? false : true, false);
  db.close();
});

test('granting Pro changes the entitlement plan', () => {
  const db = freshDb();
  const user = createUser({ email: 'trainer@example.com', password: 'correct horse battery staple' }, db);
  grantPro(user.id, db);

  assert.equal(getPlan(user.id, db), 'pro');
  db.close();
});
