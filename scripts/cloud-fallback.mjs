// CeX 雲端備援（GitHub Actions 用）
//
// 角色：本機 PC 是主力（每天 08:30／20:00 抓 → 對帳 → 健康檢查）。這支只在**本機沒按時回報**時才動：
// 自己抓一次全站 → 跟上一次雲端存下來的狀態比對 → 發 Telegram → 更新狀態。
// 本機正常時它什麼都不做（連抓都不抓），所以平時不消耗任何資源。
//
// ⚠️ 2026-10-01 修正門檻：原本是「本機超過 24 小時沒更新」才接手，但本機排程是 12 小時一次
//    → **單次失敗永遠等不到備援**（上次成功總在 12 小時多一點）；2026-10-01 08:30 發布被打斷就是這樣飄掉 5 小時。
//    改成照本機節奏判斷：**12 小時＋30 分寬容＝12.5 小時**；並加「自己剛接手過就不要再抓」的保護，
//    避免本機持續離線時每個檢查點都重複抓。（「會叫」的那個是 heartbeat-alert.mjs，兩支互相獨立。）
//
// 用法：
//   node cloud-fallback.mjs                正常跑（會先看心跳）
//   node cloud-fallback.mjs --force        忽略心跳，強制抓一次（驗收／補資料用）
//   node cloud-fallback.mjs --dry-run      不送 Telegram、不寫狀態檔，只印出來檢查
//   node cloud-fallback.mjs --repo <目錄>   repo 工作目錄（預設＝這支腳本的上一層）
//   node cloud-fallback.mjs --limit 3      只跑前 3 個切分（小樣本測試；資料量不完整）
//
// 需要的環境變數：TELEGRAM_BOT_TOKEN（沒有就只印不送）、TELEGRAM_CHAT_ID（預設使用者的 chat）
//
// 設計理由與取捨見 references/interface-hosting-design.md §七之四、handoff §0b。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendTelegram } from './notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = n => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const REPO = argOf('repo', join(HERE, '..'));
const STATE = join(REPO, 'state');
const FORCE = has('force');
const DRY = has('dry-run');
const LIMIT = Number(argOf('limit', 0));
const HEARTBEAT = join(STATE, 'heartbeat.json');   // 本機 PC 的心跳（雲端只讀、不改寫）
const BASELINE = join(STATE, 'baseline.tsv.gz');
const CLOUD = join(STATE, 'cloud.json');           // 雲端自己的紀錄（含上次發訊時間）
const FRESH_HOURS = Number(process.env.CEX_FRESH_HOURS || 12.5);      // 本機節奏 12h ＋ 30 分寬容
const MIN_GAP_HOURS = Number(process.env.CEX_MIN_GAP_HOURS || 9);     // 自己剛接手過 → 不重複抓
const STALE_BASE_HOURS = Number(process.env.CEX_STALE_BASE_HOURS || 48);
// 這支會進公開 repo，所以收訊對象不寫死在這裡（走 secrets；見 workflow）
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const mytNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
// firstStockDate 是 MYT 時間，字串格式未必帶時區 → 統一正規化成 YYYY-MM-DDTHH:MM:SS 再比大小
const normTs = s => String(s || '').replace(' ', 'T').slice(0, 19);
const cutoff24h = () => normTs(new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString());
const hours = ms => +(ms / 3600e3).toFixed(1);
const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const log = m => console.log(`[${utcNow()}] ${m}`);

