// CeX MY 全量鏡像 —— 把整站扒下來存成本地檔案，之後想查什麼就查什麼
//
// 用法：
//   node mirror.mjs --plan              只估算「要打幾次請求」（不下載）
//   node mirror.mjs                     抓「網頁可見」的（88,467 筆，預設 scope=web）
//   node mirror.mjs --scope all         連未上架的也抓（boxSaleAllowed=1，約 102,739 筆）
//   node mirror.mjs --full              連用不到的欄位也抓（最大保真）
//   node mirror.mjs --load              跑完自動載入 SQLite
//   node mirror.mjs --limit 3           只抓前 3 個 shard（小樣本測試用；資料不完整）
//   node mirror.mjs --compact <檔案>     另外寫一份「精簡狀態」（gzip TSV，供雲端備援跨次比對）
//
// 落地位置由 CEX_MIRROR_DIR／CEX_HOME 決定（見 cex-paths.mjs）；run_id 可用 CEX_RUN_ID 指定。
//
// 為什麼要兩段式：Algolia 單一 query 上限 1000 筆（深頁無效），所以
//   第一段（切分）：用「分類 × 價格區間」遞迴切分，直到每個 shard ≤1000 筆。
//     查詢只帶 sellPrice/collectionQuantity 兩個欄位，批次 25 個 query 一次 POST → 極快。
//   第二段（取件）：把每個 ≤1000 的 shard 用完整欄位抓回來，批次 4 個一次 POST。
//   → 總請求數 ≈（切分：個位數 POST）＋（88k/1000/4 ≈ 25 POST）
//
// 落地：每列一個 JSON（JSONL）＋ meta.json；載入 DB：node db-load.mjs <run_id>

import { query, params, BASE_FILTER } from './cex-api.mjs';
import { MIRROR_DIR } from './cex-paths.mjs';
import { writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createGzip } from 'node:zlib';

const has = n => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const PLAN = has('plan');
const FULL = has('full');
const LOAD = has('load');
const SCOPE = argOf('scope', 'web');
const LIMIT = Number(argOf('limit', 0));
const SCOPE_FILTER = SCOPE === 'all' ? 'boxSaleAllowed=1' : BASE_FILTER;

const SPLIT_ATTRS = ['sellPrice', 'collectionQuantity', 'priceLastChanged_timestamp', 'ecomQuantity'];
// 切分維度（實測都「不會漏筆數」：加範圍 filter 後 nbHits 與基準一致）
// popularityScore / firstPrice 實測會漏（有空值）→ 不採用
const DIMS = [
  { attr: 'sellPrice', lo: 0, hi: 100000 },
  { attr: 'collectionQuantity', lo: 0, hi: 10000 },
  { attr: 'priceLastChanged_timestamp', lo: 0, hi: 3000000000 },
  { attr: 'ecomQuantity', lo: 0, hi: 10000 },
];
const PAGE_CAP = 1000;
const BATCH_SPLIT = 25;   // 一批幾個切分查詢
const BATCH_FETCH = 4;    // 一批幾個完整抓取

// 決定要把這個 shard 拆成哪些子 shard：先試對半切現有維度，都不行才加新維度
function childrenOf(it, res) {
  for (let i = it.ranges.length - 1; i >= 0; i--) {
    const r = it.ranges[i];
    const vals = (res.hits || []).map(h => h[r.attr]).filter(v => typeof v === 'number');
    const med = median(vals);
    if (med > r.lo && med < r.hi) {
      const mk = (patch) => ({ ...it, ranges: [...it.ranges.slice(0, i), { ...r, ...patch }, ...it.ranges.slice(i + 1)] });
      return [mk({ hi: med }), mk({ lo: med })];
    }
  }
  const used = new Set(it.ranges.map(r => r.attr));
  const next = DIMS.find(d => !used.has(d.attr));
  if (next) return [{ ...it, ranges: [...it.ranges, { ...next }] }];
  return null;
}

