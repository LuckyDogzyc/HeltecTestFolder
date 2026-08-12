import { NextRequest, NextResponse } from 'next/server';
import { getDevice, saveDeviceConfig } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const device = getDevice(id);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const current = Number(new URL(req.url).searchParams.get('version') || '0');
  if (current && current >= device.configVersion) return new Response(null, { status: 304 });
  return NextResponse.json({
    configVersion: device.configVersion,
    productId: device.productId,
    cardKey: device.cardKey || '',
    dataUrl: device.dataUrl || '',
    templateId: device.templateId,
    renderProgram: device.renderProgram,
    frame: device.frame || undefined,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  // dataUrl 用请求 Host 构造绝对地址（设备从公网/局域网都能直达服务器，不用碰 GitHub raw）。
  // 浏览器 WebUI 经 http://43.162.99.23:2300 访问时 host=43.162.99.23:2300，与设备心跳同源。
  const cardKey = String(body.cardKey || '');
  const host = req.headers.get('host') || '43.162.99.23:2300';
  const dataUrl = cardKey
    ? `http://${host}/api/prices/latest?cardKey=${encodeURIComponent(cardKey)}`
    : String(body.dataUrl || '');
  // 位图静态层：WebUI 浏览器用同一套 canvas 渲染（与局域网位图通道一致），
  // 服务器只存储转发；固件刷新时叠加动态槽位（价格/时间/日期）。
  const frame = body.frame && body.frame.blackB64 && body.frame.redB64
    ? { blackB64: String(body.frame.blackB64), redB64: String(body.frame.redB64), slots: Array.isArray(body.frame.slots) ? body.frame.slots : [] }
    : undefined;
  const device = saveDeviceConfig(id, Number(body.productId || 562018), String(body.templateId || 'custom'), body.renderProgram || [], cardKey, dataUrl, frame);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, device });
}
