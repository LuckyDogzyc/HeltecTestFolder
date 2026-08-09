import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DeviceRecord, RenderCommand } from './types';
import { templatePrograms } from './templates';

const dataDir = join(process.cwd(), 'data');
const dbFile = join(dataDir, 'devices.json');

function nowIso() { return new Date().toISOString(); }
function hashKey(key: string) { return createHash('sha256').update(key).digest('hex'); }

function ensureStore() {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dbFile)) {
    const demo: DeviceRecord = {
      deviceId: 'esp32-demo-5628',
      factoryName: 'PokemonDisplay-5628',
      displayName: '演示价格牌',
      deviceKeyHash: hashKey('demo-device-key'),
      publicIp: '127.0.0.1',
      lanIp: '192.168.31.218',
      firmware: 'server-mock',
      lastSeen: nowIso(),
      configVersion: 1,
      productId: 562018,
      templateId: 'price',
      renderProgram: templatePrograms.price,
      lastStatus: { stage: 'mock-online' },
    };
    writeFileSync(dbFile, JSON.stringify({ devices: [demo] }, null, 2));
  }
}

function readStore(): { devices: DeviceRecord[] } {
  ensureStore();
  return JSON.parse(readFileSync(dbFile, 'utf8')) as { devices: DeviceRecord[] };
}

function writeStore(store: { devices: DeviceRecord[] }) {
  ensureStore();
  writeFileSync(dbFile, JSON.stringify(store, null, 2));
}

export function clientIp(headers: Headers) {
  return (headers.get('x-forwarded-for') || headers.get('x-real-ip') || '127.0.0.1').split(',')[0].trim();
}

// 设备三态：online=在线（刚心跳过）/ sleeping=深睡中（心跳在 1~2 个唤醒周期内）/ offline=离线
// 唤醒周期来自设备心跳上报的 status.sleepMin（分钟）；默认 60 分钟。
export type DevicePresence = 'online' | 'sleeping' | 'offline';

export function devicePresence(device: DeviceRecord): DevicePresence {
  const lastSeenMs = Date.parse(device.lastSeen || '');
  if (!Number.isFinite(lastSeenMs)) return 'offline';
  const ageMin = (Date.now() - lastSeenMs) / 60000;
  if (ageMin <= 10) return 'online';
  const sleepMinRaw = Number((device.lastStatus as Record<string, unknown> | undefined)?.sleepMin);
  const sleepMin = Number.isFinite(sleepMinRaw) && sleepMinRaw > 0 ? sleepMinRaw : 60;
  if (ageMin <= sleepMin * 2) return 'sleeping';
  return 'offline';
}

export function nextWakeAt(device: DeviceRecord): string | null {
  if (devicePresence(device) !== 'sleeping') return null;
  const lastSeenMs = Date.parse(device.lastSeen || '');
  const sleepMinRaw = Number((device.lastStatus as Record<string, unknown> | undefined)?.sleepMin);
  const sleepMin = Number.isFinite(sleepMinRaw) && sleepMinRaw > 0 ? sleepMinRaw : 60;
  return new Date(lastSeenMs + sleepMin * 60000).toISOString();
}

export function listDevices(publicIp?: string) {
  const store = readStore();
  // 不再按 10 分钟新鲜度过滤：睡眠设备也要显示（沉睡中状态），只有 offline 的隐藏
  return store.devices.filter((d) => {
    if (devicePresence(d) === 'offline') return false;
    if (!publicIp) return true;
    return d.publicIp === publicIp || d.publicIp === '127.0.0.1';
  });
}

export function getDevice(deviceId: string) {
  return readStore().devices.find((d) => d.deviceId === deviceId) || null;
}

export function renameDevice(deviceId: string, displayName: string) {
  const store = readStore();
  const device = store.devices.find((d) => d.deviceId === deviceId);
  if (!device) return null;
  device.displayName = displayName.slice(0, 40) || device.factoryName;
  writeStore(store);
  return device;
}

export function saveDeviceConfig(deviceId: string, productId: number, templateId: string, renderProgram: RenderCommand[]) {
  const store = readStore();
  const device = store.devices.find((d) => d.deviceId === deviceId);
  if (!device) return null;
  device.productId = productId;
  device.templateId = templateId;
  device.renderProgram = renderProgram;
  device.configVersion += 1;
  writeStore(store);
  return device;
}

export function registerDevice(input: { deviceId: string; deviceKey: string; factoryName?: string; lanIp?: string; firmware?: string; publicIp: string; status?: Record<string, unknown> }) {
  const store = readStore();
  let device = store.devices.find((d) => d.deviceId === input.deviceId);
  const keyHash = hashKey(input.deviceKey);
  if (device && device.deviceKeyHash !== keyHash) {
    // 设备 ID 被旧 demo/测试记录占用：允许真实设备覆盖（demo 记录无有效 key）
    if (device.firmware === 'server-mock' || device.firmware?.startsWith('mock')) {
      device.firmware = input.firmware || device.firmware;
      device.deviceKeyHash = keyHash;
      device.publicIp = input.publicIp;
      device.lanIp = input.lanIp || device.lanIp;
    } else {
      throw new Error('device key mismatch');
    }
  }
  if (!device) {
    device = {
      deviceId: input.deviceId,
      factoryName: input.factoryName || input.deviceId,
      displayName: input.factoryName || input.deviceId,
      deviceKeyHash: keyHash,
      publicIp: input.publicIp,
      lanIp: input.lanIp || '',
      firmware: input.firmware || '',
      lastSeen: nowIso(),
      configVersion: 1,
      productId: 562018,
      templateId: 'price',
      renderProgram: templatePrograms.price,
      lastStatus: input.status || {},
    };
    store.devices.push(device);
  } else {
    device.publicIp = input.publicIp;
    device.lanIp = input.lanIp || device.lanIp;
    device.firmware = input.firmware || device.firmware;
    device.lastSeen = nowIso();
    device.lastStatus = input.status || device.lastStatus;
  }
  writeStore(store);
  return device;
}
