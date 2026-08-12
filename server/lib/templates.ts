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
    { type: 'text', value: '{title}', valueFrom: 'card.localizedName', fallback: 'card.name|card.number', x: 8, y: 18, font: 1, color: 1, visible: true, wrap: false },
    { type: 'text', value: '${market}', valueFrom: 'price.label', x: 8, y: 64, font: 2, color: 0, visible: true, wrap: false },
    { type: 'text', value: '{rarity} / {subType}', x: 8, y: 92, font: 0, color: 0, visible: true, wrap: false },
    { type: 'text', value: 'L ${low}', x: 150, y: 92, font: 0, color: 1, visible: true, wrap: false },
  ],
  collector: [
    { type: 'text', value: '{title}', valueFrom: 'card.localizedName', fallback: 'card.name|card.number', x: 8, y: 18, font: 1, color: 1, visible: true, wrap: false },
    { type: 'text', value: '{set}', valueFrom: 'card.setName', x: 8, y: 42, font: 0, color: 0, visible: true, wrap: false },
    { type: 'text', value: '{rarity} / {subType}', x: 8, y: 61, font: 0, color: 0, visible: true, wrap: false },
    { type: 'text', value: '${market}', valueFrom: 'price.label', x: 8, y: 90, font: 2, color: 0, visible: true, wrap: false },
    { type: 'text', value: 'L ${low}', x: 140, y: 85, font: 0, color: 1, visible: true, wrap: false },
  ],
  market: [
    { type: 'text', value: '{title}', valueFrom: 'card.localizedName', fallback: 'card.name|card.number', x: 8, y: 18, font: 1, color: 1, visible: true, wrap: false },
    { type: 'text', value: '${market}', valueFrom: 'price.label', x: 8, y: 42, font: 0, color: 0, visible: true, wrap: false },
    { type: 'text', value: 'Low ${low}', x: 8, y: 62, font: 0, color: 0, visible: true, wrap: false },
    { type: 'text', value: 'Mid ${mid}', x: 8, y: 82, font: 0, color: 0, visible: true, wrap: false },
    { type: 'text', value: 'High ${high}', x: 8, y: 102, font: 0, color: 0, visible: true, wrap: false },
  ],
  custom: [
    { type: 'text', value: '{title}', valueFrom: 'card.localizedName', fallback: 'card.name|card.number', x: 8, y: 18, font: 1, color: 1, visible: true, wrap: false },
    { type: 'text', value: '${market}', valueFrom: 'price.label', x: 8, y: 64, font: 2, color: 0, visible: true, wrap: false },
    { type: 'text', value: '{time}', x: 8, y: 96, font: 0, color: 0, visible: true, wrap: false },
  ],
};

// 自定义布局的元素类型：下拉选择用
export type ElementTypeId =
  | 'title' | 'name' | 'set' | 'rarity' | 'subType'
  | 'market' | 'low' | 'mid' | 'high'
  | 'productId' | 'time' | 'date' | 'power' | 'custom';

export const ELEMENT_TYPES: { id: ElementTypeId; label: string; value: string }[] = [
  { id: 'title', label: '卡牌名（标题）', value: '{title}' },
  { id: 'name', label: '卡牌全名', value: '{name}' },
  { id: 'set', label: '系列', value: '{set}' },
  { id: 'rarity', label: '稀有度', value: '{rarity}' },
  { id: 'subType', label: '版本类型', value: '{subType}' },
  { id: 'market', label: 'Market 价格', value: '${market}' },
  { id: 'low', label: 'Low 价格', value: '${low}' },
  { id: 'mid', label: 'Mid 价格', value: '${mid}' },
  { id: 'high', label: 'High 价格', value: '${high}' },
  { id: 'productId', label: 'Product ID', value: 'ID {productId}' },
  { id: 'time', label: '更新时间', value: '{time}' },
  { id: 'date', label: '更新日期', value: '{date}' },
  { id: 'power', label: '电源状态', value: '{power}' },
  { id: 'custom', label: '自定义文本', value: '' },
];

export const MAX_CUSTOM_ITEMS = 20;

// 从 value 反推元素类型 id（用于下拉回显）
export function elementTypeOf(value: string): ElementTypeId {
  const hit = ELEMENT_TYPES.find((t) => t.id !== 'custom' && t.value === value);
  return hit ? hit.id : 'custom';
}

// 新建元素：返回默认的自定义文本元素
export function makeCustomItem(index: number): RenderCommand {
  return { type: 'text', value: `文本${index}`, x: 8, y: 30 + index * 14, font: 0, color: 0, visible: true, wrap: false };
}

export const templateLabels: Record<string, string> = {
  price: '价格优先',
  collector: '收藏展示',
  market: '行情详情',
  custom: '自定义布局',
  frame: '位图模式',
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
  // 与固件 fitTextToSlot 的 xAdvance 一致：0/1=9pt 11px, 2=12pt 14px, 3=18pt 21px, 4=24pt 28px
  if (font === 4) return 28;
  if (font === 3) return 21;
  if (font === 2) return 14;
  return 11;
}

export function fitTextToDeviceSlot(value: string, font: number, x: number, deviceWidth = 250) {
  const compacted = compactDisplayText(value);
  const maxChars = Math.max(4, Math.floor((deviceWidth - x) / approxCharWidth(font)));
  return compacted.length > maxChars ? compacted.slice(0, maxChars) : compacted;
}

function displayPrice(value: string) {
  const cleaned = (value || '').trim();
  if (!cleaned || cleaned === '--') return '--';
  if (cleaned.startsWith('$')) return cleaned;
  return `$${cleaned}`;
}

export function renderValue(value: string, card: CardSample) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const yy = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return value
    .replaceAll('{title}', card.title)
    .replaceAll('{name}', card.name)
    .replaceAll('{set}', card.set)
    .replaceAll('{rarity}', card.rarity)
    .replaceAll('{subType}', card.subType)
    .replaceAll('${market}', displayPrice(card.market))
    .replaceAll('${low}', displayPrice(card.low))
    .replaceAll('${mid}', displayPrice(card.mid))
    .replaceAll('${high}', displayPrice(card.high))
    .replaceAll('{market}', card.market)
    .replaceAll('{low}', card.low)
    .replaceAll('{mid}', card.mid)
    .replaceAll('{high}', card.high)
    .replaceAll('{power}', card.power)
    .replaceAll('{time}', `${hh}:${mm}`)
    .replaceAll('{date}', `${yy}-${mo}-${dd}`);
}
