import { NextRequest, NextResponse } from 'next/server';
import { clientIp, devicePresence, listDevices, nextWakeAt, registerDevice } from '@/lib/store';
import { findCardByKey } from '@/lib/cardCatalog';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const ip = clientIp(req.headers);
  const url = new URL(req.url);
  const currentNetworkOnly = url.searchParams.get('currentNetwork') !== '0';
  const devices = listDevices(currentNetworkOnly ? ip : undefined).map((d) => {
    // 设备当前卡：用持久化的 cardKey 解析出卡名和完整卡数据（WebUI 选中设备时直接载入，不用再搜索）。
    const card = d.cardKey ? findCardByKey(d.cardKey) : null;
    // 列表不下发位图帧（~11KB base64），避免设备列表响应膨胀；配置接口单独带。
    const { frame: _frame, ...rest } = d;
    return {
      ...rest,
      presence: devicePresence(d),
      nextWakeAt: nextWakeAt(d),
      cardName: card?.n || (d.cardKey || ''),
      card: card
        ? {
            cardKey: card.cardKey,
            sourceId: card.sourceId,
            market: card.market,
            n: card.n,
            s: card.s,
            r: card.r,
            t: card.t,
            m: card.m,
            l: card.l,
            h: card.h,
            mid: card.mid,
            num: card.num,
          }
        : undefined,
    };
  });
  return NextResponse.json({ publicIp: ip, devices });
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
