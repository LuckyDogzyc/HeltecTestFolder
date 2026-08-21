import { NextResponse } from 'next/server';
import { claimDevice } from '@/lib/pairing';
import { sessionUserFromRequest } from '@/lib/webAuth';

export const runtime = 'nodejs';
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = sessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    claimDevice(user.id, id, String(body.code || ''));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'claim failed' }, { status: 400 });
  }
}
