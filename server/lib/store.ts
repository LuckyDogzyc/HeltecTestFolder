import { createHash } from 'node:crypto';
import type { DeviceRecord, DeviceFrame, RenderCommand } from './types';
import { templatePrograms } from './templates';
import { getDb, type SqliteDatabase } from './db';

function nowIso() { return new Date().toISOString(); }
function hashKey(key: string) { return createHash('sha256').update(key).digest('hex'); }

function deviceFromRow(row: Record<string, unknown>): DeviceRecord {
  return {
    deviceId: String(row.device_id), deviceKeyHash: String(row.device_key_hash), factoryName: String(row.factory_name),
    displayName: String(row.display_name), publicIp: String(row.public_ip), lanIp: String(row.lan_ip), firmware: String(row.firmware),
    lastSeen: String(row.last_seen), configVersion: Number(row.config_version), productId: Number(row.product_id),
    cardKey: row.card_key ? String(row.card_key) : undefined, dataUrl: row.data_url ? String(row.data_url) : undefined,
    templateId: String(row.template_id), renderProgram: JSON.parse(String(row.render_program_json)) as RenderCommand[],
    frame: row.frame_json ? JSON.parse(String(row.frame_json)) as DeviceFrame : undefined,
    lastStatus: JSON.parse(String(row.last_status_json || '{}')) as Record<string, unknown>,
  };
}

function queryDevice(deviceId: string, db: SqliteDatabase) {
  const row = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId) as Record<string, unknown> | undefined;
  return row ? deviceFromRow(row) : null;
}

export function clientIp(headers: Headers) {
  return (headers.get('x-forwarded-for') || headers.get('x-real-ip') || '127.0.0.1').split(',')[0].trim();
}

export type DevicePresence = 'online' | 'sleeping' | 'offline';
export function devicePresence(device: DeviceRecord): DevicePresence {
  const lastSeenMs = Date.parse(device.lastSeen || '');
  if (!Number.isFinite(lastSeenMs)) return 'offline';
  const ageMin = (Date.now() - lastSeenMs) / 60000;
  if (ageMin <= 10) return 'online';
  const sleepMinRaw = Number((device.lastStatus as Record<string, unknown> | undefined)?.sleepMin);
  const sleepMin = Number.isFinite(sleepMinRaw) && sleepMinRaw > 0 ? sleepMinRaw : 60;
  return ageMin <= sleepMin * 2 ? 'sleeping' : 'offline';
}
export function nextWakeAt(device: DeviceRecord): string | null {
  if (devicePresence(device) !== 'sleeping') return null;
  const sleepMinRaw = Number((device.lastStatus as Record<string, unknown> | undefined)?.sleepMin);
  return new Date(Date.parse(device.lastSeen) + (Number.isFinite(sleepMinRaw) && sleepMinRaw > 0 ? sleepMinRaw : 60) * 60000).toISOString();
}

export function listDevices(publicIp?: string, db: SqliteDatabase = getDb(), ownerId?: string) {
  let sql = 'SELECT devices.* FROM devices';
  const parameters: string[] = [];
  if (ownerId) { sql += ' JOIN device_owners ON device_owners.device_id = devices.device_id WHERE device_owners.user_id = ?'; parameters.push(ownerId); }
  const devices = db.prepare(sql).all(...parameters).map((row) => deviceFromRow(row as Record<string, unknown>));
  return devices.filter((device) => !publicIp || device.publicIp === publicIp || device.publicIp === '127.0.0.1').filter((device) => devicePresence(device) !== 'offline');
}

export function getDevice(deviceId: string, db: SqliteDatabase = getDb(), ownerId?: string) {
  const device = queryDevice(deviceId, db);
  if (!device || !ownerId) return device;
  return db.prepare('SELECT 1 FROM device_owners WHERE device_id = ? AND user_id = ?').get(deviceId, ownerId) ? device : null;
}

export function deviceKeyMatches(deviceId: string, deviceKey: string, db: SqliteDatabase = getDb()) {
  const row = db.prepare('SELECT device_key_hash FROM devices WHERE device_id = ?').get(deviceId) as { device_key_hash: string } | undefined;
  return Boolean(row && deviceKey && row.device_key_hash === hashKey(deviceKey));
}

export function renameDevice(deviceId: string, displayName: string, db: SqliteDatabase = getDb(), ownerId?: string) {
  if (ownerId && !getDevice(deviceId, db, ownerId)) return null;
  const device = queryDevice(deviceId, db); if (!device) return null;
  db.prepare('UPDATE devices SET display_name = ? WHERE device_id = ?').run(displayName.slice(0, 40) || device.factoryName, deviceId);
  return queryDevice(deviceId, db);
}

export function saveDeviceConfig(deviceId: string, productId: number, templateId: string, renderProgram: RenderCommand[], cardKey?: string, dataUrl?: string, frame?: DeviceFrame, db: SqliteDatabase = getDb(), ownerId?: string) {
  if (ownerId && !getDevice(deviceId, db, ownerId)) return null;
  if (!queryDevice(deviceId, db)) return null;
  db.prepare(`UPDATE devices SET product_id = ?, template_id = ?, render_program_json = ?, card_key = ?, data_url = ?, frame_json = ?, config_version = config_version + 1 WHERE device_id = ?`)
    .run(productId, templateId, JSON.stringify(renderProgram), cardKey || null, dataUrl || null, frame ? JSON.stringify(frame) : null, deviceId);
  return queryDevice(deviceId, db);
}

export function bumpOwnedDeviceVersions(userId: string, db: SqliteDatabase = getDb()) {
  db.prepare('UPDATE devices SET config_version = config_version + 1 WHERE device_id IN (SELECT device_id FROM device_owners WHERE user_id = ?)').run(userId);
}

export function registerDevice(input: { deviceId: string; deviceKey: string; factoryName?: string; lanIp?: string; firmware?: string; publicIp: string; status?: Record<string, unknown> }, db: SqliteDatabase = getDb()) {
  if (!input.deviceId || !input.deviceKey) throw new Error('deviceId and deviceKey are required');
  const existing = queryDevice(input.deviceId, db);
  const keyHash = hashKey(input.deviceKey);
  if (existing && existing.deviceKeyHash !== keyHash) throw new Error('device key mismatch');
  const now = nowIso();
  if (!existing) {
    db.prepare(`INSERT INTO devices (device_id, device_key_hash, factory_name, display_name, public_ip, lan_ip, firmware, last_seen, config_version, product_id, card_key, data_url, template_id, render_program_json, frame_json, last_status_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 562018, NULL, NULL, 'price', ?, NULL, ?)`)
      .run(input.deviceId, keyHash, input.factoryName || input.deviceId, input.factoryName || input.deviceId, input.publicIp, input.lanIp || '', input.firmware || '', now, JSON.stringify(templatePrograms.price), JSON.stringify(input.status || {}));
  } else {
    db.prepare('UPDATE devices SET public_ip = ?, lan_ip = ?, firmware = ?, last_seen = ?, last_status_json = ? WHERE device_id = ?')
      .run(input.publicIp, input.lanIp || existing.lanIp, input.firmware || existing.firmware, now, JSON.stringify({ ...existing.lastStatus, ...(input.status || {}) }), input.deviceId);
  }
  return queryDevice(input.deviceId, db)!;
}
