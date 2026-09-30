// CeX åˆ¤æ–·å°ï¼šç”¢ç”Ÿã€Œæ‰‹æ©Ÿé ã€è¦ç”¨çš„è³‡æ–™ï¼Œä¸¦ç™¼ä½ˆåˆ° GitHub Pages çš„ data åˆ†æ”¯
//
//   node publish-web.mjs                        PC ç”¨ï¼šå¾žæœ¬æ©Ÿè³‡æ–™åº«å–ã€Œæœ€æ–°ç‹€æ…‹ï¼‹è®Šå‹•å¸³ã€
//   node publish-web.mjs --from-compact <æª”>     é›²ç«¯å‚™æ´ç”¨ï¼šå¾žæŠ“ä¸‹ä¾†çš„ç²¾ç°¡ç‹€æ…‹å–è³‡æ–™
//   node publish-web.mjs --dry-run              åªç”¢ç”Ÿæª”æ¡ˆã€ä¸ commitï¼ä¸æŽ¨
//   node publish-web.mjs --web <ç›®éŒ„>            data åˆ†æ”¯çš„å·¥ä½œç›®éŒ„ï¼ˆé è¨­ D:\AI\cex-webï¼‰
//
// ç‚ºä»€éº¼æ˜¯ã€Œåˆ†æ”¯ï¼‹amendã€è€Œä¸æ˜¯æ¯å¤©ä¸€å€‹ commitï¼š
//   items.json ç´„ 5 MBï¼Œä¸€å¤©æŽ¨å…©æ¬¡ï¼ä¸€å¹´ 3.6 GB çš„ git æ­·å²ã€‚é€™å€‹åˆ†æ”¯æ°¸é åªæœ‰**ä¸€å€‹ commit**
//   ï¼ˆæ¯æ¬¡ --amend å¾Œ force pushï¼‰ï¼Œé ç«¯ä¸æœƒé•·å¤§ï¼›èˆŠè³‡æ–™æ²’æœ‰ä¿ç•™åƒ¹å€¼ï¼Œæœ¬æ©Ÿçš„è³‡æ–™åº«æ‰æ˜¯å²æ–™ã€‚
//
// data åˆ†æ”¯å…§å®¹ï¼šindex.htmlï¼ˆè¡Œå‹•ç‰ˆé é¢ï¼‰ï¼‹ items.jsonï¼ˆæœ€æ–°ç‹€æ…‹ï¼‰ï¼‹ changes.jsonï¼ˆè®Šå‹•å¸³ï¼‰ï¼‹ meta.json
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const git = (args, opts = {}) => execFileSync('git', ['-C', WEB, ...args], { encoding: 'utf8', ...opts });
const gitEnv = () => {
  const env = { ...process.env };
  const token = process.env.GITHUB_TOKEN;
  if (token) {   // æŽˆæ¬Šèµ°ç’°å¢ƒè®Šæ•¸ï¼Œä¸å¯«é€² remote URLã€ä¸é€²å‘½ä»¤åˆ—
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
  }
  return env;
};

// â”€â”€ 1. å–å¾—è³‡æ–™ â”€â”€
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
log(`è³‡æ–™ï¼š${items.length} ç­†ï¼ˆä¾†æº ${source}${runId ? `ï¼Œrun ${runId}` : ''}ï¼‰${changes.length ? `ï½œè®Šå‹• ${changes.length} ç­†` : ''}`);

