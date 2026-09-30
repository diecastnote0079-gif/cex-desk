// CeX åˆ¤æ–·å°ï¼šæŠŠæœ¬æ©Ÿç‹€æ…‹èˆ‡è…³æœ¬ç™¼ä½ˆåˆ° cex-desk repoï¼ˆPC ç«¯ç”¨ï¼‰
//
//   node publish.mjs                 æ­£å¸¸è·‘ï¼ˆåŒæ­¥è…³æœ¬ â†’ å¯«å¿ƒè·³ â†’ commit â†’ pushï¼‰
//   node publish.mjs --no-push       åªåœ¨æœ¬æ©Ÿ commitï¼Œä¸æŽ¨
//   node publish.mjs --dry-run       åªå°è¦åšä»€éº¼ï¼Œä¸å‹•ä»»ä½•æª”æ¡ˆ
//   node publish.mjs --repo <ç›®éŒ„>     repo å·¥ä½œç›®éŒ„ï¼ˆé è¨­ D:\AI\cex-deskï¼‰
//
// ç‚ºä»€éº¼è¦é€™æ”¯ï¼šé›²ç«¯å‚™æ´ï¼ˆGitHub Actionsï¼‰è¦å…©æ¨£æ±è¥¿æ‰å‹•å¾—èµ·ä¾†â€”â€”
//   â‘  ä¸€ä»½ã€Œæœ¬æ©Ÿé‚„æ´»è‘—å—Žã€çš„å¿ƒè·³ï¼ˆæ²’æœ‰å®ƒé›²ç«¯ä¸çŸ¥é“è©²ä¸è©²æŽ¥æ‰‹ï¼‰
//   â‘¡ æŠ“å–è…³æœ¬ï¼ˆé›²ç«¯è·‘çš„æ˜¯åŒä¸€ä»½ï¼Œä¸æ˜¯å¦å¯«ä¸€å¥—ï¼‰
// å¹³å¸¸åªæœ‰å¿ƒè·³é‚£å¹¾ç™¾ bytes åœ¨å‹•ï¼Œæ‰€ä»¥ repo ä¸æœƒå› ç‚ºæ¯å¤©å…©æ¬¡è€Œè†¨è„¹ã€‚
//
// âš ï¸ token ä¸€å¾‹èµ°ç’°å¢ƒè®Šæ•¸ GITHUB_TOKENï¼Œç”¨ GIT_CONFIG_* æ³¨å…¥ http headerï¼Œ
//    ä¸å¯«é€² remote URLã€ä¸å¯«é€² .git/configã€ä¸å‡ºç¾åœ¨å‘½ä»¤åˆ—åƒæ•¸ï¼ˆæœƒæ¼é€²æ—¥èªŒèˆ‡å·¥å…·è¼¸å‡ºï¼‰ã€‚
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
  console.error(`âŒ ${REPO} ä¸æ˜¯ git repoã€‚å…ˆ cloneï¼š\n   git clone https://github.com/diecastnote0079-gif/cex-desk.git "${REPO}"`);
  process.exit(2);
}

// â”€â”€ 1. åŒæ­¥è…³æœ¬ï¼ˆå–®ä¸€ä¾†æºï¼é€™å€‹ç›®éŒ„ï¼›repo è£¡é‚£ä»½ä¸è¦æ‰‹æ”¹ï¼‰â”€â”€
const files = readdirSync(HERE).filter(f => f.endsWith('.mjs'));
const target = join(REPO, 'scripts');
if (!DRY) mkdirSync(target, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = join(HERE, f), dst = join(target, f);
  const same = existsSync(dst) && statSync(dst).size === statSync(src).size
    && Buffer.compare(readFileSync(src), readFileSync(dst)) === 0;
  if (same) continue;
  if (!DRY) copyFileSync(src, dst);
  copied++;
}
log(`è…³æœ¬åŒæ­¥ï¼š${copied} æ”¯æœ‰æ›´æ–°ï¼ˆå…± ${files.length} æ”¯ï¼‰`);

