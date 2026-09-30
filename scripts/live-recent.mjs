// CeX MY 即時 delta 查（免 key、免瀏覽器 —— 2026-09-30 換裝）
//
// 用法：node live-recent.mjs [--hours 24] [--min-price 0] [--games] [--json out.json]
//   --hours N     看過去 N 小時內有價格／庫存動靜的貨（預設 24）
//   --min-price N 只列 RM N 以上的（預設 0）
//   --games       只要有貨動靜的「遊戲類」（superCatName=Gaming）
//   --json FILE   另存完整原始明細
//
// ⚠️ 時間欄位坑（2026-09-30 實測）：
//   firstStockDate / firstStockInDate = **馬來西亞時間（UTC+8）**
//   timestamp / priceLastChanged      = **UTC**
//   兩者混用會差 8 小時；「今天新貨」一律以 MYT 日期為準。
//
// 判斷「真新貨 vs 回架」：firstStockDate 是今天（MYT）；再配 stores 看哪家店有。

import { query, params, BASE_FILTER, IN_STOCK_FILTER, PAGE_CAP, BANDS, FIELDS } from './cex-api.mjs';
import { writeFileSync } from 'node:fs';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const has = name => process.argv.includes('--' + name);
const HOURS = Number(arg('hours', 24));
const MIN = Number(arg('min-price', 0));
const GAMES_ONLY = has('games');
const JSONOUT = arg('json', '');

const myt = d => new Date(d + 8 * 3600e3).toISOString();
const TODAY_MYT = myt(Date.now()).slice(0, 10);

// 分類名 → 平台／區域（"PS5 Games: R3 CHI" → PS5 / R3 CHI）
// ⚠️ 過濾要用 `superCatFriendlyName:Gaming`；`superCatName:Gaming` 回 0 筆（不可 facet，2026-09-30 實測）。
function platformOf(h) {
  const f = String(h.categoryFriendlyName || h.categoryName || '');
  const m = f.match(/^(.+?)\s+Games\s*:/);
  if (m) return { plat: m[1].trim(), reg: (f.match(/(R\d(?:\s+\w+)?)/) || [, '—'])[1] };
  const g = f.match(/^(.+?)\s+(Consoles|Accessories|Hardware|Controllers)/);
  if (g) return { plat: g[1].trim(), reg: '—' };
  return { plat: (h.categoryName || f).slice(0, 14), reg: '—' };
}

const ts = Math.floor(Date.now() / 1000) - HOURS * 3600;
const baseF = `${BASE_FILTER} AND ${IN_STOCK_FILTER}${GAMES_ONLY ? ' AND superCatFriendlyName:Gaming' : ''}`;
const jobs = [{ params: params({ filters: baseF, numericFilters: [`priceLastChanged_timestamp > ${ts}`], attributes: FIELDS }) }];
const first = (await query(jobs))[0];
let hits = first.hits || [];
if ((first.nbHits || 0) > PAGE_CAP) {
  const bandJobs = BANDS.map(b => ({
    params: params({
      filters: `${baseF} AND sellPrice >= ${b[0]} AND sellPrice < ${b[1]}`,
      numericFilters: [`priceLastChanged_timestamp > ${ts}`],
      attributes: FIELDS,
    }),
  }));
  for (const r of await query(bandJobs)) hits = hits.concat(r.hits || []);
  const seen = new Set();
  hits = hits.filter(h => (seen.has(h.boxId) ? false : seen.add(h.boxId)));
}

const fresh = hits.filter(h => (h.firstStockDate || '').startsWith(TODAY_MYT)).sort((a, c) => c.sellPrice - a.sellPrice);
const shown = hits.filter(h => (h.sellPrice || 0) >= MIN).sort((a, c) => c.sellPrice - a.sellPrice);
const line = h => {
  const { plat, reg } = platformOf(h);
  const stores = (h.collectionStores || h.stores || []).slice(0, 3).join('/');
  return `  ${plat.padEnd(9)} ${reg.padEnd(8)} ${String(h.boxName || '').slice(0, 42).padEnd(44)} RM${String(h.sellPrice).padStart(6)} ×${h.collectionQuantity ?? h.ecomQuantity}  ${(h.firstStockDate || '—').slice(0, 16)}  ${stores.slice(0, 30)}  ${h.boxId}`;
};

console.log(`過去 ${HOURS} 小時內有動靜且有貨：${hits.length} 筆（${GAMES_ONLY ? '僅遊戲類' : '全部類別'}）｜今天（MYT ${TODAY_MYT}）新進貨：${fresh.length} 筆`);
const byCat = {};
hits.forEach(h => { const k = h.categoryName || '?'; byCat[k] = (byCat[k] || 0) + 1; });
console.log('類別分佈：' + Object.entries(byCat).sort((a, c) => c[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}×${v}`).join('、'));
console.log(`\n== 今天真新貨（MYT ${TODAY_MYT}，${fresh.length} 筆）==`);
fresh.forEach(h => console.log(line(h)));
console.log(`\n== 有動靜、RM${MIN}+（前 30）==`);
shown.slice(0, 30).forEach(h => console.log(line(h)));
if (JSONOUT) { writeFileSync(JSONOUT, JSON.stringify({ nowUtc: new Date().toISOString(), todayMyt: TODAY_MYT, hours: HOURS, hits }, null, 1)); console.log('\n明細：' + JSONOUT); }
