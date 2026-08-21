import { NextResponse } from 'next/server';
import { getSessionUser } from './auth';

export const SESSION_COOKIE = 'pokemon_display_session';

function cookieValue(cookieHeader: string | null, name: string) {
  return cookieHeader?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function sessionUserFromRequest(request: Request) {
  return getSessionUser(cookieValue(request.headers.get('cookie'), SESSION_COOKIE));
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 30 * 86400 });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 });
}
