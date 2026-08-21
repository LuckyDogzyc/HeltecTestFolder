import { NextResponse } from 'next/server';
import { getDevice, renameDevice } from '@/lib/store';
import { sessionUserFromRequest } from '@/lib/webAuth';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
 const user = sessionUserFromRequest(req);
 if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
 const { id } = await ctx.params;
 const device = getDevice(id, undefined, user.id);
 // Return 404, rather than disclosing another user's device ID.
 if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
 const { deviceKeyHash: _deviceKeyHash, ...safeDevice } = device;
 return NextResponse.json({ device: safeDevice });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
 const user = sessionUserFromRequest(req);
 if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
 const { id } = await ctx.params;
 const body = await req.json();
 const device = renameDevice(id, String(body.displayName || ''), undefined, user.id);
 if (!device) return NextResponse.json({ error: 'not found' }, { status: 404 });
 const { deviceKeyHash: _deviceKeyHash, ...safeDevice } = device;
 return NextResponse.json({ ok: true, device: safeDevice });
}
