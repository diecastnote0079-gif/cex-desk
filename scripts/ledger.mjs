// 變動帳（append-only）：比對最近兩次同範圍的抓取，把「變化」寫進 changes 表
//
// 用法：node ledger.mjs [--scope web] [--prev <run_id> --cur <run_id>] [--print]
// 可重複執行：同一組 (前次, 本次, 商品, 事件, 欄位) 只會寫一次（UNIQUE + INSERT OR IGNORE）
//
// 規矩（照業界標準，見 references/change-detection-method.md）：
//  ・以 box_id 為主鍵比對，不看資料順序
//  ・NULL-safe 比較：SQLite 用 IS NOT（用 <> 會漏掉「空值→有值」的變化）
//  ・只寫變化，不覆寫歷史；刪除（GONE）要明講
//  ・事件種類固定，不自創

import { openDb, pickPair, utcNow } from './cex-db.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes('--' + n);
const SCOPE = arg('scope', 'web');

const db = openDb();
let prev = arg('prev'), cur = arg('cur');
if (!prev || !cur) {
  const pair = pickPair(db, SCOPE);
  if (!pair) { console.error(`找不到兩次可比的 ${SCOPE} 抓取紀錄（需要至少兩次）`); process.exit(2); }
  prev = pair.prev; cur = pair.cur;
  console.log(`比對：${prev}（${pair.prevMeta.items} 筆） → ${cur}（${pair.curMeta.items} 筆）`);
}

const now = utcNow();
const F = `c.box_id, c.name, c.category_friendly, c.super_cat_friendly, c.first_stock, c.price_changed`;
const P = `p.run_id=? AND p.box_id=c.box_id`;

// 每個事件一段 SQL；欄位與事件種類固定
// ⚠️ 教訓（2026-09-30 實測踩到）：SQLite 的運算式欄位**一定要給 AS 別名**，否則回傳的欄位名是
//    一長串運算式文字，程式讀 r.old_value 會拿到 undefined → 整批變動數量顯示 null。
const BLOCKS = [
  ['NEW', '新增（上次沒有這個 box_id）', '', `
    SELECT ${F}, CAST(c.sell_price AS TEXT) AS new_value
    FROM items c LEFT JOIN items p ON ${P}
    WHERE c.run_id=? AND p.box_id IS NULL`],
  ['GONE', '消失（賣掉／下架）', '', `
    SELECT p.box_id, p.name, p.category_friendly, p.super_cat_friendly, p.first_stock,
           p.price_changed AS src_time, CAST(p.sell_price AS TEXT) AS old_value
    FROM items p LEFT JOIN items c ON c.run_id=? AND c.box_id=p.box_id
    WHERE p.run_id=? AND c.box_id IS NULL`],
  ['PRICE_UP', '改價：調漲', 'sell_price', `
    SELECT ${F}, CAST(p.sell_price AS TEXT) AS old_value, CAST(c.sell_price AS TEXT) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND c.sell_price > p.sell_price`],
  ['PRICE_DOWN', '改價：調降', 'sell_price', `
    SELECT ${F}, CAST(p.sell_price AS TEXT) AS old_value, CAST(c.sell_price AS TEXT) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND c.sell_price < p.sell_price`],
  ['RESTOCK', '回架（0 → 有貨）', 'qty', `
    SELECT ${F}, '0' AS old_value, CAST(c.qty AS TEXT) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND p.qty = 0 AND c.qty > 0`],
  ['SOLD_OUT', '賣光（有貨 → 0）', 'qty', `
    SELECT ${F}, CAST(p.qty AS TEXT) AS old_value, '0' AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND p.qty > 0 AND c.qty = 0`],
  ['QTY_UP', '庫存增加（>0，非回架）', 'qty', `
    SELECT ${F}, CAST(p.qty AS TEXT) AS old_value, CAST(c.qty AS TEXT) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND p.qty > 0 AND c.qty > p.qty`],
  ['QTY_DOWN', '庫存減少（>0，非賣光）', 'qty', `
    SELECT ${F}, CAST(p.qty AS TEXT) AS old_value, CAST(c.qty AS TEXT) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND p.qty > 0 AND c.qty > 0 AND c.qty < p.qty`],
  ['FLOOR_CHANGE', '保底價變動（CeX 買取價）', 'cash_buy', `
    SELECT ${F}, COALESCE(CAST(p.cash_buy AS TEXT),'(空)') AS old_value,
                 COALESCE(CAST(c.cash_buy AS TEXT),'(空)') AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND c.cash_buy IS NOT p.cash_buy`],
  ['STORE_CHANGE', '上架分店變動', 'stores', `
    SELECT ${F}, substr(COALESCE(p.stores_json,''),1,300) AS old_value,
                 substr(COALESCE(c.stores_json,''),1,300) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND c.stores_json IS NOT p.stores_json`],
  ['STATUS_CHANGE', '狀態變動（停產／可買可賣旗標）', 'flags', `
    SELECT ${F},
           ('disc=' || COALESCE(p.discontinued,-1) || ' buy=' || COALESCE(p.buy_allowed,-1)) AS old_value,
           ('disc=' || COALESCE(c.discontinued,-1) || ' buy=' || COALESCE(c.buy_allowed,-1)) AS new_value
    FROM items c JOIN items p ON ${P}
    WHERE c.run_id=? AND (c.discontinued IS NOT p.discontinued OR c.buy_allowed IS NOT p.buy_allowed)`],
];

const ins = db.prepare(`INSERT OR IGNORE INTO changes
  (detected_at, run_prev, run_cur, box_id, name, category_friendly, super_cat_friendly, event, field, old_value, new_value, src_time, first_stock)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

const summary = {};
let inserted = 0;
db.exec('BEGIN');
for (const [event, label, field, sql] of BLOCKS) {
  // GONE 的參數順序不同（c.run_id 在前）
  const params = event === 'GONE' ? [cur, prev] : [prev, cur];
  const rows = db.prepare(sql).all(...params);
  for (const r of rows) {
    const res = ins.run(now, prev, cur, r.box_id, r.name, r.category_friendly, r.super_cat_friendly,
      event, field, r.old_value ?? null, r.new_value ?? null, r.src_time ?? null, r.first_stock ?? null);
    if (res.changes > 0) inserted++;
  }
  summary[event] = { label, n: rows.length };
}
db.exec('COMMIT');

console.log(`\n=== 變動帳（${prev} → ${cur}）===`);
const shown = Object.entries(summary).filter(([, v]) => v.n > 0);
if (!shown.length) console.log('  沒有任何變化');
else shown.sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) => console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(6)}  ${v.label}`));
console.log(`\n新寫入 ${inserted} 列（已存在的同筆變化不會重複寫）｜changes 表累計 ${db.prepare('SELECT COUNT(*) c FROM changes').get().c} 列`);

if (has('print')) {
  const rows = db.prepare(`SELECT event, box_id, name, category_friendly, old_value, new_value, first_stock
    FROM changes WHERE run_prev=? AND run_cur=? ORDER BY event, name LIMIT 60`).all(prev, cur);
  console.log('\n明細（前 60）：');
  rows.forEach(r => console.log(`  ${r.event.padEnd(13)} ${String(r.category_friendly || '').padEnd(20).slice(0, 20)} ${String(r.name || '').slice(0, 34).padEnd(36)} ${r.old_value ?? ''}→${r.new_value ?? ''}`));
}
