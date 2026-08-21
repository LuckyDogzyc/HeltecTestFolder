import { NextResponse } from 'next/server';
import { deleteSession } from '@/lib/auth';
import { clearSessionCookie, SESSION_COOKIE } from '@/lib/webAuth';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  const token = request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  deleteSession(token);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
