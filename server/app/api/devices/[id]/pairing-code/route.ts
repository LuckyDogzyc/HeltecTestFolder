import { NextResponse } from 'next/server';
import { createPairingCode, isClaimed } from '@/lib/pairing';
import { deviceKeyMatches, getDevice } from '@/lib/store';

export const runtime = 'nodejs';

function bearerKey(request: Request) {
  return request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: deviceId } = await ctx.params;
  const deviceKey = bearerKey(request);
  if (!deviceKey || !deviceKeyMatches(deviceId, deviceKey)) {
    return NextResponse.json({ ok: false, error: 'invalid device credentials' }, { status: 401 });
  }
  if (!getDevice(deviceId)) return NextResponse.json({ ok: false, error: 'device not found' }, { status: 404 });
  if (isClaimed(deviceId)) {
    return NextResponse.json({ ok: false, error: 'device is already claimed' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, deviceId, code: createPairingCode(deviceId), expiresInSeconds: 600 });
}
