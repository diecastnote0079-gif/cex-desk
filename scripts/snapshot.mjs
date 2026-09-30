// CeX MY 遊戲類全量快照（免 key、免瀏覽器 —— 2026-09-30 換裝，取代 snapshot.sh）
//
// 用法：node snapshot.mjs [--cats 1187,1186] [--out 路徑.tsv]
//   預設抓 references/catalog/categories.json 裡的「遊戲類」全部（superCatName=Gaming）。
//   輸出 TSV 欄位與舊版相同（相容 highvalue.py / diff_snapshots.py）：
//     平台 \t 區域 \t 遊戲名 \t 價格 \t 庫存 \t timestamp(UTC) \t boxId(條碼)
//
// ⚠️ 1000 筆上限：Algolia 深頁無效，fetchCategory 會自動用價格分層補齊。
// ⚠️ 基準注意：比對前先讀 references/method.md 的「基線注意」，用錯基準會生出上萬筆假 NEW。

import { fetchCategories, BASE_FILTER, FIELDS } from './cex-api.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATS_JSON = join(HERE, '..', 'references', 'catalog', 'categories.json');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // MYT
const hhmm = new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 16).replace(':', '');
// ⚠️ 史料不進凜的記憶（體積大）：預設寫到本機 D:\AI\cex-db\snapshots（可用 CEX_SNAP_DIR 覆寫）
const snapDir = process.env.CEX_SNAP_DIR || 'D:\\AI\\cex-db\\snapshots';
// ⚠️ 絕不覆蓋既有快照：snap-<date>.tsv 可能是基準檔（比對的錨點）
let defaultOut = join(snapDir, `snap-${today}.tsv`);
if (existsSync(defaultOut)) defaultOut = join(snapDir, `snap-${today}-${hhmm}.tsv`);
const OUT = arg('out', defaultOut);
const explicit = arg('cats', '');
if (!existsSync(CATS_JSON) && !explicit) throw new Error(`找不到分類表 ${CATS_JSON} → 先跑 node sync-categories.mjs`);
const catIds = explicit ? explicit.split(',').map(s => s.trim()) : JSON.parse(readFileSync(CATS_JSON, 'utf8')).gamingCategoryIds;

const t0 = Date.now();
const { hits, requests } = await fetchCategories(catIds, { filter: BASE_FILTER, attributes: FIELDS });

function platformOf(h) {
  const f = String(h.categoryFriendlyName || h.categoryName || '');
  const m = f.match(/^(.+?)\s+Games\s*:/);
  if (m) return [m[1].trim(), (f.match(/(R\d(?:\s+\w+)?)/) || [, '—'])[1]];
  const g = f.match(/^(.+?)\s+(Consoles|Accessories|Hardware|Controllers)/);
  if (g) return [g[1].trim(), '—'];
  return [(h.categoryName || f), '—'];
}

const rows = hits.map(h => {
  const [plat, reg] = platformOf(h);
  return [plat, reg, String(h.boxName || '').replace(/\t/g, ' '), h.sellPrice ?? '', h.collectionQuantity ?? h.ecomQuantity ?? 0, h.timestamp || '', h.boxId || ''].join('\t');
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, rows.join('\n') + '\n');

console.log(`分類 ${catIds.length} 個｜Algolia 請求 ${requests} 次｜耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`寫入 ${rows.length} 列 → ${OUT}`);
const withStock = hits.filter(h => (h.collectionQuantity ?? h.ecomQuantity ?? 0) > 0).length;
console.log(`其中現在有貨 ${withStock} 筆｜無貨（目錄留存）${rows.length - withStock} 筆`);
