import { NextRequest, NextResponse } from 'next/server';
import { findCardByKey } from '@/lib/cardCatalog';
import { getGradedPrices } from '@/lib/pricecharting';

export const runtime = 'nodejs';

// 评级卡价格：免费抓 PriceCharting 公开产品页价格表（无需 API token/订阅）。
// 结果按 公司:分数 组织，如 { 'PSA:10': 651.15 }；服务端缓存 24h，设备每日唤醒时自动刷新。
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const cardKey = params.get('cardKey') || '';
  const card = findCardByKey(cardKey);
  if (!card) {
    return NextResponse.json({ status: 'not_found', error: 'CARD_NOT_FOUND' }, { status: 404 });
  }

  const result = await getGradedPrices(card);
  if (!result.ok) {
    return NextResponse.json({ status: 'upstream', error: `PRICECHARTING_${result.reason.toUpperCase()}` }, { status: 200 });
  }
  return NextResponse.json({
    status: 'ok',
    cardKey,
    grades: result.grades,
    matched: result.matched,
    refreshed: result.refreshed,
  });
}
