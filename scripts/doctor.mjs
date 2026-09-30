// 健康檢查（業界標準五訊號）：新鮮度／筆數／欄位／品質／心跳
// 用法：node doctor.mjs [--run <run_id>] [--quiet]
// 結果寫進 health 表；每次給阿夜資料前先看這個
import { openDb, readMeta, recentRuns, utcNow, MIRROR_DIR } from './cex-db.mjs';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const QUIET = process.argv.includes('--quiet');
const db = openDb();

// 目前最新的一次 run
const runId = arg('run', db.prepare(`SELECT run_id FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1`).get()?.run_id);
if (!runId) { console.error('DB 裡還沒有任何 run'); process.exit(2); }
const meta = readMeta(runId) || {};
const runRow = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
const scope = meta.scope || runRow?.scope || 'web';

const results = [];
const add = (signal, status, detail) => results.push({ signal, status, detail });

// ── ① 新鮮度：最後一次成功抓取距今多久 ──
// 取 meta.startedMYT；舊版格式把 MYT 標成 Z（會算出負數）→ 負數就走 DB 的載入時間
let anchor = meta.startedMYT || runRow?.started_at;
let ageH = anchor ? (Date.now() - Date.parse(anchor)) / 3600e3 : null;
let ageNote = '';
if (ageH !== null && ageH < -0.5) {
  anchor = runRow?.finished_at || runRow?.started_at;
  ageH = anchor ? (Date.now() - Date.parse(anchor)) / 3600e3 : null;
  ageNote = '（用載入時間估算；該筆 meta 的時區標記是舊格式）';
}
if (ageH === null) add('freshness', 'WARN', '這筆 run 沒有記錄時間');
else if (ageH > 36) add('freshness', 'FAIL', `資料已 ${ageH.toFixed(1)} 小時沒更新（超過 36h）`);
else if (ageH > 26) add('freshness', 'WARN', `資料 ${ageH.toFixed(1)} 小時前的（每日兩次的話不該這麼舊）`);
else add('freshness', 'OK', `資料 ${ageH.toFixed(1)} 小時前抓的${ageNote}`);

// ── ② 筆數：與同範圍上一次比 ──
const prev = db.prepare(`SELECT run_id, items FROM runs WHERE scope=? AND run_id<>? ORDER BY started_at DESC, run_id DESC LIMIT 1`).get(scope, runId);
const items = meta.items ?? runRow?.items ?? 0;
if (!items) add('volume', 'FAIL', '抓到 0 筆（來源掛了或全部被擋）');
else if (prev?.items) {
  const d = (items - prev.items) / prev.items * 100;
  if (Math.abs(d) > 2) add('volume', 'WARN', `筆數 ${prev.items} → ${items}（${d > 0 ? '+' : ''}${d.toFixed(2)}%，超過 ±2%）`);
  else add('volume', 'OK', `筆數 ${items}（與上次 ${prev.items} 差 ${d.toFixed(2)}%）`);
} else add('volume', 'OK', `筆數 ${items}（沒有可比的上一筆）`);

// ── ③ 欄位指紋：抽樣 JSONL 前 200 行，看欄位有沒有變 ──
const jsonl = join(MIRROR_DIR, runId, 'items.jsonl');
let fingerprint = null, cols = [], sampled = 0;
if (existsSync(jsonl)) {
  const rl = createInterface({ input: createReadStream(jsonl, { encoding: 'utf8' }), crlfDelay: Infinity });
  const keysets = new Map();
  for await (const line of rl) {
    if (!line.trim()) continue;
    const k = Object.keys(JSON.parse(line)).sort().join('|');
    keysets.set(k, (keysets.get(k) || 0) + 1);
    if (++sampled >= 200) break;
  }
  // 取樣本中最常見的欄位集合當基準
  const top = [...keysets.entries()].sort((a, b) => b[1] - a[1])[0];
  cols = top ? top[0].split('|') : [];
  fingerprint = createHash('sha256').update(cols.join(',')).digest('hex').slice(0, 16);
  const inconsistent = [...keysets.entries()].filter(([k, n]) => k !== top?.[0] && n > 0).length;
  if (inconsistent > 0) add('schema', 'WARN', `抽樣 ${sampled} 筆中有 ${inconsistent} 種不同欄位組合（來源可能正在改版）`);
  const lastLog = db.prepare(`SELECT * FROM schema_log WHERE run_id<>? ORDER BY checked_at DESC LIMIT 1`).get(runId);
  if (lastLog && lastLog.fingerprint !== fingerprint) {
    const before = new Set(JSON.parse(lastLog.columns_json));
    const after = new Set(cols);
    const added = cols.filter(c => !before.has(c));
    const removed = JSON.parse(lastLog.columns_json).filter(c => !after.has(c));
    add('schema', 'FAIL', `欄位變了：新增 [${added.join(', ') || '無'}]｜消失 [${removed.join(', ') || '無'}]`);
  } else if (!lastLog) add('schema', 'OK', `${cols.length} 個欄位（第一次記錄指紋）`);
  else add('schema', 'OK', `${cols.length} 個欄位，與上次指紋一致`);
} else add('schema', 'WARN', `找不到原始檔 ${jsonl}`);

