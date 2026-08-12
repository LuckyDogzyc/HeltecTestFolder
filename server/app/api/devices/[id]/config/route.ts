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
  const device = saveDeviceConfig(id, Number(body.productId || 562018), String(body.templateId || 'custom'), body.renderProgram || [], cardKey, dataUrl);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, device });
}
