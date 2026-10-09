// CeX 判斷台：產生「手機頁」要用的資料，並發佈到 GitHub Pages 的 data 分支
//
//   node publish-web.mjs                        PC 用：從本機資料庫取「最新狀態＋變動帳」
//   node publish-web.mjs --from-compact <檔>     雲端備援用：從抓下來的精簡狀態取資料
//   node publish-web.mjs --dry-run              只產生檔案、不 commit／不推
//   node publish-web.mjs --web <目錄>            data 分支的工作目錄（預設 D:\AI\cex-web）
//
// 為什麼是「分支＋amend」而不是每天一個 commit：
//   items.json 約 5 MB，一天推兩次＝一年 3.6 GB 的 git 歷史。這個分支永遠只有**一個 commit**
//   （每次 --amend 後 force push），遠端不會長大；舊資料沒有保留價值，本機的資料庫才是史料。
//
// data 分支內容：index.html（行動版頁面）＋ items.json（最新狀態）＋ changes.json（變動帳）＋ meta.json
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendTelegram, reportSend } from './notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = n => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const DRY = has('dry-run');
const PUSH = !has('no-push');
const COMPACT = argOf('from-compact', null);
const WEB = argOf('web', 'D:\\AI\\cex-web');
const REPO = argOf('repo', 'D:\\AI\\cex-desk');
const HTML = argOf('html', join(REPO, 'web', 'index.html'));
const REPO_URL = argOf('repo-url', 'https://github.com/diecastnote0079-gif/cex-desk.git');
const BRANCH = 'data';
const CHG_DAYS = Number(argOf('days', 14));
const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const log = m => console.log(`[${utcNow()}] ${m}`);
const COLS = ['boxId', 'name', 'cat', 'price', 'cash', 'qty', 'stores', 'first'];

// 沒有 token 時清掉 credential helper → 立刻失敗，不卡在等認證（同 publish.mjs 的說明）
const credArgs = () => (process.env.GITHUB_TOKEN ? [] : ['-c', 'credential.helper=']);
const git = (args, opts = {}) => execFileSync('git', ['-C', WEB, ...credArgs(), ...args], { encoding: 'utf8', ...opts });
const gitEnv = () => {
  const env = { ...process.env };
  const token = process.env.GITHUB_TOKEN;
  // 2026-10-01：沒有憑證時不要卡在等認證（清 helper 見上面 credArgs）
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
};

// ── 1. 取得資料 ──
let items = [], source, runId = null, scope = 'web', changes = [];

