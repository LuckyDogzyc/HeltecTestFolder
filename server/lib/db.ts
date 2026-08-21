import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SqliteDatabase = Database.Database;

const dataDir = join(process.cwd(), 'data');
const databasePath = process.env.POKEMON_DISPLAY_DB_PATH || join(dataDir, 'pokemon-display.sqlite');
let database: SqliteDatabase | undefined;

export function initDatabase(db: SqliteDatabase) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      device_key_hash TEXT NOT NULL,
      factory_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      public_ip TEXT NOT NULL,
      lan_ip TEXT NOT NULL,
      firmware TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      config_version INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      card_key TEXT,
      data_url TEXT,
      template_id TEXT NOT NULL,
      render_program_json TEXT NOT NULL,
      frame_json TEXT,
      last_status_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_owners (
      device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      claimed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entitlements (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL CHECK(plan IN ('free', 'pro')),
      expires_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairing_codes (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_device_id ON pairing_codes(device_id);
  `);
}

function migrateLegacyDevices(db: SqliteDatabase) {
  const count = (db.prepare('SELECT COUNT(*) AS count FROM devices').get() as { count: number }).count;
  const legacyPath = join(dataDir, 'devices.json');
  if (count || !existsSync(legacyPath)) return;

  const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as { devices?: Array<Record<string, unknown>> };
  const insert = db.prepare(`INSERT OR IGNORE INTO devices (
    device_id, device_key_hash, factory_name, display_name, public_ip, lan_ip, firmware,
    last_seen, config_version, product_id, card_key, data_url, template_id,
    render_program_json, frame_json, last_status_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const importAll = db.transaction(() => {
    for (const device of legacy.devices || []) {
      insert.run(
        String(device.deviceId), String(device.deviceKeyHash), String(device.factoryName || device.deviceId),
        String(device.displayName || device.factoryName || device.deviceId), String(device.publicIp || ''),
        String(device.lanIp || ''), String(device.firmware || ''), String(device.lastSeen || new Date().toISOString()),
        Number(device.configVersion || 1), Number(device.productId || 562018), device.cardKey ? String(device.cardKey) : null,
        device.dataUrl ? String(device.dataUrl) : null, String(device.templateId || 'price'),
        JSON.stringify(device.renderProgram || []), device.frame ? JSON.stringify(device.frame) : null,
        JSON.stringify(device.lastStatus || {}),
      );
    }
  });
  importAll();
}

export function getDb() {
  if (!database) {
    mkdirSync(dataDir, { recursive: true });
    database = new Database(databasePath);
    initDatabase(database);
    migrateLegacyDevices(database);
  }
  return database;
}

export function closeDatabaseForTests() {
  database?.close();
  database = undefined;
}
