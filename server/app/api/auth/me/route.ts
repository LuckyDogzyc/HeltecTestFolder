import { NextResponse } from 'next/server';
import { getPlan } from '@/lib/entitlements';
import { sessionUserFromRequest } from '@/lib/webAuth';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const user = sessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json({ user: { email: user.email }, plan: getPlan(user.id) });
}
