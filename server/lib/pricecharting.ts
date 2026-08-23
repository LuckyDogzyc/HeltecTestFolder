import { norm, tokens } from './cardCatalog';
import type { IndexedCard } from './cardCatalog';

// 免费 PriceCharting 数据源：抓公开产品页的 #price_data 价格表（列：Ungraded / Grade 7 / Grade 8 / Grade 9 / Grade 9.5 / PSA 10）。
// 无需 API token / 订阅。参考 https://github.com/TomasPereiraa/Pokemon-Card-Tracking 的抓取思路（本实现用普通 HTTP，不依赖浏览器）。

const SEARCH_URL = 'https://www.pricecharting.com/search-products?type=prices&q=';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 每天刷新一次（配合设备每日唤醒）
export type GradePrices = Record<string, number>; // key 形如 'PSA:10'

const cache = new Map<string, { grades: GradePrices | null; fetchedAt: number }>();

// 公开页面的通用评级列 → 我们 UI 的 公司:分数 key（BGS/CGC 不在公开页上，暂无数据）
const TABLE_TO_GRADE_KEY: Record<string, string> = {
  'PSA 10': 'PSA:10',
  'Grade 9': 'PSA:9',
  'Grade 8': 'PSA:8',
  'Grade 7': 'PSA:7',
};

export type GradedResult =
  | { ok: true; grades: GradePrices | null; matched?: string; refreshed: boolean }
  | { ok: false; reason: 'upstream' | 'blocked' | 'not_found' };

function httpGet(url: string, signal?: AbortSignal): Promise<Response> {
  return fetch(url, {
    // 只声明 text/html：PriceCharting 会按 Accept 协商返回 JSON 或 HTML，这里要 HTML 搜索页
    headers: { Accept: 'text/html', 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: signal ?? AbortSignal.timeout(15000),
    cache: 'no-store',
  });
}

export type PcSearchHit = { title: string; href: string };

// 解析搜索页里的产品链接（/game/<console>/<slug>），兼容相对/绝对 href
export function parseSearchResults(html: string): PcSearchHit[] {
  const hits: PcSearchHit[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+href="(?:https?:\/\/(?:www\.)?pricecharting\.com)?(\/game\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    const title = m[2]?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim() || '';
    if (!title || seen.has(href)) continue;
    seen.add(href);
    hits.push({ title, href: `https://www.pricecharting.com${href}` });
    if (hits.length >= 20) break;
  }
  return hits;
}

function parseUsdPrice(raw: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec((raw || '').replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 解析产品页 #price_data 表：thead 第一行（Ungraded…PSA 10）↔ tbody 第一行价格
export function parsePriceTable(html: string): Record<string, number> | null {
  const tableMatch = /<table[^>]*id="price_data"[\s\S]*?<\/table>/i.exec(html);
  if (!tableMatch) return null;
  const table = tableMatch[0];

  const theadMatch = /<thead[\s\S]*?<\/thead>/i.exec(table);
  if (!theadMatch) return null;
  const firstHeaderRow = /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(theadMatch[0]);
  if (!firstHeaderRow) return null;
  const labels = [...firstHeaderRow[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((c) =>
    c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );

  const tbodyMatch = /<tbody[\s\S]*?<\/tbody>/i.exec(table);
  if (!tbodyMatch) return null;
  const firstBodyRow = /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(tbodyMatch[0]);
  if (!firstBodyRow) return null;
  const cells = [...firstBodyRow[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);

  const out: Record<string, number> = {};
  for (let i = 0; i < labels.length && i < cells.length; i++) {
    if (!labels[i]) continue;
    const price = parseUsdPrice(cells[i]);
    if (price !== null) out[labels[i]] = price;
  }
  return Object.keys(out).length ? out : null;
}

export async function fetchProductPrices(href: string): Promise<Record<string, number> | null> {
  const response = await httpGet(href);
  if (!response.ok) throw new Error(`pricecharting page ${response.status}`);
  const html = await response.text();
  return parsePriceTable(html);
}

function matchScore(hit: PcSearchHit, card: IndexedCard): number {
  const title = norm(hit.title);
  const base = norm((card.n || '').split(' - ')[0]);
  const num = norm((card.num || '').split('/')[0]);
  const slug = norm(hit.href);
  let score = 0;
  if (base && title.includes(base)) score += 400;
  if (num && title.includes(num)) score += 300;
  for (const t of tokens(card.s || '')) {
    if (t.length >= 4 && (title.includes(t) || slug.includes(t))) score += 40;
  }
  const isJp = card.market === 'pokemon-jp';
  if (isJp) {
    if (slug.includes('japanese')) score += 50;
    else if (slug.includes('korean') || slug.includes('chinese')) score -= 100;
  } else {
    if (slug.includes('japanese') || slug.includes('korean') || slug.includes('chinese')) score -= 50;
  }
  return score;
}

export async function getGradedPrices(
  card: IndexedCard,
  opts?: { force?: boolean }
): Promise<GradedResult> {
  const cached = cache.get(card.cardKey);
  if (cached && !opts?.force && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, grades: cached.grades, refreshed: false };
  }
  try {
    const base = (card.n || '').split(' - ')[0].trim();
    const num = (card.num || '').split('/')[0].trim();
    const query = [base, num].filter(Boolean).join(' ').slice(0, 120);
    const response = await httpGet(SEARCH_URL + encodeURIComponent(query));
    if (!response.ok) throw new Error(`search ${response.status}`);
    const html = await response.text();
    const hits = parseSearchResults(html);
    if (!hits.length) {
      cache.set(card.cardKey, { grades: null, fetchedAt: Date.now() });
      return { ok: true, grades: null, refreshed: true };
    }
    let best: PcSearchHit | null = null;
    let bestScore = 0;
    for (const hit of hits) {
      const s = matchScore(hit, card);
      if (s > bestScore) {
        bestScore = s;
        best = hit;
      }
    }
    // 必须卡名+编号都命中才算匹配成功
    if (!best || bestScore < 700) {
      cache.set(card.cardKey, { grades: null, fetchedAt: Date.now() });
      return { ok: true, grades: null, matched: best?.title, refreshed: true };
    }
    const table = await fetchProductPrices(best.href);
    const grades: GradePrices = {};
    if (table) {
      for (const [label, key] of Object.entries(TABLE_TO_GRADE_KEY)) {
        const price = table[label];
        if (typeof price === 'number') grades[key] = price;
      }
    }
    cache.set(card.cardKey, { grades: Object.keys(grades).length ? grades : null, fetchedAt: Date.now() });
    return { ok: true, grades: Object.keys(grades).length ? grades : null, matched: best.title, refreshed: true };
  } catch (error) {
    console.error('pricecharting fetch failed:', error instanceof Error ? error.message : error);
    return { ok: false, reason: 'upstream' };
  }
}

// 测试/维护用：清缓存
export function clearPriceChartingCache() {
  cache.clear();
}
