import { NextResponse } from 'next/server';
import { createSession, createUser } from '@/lib/auth';
import { getPlan } from '@/lib/entitlements';
import { setSessionCookie } from '@/lib/webAuth';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const user = createUser({ email: String(body.email || ''), password: String(body.password || '') });
    const response = NextResponse.json({ user: { email: user.email }, plan: getPlan(user.id) }, { status: 201 });
    setSessionCookie(response, createSession(user.id));
    return response;
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'registration failed' }, { status: 400 });
  }
}
