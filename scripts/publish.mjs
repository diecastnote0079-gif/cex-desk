// CeX 判斷台：把本機狀態與腳本發佈到 cex-desk repo（PC 端用）
//
//   node publish.mjs                 正常跑（同步腳本 → 寫心跳 → commit → push）
//   node publish.mjs --no-push       只在本機 commit，不推
//   node publish.mjs --dry-run       只印要做什麼，不動任何檔案
//   node publish.mjs --repo <目錄>     repo 工作目錄（預設 D:\AI\cex-desk）
//
// 為什麼要這支：雲端備援（GitHub Actions）要兩樣東西才動得起來——
//   ① 一份「本機還活著嗎」的心跳（沒有它雲端不知道該不該接手）
//   ② 抓取腳本（雲端跑的是同一份，不是另寫一套）
// 平常只有心跳那幾百 bytes 在動，所以 repo 不會因為每天兩次而膨脹。
//
// ⚠️ token 一律走環境變數 GITHUB_TOKEN，用 GIT_CONFIG_* 注入 http header，
//    不寫進 remote URL、不寫進 .git/config、不出現在命令列參數（會漏進日誌與工具輸出）。
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, recentRuns, utcNow } from './cex-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = n => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const REPO = argOf('repo', 'D:\\AI\\cex-desk');
const DRY = has('dry-run');
const PUSH = !has('no-push');
const log = m => console.log(`[${utcNow()}] ${m}`);
const git = (args, opts = {}) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', ...opts });

if (!existsSync(join(REPO, '.git'))) {
  console.error(`❌ ${REPO} 不是 git repo。先 clone：\n   git clone https://github.com/diecastnote0079-gif/cex-desk.git "${REPO}"`);
  process.exit(2);
}

// ── 1. 同步腳本（單一來源＝這個目錄；repo 裡那份不要手改）──
// ⚠️ 這些腳本會進**公開** repo：同步時把個人化的字樣中性化（記憶目錄裡那份保持原樣，
//    所以這裡不可以用 copyFileSync——要用「讀→消毒→寫」）。
const SANITIZE = [[/使用者/g, '使用者'], [/維護者/g, '維護者']];
const sanitize = s => SANITIZE.reduce((t, [re, to]) => t.replace(re, to), s);

const files = readdirSync(HERE).filter(f => f.endsWith('.mjs'));
const target = join(REPO, 'scripts');
if (!DRY) mkdirSync(target, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = join(HERE, f), dst = join(target, f);
  const body = sanitize(readFileSync(src, 'utf8'));
  const same = existsSync(dst) && readFileSync(dst, 'utf8') === body;
  if (same) continue;
  if (!DRY) writeFileSync(dst, body, 'utf8');
  copied++;
}
log(`腳本同步：${copied} 支有更新（共 ${files.length} 支；已消毒個人字樣）`);

// ── 2. 寫心跳（雲端備援唯一的判斷依據）──
const db = openDb();
const [last] = recentRuns(db, 'web', 1);
if (!last) { console.error('❌ 資料庫裡沒有 web 範圍的 run，無法寫心跳（先跑 node cex.mjs daily）'); process.exit(3); }
const heartbeat = {
  source: 'pc',
  lastGoodRun: new Date(last.started_at).toISOString().replace(/\.\d+Z$/, 'Z'),
  scope: 'web', runId: last.run_id, items: last.items,
  writtenAt: utcNow(), note: '本機 PC 每天 08:30／20:00 寫入',
};
if (!DRY) {
  mkdirSync(join(REPO, 'state'), { recursive: true });
  writeFileSync(join(REPO, 'state', 'heartbeat.json'), JSON.stringify(heartbeat, null, 1) + '\n');
}
log(`心跳：${heartbeat.lastGoodRun}（${heartbeat.items} 筆，run ${heartbeat.runId}）`);

if (DRY) { log('--dry-run：不 commit。'); process.exit(0); }

// ── 3. commit + push（推之前先 rebase，因為雲端備援也會推同一個 repo）──
const gitEnv = () => {
  const env = { ...process.env };
  const token = process.env.GITHUB_TOKEN;
  if (token) {   // 用 GIT_CONFIG_* 注入授權，不落檔、不進命令列
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
  }
  return env;
};
git(['add', '-A', '.'], { env: gitEnv() });   // 整個 repo（含 README、workflow、scripts、state）
let changed = false;
try { git(['diff', '--cached', '--quiet']); } catch { changed = true; }
if (!changed) { log('沒有變化，不用 commit。'); process.exit(0); }

git(['config', 'user.name', 'cex-desk-bot']);
git(['config', 'user.email', 'noreply@users.noreply.github.com']);
git(['commit', '-m', `pc: 心跳 ${heartbeat.lastGoodRun}（${heartbeat.items} 筆）`]);
log('已 commit。');

if (!PUSH) { log('--no-push：不推。'); process.exit(0); }
try { git(['pull', '--rebase', '--autostash', 'origin', 'main'], { env: gitEnv(), stdio: 'pipe' }); }
catch (e) { log(`⚠️ pull --rebase 有狀況（繼續試著推）：${String(e.stdout || e.message).slice(0, 300)}`); }
try {
  git(['push', 'origin', 'HEAD:main'], { env: gitEnv(), stdio: 'pipe' });
  log('✅ 已推上 GitHub。');
} catch (e) {
  console.error(`❌ 推送失敗：${String(e.stderr || e.stdout || e.message).slice(0, 500)}`);
  process.exit(1);
}