// ── ④ 品質：重複主鍵／關鍵欄位空值 ──
const dup = db.prepare('SELECT COUNT(*) c FROM (SELECT box_id FROM items WHERE run_id=? GROUP BY box_id HAVING COUNT(*)>1)').get(runId).c;
const total = db.prepare('SELECT COUNT(*) c FROM items WHERE run_id=?').get(runId).c;
const noPrice = db.prepare('SELECT COUNT(*) c FROM items WHERE run_id=? AND (sell_price IS NULL OR sell_price<=0)').get(runId).c;
const noName = db.prepare("SELECT COUNT(*) c FROM items WHERE run_id=? AND (name IS NULL OR TRIM(name)='')").get(runId).c;
const noQty = db.prepare('SELECT COUNT(*) c FROM items WHERE run_id=? AND qty IS NULL').get(runId).c;
const pct = n => total ? (n / total * 100).toFixed(2) + '%' : 'n/a';
if (dup > 0) add('quality', 'FAIL', `重複主鍵 ${dup} 筆（比對會出錯）`);
else if (noPrice / total > 0.05) add('quality', 'FAIL', `沒有標價的 ${noPrice} 筆（${pct(noPrice)}）`);
else if (noPrice > 0 || noName > 0) add('quality', 'WARN', `沒有標價 ${noPrice} 筆（${pct(noPrice)}）｜沒有名稱 ${noName} 筆｜沒有庫存值 ${noQty} 筆`);
else add('quality', 'OK', `${total} 筆：主鍵無重複、標價與名稱完整`);

// ── ⑤ 心跳：上次成功檢查距今 ──
const lastRun = db.prepare(`SELECT run_id, started_at FROM runs WHERE run_id<>? ORDER BY started_at DESC, run_id DESC LIMIT 1`).get(runId);
if (lastRun?.started_at) {
  const gapH = (Date.parse(anchor) - Date.parse(lastRun.started_at)) / 3600e3;
  add('heartbeat', gapH > 26 ? 'WARN' : 'OK', `距上次抓取 ${gapH.toFixed(1)} 小時（${lastRun.run_id} → ${runId}）`);
} else add('heartbeat', 'OK', '第一次抓取');

// ── 寫入 DB ──
const insH = db.prepare('INSERT OR REPLACE INTO health (run_id, checked_at, signal, status, detail) VALUES (?,?,?,?,?)');
db.exec('BEGIN');
for (const r of results) insH.run(runId, utcNow(), r.signal, r.status, r.detail);
db.prepare('INSERT OR REPLACE INTO schema_log (run_id, checked_at, fingerprint, n_columns, columns_json) VALUES (?,?,?,?,?)')
  .run(runId, utcNow(), fingerprint ?? 'n/a', cols.length, JSON.stringify(cols));
db.exec('COMMIT');

const bad = results.filter(r => r.status !== 'OK');
const icon = s => s === 'OK' ? '✅' : s === 'WARN' ? '🟡' : '🔴';
if (!QUIET) {
  console.log(`健康檢查：${runId}（範圍 ${scope}，${total} 筆）`);
  results.forEach(r => console.log(`  ${icon(r.status)} ${r.signal.padEnd(10)} ${r.detail}`));
  console.log(bad.length ? `\n⚠️ ${bad.length} 項需要注意` : '\n全部正常');
}
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
