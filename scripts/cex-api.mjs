// CeX MY —— 免 key、免瀏覽器的 Algolia 客戶端（2026-09-30 實測確認）
// 用途：所有 CeX 抓取腳本的共同底層。任何有網路的機器都能跑（不需 CDP、不需瀏覽器）。
//
// 用法（程式內）：  import { query, discoverCategories, fetchCategory, fetchCategories, gateName, BASE_FILTER } from './cex-api.mjs'
// 用法（命令列）：  node cex-api.mjs selftest
//
// 原理：my.webuy.com 的搜尋框打的是 Algolia 索引 prod_cex_my，該端點公開且 CORS 全開，
//       不需要 X-Algolia-* 標頭。詳見 references/method-audit.md。

const ENDPOINT = 'https://search.webuy.io/1/indexes/*/queries';
const INDEX = 'prod_cex_my';
const UA = 'Rin-CeX-MY/1.0 (personal second-hand price research)';

export const BASE_FILTER = 'boxVisibilityOnWeb=1 AND boxSaleAllowed=1 AND sellPrice > 0';
export const IN_STOCK_FILTER = '(inStockStore=1 OR inStockOnline=1)';
export const PAGE_CAP = 1000;              // Algolia paginationLimitedTo：深頁無效，只能靠價格分層
export const BATCH_CAP = 50;               // Algolia 每批 requests 上限
const PACE_MS = 900;                       // 自律節流：社群慣例 ≤1 req/s
const MAX_ATTEMPTS = 3;

export const FIELDS = [
  'boxName', 'boxId', 'categoryId', 'categoryName', 'categoryFriendlyName', 'superCatName',
  'sellPrice', 'firstPrice', 'previousPrice', 'priceLastChanged', 'priceLastChanged_timestamp',
  'ecomQuantity', 'collectionQuantity', 'timestamp', 'firstStockDate', 'firstStockInDate',
  'stores', 'outOfStock', 'collectionStores', 'inStockStore', 'inStockOnline',
  'discontinued', 'boxBuyAllowed', 'cashPriceCalculated', 'exchangePriceCalculated',
  'buyPerc', 'exchangePerc', 'popularityScore', 'priceReduced', 'availability',
  'rating', 'productLineName', 'imageUrls', 'objectID',
];

// ---------- 節流 ----------
let lastAt = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pace() {
  const wait = PACE_MS - (Date.now() - lastAt);
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

// ---------- 核心：一次 POST 打多組 query ----------
export async function query(requests, { pace: doPace = true } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) throw new Error('query: requests 不可為空');
  if (requests.length > BATCH_CAP) throw new Error(`query: 一批最多 ${BATCH_CAP} 組（收到 ${requests.length}）`);
  const body = JSON.stringify({
    requests: requests.map(r => ({ indexName: r.indexName || INDEX, params: r.params })),
  });
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (doPace) await pace();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.message) throw new Error(`Algolia: ${j.message}`);
      if (!Array.isArray(j.results)) throw new Error('回應沒有 results（endpoint 可能變了）');
      return j.results;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  // 絕不把失敗當成「0 筆」——呼叫方必須看得到錯誤
  throw new Error(`CeX query 失敗（試了 ${MAX_ATTEMPTS} 次）：${lastErr.message}`);
}

// 只要一組查詢時用這個（query() 回傳的是**陣列**，忘記取 [0] 會拿到 undefined 而靜默變成 0 筆）
export async function queryOne(paramsStr, opts = {}) {
  const res = await query([{ params: paramsStr }], opts);
  const r = res[0];
  if (!r) throw new Error('queryOne: 回應中沒有 results[0]');
  if (r.message) throw new Error(`Algolia: ${r.message}`);
  return r;
}

