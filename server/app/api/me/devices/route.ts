import { NextResponse } from 'next/server';
import { listDevices } from '@/lib/store';
import { sessionUserFromRequest } from '@/lib/webAuth';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const user = sessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const devices = listDevices(undefined, undefined, user.id).map(({ deviceKeyHash: _deviceKeyHash, ...device }) => device);
  return NextResponse.json({ devices });
}