if (COMPACT) {
  source = 'cloud';
  const rows = gunzipSync(readFileSync(COMPACT)).toString('utf8').split('\n');
  const cols = rows.shift().replace(/^#/, '').split('\t');
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  for (const line of rows) {
    if (!line) continue;
    const f = line.split('\t');
    items.push([f[ix.boxId], f[ix.boxName], f[ix.categoryFriendlyName],
      Number(f[ix.sellPrice]) || 0, Number(f[ix.cashPriceCalculated]) || 0,
      Number(f[ix.collectionQuantity]) || 0, 0, f[ix.firstStockDate] || '']);
  }
} else {
  source = 'pc';
  const { openDb, recentRuns } = await import('./cex-db.mjs');
  const db = openDb();
  const [last] = recentRuns(db, 'web', 1);
  runId = last?.run_id || null;
  for (const r of db.prepare(`SELECT box_id, name, category_friendly, sell_price, cash_buy, qty, stores_json, first_stock
                              FROM latest_items`).all()) {
    let stores = 0;
    try { stores = JSON.parse(r.stores_json || '[]').length; } catch {}
    items.push([r.box_id, r.name, r.category_friendly, r.sell_price || 0, r.cash_buy || 0, r.qty || 0, stores, r.first_stock || '']);
  }
  const cut = new Date(Date.now() - CHG_DAYS * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z');
  changes = db.prepare(`SELECT detected_at t, event, box_id boxId, name, category_friendly cat, old_value old, new_value new
                        FROM changes WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 5000`).all(cut);
}

items.sort((a, b) => b[3] - a[3]);
log(`資料：${items.length} 筆（來源 ${source}${runId ? `，run ${runId}` : ''}）${changes.length ? `｜變動 ${changes.length} 筆` : ''}`);

// 「沒有可用基準」≠「真的零變動」：雲端備援（--from-compact）沒有本機帳本可比、runId 也拿不到，
//   changes 永遠是空陣列（不是算出來的）→ 視為沒有基準；本機路徑要有上一輪 run（run_id）才算有基準。
const hasBaseline = !COMPACT && runId !== null;

// ── 2. 準備發佈目錄（要先有 repo 才能寫檔：git clone 不接受非空目錄）──
function ensureRepo() {
  if (DRY) return;
  if (existsSync(join(WEB, '.git'))) {
    try { git(['fetch', 'origin', BRANCH], { env: gitEnv() }); git(['reset', '--hard', `origin/${BRANCH}`]); }
    catch (e) { log(`⚠️ 同步遠端失敗（續用本地）：${String(e.message).slice(0, 160)}`); }
    return;
  }
  if (existsSync(WEB)) {   // 只有「不是 git repo 的暫存目錄」才會被清掉（保護真正的 repo）
    log(`⚠️ ${WEB} 存在但沒有 .git → 視為暫存目錄，清掉重建`);
    rmSync(WEB, { recursive: true, force: true });
  }
  log(`第一次：clone ${BRANCH} 分支 → ${WEB}`);
  execFileSync('git', ['clone', '--branch', BRANCH, '--single-branch', REPO_URL, WEB], { stdio: 'inherit' });
}
ensureRepo();

// ── 3. 寫檔 ──
if (!DRY) mkdirSync(WEB, { recursive: true });
const write = (name, obj) => {
  if (DRY) return;
  writeFileSync(join(WEB, name), JSON.stringify(obj) + '\n');
};
// 把 repo 的 web/ 整個目錄複製到資料分支根目錄（index.html、manifest.webmanifest、icons…）
const WEB_SRC = dirname(HTML);
if (existsSync(WEB_SRC)) {
  const pageFiles = readdirSync(WEB_SRC);
  if (!DRY) for (const f of pageFiles) copyFileSync(join(WEB_SRC, f), join(WEB, f));
  log(`頁面檔案同步：${pageFiles.length} 個（${pageFiles.join('、')}）`);
} else {
  log(`⚠️ 找不到頁面目錄 ${WEB_SRC}（只更新資料）`);
}

write('items.json', { cols: COLS, items });
// 沒有可用基準又沒變動時，不能用空的 rows 蓋掉上一次已發佈的帳本（2026-10-09 雲端備援空帳事故）
let changesStale = false, publishedChanges = changes.length;
let oldChg = null;
try { oldChg = JSON.parse(readFileSync(join(WEB, 'changes.json'), 'utf8')); } catch {}
if (changes.length === 0 && !hasBaseline && oldChg) {
  changesStale = true;
  publishedChanges = oldChg.rows?.length ?? 0;
  log(`⚠️ 沒有可用基準（${source}${runId ? '' : '，無 run_id'}）→ 保留上一次的 changes.json（${publishedChanges} 筆），不覆蓋成空帳。`);
} else {
  write('changes.json', { generatedAt: utcNow(), days: CHG_DAYS, rows: changes });
}
const meta = { generatedAt: utcNow(), source, runId, scope, count: items.length, changes: publishedChanges };
if (changesStale) meta.changesStale = true;   // 誠實標記：這一輪的 changes 是沿用上一次的帳本，不是本次算出來的
write('meta.json', meta);
if (!DRY) {
  const bytes = readFileSync(join(WEB, 'items.json')).length;
  log(`items.json ${(bytes / 1048576).toFixed(1)} MB（未壓縮；GitHub Pages 會自動 gzip）`);
}

// ── 4. 發佈（分支永遠一個 commit）──
if (DRY) { log('--dry-run：不 commit、不推。'); process.exit(0); }
git(['config', 'user.name', 'cex-desk-bot']);
git(['config', 'user.email', 'noreply@users.noreply.github.com']);
git(['add', '-A']);
let same = false;
try { git(['diff', '--cached', '--quiet']); same = true; } catch {}
if (same) { log('內容沒有變化，不推。'); process.exit(0); }
git(['commit', '--amend', '-m', `data: 最新資料 ${utcNow()}（${items.length} 筆）`]);
log('已 amend 成單一 commit。');
if (!PUSH) { log('--no-push：不推。'); process.exit(0); }
try {
  git(['push', '--force', 'origin', `HEAD:${BRANCH}`], { env: gitEnv(), stdio: 'pipe', timeout: 60000 });
  log('✅ 已推上 GitHub Pages 的資料分支。');
} catch (e) {
  console.error(`❌ 推送失敗：${String(e.stderr || e.stdout || e.message).slice(0, 400)}`);
  process.exit(1);
}

// ── 收工自我檢查：資料分支真的換成這一版了嗎？（2026-10-01 補）──
// 用 git ls-remote 比對 commit SHA——問 git 本身，零快取、零延遲。
// （教訓：抓 raw 檔驗會被 CDN 快取騙；而「線上頁面 run」在 publish.mjs 那步還沒更新，不能在那裡比。）
{
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let ok = false, detail = '';
  for (let i = 1; i <= 3; i++) {
    const head = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    let remote = '';
    try { remote = (git(['ls-remote', 'origin', `refs/heads/${BRANCH}`], { env: gitEnv(), timeout: 30000 }).trim().split(/\s+/)[0] || ''); } catch { remote = ''; }
    ok = !!remote && remote === head;
    detail = `線上 ${BRANCH}=${remote.slice(0, 10) || '讀不到'}｜本機 HEAD=${head.slice(0, 10)}`;
    if (ok) break;
    if (i < 3) { log(`自我檢查第 ${i} 次不一致（${detail}）→ 10 秒後重試`); await sleep(10000); }
  }
  if (ok) log(`✅ 收工自我檢查：資料分支已更新（${items.length} 筆）。`);
  else {
    log(`⚠️ 收工自我檢查沒過：${detail}`);
    reportSend(log, await sendTelegram([
      '⚠️ CeX 手機頁資料自我檢查沒過', '', detail, '',
      '代表：資料分支沒有換成這一版。',
      '下一步：下一輪會再推一次；若持續沒好請告知。',
    ].join('\n')));
  }
}