// 組 params 字串（一律完整 URL-encode，避免 & / 空格 / `:` 踩雷）
export function params({ query: q = '', hitsPerPage = PAGE_CAP, page = 0, filters = '', numericFilters = null, facets = null, maxValuesPerFacet = null, attributes = null, extra = null } = {}) {
  const p = new URLSearchParams();
  p.set('query', q);
  p.set('hitsPerPage', String(hitsPerPage));
  if (page) p.set('page', String(page));
  if (filters) p.set('filters', filters);
  if (numericFilters) p.set('numericFilters', JSON.stringify(numericFilters));
  if (facets) p.set('facets', JSON.stringify(facets));
  if (maxValuesPerFacet) p.set('maxValuesPerFacet', String(maxValuesPerFacet));
  if (attributes) p.set('attributesToRetrieve', JSON.stringify(attributes));
  if (extra) for (const [k, v] of Object.entries(extra)) p.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return p.toString();
}

// ---------- 價格分層（突破 1000 筆上限） ----------
export const BANDS = [[0, 40], [40, 80], [80, 150], [150, 300], [300, 100000]];
const bandFilter = ([lo, hi], attr = 'sellPrice') => `${attr} >= ${lo} AND ${attr} < ${hi}`;

/**
 * 取一個分類的全部筆數：先打一次；撞到 1000 上限再用價格分層補齊，最後以 boxId 去重。
 * @returns {Promise<{hits: Array, requests: number, nbHits: number}>}
 */
export async function fetchCategory(catId, { filter = BASE_FILTER, attributes = FIELDS } = {}) {
  const f = `${filter} AND categoryId:${catId}`;
  const [first] = await query([{ params: params({ filters: f, attributes }) }]);
  let hits = first.hits || [];
  let requests = 1;
  if ((first.nbHits || 0) > PAGE_CAP) {
    const jobs = BANDS.map(b => ({ params: params({ filters: `${f} AND ${bandFilter(b)}`, attributes }) }));
    for (let i = 0; i < jobs.length; i += BATCH_CAP) {
      const chunk = jobs.slice(i, i + BATCH_CAP);
      const out = await query(chunk);
      requests += chunk.length;
      for (const r of out) hits = hits.concat(r.hits || []);
    }
  }
  const seen = new Set();
  return { hits: hits.filter(h => (seen.has(h.boxId) ? false : seen.add(h.boxId))), requests, nbHits: first.nbHits || 0 };
}

/**
 * 取多個分類（自動分批、以 boxId 去重）。
 */
export async function fetchCategories(catIds, opts = {}) {
  let hits = [], requests = 0;
  const list = [...catIds];
  for (let i = 0; i < list.length; i += 6) {
    const chunk = list.slice(i, i + 6);
    const out = await Promise.all(chunk.map(id => fetchCategory(id, opts)));
    for (const r of out) { hits = hits.concat(r.hits); requests += r.requests; }
  }
  const seen = new Set();
  return { hits: hits.filter(h => (seen.has(h.boxId) ? false : seen.add(h.boxId))), requests };
}

// ---------- 分類列舉（取代手寫 categoryId 表） ----------
/**
 * 列出所有分類的 boxId 數（facet 計數）。
 * ⚠️ facets 的 nbHits 會低估（實測 76,617 vs 88,449）→ 這裡只做「有哪些分類」與相對大小，別當總量。
 */
export async function listCategories({ filter = BASE_FILTER } = {}) {
  const [r] = await query([{
    params: params({
      hitsPerPage: 0, filters: filter,
      facets: ['categoryId', 'superCatFriendlyName'],
      maxValuesPerFacet: 1000,
    }),
  }]);
  const ids = r.facets?.categoryId || {};
  return {
    facetNbHits: r.nbHits,
    superCats: r.facets?.superCatFriendlyName || {},
    rows: Object.keys(ids).map(categoryId => ({ categoryId, facetCount: ids[categoryId] })),
  };
}

/**
 * 給定 categoryId，回傳名稱與「精確」筆數（每類一組查詢、一次批次送完，非 facets 的估計值）。
 * @returns {Promise<Array<{categoryId, categoryName, categoryFriendlyName, superCatName, nbHits}>>}
 */
