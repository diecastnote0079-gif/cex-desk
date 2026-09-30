// 把 mirror.mjs 產出的 JSONL 載入 SQLite（node 內建 node:sqlite，零安裝）
//
// 用法：node db-load.mjs <run_id 或 items.jsonl 路徑> [--db D:\AI\cex-db\cex.sqlite]
// 之後查詢：node cexq.mjs "SELECT ..."（見 cexq.mjs）
import { readFileSync, existsSync } from 'node:fs';
import { openDb } from './cex-db.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('db', 'D:\\AI\\cex-db\\cex.sqlite');
const target = process.argv[2];
if (!target) { console.error('用法: node db-load.mjs <run_id|items.jsonl> [--db path]'); process.exit(2); }
const itemsPath = target.endsWith('.jsonl') ? target : `D:\\AI\\cex-db\\mirror\\${target}\\items.jsonl`;
const metaPath = itemsPath.replace(/items\.jsonl$/, 'meta.json');
if (!existsSync(itemsPath)) { console.error('找不到', itemsPath); process.exit(2); }

process.env.CEX_DB = DB;
const db = openDb(DB);   // 表結構由 cex-db.mjs 統一定義（含 scope 欄位與遷移）

const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
const runId = meta.runId || target.replace(/^.*[\\/]/, '').replace('.jsonl', '');
db.prepare(`INSERT OR REPLACE INTO runs
  (run_id, started_at, finished_at, scope, requests, items, index_reported, unreachable, full_flag, filters)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
  runId, meta.startedMYT ? new Date(meta.startedMYT).toISOString() : null, new Date().toISOString(), meta.scope ?? 'web',
  meta.requests ?? null, meta.items ?? null, meta.indexReportedTotal ?? null,
  meta.unreachable ?? null, meta.full ? 1 : 0, meta.filters ?? null,
);

const ins = db.prepare(`INSERT OR REPLACE INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const j = v => (v === undefined || v === null) ? null : JSON.stringify(v);
const n = v => (typeof v === 'number' ? v : (v == null ? null : Number(v) || null));

let count = 0;
db.exec('BEGIN');
for (const line of readFileSync(itemsPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const h = JSON.parse(line);
  ins.run(
    runId, h.boxId ?? null, h.boxName ?? null, String(h.categoryId ?? ''), h.categoryName ?? null,
    h.categoryFriendlyName ?? null, h.superCatName ?? null, h.superCatFriendlyName ?? null,
    n(h.sellPrice), n(h.firstPrice), n(h.previousPrice), n(h.priceReduced),
    h.priceLastChanged ?? null, n(h.priceLastChanged_timestamp),
    n(h.cashPriceCalculated), n(h.exchangePriceCalculated), n(h.buyPerc), n(h.exchangePerc),
    n(h.collectionQuantity ?? h.ecomQuantity), n(h.ecomQuantity), j(h.collectionStores ?? h.stores), j(h.outOfStock), j(h.availability),
    n(h.inStockStore), n(h.inStockOnline), h.firstStockDate ?? null, h.firstStockInDate ?? null, h.timestamp ?? null,
    n(h.discontinued), n(h.boxBuyAllowed), n(h.boxWebBuyAllowed), n(h.boxSaleAllowed),
    n(h.boxVisibilityOnWeb), n(h.showOnWeb), n(h.webShowSellPrice), n(h.boxDeleted),
    n(h.rating), n(h.popularityScore), n(h.new), h.origin ?? null, j(h.productLineName),
    n(h.masterBoxId), n(h.productImage), JSON.stringify(h),
  );
  count++;
}
db.exec('COMMIT');

// 便利視圖
db.exec(`
CREATE VIEW IF NOT EXISTS latest_run AS SELECT run_id FROM runs ORDER BY started_at DESC, finished_at DESC LIMIT 1;
CREATE VIEW IF NOT EXISTS latest_items AS SELECT * FROM items WHERE run_id = (SELECT run_id FROM latest_run);
CREATE VIEW IF NOT EXISTS last_two AS SELECT run_id FROM runs ORDER BY started_at DESC, finished_at DESC LIMIT 2;
`);

console.log(`載入 ${count} 筆 → ${DB}（run ${runId}）`);
const tot = db.prepare('SELECT COUNT(*) c FROM items WHERE run_id = ?').get(runId).c;
const runs = db.prepare('SELECT run_id, items, index_reported FROM runs ORDER BY started_at DESC LIMIT 5').all();
console.log('DB 內 run：'); runs.forEach(r => console.log(`  ${r.run_id}  ${r.items} 筆（索引回報 ${r.index_reported}）`));
console.log('此 run 實際列數:', tot);
