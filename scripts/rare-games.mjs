// 定向稀有查：遊戲片 × 有貨 × RM100+ × 庫存 ≤N（預設 1）
// 用法：node rare-games.mjs [--min-price 100] [--max-qty 1] [--hours 0] [--all] [--retro]
//   --hours N  只列「過去 N 小時內有動靜」的（0 = 全部）
//   --all      連主機／周邊一起列（預設只列遊戲片）
//   --retro    只列復古／掌機平台（PS2/PS3/PSP/VITA/3DS/DS/Wii/WiiU/X360）
import { queryOne, params, BASE_FILTER, IN_STOCK_FILTER } from './cex-api.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes('--' + n);
const MIN = Number(arg('min-price', 100));
const MAXQ = Number(arg('max-qty', 1));
const HOURS = Number(arg('hours', 0));
const ALL = has('all');
const RETRO = has('retro');
const RETRO_PLAT = ['PS2', 'PS3', 'PSP', 'VITA', '3DS', 'DS', 'WII', 'WIIU', 'X360'];
const TODAY_MYT = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

let f = `${BASE_FILTER} AND ${IN_STOCK_FILTER} AND superCatFriendlyName:Gaming AND sellPrice >= ${MIN} AND collectionQuantity <= ${MAXQ}`;
const opts = { hitsPerPage: 1000, filters: f, attributes: ['boxName', 'boxId', 'categoryName', 'categoryFriendlyName', 'sellPrice', 'collectionQuantity', 'stores', 'collectionStores', 'firstStockDate', 'priceLastChanged', 'priceLastChanged_timestamp', 'previousPrice'] };
if (HOURS > 0) {
  opts.numericFilters = [`priceLastChanged_timestamp > ${Math.floor(Date.now() / 1000) - HOURS * 3600}`];
}
const r = await queryOne(params(opts));
const platOf = h => String(h.categoryFriendlyName || h.categoryName || '').split(' Games')[0];
let hits = r.hits || [];
if (!ALL) hits = hits.filter(h => /Games/.test(h.categoryName || ''));
if (RETRO) hits = hits.filter(h => RETRO_PLAT.includes(platOf(h)));
hits.sort((a, b) => b.sellPrice - a.sellPrice);

const label = `遊戲片${RETRO ? '（復古／掌機）' : ALL ? '' : ''}｜RM${MIN}+｜庫存≤${MAXQ}｜有貨`;
console.log(`${label}：${hits.length} 筆（原始查詢 ${r.nbHits} 筆）${HOURS ? `｜僅過去 ${HOURS}h 有動靜` : ''}\n`);
console.log('平台      區域      名稱                                     標價   庫存  分店（哪家）                條碼');
console.log('─'.repeat(118));
for (const h of hits.slice(0, 50)) {
  const cat = String(h.categoryFriendlyName || '').replace(' Games:', '');
  const stores = (h.collectionStores || h.stores || []).join('/');
  const fresh = (h.firstStockDate || '').startsWith(TODAY_MYT) ? ' 🆕新品' : '';
  const move = h.previousPrice && h.previousPrice !== h.sellPrice
    ? (h.sellPrice < h.previousPrice ? ` ⬇跌 RM${h.previousPrice}→${h.sellPrice}` : ` ⬆漲 RM${h.previousPrice}→${h.sellPrice}`) : '';
  console.log(`${cat.padEnd(9).slice(0, 9)} ${String(h.boxName || '').padEnd(42).slice(0, 42)} RM${String(h.sellPrice).padStart(5)} ×${h.collectionQuantity} ${stores.padEnd(28).slice(0, 28)} ${h.boxId}${fresh}${move}`);
}
if (hits.length > 50) console.log(`… 另有 ${hits.length - 50} 筆`);
const byPlat = {};
for (const h of hits) { const p = platOf(h); byPlat[p] = (byPlat[p] || 0) + 1; }
console.log('\n平台分佈：' + Object.entries(byPlat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('、'));
const drops = hits.filter(h => h.previousPrice > h.sellPrice);
console.log(`跌價 ${drops.length} 筆｜今天新品 ${hits.filter(h => (h.firstStockDate || '').startsWith(TODAY_MYT)).length} 筆`);
