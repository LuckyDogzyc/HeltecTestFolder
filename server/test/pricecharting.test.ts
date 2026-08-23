import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLocalGradedPricesCache, clearPriceChartingCache, getGradedPrices, parsePriceTable, parseSearchResults, readLocalGradedPrices } from '../lib/pricecharting';
import type { IndexedCard } from '../lib/cardCatalog';

const SEARCH_HTML = `<html><body>
<a href="/game/pokemon-japanese-terastal-festival/umbreon-ex-217">Umbreon Ex #217</a>
<a href="/game/pokemon-korean-terastal-festival-ex/umbreon-ex-217">Umbreon Ex #217</a>
<a href="/console/pokemon-japanese-terastal-festival">Pokemon Japanese Terastal Festival</a>
</body></html>`;

// HTTP 兜底测试用（Mega Charizard Y ex #22，Ascended Heroes）
const MC_SEARCH_HTML = `<html><body>
<a href="https://www.pricecharting.com/game/pokemon-ascended-heroes/mega-charizard-y-ex-22">Mega Charizard Y ex #22</a>
<a href="/game/pokemon-japanese-ascended-heroes/mega-charizard-y-ex-22">Mega Charizard Y ex #22</a>
</body></html>`;

const PRODUCT_HTML = `<html><body>
<table id="price_data">
<thead><tr><th>Ungraded</th><th>Grade 7</th><th>Grade 8</th><th>Grade 9</th><th>Grade 9.5</th><th>PSA 10</th></tr>
<tr></tr>
<tr><th>Grade 9</th><th>Grade 9.5</th><th>PSA 10</th></tr></thead>
<tbody><tr>
<td id="used_price">$385.69</td><td id="complete_price">$357.50</td><td id="new_price">$418.52</td>
<td id="graded_price">$460.00</td><td id="box_only_price">$481.25</td><td id="manual_only_price">$651.15</td><td></td>
</tr><tr><td>volume: 1 sale per week</td></tr></tbody>
</table>
</body></html>`;

const umbreonCard: IndexedCard = {
  id: 602681,
  n: 'Umbreon ex - 217/187',
  s: 'SV8a: Terastal Fest ex',
  r: 'SAR',
  t: 'Holofoil',
  num: '217/187',
  q: 'umbreon ex sv8a terastal fest ex',
  sourceId: 'tcgcsv-pokemon-jp',
  market: 'pokemon-jp',
  cardKey: 'tcgcsv-pokemon-jp:602681:Holofoil',
  variantKey: 'Holofoil',
  _hay: 'umbreon ex sv8a terastal fest ex',
  _name: 'umbreon ex',
  _set: 'sv8a terastal fest ex',
  _num: '217 187',
  _tokens: new Set(['umbreon', 'ex', 'sv8a', 'terastal', 'fest']),
};

// 不在本地 graded_prices.json 里的卡（用于验证 HTTP 兜底）
const mcharizardCard: IndexedCard = {
  id: 675834,
  n: 'Mega Charizard Y ex - 022/217',
  s: 'ME: Ascended Heroes',
  r: 'Double Rare',
  t: 'Holofoil',
  num: '022/217',
  q: 'mega charizard y ex me ascended heroes',
  sourceId: 'tcgcsv-pokemon-us',
  market: 'pokemon-us',
  cardKey: 'tcgcsv-pokemon-us:675834:Holofoil',
  variantKey: 'Holofoil',
  _hay: 'mega charizard y ex me ascended heroes',
  _name: 'mega charizard y ex',
  _set: 'me ascended heroes',
  _num: '022 217',
  _tokens: new Set(['mega', 'charizard', 'y', 'ex', 'me', 'ascended', 'heroes']),
};

test('parseSearchResults extracts product links from search page', () => {
  const hits = parseSearchResults(SEARCH_HTML);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, 'Umbreon Ex #217');
  assert.equal(hits[0].href, 'https://www.pricecharting.com/game/pokemon-japanese-terastal-festival/umbreon-ex-217');
});

test('parsePriceTable maps labels to first price row', () => {
  const table = parsePriceTable(PRODUCT_HTML);
  assert.ok(table);
  assert.equal(table!['Ungraded'], 385.69);
  assert.equal(table!['Grade 7'], 357.5);
  assert.equal(table!['Grade 8'], 418.52);
  assert.equal(table!['Grade 9'], 460);
  assert.equal(table!['Grade 9.5'], 481.25);
  assert.equal(table!['PSA 10'], 651.15);
});

test('getGradedPrices maps table to PSA keys and prefers JP console (HTTP fallback)', async () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/search-products')) return new Response(MC_SEARCH_HTML, { status: 200 });
    if (u.includes('/game/')) return new Response(PRODUCT_HTML, { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    clearPriceChartingCache();
    clearLocalGradedPricesCache();
    const result = await getGradedPrices(mcharizardCard);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.grades, { 'PSA:10': 651.15, 'PSA:9': 460, 'PSA:8': 418.52, 'PSA:7': 357.5 });
    assert.equal(result.matched, 'Mega Charizard Y ex #22');
    assert.equal(result.refreshed, true);
    assert.equal(calls.length, 2); // search + product page

    // 第二次调用命中 24h 缓存，不发请求
    const again = await getGradedPrices(mcharizardCard);
    assert.equal(again.ok && again.refreshed, false);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('getGradedPrices prefers local graded_prices.json (no HTTP)', async () => {
  const local = readLocalGradedPrices();
  assert.ok(local && local.prices, 'cards/graded_prices.json 应存在（由脚本生成）');
  const localGrades = local.prices!['tcgcsv-pokemon-jp:602681:Holofoil'];
  assert.ok(localGrades && localGrades['PSA:10'] > 0);

  // fetch 若被调用则直接抛错：验证本地命中时零 HTTP
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('HTTP 不应被调用：本地数据命中');
  }) as typeof fetch;
  try {
    clearLocalGradedPricesCache();
    clearPriceChartingCache();
    const result = await getGradedPrices(umbreonCard);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, 'local');
    assert.equal(result.grades!['PSA:10'], localGrades['PSA:10']);
    assert.equal(result.grades!['PSA:9'], localGrades['PSA:9']);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('getGradedPrices returns null grades when no match', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).includes('/search-products')) return new Response('<html><body>no results</body></html>', { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    clearPriceChartingCache();
    const result = await getGradedPrices(mcharizardCard);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.grades, null);
    assert.equal(result.refreshed, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});