// ── 精簡狀態檔的讀取（格式由 mirror.mjs --compact 產生）──
function readState(file) {
  const rows = gunzipSync(readFileSync(file)).toString('utf8').split('\n');
  const cols = rows.shift().replace(/^#/, '').split('\t');
  const map = new Map();
  for (const line of rows) {
    if (!line) continue;
    const f = line.split('\t');
    map.set(f[0], {
      name: f[1], cat: f[2], super: f[3],
      price: Number(f[4]) || 0, cash: Number(f[5]) || 0,
      qty: Number(f[6]) || 0, first: f[7] || '',
    });
  }
  return { cols, map };
}

// ── 1. 心跳：本機還在跑就不要動 ──
const hb = readJson(HEARTBEAT);
const lastGoodMs = hb?.lastGoodRun ? Date.parse(hb.lastGoodRun) : null;
const pcAgeH = lastGoodMs ? hours(Date.now() - lastGoodMs) : null;
log(hb ? `心跳：${hb.source}／${hb.lastGoodRun}（${pcAgeH} 小時前，${hb.items ?? '?'} 筆）` : '沒有心跳檔（視為本機從未成功抓取）');

if (!FORCE && pcAgeH !== null && pcAgeH < FRESH_HOURS) {
  log(`本機資料還在 ${FRESH_HOURS} 小時內 → 雲端備援不做任何事（不抓取、不發訊）。`);
  console.log('FALLBACK_SUMMARY ' + JSON.stringify({ action: 'skip', reason: 'fresh', pcAgeHours: pcAgeH }));
  process.exit(0);
}
log(FORCE ? '（--force：忽略心跳，強制執行）' : `本機已 ${pcAgeH} 小時沒更新 → 備援接手。`);

// ── 2. 自己抓一次全站（用同一支 mirror，避免兩套抓取邏輯）──
const tmpDir = process.env.CEX_HOME || join(REPO, '.tmp');
mkdirSync(tmpDir, { recursive: true });
const currentFile = join(tmpDir, 'current.tsv.gz');
const runId = mytNow().replace(/[-:T]/g, '').slice(0, 14);
const t0 = Date.now();
log(`開始抓取（scope=web，run_id=${runId}）…`);
execFileSync(process.execPath, [
  join(HERE, 'mirror.mjs'), '--scope', 'web', '--compact', currentFile,
  ...(LIMIT ? ['--limit', String(LIMIT)] : []),
], { stdio: 'inherit', env: { ...process.env, CEX_RUN_ID: runId } });
const fetchSec = ((Date.now() - t0) / 1000).toFixed(0);
log(`抓取完成，耗時 ${fetchSec} 秒`);

// ── 3. 跟雲端存下來的上次狀態比對 ──
const cur = readState(currentFile);
const prev = existsSync(BASELINE) ? readState(BASELINE) : null;
const prevMeta = readJson(CLOUD);
const baseAgeH = prevMeta?.at ? hours(Date.now() - Date.parse(prevMeta.at)) : null;
const rebuilt = !prev || baseAgeH === null || baseAgeH > STALE_BASE_HOURS;   // 基準太舊 → 只報近 24h，避免洗版

const isNew = [], gone = [], priceChanged = [], qtyChanged = [];
for (const [id, c] of cur.map) {
  const p = prev?.map.get(id);
  if (!p) { isNew.push({ id, ...c }); continue; }
  if (p.price !== c.price) priceChanged.push({ id, from: p.price, to: c.price, ...c });
  else if (p.qty !== c.qty) qtyChanged.push({ id, from: p.qty, to: c.qty, ...c });
}
if (prev) for (const [id, p] of prev.map) if (!cur.map.has(id)) gone.push({ id, ...p });

const cut = cutoff24h();
const arrivals = [...cur.map].filter(([, v]) => normTs(v.first) >= cut).map(([id, v]) => ({ id, ...v }));

// 基準壞掉時只信任「近期新上架」；基準正常時信任完整變動帳
const listed = rebuilt ? arrivals : isNew;
log(`比對：本次 ${cur.map.size} 筆｜新上架 ${isNew.length}｜賣光/消失 ${gone.length}｜改價 ${priceChanged.length}｜庫存變動 ${qtyChanged.length}`
  + (rebuilt ? `｜基準${prev ? `已 ${baseAgeH} 小時` : '不存在'} → 只列近 24 小時新上架 ${arrivals.length} 筆` : ''));

// 發訊規則：① 這是電腦斷線後的第一次接手 → 一定講 ② 有 RM100+ 或庫存≤1 的貨 → 一定講
// 其餘（電腦一直沒開、又沒好貨）→ 只更新狀態、不打擾他（「不主動通知」＋「空手而回是常態」）
const worth = listed.filter(x => x.price >= 100 || x.qty <= 1);
const firstSincePc = !prevMeta || (lastGoodMs !== null && Date.parse(prevMeta.at) < lastGoodMs);
const notify = firstSincePc || worth.length > 0;
log(`發訊判斷：${notify ? '要發' : '不發'}（${firstSincePc ? '電腦斷線後第一次' : `好貨 ${worth.length} 筆`}）`);

// ── 4. 組 Telegram 訊息 ──
const fmt = x => `・${x.name || '(無名)'}（${x.cat || '?'}）RM${x.price}`
  + (x.qty <= 1 ? '｜庫存≤1' : `｜庫存 ${x.qty}`) + (x.cash ? `｜買取 RM${x.cash}` : '');
const lines = [];
lines.push(`🛰 CeX 雲端備援接手${FORCE ? '（手動強制）' : ''}`);
lines.push(pcAgeH === null ? '電腦從未回報成功抓取' : `電腦最後成功抓取：${pcAgeH} 小時前`);
lines.push(`雲端抓取：${cur.map.size} 筆／${fetchSec} 秒`);
lines.push(rebuilt ? `（雲端基準${prev ? '已逾 48 小時' : '不存在'} → 這輪只列近 24 小時新上架）`
  : `新上架 ${isNew.length}｜賣光 ${gone.length}｜改價 ${priceChanged.length}｜庫存變動 ${qtyChanged.length}`);

if (worth.length) {
  lines.push('─────', '🆕 值得看的（RM100+ 或庫存≤1）：');
  for (const x of worth.slice(0, 12)) lines.push(fmt(x));
  if (worth.length > 12) lines.push(`…另有 ${worth.length - 12} 筆`);
  if (listed.length > worth.length) lines.push(`（其餘 ${listed.length - worth.length} 筆一般品略）`);
} else {
  lines.push('─────', '🆕 沒有 RM100+ 或庫存≤1 的（空手而回是常態）');
}
if (!rebuilt && priceChanged.length) {
  lines.push('─────', `💰 改價 ${priceChanged.length} 筆：`);
  for (const x of priceChanged.slice(0, 8)) lines.push(`・${x.name}（${x.cat}）RM${x.from} → RM${x.to}${x.to < x.from ? '（降）' : '（升）'}`);
  if (priceChanged.length > 8) lines.push(`…另有 ${priceChanged.length - 8} 筆`);
}
const msg = lines.join('\n').slice(0, 3800);
console.log('\n===== Telegram 訊息預覽 =====\n' + msg + '\n=============================\n');

let sent = null;
if (DRY) log('--dry-run：不送 Telegram、不寫狀態檔。');
else if (!notify) log('不打擾（狀態照樣更新，只是不發訊）。');
else if (!TOKEN || !CHAT_ID) { log('⚠️ 沒有 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID → 只印不送（狀態檔仍會更新）。'); }
else {
  const res = await sendTelegram(msg, { token: TOKEN, chatId: CHAT_ID });
  sent = { ok: !!res.ok, message_id: res.messageId, error: res.ok ? null : res.error };
  log(sent.ok ? `✅ Telegram 已送出（message_id ${sent.message_id}）` : `❌ Telegram 失敗：${res.error}`);
  if (!sent.ok) process.exitCode = 1;
}

// ── 5. 更新狀態（只在真的做完時寫；心跳檔是本機的，雲端只讀不改）──
if (!DRY) {
  mkdirSync(STATE, { recursive: true });
  copyFileSync(currentFile, BASELINE);
  writeFileSync(CLOUD, JSON.stringify({
    at: utcNow(), runId, scope: 'web', items: cur.map.size,
    new: isNew.length, gone: gone.length, priceChanged: priceChanged.length, qtyChanged: qtyChanged.length,
    rebuilt, notified: !!sent?.ok, sent, fetchSec: +fetchSec,
  }, null, 1) + '\n');
  log('狀態檔已更新（baseline.tsv.gz／cloud.json）');
}

console.log('FALLBACK_SUMMARY ' + JSON.stringify({
  action: 'ran', force: FORCE, items: cur.map.size, new: isNew.length, gone: gone.length,
  priceChanged: priceChanged.length, qtyChanged: qtyChanged.length, rebuilt, sent,
}));