export async function describeCategories(catIds, { filter = BASE_FILTER } = {}) {
  const ids = [...catIds];
  const jobs = ids.map(id => ({
    params: params({
      hitsPerPage: 1, filters: `${filter} AND categoryId:${id}`,
      attributes: ['categoryId', 'categoryName', 'categoryFriendlyName', 'superCatName'],
    }),
  }));
  const out = [];
  for (let i = 0; i < jobs.length; i += BATCH_CAP) {
    const chunk = jobs.slice(i, i + BATCH_CAP);
    const res = await query(chunk);
    res.forEach((r, k) => {
      const h = r.hits?.[0] || {};
      out.push({
        categoryId: ids[i + k],
        categoryName: h.categoryName || null,
        categoryFriendlyName: h.categoryFriendlyName || null,
        superCatName: h.superCatName || null,
        nbHits: r.nbHits || 0,
      });
    });
  }
  return out;
}

/** 一次拿完整分類表（ids 來自 facets，名稱與精確筆數來自批次查詢）。 */
export async function discoverCategories({ filter = BASE_FILTER } = {}) {
  const { rows, superCats, facetNbHits } = await listCategories({ filter });
  const described = await describeCategories(rows.map(r => r.categoryId), { filter });
  const byId = new Map(described.map(d => [d.categoryId, d]));
  const categories = rows.map(r => ({ ...r, ...(byId.get(r.categoryId) || {}) }))
    .sort((a, b) => b.nbHits - a.nbHits);
  return { categories, superCats, facetNbHits, totalFromCategories: categories.reduce((s, c) => s + c.nbHits, 0) };
}

// ---------- 名稱查詢閘門（Algolia 是模糊索引，會自信地答錯） ----------
const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'for', 'with', 'to', 'in', 'on']);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
const toks = s => norm(s).split(/\s+/).filter(t => t && !STOP.has(t));
const isModelNo = t => /[0-9]/.test(t) && t.length >= 2;

/**
 * 判斷某筆結果是否真的匹配查詢：詞重疊率 ≥ 門檻，且查詢中的「型號」字串必須實際出現（否決權）。
 * 門檻 0.6 來自社群實測（真匹配 0.62–0.86、錯配 ≤0.50）；型號否決＝FX-CG50 永不匹配 FX-CG20。
 * @returns {{ok: boolean, score: number, missing: string[], vetoed: string[]}}
 */
export function gateName(queryText, candidateName, { threshold = 0.6 } = {}) {
  const q = toks(queryText), c = norm(candidateName);
  const missing = q.filter(t => !c.includes(t));
  const score = q.length ? (q.length - missing.length) / q.length : 0;
  const vetoed = q.filter(isModelNo).filter(t => !c.includes(t));
  return { ok: vetoed.length === 0 && score >= threshold, score: Number(score.toFixed(3)), missing, vetoed };
}

// ---------- 命令列自檢 ----------
if (process.argv[1] && process.argv[1].endsWith('cex-api.mjs') && process.argv[2] === 'selftest') {
  const t0 = Date.now();
  const [r] = await query([{ params: params({ query: 'metaphor', hitsPerPage: 3, attributes: ['boxName', 'sellPrice', 'firstStockDate'] }) }]);
  console.log('① 免 key 查詢:', r.nbHits, '筆｜首筆 =', r.hits[0]?.boxName, 'RM' + r.hits[0]?.sellPrice);
  const batch = await query([
    { params: params({ filters: `${BASE_FILTER} AND categoryId:1187`, hitsPerPage: 1, attributes: ['boxName'] }) },
    { params: params({ filters: `${BASE_FILTER} AND categoryId:1186`, hitsPerPage: 1, attributes: ['boxName'] }) },
  ]);
  console.log('② 批次:', batch.length, '組｜nbHits =', batch.map(x => x.nbHits).join(', '));
  const d = await discoverCategories();
  console.log('③ 分類自動列舉:', d.categories.length, '類｜前 3 =', d.categories.slice(0, 3).map(c => `${c.categoryFriendlyName}=${c.nbHits}`).join(' | '));
  console.log('   精確合計 =', d.totalFromCategories, '（facet 估 =', d.facetNbHits, '）');
  console.log('④ 閘門（應擋下）:', JSON.stringify(gateName('argon one m.2 case', 'Spigen Ultra Hybrid Zero One Case For Samsung Galaxy S24 Ultra')));
  console.log('⑤ 閘門（應放行）:', JSON.stringify(gateName('Metaphor ReFantazio', 'Metaphor: ReFantazio')));
  console.log('共', Date.now() - t0, 'ms');
}