// 想留的欄位＝單一商品回傳的**全部 60 個欄位**（2026-09-30 從 CeX 網站自己的請求核對過），只排除
// `_highlightResult`（搜尋高亮用的雜訊，每次查詢都不同，比對時只會製造假變動）
const ALL_FIELDS = [
  'availability', 'boxBuyAllowed', 'boxDeleted', 'boxId', 'boxName', 'boxSaleAllowed', 'boxVisibilityOnWeb',
  'boxWebBuyAllowed', 'boxWebSaleAllowed', 'buyPerc', 'cashBuyPrice', 'cashPriceCalculated',
  'categoryFriendlyName', 'categoryId', 'categoryName', 'collectionQuantity', 'collectionStores',
  'discontinued', 'ecomQuantity', 'exchangePerc', 'exchangePrice', 'exchangePriceCalculated',
  'firstImageDate', 'firstPrice', 'firstStockDate', 'firstStockInDate', 'gradeId', 'imageNames', 'imageUrls',
  'inStockOnline', 'inStockStore', 'isImageTypeInternal', 'masterBoxId', 'masterBoxname', 'new', 'objectID',
  'operatorId', 'origin', 'outOfStock', 'popularityScore', 'previousPrice', 'priceLastChanged',
  'priceLastChanged_timestamp', 'priceReduced', 'productImage', 'productLineId', 'productLineName', 'rating',
  'scId', 'sellPrice', 'showOnWeb', 'stores', 'superCatFriendlyName', 'superCatName', 'timestamp',
  'webBuyAllowed', 'webSaleAllowed', 'webShowBuyPrice', 'webShowSellPrice',
];
const KEEP = ALL_FIELDS;

const nowMYT = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
const RUN_ID = process.env.CEX_RUN_ID || nowMYT().replace(/[-:T]/g, '').slice(0, 14); // 含秒，避免同一分鐘撞號
const OUTDIR = join(MIRROR_DIR, RUN_ID);
const PRICE = { attr: 'sellPrice', lo: 0, hi: 100000 };

// ── 精簡狀態檔（--compact <檔案>）──
// 目的：給「雲端備援」做跨次比對用的最小狀態。不含 raw_json，所以體積小到可以進 git。
// 欄位固定順序、Tab 分隔、gzip；第一行是版本標頭（以 # 開頭，解析時略過）。
// 需要完整欄位時照舊用 JSONL＋SQLite，不要靠這份。
const COMPACT = argOf('compact', null);
const COMPACT_COLS = ['boxId', 'boxName', 'categoryFriendlyName', 'superCatFriendlyName',
  'sellPrice', 'cashPriceCalculated', 'collectionQuantity', 'firstStockDate'];
const clean = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
let compactWs = null, compactStream = null;
function openCompact() {
  if (!COMPACT) return;
  mkdirSync(dirname(COMPACT), { recursive: true });
  compactStream = createWriteStream(COMPACT);
  compactWs = createGzip();
  compactWs.pipe(compactStream);
  compactWs.write('#' + COMPACT_COLS.join('\t') + '\n');   // ⚠️ 標頭要走 gzip，不能直接寫檔案
}
function writeCompact(h) {
  if (!compactWs) return;
  compactWs.write(COMPACT_COLS.map(c => clean(h[c])).join('\t') + '\n');
}

const filterOf = (ranges) => [SCOPE_FILTER, ...ranges.map(r => `${r.attr} >= ${r.lo} AND ${r.attr} < ${r.hi}`)].join(' AND ');
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(0);

// ── 起點：不做分類切分，直接從「整個索引」往下切 ──
// （分類切分會漏掉約 11,838 筆沒有 categoryId 的記錄，實測 88,459 vs 76,621）
const [base] = await query([{ params: params({ hitsPerPage: 0, filters: SCOPE_FILTER }) }]);
const indexTotal = base.nbHits;
console.log(`範圍 ${SCOPE}｜索引合計 ${indexTotal} 筆｜欄位 ${FULL ? '全欄位' : KEEP.length + ' 個'}｜切分維度 ${DIMS.map(d => d.attr).join(' → ')}`);