// â”€â”€ 2. å¯«å¿ƒè·³ï¼ˆé›²ç«¯å‚™æ´å”¯ä¸€çš„åˆ¤æ–·ä¾æ“šï¼‰â”€â”€
const db = openDb();
const [last] = recentRuns(db, 'web', 1);
if (!last) { console.error('âŒ è³‡æ–™åº«è£¡æ²’æœ‰ web ç¯„åœçš„ runï¼Œç„¡æ³•å¯«å¿ƒè·³ï¼ˆå…ˆè·‘ node cex.mjs dailyï¼‰'); process.exit(3); }
const heartbeat = {
  source: 'pc',
  lastGoodRun: new Date(last.started_at).toISOString().replace(/\.\d+Z$/, 'Z'),
  scope: 'web', runId: last.run_id, items: last.items,
  writtenAt: utcNow(), note: 'æœ¬æ©Ÿ PC æ¯å¤© 08:30ï¼20:00 å¯«å…¥',
};
if (!DRY) {
  mkdirSync(join(REPO, 'state'), { recursive: true });
  writeFileSync(join(REPO, 'state', 'heartbeat.json'), JSON.stringify(heartbeat, null, 1) + '\n');
}
log(`å¿ƒè·³ï¼š${heartbeat.lastGoodRun}ï¼ˆ${heartbeat.items} ç­†ï¼Œrun ${heartbeat.runId}ï¼‰`);

if (DRY) { log('--dry-runï¼šä¸ commitã€‚'); process.exit(0); }

// â”€â”€ 3. commit + pushï¼ˆæŽ¨ä¹‹å‰å…ˆ rebaseï¼Œå› ç‚ºé›²ç«¯å‚™æ´ä¹ŸæœƒæŽ¨åŒä¸€å€‹ repoï¼‰â”€â”€
const gitEnv = () => {
  const env = { ...process.env };
  const token = process.env.GITHUB_TOKEN;
  if (token) {   // ç”¨ GIT_CONFIG_* æ³¨å…¥æŽˆæ¬Šï¼Œä¸è½æª”ã€ä¸é€²å‘½ä»¤åˆ—
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
  }
  return env;
};
git(['add', '-A', '.'], { env: gitEnv() });   // æ•´å€‹ repoï¼ˆå« READMEã€workflowã€scriptsã€stateï¼‰
let changed = false;
try { git(['diff', '--cached', '--quiet']); } catch { changed = true; }
if (!changed) { log('æ²’æœ‰è®ŠåŒ–ï¼Œä¸ç”¨ commitã€‚'); process.exit(0); }

git(['config', 'user.name', 'cex-desk-bot']);
git(['config', 'user.email', 'noreply@users.noreply.github.com']);
git(['commit', '-m', `pc: å¿ƒè·³ ${heartbeat.lastGoodRun}ï¼ˆ${heartbeat.items} ç­†ï¼‰`]);
log('å·² commitã€‚');

if (!PUSH) { log('--no-pushï¼šä¸æŽ¨ã€‚'); process.exit(0); }
try { git(['pull', '--rebase', '--autostash', 'origin', 'main'], { env: gitEnv(), stdio: 'pipe' }); }
catch (e) { log(`âš ï¸ pull --rebase æœ‰ç‹€æ³ï¼ˆç¹¼çºŒè©¦è‘—æŽ¨ï¼‰ï¼š${String(e.stdout || e.message).slice(0, 300)}`); }
try {
  git(['push', 'origin', 'HEAD:main'], { env: gitEnv(), stdio: 'pipe' });
  log('âœ… å·²æŽ¨ä¸Š GitHubã€‚');
} catch (e) {
  console.error(`âŒ æŽ¨é€å¤±æ•—ï¼š${String(e.stderr || e.stdout || e.message).slice(0, 500)}`);
  process.exit(1);
}
