// 每天一次「兩份實作對帳」：SQL（ledger.mjs 寫進 changes 表）vs JS 規則（ledger-core.mjs）
//
// 為什麼要這支：判定規則集中在 `ledger-core.mjs`，但伺服器那條路仍是 `ledger.mjs` 的 SQL。
// 只要兩邊對同一組 run 算出的「逐事件數量」不同 → 就是漂移 → 記進 parity.json，
// 由心跳帶上雲端 → 雲端告警器會講（PC 端沒有 Telegram 憑證，所以由雲端負責叫）。
//
// 用法：
//   node ledger-parity.mjs [--scope web] [--prev <run> --cur <run>] [--quiet]
// 離開碼：0＝一致或無法比對、2＝發現漂移
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, pickPair, utcNow, CEX_HOME } from './cex-db.mjs';
import { diffRows, countByEvent, RULES } from './ledger-core.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const QUIET = process.argv.includes('--quiet');
const SCOPE = arg('scope', 'web');
const log = m => { if (!QUIET) console.log(m); };

const db = openDb();
let pair = null;
if (arg('prev') && arg('cur')) pair = { prev: arg('prev'), cur: arg('cur') };
else pair = pickPair(db, SCOPE);
if (!pair) { log('對帳略過：需要至少兩次可比的抓取。'); console.log('PARITY_SKIP'); process.exit(0); }

const load = runId => db.prepare(`
  SELECT box_id, name, category_friendly, sell_price, qty, cash_buy, stores_json,
         discontinued, buy_allowed, first_stock
  FROM items WHERE run_id=?`).all(runId).map(r => ({
  boxId: r.box_id, name: r.name, cat: r.category_friendly,
  price: r.sell_price, qty: r.qty, cash: r.cash_buy, stores: r.stores_json,
  discontinued: r.discontinued, buyAllowed: r.buy_allowed, first: r.first_stock,
}));

const prevRows = load(pair.prev), curRows = load(pair.cur);
const jsCounts = countByEvent(diffRows(prevRows, curRows));

const sqlCounts = {};
for (const r of db.prepare('SELECT event, COUNT(*) c FROM changes WHERE run_prev=? AND run_cur=? GROUP BY event').all(pair.prev, pair.cur)) {
  sqlCounts[r.event] = r.c;
}

// 逐事件比對（以規則表為準，兩邊都沒有的算 0）
const diffs = [];
const allKeys = [...new Set([...RULES.map(r => r.key), ...Object.keys(sqlCounts), ...Object.keys(jsCounts)])];
for (const k of allKeys) {
  const a = sqlCounts[k] || 0, b = jsCounts[k] || 0;
  if (a !== b) diffs.push({ event: k, sql: a, js: b });
}

const result = {
  at: utcNow(), scope: SCOPE, runPrev: pair.prev, runCur: pair.cur,
  ok: diffs.length === 0, diffs,
  sqlCounts, jsCounts,
  items: { prev: prevRows.length, cur: curRows.length },
};

// 寫進本機狀態（publish.mjs 會把它帶進心跳，雲端才看得到）
try {
  const dir = CEX_HOME;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'parity.json'), JSON.stringify(result, null, 1) + '\n');
} catch (e) { log('⚠️ 寫 parity.json 失敗：' + e.message); }

if (result.ok) {
  const n = allKeys.reduce((s, k) => s + (jsCounts[k] || 0), 0);
  log(`\n=== 兩份實作對帳（${pair.prev} → ${pair.cur}）===`);
  log(`  ✅ 逐事件一致（${RULES.length} 種；變動共 ${n} 筆）｜items ${prevRows.length} → ${curRows.length}`);
  console.log('PARITY_OK ' + JSON.stringify({ runPrev: pair.prev, runCur: pair.cur, events: n }));
  process.exit(0);
}

log(`\n=== 兩份實作對帳（${pair.prev} → ${pair.cur}）===`);
log('  🔴 發現漂移（SQL vs JS）：');
for (const d of diffs) log(`    ${d.event.padEnd(14)} SQL=${String(d.sql).padStart(6)}  JS=${String(d.js).padStart(6)}`);
log(`  items ${prevRows.length} → ${curRows.length}`);
console.log('PARITY_FAIL ' + JSON.stringify(result));
process.exit(2);
