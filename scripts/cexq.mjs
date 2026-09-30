// 查詢 CeX 本地庫（SQLite）——「要查什麼都可以」
//
// 用法：
//   node cexq.mjs "SELECT * FROM latest_items LIMIT 5"
//   node cexq.mjs --file some.sql
//   node cexq.mjs --json "SELECT ..."        # 輸出 JSON
//   node cexq.mjs --tables                    # 看有哪些表／視圖
//   node cexq.mjs --runs                      # 看有哪些 mirror run
//
// 常用表／視圖：
//   latest_items   最新一次鏡像的全部商品（欄位見 db-load.mjs）
//   items          所有 run 的歷史（含 run_id）
//   runs           每次鏡像的統計
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const DB = (() => { const i = args.indexOf('--db'); return i > 0 ? args[i + 1] : 'D:\\AI\\cex-db\\cex.sqlite'; })();
const asJson = args.includes('--json');
const dbIdx = args.indexOf('--db');
const consumed = new Set();
if (dbIdx >= 0) { consumed.add(dbIdx); consumed.add(dbIdx + 1); }
if (args.includes('--file')) consumed.add(args.indexOf('--file') + 1);
const sql = args.find((a, i) => !consumed.has(i) && !a.startsWith('--'));

const db = new DatabaseSync(DB);

if (args.includes('--tables')) {
  const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  rows.forEach(r => console.log(`${r.type.padEnd(6)} ${r.name}`));
  process.exit(0);
}
if (args.includes('--runs')) {
  const rows = db.prepare('SELECT run_id, started_at, items, index_reported, requests, unreachable FROM runs ORDER BY started_at DESC').all();
  if (!rows.length) { console.log('（還沒有任何 mirror run）'); process.exit(0); }
  console.log('run_id        started(MYT)        商品數   索引回報  請求  未抓到');
  rows.forEach(r => console.log(`${r.run_id}  ${(r.started_at || '').slice(0, 16)}  ${String(r.items).padStart(7)}  ${String(r.index_reported).padStart(8)}  ${String(r.requests).padStart(5)}  ${String(r.unreachable ?? 0).padStart(6)}`));
  process.exit(0);
}

let query = sql;
if (args.includes('--file')) {
  const i = args.indexOf('--file');
  query = require('node:fs').readFileSync(args[i + 1], 'utf8');
}
if (!query) { console.error('用法: node cexq.mjs "SELECT ..." ｜ --tables ｜ --runs'); process.exit(2); }

try {
  const stmt = db.prepare(query);
  const rows = stmt.all();
  if (asJson) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  if (!rows.length) { console.log('（0 筆）'); process.exit(0); }
  const cols = Object.keys(rows[0]);
  const width = c => Math.min(38, Math.max(c.length, ...rows.slice(0, 200).map(r => String(r[c] ?? '').length)));
  const w = Object.fromEntries(cols.map(c => [c, width(c)]));
  console.log(cols.map(c => c.padEnd(w[c])).join('  '));
  console.log(cols.map(c => '─'.repeat(w[c])).join('  '));
  rows.forEach(r => console.log(cols.map(c => {
    let v = r[c];
    if (typeof v === 'string' && v.length > 200) v = v.slice(0, 200) + '…';
    return String(v ?? '').padEnd(w[c]).slice(0, w[c]);
  }).join('  ')));
  console.log(`\n（${rows.length} 筆）`);
} catch (e) {
  console.error('SQL 錯誤:', e.message);
  process.exit(1);
}
