import { NextResponse } from 'next/server';
import { clientIp, devicePresence, getDevice, listDevices, nextWakeAt, registerDevice } from '@/lib/store';
import { createPairingCode } from '@/lib/pairing';
import { sessionUserFromRequest } from '@/lib/webAuth';
import { findCardByKey } from '@/lib/cardCatalog';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  const user = sessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const ip = clientIp(request.headers);
  const currentNetworkOnly = new URL(request.url).searchParams.get('currentNetwork') !== '0';
  const devices = listDevices(currentNetworkOnly ? ip : undefined, undefined, user.id).map((device) => {
    const card = device.cardKey ? findCardByKey(device.cardKey) : null;
    const { frame: _frame, deviceKeyHash: _deviceKeyHash, ...rest } = device;
    return { ...rest, presence: devicePresence(device), nextWakeAt: nextWakeAt(device), cardName: card?.n || device.cardKey || '' };
  });
  return NextResponse.json({ publicIp: ip, devices });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const bearer = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const existing = body.deviceId ? getDevice(String(body.deviceId)) : null;
    const deviceKey = String(bearer);
    if (!deviceKey) return NextResponse.json({ ok: false, error: 'Bearer device key is required' }, { status: 401 });
    const device = registerDevice({ deviceId: String(body.deviceId || ''), deviceKey, factoryName: body.factoryName, lanIp: body.lanIp, firmware: body.firmware, publicIp: clientIp(request.headers), status: body.status || {} });
    // Only the authenticated physical device receives this short-lived code; it is never returned by browser APIs.
    const pairingCode = existing ? undefined : createPairingCode(device.deviceId);
    return NextResponse.json({ ok: true, device: { deviceId: device.deviceId, configVersion: device.configVersion }, pairingCode });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'register failed' }, { status: 400 });
  }
}
