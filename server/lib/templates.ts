import type { CardSample, RenderCommand } from './types';

export const sampleCard: CardSample = {
  productId: 562018,
  title: 'GRENINJA EX',
  name: 'Greninja ex - 132',
  set: 'SV Promo',
  rarity: 'Promo',
  subType: 'Holofoil',
  market: '101.45',
  low: '97.49',
  mid: '119.39',
  high: '525.15',
  power: 'USB',
};

export const templatePrograms: Record<string, RenderCommand[]> = {
  price: [
    { type: 'text', value: '{title}', x: 8, y: 18, font: 1, color: 1, visible: true },
    { type: 'text', value: '${market}', x: 8, y: 64, font: 2, color: 0, visible: true },
    { type: 'text', value: '{rarity} / {subType}', x: 8, y: 92, font: 0, color: 0, visible: true },
    { type: 'text', value: 'L ${low}', x: 150, y: 92, font: 0, color: 1, visible: true },
  ],
  collector: [
    { type: 'text', value: '{title}', x: 8, y: 18, font: 1, color: 1, visible: true },
    { type: 'text', value: '{set}', x: 8, y: 42, font: 0, color: 0, visible: true },
    { type: 'text', value: '{rarity} / {subType}', x: 8, y: 61, font: 0, color: 0, visible: true },
    { type: 'text', value: '${market}', x: 8, y: 90, font: 2, color: 0, visible: true },
    { type: 'text', value: 'L ${low}', x: 140, y: 85, font: 0, color: 1, visible: true },
  ],
  market: [
    { type: 'text', value: '{title}', x: 8, y: 18, font: 1, color: 1, visible: true },
    { type: 'text', value: 'M ${market}', x: 8, y: 42, font: 0, color: 0, visible: true },
    { type: 'text', value: 'Low ${low}', x: 8, y: 62, font: 0, color: 0, visible: true },
    { type: 'text', value: 'Mid ${mid}', x: 8, y: 82, font: 0, color: 0, visible: true },
    { type: 'text', value: 'High ${high}', x: 8, y: 102, font: 0, color: 0, visible: true },
  ],
  custom: [
    { type: 'text', value: '{title}', x: 8, y: 18, font: 1, color: 1, visible: true },
    { type: 'text', value: '{set}', x: 8, y: 42, font: 0, color: 0, visible: true },
    { type: 'text', value: '${market}', x: 8, y: 72, font: 2, color: 0, visible: true },
    { type: 'text', value: 'L ${low}', x: 150, y: 92, font: 0, color: 1, visible: true },
    { type: 'text', value: 'ID {productId}', x: 8, y: 112, font: 0, color: 0, visible: true },
    { type: 'text', value: '{power}', x: 190, y: 112, font: 0, color: 1, visible: true },
  ],
};

export const templateLabels: Record<string, string> = {
  price: '价格优先',
  collector: '收藏展示',
  market: '行情详情',
  custom: '自定义布局',
};

export function normalizeTitle(name: string) {
  const t = (name || '').split(' - ')[0].trim().toUpperCase();
  return t || 'CARD';
}

function compactDisplayText(value: string) {
  return value
    .replaceAll('Double Rare', 'Dbl Rare')
    .replaceAll('Ultra Rare', 'Ultra')
    .replaceAll('Illustration Rare', 'Illus Rare')
    .replaceAll('Special Illustration Rare', 'SIR')
    .replaceAll('Hyper Rare', 'Hyper')
    .replaceAll('Reverse Holofoil', 'Rev Holo')
    .replaceAll('Holofoil', 'Holo')
    .replaceAll(' / ', '/');
}

function approxCharWidth(font: number) {
  if (font === 2) return 14;
  if (font === 1) return 11;
  return 8;
}

export function fitTextToDeviceSlot(value: string, font: number, x: number) {
  const compacted = compactDisplayText(value);
  const maxChars = Math.max(4, Math.floor((250 - x) / approxCharWidth(font)));
  return compacted.length > maxChars ? compacted.slice(0, maxChars) : compacted;
}

export function renderValue(value: string, card: CardSample) {
  return value
    .replaceAll('{title}', card.title)
    .replaceAll('{name}', card.name)
    .replaceAll('{set}', card.set)
    .replaceAll('{rarity}', card.rarity)
    .replaceAll('{subType}', card.subType)
    .replaceAll('{productId}', String(card.productId))
    .replaceAll('${market}', `$${card.market}`)
    .replaceAll('${low}', `$${card.low}`)
    .replaceAll('${mid}', `$${card.mid}`)
    .replaceAll('${high}', `$${card.high}`)
    .replaceAll('{market}', card.market)
    .replaceAll('{low}', card.low)
    .replaceAll('{mid}', card.mid)
    .replaceAll('{high}', card.high)
    .replaceAll('{power}', card.power);
}
