import { NextResponse } from 'next/server';
import { deviceKeyMatches, getDevice, saveDeviceConfig } from '@/lib/store';
import { getPlan, requireFeature } from '@/lib/entitlements';
import { sessionUserFromRequest } from '@/lib/webAuth';
import { cardSampleFromCard, findCardByKey } from '@/lib/cardCatalog';
import { framePayload } from '@/lib/epaperBitmap';
import { getGradedPrices } from '@/lib/pricecharting';
import type { BackgroundColor, DeviceRecord, DeviceFrame } from '@/lib/types';

export const runtime = 'nodejs';

// 每日刷新：设备唤醒拉取配置时，若布局含评级元素且评级价缓存已过期（>24h），
// 则重新抓取 PriceCharting 评级价并重新烘焙位图；只有画面真的变了才 bump 版本号。
async function maybeRefreshGradedFrame(device: DeviceRecord): Promise<DeviceRecord> {
  const program = device.renderProgram || [];
  const cardKey = device.cardKey || '';
  const needsGrade = cardKey && program.some((item) => /\{grade:/.test(item.value || ''));
  if (!needsGrade) return device;

  const card = findCardByKey(cardKey);
  if (!card) return device;

  const result = await getGradedPrices(card);
  if (!result.ok || !result.refreshed) return device;

  const sample = cardSampleFromCard(card, result.grades ?? undefined);
  const bg = (device.frame?.backgroundColor || 'white') as BackgroundColor;
  const payload = framePayload(program, sample, bg);
  const newFrame: DeviceFrame = {
    blackB64: payload.blackB64,
    redB64: payload.redB64,
    slots: payload.slots,
    backgroundColor: bg,
  };
  const oldFrame = device.frame;
  const changed =
    !oldFrame || oldFrame.blackB64 !== newFrame.blackB64 || oldFrame.redB64 !== newFrame.redB64;
  if (!changed) return device;

  saveDeviceConfig(device.deviceId, device.productId, device.templateId, program, cardKey, device.dataUrl || '', newFrame);
  return getDevice(device.deviceId)!;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (!deviceKeyMatches(id, bearer)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const device = getDevice(id);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const current = Number(new URL(req.url).searchParams.get('version') || '0');
  const freshDevice = await maybeRefreshGradedFrame(device);
  if (current && current >= freshDevice.configVersion) return new Response(null, { status: 304 });
  return NextResponse.json({ configVersion: freshDevice.configVersion, productId: freshDevice.productId, cardKey: freshDevice.cardKey || '', dataUrl: freshDevice.dataUrl || '', templateId: freshDevice.templateId, renderProgram: freshDevice.renderProgram, frame: freshDevice.frame || undefined });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = sessionUserFromRequest(req);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json();
  // Static black/red frames are required by the current ESP32 for every plan.
  // Only advanced layout selection or a future uploaded asset is Pro-only.
  const advanced = String(body.templateId || '') === 'advanced' || Boolean(body.assetId);
  try {
    if (advanced) requireFeature(getPlan(user.id), 'advanced_config');
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'forbidden' }, { status: 403 });
  }
  const rawHost = req.headers.get('host') || '';
  const publicHost = rawHost && !/^(127\.|10\.|192\.168\.|172\.|0\.0\.0\.0|localhost)/.test(rawHost) ? rawHost : '43.162.99.23:2300';
  const cardKey = String(body.cardKey || '');
  const dataUrl = cardKey ? `http://${publicHost}/api/prices/latest?cardKey=${encodeURIComponent(cardKey)}` : String(body.dataUrl || '');
  const backgroundColor = ['white', 'black', 'red'].includes(String(body.frame?.backgroundColor)) ? String(body.frame.backgroundColor) as 'white' | 'black' | 'red' : 'white';
  const frame = body.frame?.blackB64 && body.frame?.redB64 ? { blackB64: String(body.frame.blackB64), redB64: String(body.frame.redB64), slots: Array.isArray(body.frame.slots) ? body.frame.slots : [], backgroundColor } : undefined;
  const device = saveDeviceConfig(id, Number(body.productId || 562018), String(body.templateId || 'custom'), Array.isArray(body.renderProgram) ? body.renderProgram : [], cardKey, dataUrl, frame, undefined, user.id);
  if (!device) return NextResponse.json({ error: 'forbidden or not found' }, { status: 403 });
  const { deviceKeyHash: _deviceKeyHash, ...safeDevice } = device;
  return NextResponse.json({ ok: true, device: safeDevice });
}
