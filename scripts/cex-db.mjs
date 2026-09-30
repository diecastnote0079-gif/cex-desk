// CeX 資料庫：單一入口，負責「開 DB ＋ 確保表結構 ＋ 共用小工具」
// 其他腳本一律 import 這裡，不要各自開 DB（schema 只寫一處）
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { DB_PATH, MIRROR_DIR, CEX_HOME, LOG_DIR } from './cex-paths.mjs';

export { DB_PATH, MIRROR_DIR, CEX_HOME, LOG_DIR };

export function openDb(path = DB_PATH) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, scope TEXT,
      requests INTEGER, items INTEGER, index_reported INTEGER, unreachable INTEGER,
      full_flag INTEGER, filters TEXT
    );
    CREATE TABLE IF NOT EXISTS items (
      run_id TEXT, box_id TEXT, name TEXT, category_id TEXT, category_name TEXT,
      category_friendly TEXT, super_cat TEXT, super_cat_friendly TEXT,
      sell_price REAL, first_price REAL, prev_price REAL, price_reduced INTEGER,
      price_changed TEXT, price_changed_ts INTEGER,
      cash_buy REAL, voucher_buy REAL, buy_perc REAL, exch_perc REAL,
      qty INTEGER, ecom_qty INTEGER, stores_json TEXT, out_json TEXT, availability TEXT,
      in_store INTEGER, in_online INTEGER, first_stock TEXT, first_stock_in TEXT, ts TEXT,
      discontinued INTEGER, buy_allowed INTEGER, web_buy_allowed INTEGER, sale_allowed INTEGER,
      visible INTEGER, show_on_web INTEGER, show_sell_price INTEGER, deleted INTEGER,
      rating REAL, popularity REAL, is_new INTEGER, origin TEXT, product_lines TEXT,
      master_box_id INTEGER, image INTEGER, raw_json TEXT,
      PRIMARY KEY (run_id, box_id)
    );

    -- ★ 變動帳：只增不改。同一組 (前次run, 本次run, 商品, 事件, 欄位) 只會有一列 → 可重複執行
    CREATE TABLE IF NOT EXISTS changes (
      ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at TEXT NOT NULL,
      run_prev TEXT NOT NULL, run_cur TEXT NOT NULL,
      box_id TEXT NOT NULL, name TEXT, category_friendly TEXT, super_cat_friendly TEXT,
      event TEXT NOT NULL, field TEXT DEFAULT '',
      old_value TEXT, new_value TEXT,
      src_time TEXT,            -- 來源宣稱時間（firstStockDate=MYT / priceLastChanged=UTC）
      first_stock TEXT,
      UNIQUE (run_prev, run_cur, box_id, event, field)
    );

    -- 健康檢查（五個訊號）
    CREATE TABLE IF NOT EXISTS health (
      run_id TEXT NOT NULL, checked_at TEXT NOT NULL,
      signal TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
      PRIMARY KEY (run_id, signal)
    );

    -- 欄位指紋（偵測來源改版）
    CREATE TABLE IF NOT EXISTS schema_log (
      run_id TEXT PRIMARY KEY, checked_at TEXT NOT NULL,
      fingerprint TEXT NOT NULL, n_columns INTEGER, columns_json TEXT
    );

    CREATE VIEW IF NOT EXISTS latest_items AS
      SELECT * FROM items WHERE run_id = (SELECT run_id FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1);
    CREATE VIEW IF NOT EXISTS latest_run AS
      SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1;
  `);

  // ── 遷移：舊版 runs 表沒有 scope 欄位（由 db-load.mjs 建立）→ 補上並回填 ──
  const cols = db.prepare(`SELECT name FROM pragma_table_info('runs')`).all().map(r => r.name);
  if (!cols.includes('scope')) {
    db.exec(`ALTER TABLE runs ADD COLUMN scope TEXT`);
    db.exec(`UPDATE runs SET scope = CASE
        WHEN filters LIKE '%boxSaleAllowed=1' AND (filters IS NULL OR filters NOT LIKE '%boxVisibilityOnWeb%') THEN 'all'
        ELSE 'web' END
      WHERE scope IS NULL`);
    db.exec(`UPDATE runs SET scope='web' WHERE scope IS NULL`);
  }
  return db;
}

/** 最近 n 次「同一個範圍（scope）」的 run（新→舊），用來兩兩比對 */
export function recentRuns(db, scope = 'web', n = 2) {
  return db.prepare(
    `SELECT run_id, started_at, items FROM runs WHERE scope = ? ORDER BY started_at DESC, run_id DESC LIMIT ?`
  ).all(scope, n);
}

/** 找兩次可比對的 run：預設「最新 vs 上一次同範圍」 */
export function pickPair(db, scope = 'web') {
  const rs = recentRuns(db, scope, 2);
  if (rs.length < 2) return null;
  return { cur: rs[0].run_id, prev: rs[1].run_id, curMeta: rs[0], prevMeta: rs[1] };
}

export function readMeta(runId) {
  const p = `${MIRROR_DIR}\\${runId}\\meta.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const mytNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
