import { NextRequest, NextResponse } from 'next/server';
import { hasUsablePrice, loadCards, MARKET_INDEX, norm, publicCard, tokens, type IndexedCard } from '@/lib/cardCatalog';

export const runtime = 'nodejs';

function unique(parts: string[]) {
  return Array.from(new Set(parts.filter(Boolean)));
}

function expandedQueryParts(query: string) {
  const raw = norm(query);
  const out = tokens(raw);
  // 通用归一，不在代码里写具体卡牌/周年/系列的业务映射；多语言别名来自索引 q 字段。
  if (/\bpokemon\b/u.test(raw)) out.push('pokémon');
  if (/\bmega\b/u.test(raw)) out.push('m');
  if (/\bm\b/u.test(raw)) out.push('mega');
  return unique(out);
}

function score(card: IndexedCard, query: string) {
  const raw = norm(query);
  if (!raw) return 0;
  const qTokens = expandedQueryParts(query);
  const rawTokens = tokens(raw);
  const requiredTokens = rawTokens.filter((part) => !['25', '25th', 'promo', 'pokemon', 'card', 'tcg', 'mega'].includes(part));
  if (requiredTokens.length && !requiredTokens.every((part) => card._hay.includes(part))) return 0;
  let s = 0;

  if (card._name === raw) s += 12000;
  if (card._name.startsWith(raw)) s += 8000;
  if (card._name.includes(raw)) s += 5000;
  if (card._num && card._num === raw) s += 9000;
  if (card._num && card._num.startsWith(raw)) s += 5200;
  if (card._num && card._num.includes(raw)) s += 3500;
  if (card._set.includes(raw)) s += 2200;
  if (card._hay.includes(raw)) s += 1200;

  for (const part of qTokens) {
    if (!part) continue;
    if (card._tokens.has(part)) s += 520;
    else if (card._name.includes(part)) s += 360;
    else if (card._set.includes(part)) s += 260;
    else if (card._hay.includes(part)) s += 120;
  }

  if (raw.includes('promo') && /promo/iu.test(card.r || card.s || card.n || '')) s += 900;

  for (const part of qTokens) {
    if (part.length >= 4 && card._name.split(' ').includes(part)) s += 900;
  }
  if (/stamped/iu.test(card.n || '') && !card._name.startsWith(raw.split(' ')[0] || '')) s -= 900;

  if (s <= 0) return 0;
  const price = typeof card.m === 'number' ? card.m : 0;
  return s + Math.min(800, Math.log10(price + 1) * 180);
}

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const q = params.get('q') || '';
  const market = params.get('market') || 'pokemon-us';
  if (!MARKET_INDEX[market]) return NextResponse.json({ cards: [], message: '该卡牌市场暂未接入' });
  if (!q.trim()) return NextResponse.json({ cards: [] });

  const cards = loadCards(market)
    .map((card) => ({ card, score: score(card, q) }))
    .filter((x) => x.score > 0 && hasUsablePrice(x.card))
    .sort((a, b) => b.score - a.score || (b.card.m || 0) - (a.card.m || 0))
    .slice(0, 200)
    .map((x) => publicCard(x.card));
  return NextResponse.json({ cards });
}
