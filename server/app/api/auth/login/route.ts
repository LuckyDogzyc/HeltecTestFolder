import { NextResponse } from 'next/server';
import { authenticateUser, createSession } from '@/lib/auth';
import { getPlan } from '@/lib/entitlements';
import { setSessionCookie } from '@/lib/webAuth';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const body = await request.json();
  const user = authenticateUser(String(body.email || ''), String(body.password || ''));
  if (!user) return NextResponse.json({ error: 'invalid email or password' }, { status: 401 });
  const response = NextResponse.json({ user: { email: user.email }, plan: getPlan(user.id) });
  setSessionCookie(response, createSession(user.id));
  return response;
}
