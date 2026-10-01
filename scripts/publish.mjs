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
import { sendTelegram, reportSend } from './notify.mjs';

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
  // ⚠️ 兩邊的換行都可能被 core.autocrlf=true 改成 CRLF → 比對前**兩邊都**正規化，
  //    否則每次都會誤判成「有更新」而反覆重寫（實測：不這樣做會一直報「N 支有更新」）
  const body = sanitize(readFileSync(src, 'utf8'));
  const norm = s => s.replace(/\r\n/g, '\n');
  const same = existsSync(dst) && norm(readFileSync(dst, 'utf8')) === norm(body);
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
  // ⚠️ 2026-10-01：沒有憑證時 git 會**卡在等認證**（今天 08:30 的排程就是這樣掛到被排程殺掉，
  //    一掛就是好幾個小時、還留著一堆殘留程序）。一律禁止互動＋逾時：
  //    寧可 60 秒內失敗（會觸發告警、下一輪自動補發），也不要無聲地卡住。
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
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
try { git(['pull', '--rebase', '--autostash', 'origin', 'main'], { env: gitEnv(), stdio: 'pipe', timeout: 60000 }); }
catch (e) { log(`⚠️ pull --rebase 有狀況（繼續試著推）：${String(e.stdout || e.message).slice(0, 300)}`); }
try {
  git(['push', 'origin', 'HEAD:main'], { env: gitEnv(), stdio: 'pipe', timeout: 60000 });
  log('✅ 已推上 GitHub。');
} catch (e) {
  console.error(`❌ 推送失敗：${String(e.stderr || e.stdout || e.message).slice(0, 500)}`);
  process.exit(1);
}

// ── 4. 收工自我檢查：線上真的收到本機這一版嗎？（2026-10-01 補）──
// 那天「本機 commit 了、沒 push」，整條線靜靜飄了 5 小時沒人知道。
// 這裡推完之後**回頭讀線上的成品**（驗結果，不是驗有沒有跑完），不一致就發 Telegram 叫人。
// ⚠️ raw.githubusercontent 有快取 → 帶 query 破快取，並重試 3 次才判定（避免誤報）。
const RAW = 'https://raw.githubusercontent.com/diecastnote0079-gif/cex-desk';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readOnline(path) {
  try {
    const r = await fetch(`${RAW}/${path}?t=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
let verify = { ok: false, detail: '' };
for (let i = 1; i <= 3; i++) {
  const hbOnline = await readOnline('main/state/heartbeat.json');
  const meta = await readOnline('data/meta.json');
  verify = {
    ok: hbOnline?.runId === heartbeat.runId && meta?.runId === heartbeat.runId,
    detail: `線上心跳 run=${hbOnline?.runId ?? '讀不到'}｜線上頁面 run=${meta?.runId ?? '讀不到'}｜本機 run=${heartbeat.runId}`,
  };
  if (verify.ok) break;
  if (i < 3) { log(`自我檢查第 ${i} 次不一致（${verify.detail}）→ 15 秒後重試`); await sleep(15000); }
}
if (verify.ok) log(`✅ 收工自我檢查：線上與本機一致（run=${heartbeat.runId}）。`);
else {
  log(`⚠️ 收工自我檢查沒過：${verify.detail}`);
  reportSend(log, await sendTelegram([
    '⚠️ CeX 發布自我檢查沒過',
    '',
    `本機剛推上去的是 run=${heartbeat.runId}（${heartbeat.items} 筆）`,
    verify.detail,
    '',
    '代表：本機說推了，但線上讀到的還是舊的。',
    '下一步：下一輪開跑時會自動補推；若持續沒好請告知。',
  ].join('\n')));
}
