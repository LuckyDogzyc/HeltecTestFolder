import { getDb, type SqliteDatabase } from './db';

export type Plan = 'free' | 'pro';
export type Feature = 'advanced_config' | 'assets' | 'additional_devices';

export function getPlan(userId: string, db: SqliteDatabase = getDb()): Plan {
  const row = db.prepare('SELECT plan, expires_at FROM entitlements WHERE user_id = ?').get(userId) as { plan: Plan; expires_at: string | null } | undefined;
  if (!row || (row.expires_at && row.expires_at <= new Date().toISOString())) return 'free';
  return row.plan;
}

export function requireFeature(plan: Plan, feature: Feature) {
  if (plan === 'pro') return;
  throw new Error(`${feature} requires Pro`);
}

export function grantPro(userId: string, db: SqliteDatabase = getDb(), expiresAt: string | null = null) {
  db.prepare(`INSERT INTO entitlements (user_id, plan, expires_at, updated_at) VALUES (?, 'pro', ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET plan = 'pro', expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
    .run(userId, expiresAt, new Date().toISOString());
}

export function revokePro(userId: string, db: SqliteDatabase = getDb()) {
  db.prepare(`INSERT INTO entitlements (user_id, plan, expires_at, updated_at) VALUES (?, 'free', NULL, ?)
    ON CONFLICT(user_id) DO UPDATE SET plan = 'free', expires_at = NULL, updated_at = excluded.updated_at`)
    .run(userId, new Date().toISOString());
}