// ── 第一段：切分（輕量欄位、批次送出）──
let queue = [{ ranges: [{ ...PRICE }] }];
let splitPosts = 0, splitQueries = 0;
const finalShards = [];
while (queue.length) {
  const batch = queue.splice(0, BATCH_SPLIT);
  const reqs = batch.map(it => ({ params: params({ filters: filterOf(it.ranges), attributes: SPLIT_ATTRS }) }));
  const results = await query(reqs);
  splitPosts++; splitQueries += reqs.length;
  results.forEach((res, i) => {
    const it = batch[i];
    const nb = res.nbHits || 0;
    if (!nb) return;
    if (nb <= PAGE_CAP) { finalShards.push({ ...it, nb }); return; }
    const kids = childrenOf(it, res);
    if (kids && kids.length === 2 && it.ranges.length < 8) queue.push(...kids);
    else if (kids && kids.length === 1) queue.push(kids[0]);
    else {
      finalShards.push({ ...it, nb, partial: true }); // 抓得到的 1000 筆仍然收
      console.log(`  ⚠️ shard 無法再切（${nb} 筆，只能取 1000）: ${filterOf(it.ranges).slice(0, 110)}`);
    }
  });
  console.log(`  切分中… 待切 ${queue.length}｜已成 shard ${finalShards.length}｜POST ${splitPosts}（${el()}s）`);
}
const plannedTotal = finalShards.reduce((s, x) => s + x.nb, 0);
console.log(`\n切分完成：${finalShards.length} 個 shard｜切分 POST ${splitPosts}（含 ${splitQueries} 個 query）｜涵蓋 ${plannedTotal} 筆｜耗時 ${el()}s`);

if (PLAN) {
  const posts = splitPosts + Math.ceil(finalShards.length / BATCH_FETCH);
  console.log(`\n=== 估算 ===\n第二段取件：${Math.ceil(finalShards.length / BATCH_FETCH)} 個 POST（每批 ${BATCH_FETCH} 個 shard）`);
  console.log(`總 POST ≈ ${posts}｜預估時間 ≈ ${((posts * 1.5) / 60).toFixed(1)}–${((posts * 3) / 60).toFixed(1)} 分鐘`);
  process.exit(0);
}

// ── 第二段：完整抓取（批次；邊抓邊寫，不把 7 萬筆留在記憶體）──
const attributes = FULL ? null : KEEP;
const seen = new Set();
let written = 0;
mkdirSync(OUTDIR, { recursive: true });
const itemsPath = join(OUTDIR, 'items.jsonl');
const ws = createWriteStream(itemsPath);
openCompact();
let fetchPosts = 0;
const fetchEnd = LIMIT ? Math.min(LIMIT, finalShards.length) : finalShards.length;
if (LIMIT) console.log(`⚠️ --limit ${LIMIT}：只抓前 ${fetchEnd}／${finalShards.length} 個 shard（資料不完整，僅供測試）`);
for (let i = 0; i < fetchEnd; i += BATCH_FETCH) {
  const batch = finalShards.slice(i, i + BATCH_FETCH);
  const reqs = batch.map(it => ({ params: params({ filters: filterOf(it.ranges), attributes }) }));
  const results = await query(reqs);
  fetchPosts++;
  for (const res of results) for (const h of res.hits || []) {
    if (seen.has(h.boxId)) continue;
    seen.add(h.boxId); written++;
    writeCompact(h);
    if (!ws.write(JSON.stringify(h) + '\n')) await once(ws, 'drain');
  }
  if (fetchPosts % 5 === 0) console.log(`  取件中… ${written} 筆 / POST ${fetchPosts}（${el()}s）`);
}
ws.end();
await once(ws, 'finish');
if (compactWs) {
  compactWs.end();
  await once(compactStream, 'finish');
  console.log(`精簡狀態已寫入 ${COMPACT}`);
}
const elapsed = el();
console.log(`\n完成：${written} 筆（切分涵蓋 ${plannedTotal}，索引合計 ${indexTotal}）｜POST ${splitPosts + fetchPosts} 次｜耗時 ${elapsed}s`);

const rows = written;
const meta = {
  runId: RUN_ID, startedMYT: nowMYT(), scope: SCOPE, full: FULL,
  splitPosts, fetchPosts, queries: splitQueries, shards: finalShards.length,
  items: rows, plannedTotal, indexTotal, elapsedSec: +elapsed, filters: SCOPE_FILTER,
  dimensions: DIMS.map(d => d.attr),
};
writeFileSync(join(OUTDIR, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(`已寫入 ${itemsPath}`);
if (LOAD) execFileSync(process.execPath, [join(import.meta.dirname, 'db-load.mjs'), RUN_ID], { stdio: 'inherit' });
else console.log(`載入資料庫：node db-load.mjs ${RUN_ID}`);
