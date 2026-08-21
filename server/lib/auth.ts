import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDb, type SqliteDatabase } from './db';

export type User = { id: string; email: string; createdAt: string };
const SESSION_DAYS = 30;

function userFromRow(row: { id: string; email: string; created_at: string }): User {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function passwordMatches(password: string, encoded: string) {
  const [algorithm, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createUser(input: { email: string; password: string }, db: SqliteDatabase = getDb()): User {
  const email = input.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('invalid email');
  if (input.password.length < 12) throw new Error('password must be at least 12 characters');
  const user: User = { id: randomBytes(16).toString('hex'), email, createdAt: new Date().toISOString() };
  const add = db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, hashPassword(input.password), user.createdAt);
    db.prepare("INSERT INTO entitlements (user_id, plan, expires_at, updated_at) VALUES (?, 'free', NULL, ?)")
      .run(user.id, user.createdAt);
  });
  add();
  return user;
}

export function authenticateUser(email: string, password: string, db: SqliteDatabase = getDb()): User | null {
  const row = db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?').get(email.trim().toLowerCase()) as { id: string; email: string; password_hash: string; created_at: string } | undefined;
  return row && passwordMatches(password, row.password_hash) ? userFromRow(row) : null;
}

export function createSession(userId: string, db: SqliteDatabase = getDb()) {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), userId, expiresAt, now.toISOString());
  return token;
}

export function getSessionUser(token: string | undefined, db: SqliteDatabase = getDb()): User | null {
  if (!token) return null;
  const row = db.prepare(`SELECT users.id, users.email, users.created_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .get(tokenHash(token), new Date().toISOString()) as { id: string; email: string; created_at: string } | undefined;
  return row ? userFromRow(row) : null;
}

export function deleteSession(token: string | undefined, db: SqliteDatabase = getDb()) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}
