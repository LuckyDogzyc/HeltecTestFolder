import { NextRequest, NextResponse } from 'next/server';
import { findCardByKey, norm } from '@/lib/cardCatalog';

export const runtime = 'nodejs';

// PriceCharting 评级卡价格查询（需要免费 API token：https://www.pricecharting.com/api）
// 返回该卡各评级公司/分数的美元价格，key 形如 "PSA:10"。
const API_BASE = 'https://www.pricecharting.com/api/products';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 评级价格变化慢，缓存 12 小时

const cache = new Map<string, { data: Record<string, number> | null; fetchedAt: number }>();

type PcProduct = {
  'product-name'?: string;
  link?: string;
  [key: string]: unknown;
};

function parseUsd(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,]/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// PriceCharting 字段：psa10/psa9、bgs10/bgs9、cgc10/cgc9、sgc10/sgc9
const GRADE_FIELDS: Record<string, Record<string, string>> = {
  PSA: { psa10: '10', psa9: '9', psa8: '8', psa7: '7' },
  BGS: { bgs10: '10', bgs9: '9', bgs8: '8', bgs7: '7' },
  CGC: { cgc10: '10', cgc9: '9', cgc8: '8', cgc7: '7' },
  SGC: { sgc10: '10', sgc9: '9', sgc8: '8', sgc7: '7' },
};

function matchScore(productName: string, base: string, num: string, setTokens: string[]) {
  const name = norm(productName);
  let s = 0;
  if (base && name.includes(norm(base))) s += 400;
  if (num && name.includes(norm(num))) s += 300;
  if (base && norm(base).split(' ').some((part) => part.length >= 4 && name.includes(part))) s += 100;
  if (setTokens.length && setTokens.some((t) => t.length >= 4 && name.includes(t))) s += 60;
  return s;
}

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const cardKey = params.get('cardKey') || '';
  const card = findCardByKey(cardKey);
  if (!card) {
    return NextResponse.json({ status: 'not_found', error: 'CARD_NOT_FOUND' }, { status: 404 });
  }

  const token = process.env.PRICE_CHARTING_TOKEN || '';
  if (!token) {
    return NextResponse.json({ status: 'no_token', error: 'PRICE_CHARTING_TOKEN 未配置：在 server/.env.local 填入 https://www.pricecharting.com/api 的免费 token' }, { status: 200 });
  }

  const cached = cache.get(cardKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ status: 'ok', cardKey, grades: cached.data });
  }

  // 查询词：卡名（去掉编号部分）+ 编号，如 "Mega Charizard Y ex 022"
  const nameBase = (card.n || '').split(' - ')[0].trim();
  const numPart = (card.num || '').split('/')[0].trim();
  const setTokens = norm(card.s || '').split(' ').filter(Boolean);
  const query = [nameBase, numPart].filter(Boolean).join(' ').slice(0, 120);

  try {
    const response = await fetch(`${API_BASE}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error(`pricecharting ${response.status}: ${body.slice(0, 200)}`);
      return NextResponse.json({ status: 'upstream', error: `PRICECHARTING_${response.status}` }, { status: 200 });
    }
    const products = (await response.json()) as PcProduct[];
    if (!Array.isArray(products) || !products.length) {
      cache.set(cardKey, { data: null, fetchedAt: Date.now() });
      return NextResponse.json({ status: 'ok', cardKey, grades: null, query });
    }

    let best: PcProduct | null = null;
    let bestScore = 0;
    for (const product of products) {
      const productName = typeof product['product-name'] === 'string' ? product['product-name'] : '';
      const s = matchScore(productName, nameBase, numPart, setTokens);
      if (s > bestScore) { bestScore = s; best = product; }
    }
    if (!best || bestScore <= 0) {
      cache.set(cardKey, { data: null, fetchedAt: Date.now() });
      return NextResponse.json({ status: 'ok', cardKey, grades: null, query, hint: 'no_match' });
    }

    const grades: Record<string, number> = {};
    for (const [company, fieldMap] of Object.entries(GRADE_FIELDS)) {
      for (const [field, score] of Object.entries(fieldMap)) {
        const price = parseUsd(best[field]);
        if (price !== null && price > 0) grades[`${company}:${score}`] = price;
      }
    }

    cache.set(cardKey, { data: grades, fetchedAt: Date.now() });
    return NextResponse.json({
      status: 'ok',
      cardKey,
      grades: Object.keys(grades).length ? grades : null,
      matched: typeof best['product-name'] === 'string' ? best['product-name'] : undefined,
      link: typeof best.link === 'string' ? best.link : undefined,
      query,
    });
  } catch (error) {
    console.error('pricecharting fetch failed:', error instanceof Error ? error.message : error);
    return NextResponse.json({ status: 'upstream', error: 'PRICECHARTING_UNREACHABLE' }, { status: 200 });
  }
}
