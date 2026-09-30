// 變動帳自我測試：用合成資料造出「每一種變化」，驗證 ledger 一種不漏、一種不多
// 用法：node selftest-ledger.mjs
// 會用暫存 DB（不會碰正式資料庫）
import { openDb } from './cex-db.mjs';
import { execFileSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTDB = join(tmpdir(), 'cex-ledger-test.sqlite');
for (const f of [TESTDB, TESTDB + '-wal', TESTDB + '-shm']) if (existsSync(f)) unlinkSync(f);

const db = openDb(TESTDB);
db.prepare('INSERT INTO runs (run_id, started_at, scope, items) VALUES (?,?,?,?)').run('TEST_A', '2026-01-01T00:00:00Z', 'test', 10);
db.prepare('INSERT INTO runs (run_id, started_at, scope, items) VALUES (?,?,?,?)').run('TEST_B', '2026-01-02T00:00:00Z', 'test', 10);

const COLS = ['run_id', 'box_id', 'name', 'category_friendly', 'super_cat_friendly', 'sell_price', 'qty', 'cash_buy', 'stores_json', 'discontinued', 'buy_allowed', 'first_stock', 'price_changed'];
const ins = db.prepare(`INSERT INTO items (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
const row = (run, box, over = {}) => ins.run(run, box, over.name ?? 'Game ' + box, over.cat ?? 'PS5 Games: R3 CHI', 'Gaming',
  over.price ?? 100, over.qty ?? 1, over.floor ?? 50, over.stores ?? '["A"]', over.disc ?? 0, over.buy ?? 1,
  over.first ?? '2026-01-01 00:00:00', over.chg ?? '2026-01-01 00:00:00');

// A 快照
row('TEST_A', 'ID_SAME', {});                       // 完全不變 → 不該有事件
row('TEST_A', 'ID_PRICE_UP', { price: 100 });
row('TEST_A', 'ID_PRICE_DOWN', { price: 100 });
row('TEST_A', 'ID_QTY_UP', { qty: 2 });
row('TEST_A', 'ID_QTY_DOWN', { qty: 3 });
row('TEST_A', 'ID_RESTOCK', { qty: 0 });
row('TEST_A', 'ID_SOLDOUT', { qty: 2 });
row('TEST_A', 'ID_FLOOR', { floor: 50 });
row('TEST_A', 'ID_STORE', { stores: '["A"]' });
row('TEST_A', 'ID_STATUS', { disc: 0 });
row('TEST_A', 'ID_GONE', {});
row('TEST_A', 'ID_NULLFLOOR', { floor: null });     // 空 → 有值（NULL-safe 測試）
row('TEST_A', 'ID_GONE2', { name: '只在 A 有的另一筆' });  // 第二個消失案例

// B 快照
row('TEST_B', 'ID_SAME', {});
row('TEST_B', 'ID_PRICE_UP', { price: 120 });
row('TEST_B', 'ID_PRICE_DOWN', { price: 80 });
row('TEST_B', 'ID_QTY_UP', { qty: 5 });
row('TEST_B', 'ID_QTY_DOWN', { qty: 1 });
row('TEST_B', 'ID_RESTOCK', { qty: 3 });
row('TEST_B', 'ID_SOLDOUT', { qty: 0 });
row('TEST_B', 'ID_FLOOR', { floor: 60 });
row('TEST_B', 'ID_STORE', { stores: '["A","B"]' });
row('TEST_B', 'ID_STATUS', { disc: 1 });
row('TEST_B', 'ID_NULLFLOOR', { floor: 40 });
row('TEST_B', 'ID_NEW', {});                        // 新增
db.close();

// 跑 ledger（分開的 process，模擬真實使用）
execFileSync(process.execPath, [join(HERE, 'ledger.mjs'), '--scope', 'test', '--prev', 'TEST_A', '--cur', 'TEST_B'],
  { env: { ...process.env, CEX_DB: TESTDB }, stdio: 'inherit' });

// 驗證
const db2 = openDb(TESTDB);
const got = db2.prepare(`SELECT box_id, event FROM changes WHERE run_prev='TEST_A' AND run_cur='TEST_B' ORDER BY box_id, event`).all();
const want = [
  ['ID_FLOOR', 'FLOOR_CHANGE'], ['ID_GONE', 'GONE'], ['ID_GONE2', 'GONE'], ['ID_NEW', 'NEW'],
  ['ID_NULLFLOOR', 'FLOOR_CHANGE'], ['ID_PRICE_DOWN', 'PRICE_DOWN'], ['ID_PRICE_UP', 'PRICE_UP'],
  ['ID_QTY_DOWN', 'QTY_DOWN'], ['ID_QTY_UP', 'QTY_UP'], ['ID_RESTOCK', 'RESTOCK'],
  ['ID_SOLDOUT', 'SOLD_OUT'], ['ID_STATUS', 'STATUS_CHANGE'], ['ID_STORE', 'STORE_CHANGE'],
].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
const gotK = got.map(r => [r.box_id, r.event]);
const missing = want.filter(w => !gotK.some(g => g[0] === w[0] && g[1] === w[1]));
const extra = gotK.filter(g => !want.some(w => w[0] === g[0] && w[1] === g[1]));
const sameRow = gotK.filter(g => g[0] === 'ID_SAME');

console.log(`\n期望 ${want.length} 個事件｜實際 ${gotK.length} 個`);
console.log('漏掉:', missing.length ? JSON.stringify(missing) : '無');
console.log('多報:', extra.length ? JSON.stringify(extra) : '無');
console.log('不變的那筆有沒有被誤報:', sameRow.length ? '有（錯誤！）' : '沒有 ✅');

// 再跑一次，驗證「可重複執行不會重複寫」
execFileSync(process.execPath, [join(HERE, 'ledger.mjs'), '--scope', 'test', '--prev', 'TEST_A', '--cur', 'TEST_B', '--quiet'],
  { env: { ...process.env, CEX_DB: TESTDB }, stdio: 'pipe' });
const after = db2.prepare('SELECT COUNT(*) c FROM changes').get().c;
console.log(`重跑一次後 changes 仍是 ${after} 列（${after === gotK.length ? '冪等 ✅' : '重複寫入了！❌'}）`);

const pass = !missing.length && !extra.length && !sameRow.length && after === gotK.length;
console.log(pass ? '\n✅ 全部通過' : '\n❌ 有問題');
db2.close();
process.exitCode = pass ? 0 : 1;
