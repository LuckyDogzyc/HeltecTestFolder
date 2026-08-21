import { NextResponse } from 'next/server';
import { deviceKeyMatches, getDevice, saveDeviceConfig } from '@/lib/store';
import { getPlan, requireFeature } from '@/lib/entitlements';
import { sessionUserFromRequest } from '@/lib/webAuth';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
  if (!deviceKeyMatches(id, bearer)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const device = getDevice(id);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const current = Number(new URL(req.url).searchParams.get('version') || '0');
  if (current && current >= device.configVersion) return new Response(null, { status: 304 });
  return NextResponse.json({ configVersion: device.configVersion, productId: device.productId, cardKey: device.cardKey || '', dataUrl: device.dataUrl || '', templateId: device.templateId, renderProgram: device.renderProgram, frame: device.frame || undefined });
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
  const frame = body.frame?.blackB64 && body.frame?.redB64 ? { blackB64: String(body.frame.blackB64), redB64: String(body.frame.redB64), slots: Array.isArray(body.frame.slots) ? body.frame.slots : [] } : undefined;
  const device = saveDeviceConfig(id, Number(body.productId || 562018), String(body.templateId || 'custom'), Array.isArray(body.renderProgram) ? body.renderProgram : [], cardKey, dataUrl, frame, undefined, user.id);
  if (!device) return NextResponse.json({ error: 'forbidden or not found' }, { status: 403 });
  const { deviceKeyHash: _deviceKeyHash, ...safeDevice } = device;
  return NextResponse.json({ ok: true, device: safeDevice });
}
