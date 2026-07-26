import { NextRequest, NextResponse } from 'next/server';
import { clientIp, listDevices, registerDevice } from '@/lib/store';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers);
  const url = new URL(req.url);
  const currentNetworkOnly = url.searchParams.get('currentNetwork') !== '0';
  return NextResponse.json({ publicIp: ip, devices: listDevices(currentNetworkOnly ? ip : undefined) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = req.headers.get('authorization') || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const device = registerDevice({
      deviceId: String(body.deviceId || ''),
      deviceKey: String(body.deviceKey || bearer || ''),
      factoryName: body.factoryName,
      lanIp: body.lanIp,
      firmware: body.firmware,
      publicIp: clientIp(req.headers),
      status: body.status || {},
    });
    return NextResponse.json({ ok: true, device });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'register failed' }, { status: 400 });
  }
}
