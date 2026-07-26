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
    templateId: device.templateId,
    renderProgram: device.renderProgram,
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const device = saveDeviceConfig(id, Number(body.productId || 562018), String(body.templateId || 'custom'), body.renderProgram || []);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, device });
}
