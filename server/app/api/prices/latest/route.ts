import { NextRequest, NextResponse } from 'next/server';
import { findCardByKey, MARKET_INDEX, priceLabel } from '@/lib/cardCatalog';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const cardKey = params.get('cardKey') || '';
  const card = findCardByKey(cardKey);
  if (!card) {
    return NextResponse.json({ schemaVersion: 1, status: 'not_found', error: 'CARD_NOT_FOUND' }, { status: 404 });
  }
  const marketMeta = MARKET_INDEX[card.market] || MARKET_INDEX['pokemon-us'];
  const amount = typeof card.m === 'number' ? card.m : card.l;
  const low = typeof card.l === 'number' ? card.l : null;
  const label = priceLabel(card, marketMeta.currency);
  const payload = {
    schemaVersion: 1,
    status: 'ok',
    updatedAt: new Date().toISOString(),
    source: {
      sourceId: card.sourceId,
      sourceName: marketMeta.displayName,
      market: card.market,
    },
    card: {
      cardKey: card.cardKey,
      name: card.n,
      localizedName: card.n,
      setName: card.s || '',
      number: card.num || '',
      rarity: card.r || '',
      variant: card.t || '',
    },
    price: {
      amount: typeof amount === 'number' ? amount : null,
      low,
      currency: marketMeta.currency,
      label,
    },
  };
  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      ETag: `"${Buffer.from(`${card.cardKey}:${amount ?? ''}:${low ?? ''}`).toString('base64url')}"`,
    },
  });
}