// â”€â”€ 2. æº–å‚™ç™¼ä½ˆç›®éŒ„ï¼ˆè¦å…ˆæœ‰ repo æ‰èƒ½å¯«æª”ï¼šgit clone ä¸æŽ¥å—éžç©ºç›®éŒ„ï¼‰â”€â”€
function ensureRepo() {
  if (DRY) return;
  if (existsSync(join(WEB, '.git'))) {
    try { git(['fetch', 'origin', BRANCH], { env: gitEnv() }); git(['reset', '--hard', `origin/${BRANCH}`]); }
    catch (e) { log(`âš ï¸ åŒæ­¥é ç«¯å¤±æ•—ï¼ˆçºŒç”¨æœ¬åœ°ï¼‰ï¼š${String(e.message).slice(0, 160)}`); }
    return;
  }
  if (existsSync(WEB)) {   // åªæœ‰ã€Œä¸æ˜¯ git repo çš„æš«å­˜ç›®éŒ„ã€æ‰æœƒè¢«æ¸…æŽ‰ï¼ˆä¿è­·çœŸæ­£çš„ repoï¼‰
    log(`âš ï¸ ${WEB} å­˜åœ¨ä½†æ²’æœ‰ .git â†’ è¦–ç‚ºæš«å­˜ç›®éŒ„ï¼Œæ¸…æŽ‰é‡å»º`);
    rmSync(WEB, { recursive: true, force: true });
  }
  log(`ç¬¬ä¸€æ¬¡ï¼šclone ${BRANCH} åˆ†æ”¯ â†’ ${WEB}`);
  execFileSync('git', ['clone', '--branch', BRANCH, '--single-branch', REPO_URL, WEB], { stdio: 'inherit' });
}
ensureRepo();

// â”€â”€ 3. å¯«æª” â”€â”€
if (!DRY) mkdirSync(WEB, { recursive: true });
const write = (name, obj) => {
  if (DRY) return;
  writeFileSync(join(WEB, name), JSON.stringify(obj) + '\n');
};
if (!DRY && existsSync(HTML)) copyFileSync(HTML, join(WEB, 'index.html'));
else if (!existsSync(HTML)) log(`âš ï¸ æ‰¾ä¸åˆ°é é¢ ${HTML}ï¼ˆåªæ›´æ–°è³‡æ–™ï¼‰`);

write('items.json', { cols: COLS, items });
write('changes.json', { generatedAt: utcNow(), days: CHG_DAYS, rows: changes });
write('meta.json', { generatedAt: utcNow(), source, runId, scope, count: items.length, changes: changes.length });
if (!DRY) {
  const bytes = readFileSync(join(WEB, 'items.json')).length;
  log(`items.json ${(bytes / 1048576).toFixed(1)} MBï¼ˆæœªå£“ç¸®ï¼›GitHub Pages æœƒè‡ªå‹• gzipï¼‰`);
}

// â”€â”€ 4. ç™¼ä½ˆï¼ˆåˆ†æ”¯æ°¸é ä¸€å€‹ commitï¼‰â”€â”€
if (DRY) { log('--dry-runï¼šä¸ commitã€ä¸æŽ¨ã€‚'); process.exit(0); }
git(['config', 'user.name', 'cex-desk-bot']);
git(['config', 'user.email', 'noreply@users.noreply.github.com']);
git(['add', '-A']);
let same = false;
try { git(['diff', '--cached', '--quiet']); same = true; } catch {}
if (same) { log('å…§å®¹æ²’æœ‰è®ŠåŒ–ï¼Œä¸æŽ¨ã€‚'); process.exit(0); }
git(['commit', '--amend', '-m', `data: æœ€æ–°è³‡æ–™ ${utcNow()}ï¼ˆ${items.length} ç­†ï¼‰`]);
log('å·² amend æˆå–®ä¸€ commitã€‚');
if (!PUSH) { log('--no-pushï¼šä¸æŽ¨ã€‚'); process.exit(0); }
try {
  git(['push', '--force', 'origin', `HEAD:${BRANCH}`], { env: gitEnv(), stdio: 'pipe' });
  log('âœ… å·²æŽ¨ä¸Š GitHub Pages çš„è³‡æ–™åˆ†æ”¯ã€‚');
} catch (e) {
  console.error(`âŒ æŽ¨é€å¤±æ•—ï¼š${String(e.stderr || e.stdout || e.message).slice(0, 400)}`);
  process.exit(1);
}
