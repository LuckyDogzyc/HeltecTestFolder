import { NextRequest, NextResponse } from 'next/server';
import { getDevice, renameDevice } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const device = getDevice(id);
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ device });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const device = renameDevice(id, String(body.displayName || ''));
  if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, device });
}
