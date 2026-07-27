import { readFileSync } from 'fs';
import { join } from 'path';

export type CardRow = {
  id: number;
  n: string;
  s?: string;
  r?: string;
  t?: string;
  m?: number;
  l?: number;
  h?: number;
  mid?: number;
  mi?: number;
  num?: string;
  q?: string;
};

export type IndexedCard = CardRow & {
  sourceId: string;
  market: string;
  cardKey: string;
  variantKey: string;
  _hay: string;
  _name: string;
  _set: string;
  _num: string;
  _tokens: Set<string>;
};

export const MARKET_INDEX: Record<string, { filename: string; sourceId: string; displayName: string; currency: string }> = {
  'pokemon-us': { filename: 'search_index.us.min.json', sourceId: 'tcgcsv-pokemon-us', displayName: '宝可梦美国', currency: 'USD' },
  'pokemon-jp': { filename: 'search_index.jp.min.json', sourceId: 'tcgcsv-pokemon-jp', displayName: '宝可梦日本', currency: 'USD' },
};

const SEALED_RE = /\b(pack|booster|box|bundle|tin|case|collection|deck|binder|album|sleeves|poster|playmat|portfolio|file set|trainer box|battle academy|starter set|deck set|code card|jumbo)\b/iu;
let cache: Record<string, IndexedCard[]> = {};

export function norm(v: string) {
  return (v || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokens(v: string) {
  return norm(v).split(' ').filter(Boolean);
}

function isSingleCard(card: CardRow) {
  const name = card.n || '';
  const set = card.s || '';
  const rarity = card.r || '';
  const number = card.num || '';
  if (/code card/iu.test(name) || /jumbo/iu.test(name) || /jumbo cards/iu.test(set)) return false;
  if (SEALED_RE.test(name)) return false;
  return Boolean(rarity || number || /\bcard\b/iu.test(name));
}

function encodeCardKey(sourceId: string, productId: number, subtype?: string) {
  const variant = encodeURIComponent(subtype || 'default');
  return `${sourceId}:${productId}:${variant}`;
}

export function parseCardKey(cardKey: string) {
  const parts = (cardKey || '').split(':');
  if (parts.length < 3) return null;
  const variant = decodeURIComponent(parts.slice(2).join(':'));
  const productId = Number(parts[1]);
  if (!parts[0] || !Number.isFinite(productId)) return null;
  return { sourceId: parts[0], productId, variant };
}

export function marketForSource(sourceId: string) {
  return Object.entries(MARKET_INDEX).find(([, meta]) => meta.sourceId === sourceId)?.[0];
}

export function hasUsablePrice(card: CardRow) {
  return typeof card.m === 'number' || typeof card.l === 'number';
}

export function loadCards(market: string) {
  if (cache[market]) return cache[market];
  const meta = MARKET_INDEX[market] || MARKET_INDEX['pokemon-us'];
  const path = join(process.cwd(), '..', 'cards', meta.filename);
  const data = JSON.parse(readFileSync(path, 'utf8')) as { cards: CardRow[] };
  cache[market] = (data.cards || []).filter(isSingleCard).map((card) => {
    const hay = norm(card.q || [card.n, card.s || '', card.r || '', card.t || '', card.num || ''].join(' '));
    const cardKey = encodeCardKey(meta.sourceId, card.id, card.t);
    return {
      ...card,
      sourceId: meta.sourceId,
      market,
      cardKey,
      variantKey: `${cardKey}`,
      _hay: hay,
      _name: norm(card.n || ''),
      _set: norm(card.s || ''),
      _num: norm(card.num || ''),
      _tokens: new Set(tokens(hay)),
    };
  });
  return cache[market];
}

export function publicCard(card: IndexedCard) {
  const { id, _hay, _name, _set, _num, _tokens, q, ...rest } = card;
  return rest;
}

export function findCardByKey(cardKey: string) {
  const parsed = parseCardKey(cardKey);
  if (!parsed) return null;
  const market = marketForSource(parsed.sourceId);
  if (!market) return null;
  return loadCards(market).find((card) => card.id === parsed.productId && (card.t || 'default') === parsed.variant) || null;
}

export function priceLabel(card: CardRow, currency = 'USD') {
  const amount = typeof card.m === 'number' ? card.m : card.l;
  if (typeof amount !== 'number') return '';
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
}
