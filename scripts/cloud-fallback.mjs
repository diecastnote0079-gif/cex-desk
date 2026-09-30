// CeX é›²ç«¯å‚™æ´ï¼ˆGitHub Actions ç”¨ï¼‰
//
// è§’è‰²ï¼šæœ¬æ©Ÿ PC æ˜¯ä¸»åŠ›ï¼ˆæ¯å¤© 08:30ï¼20:00 æŠ“ â†’ å°å¸³ â†’ å¥åº·æª¢æŸ¥ï¼‰ã€‚é€™æ”¯åªåœ¨**æœ¬æ©Ÿè¶…éŽ 24 å°æ™‚
// æ²’æœ‰æˆåŠŸæŠ“å–**æ™‚æ‰å‹•ï¼šè‡ªå·±æŠ“ä¸€æ¬¡å…¨ç«™ â†’ è·Ÿä¸Šä¸€æ¬¡é›²ç«¯å­˜ä¸‹ä¾†çš„ç‹€æ…‹æ¯”å° â†’ ç™¼ Telegram â†’ æ›´æ–°ç‹€æ…‹ã€‚
// æœ¬æ©Ÿæ­£å¸¸æ™‚å®ƒä»€éº¼éƒ½ä¸åšï¼ˆé€£æŠ“éƒ½ä¸æŠ“ï¼‰ï¼Œæ‰€ä»¥å¹³æ™‚ä¸æ¶ˆè€—ä»»ä½•è³‡æºã€‚
//
// ç”¨æ³•ï¼š
//   node cloud-fallback.mjs                æ­£å¸¸è·‘ï¼ˆæœƒå…ˆçœ‹å¿ƒè·³ï¼‰
//   node cloud-fallback.mjs --force        å¿½ç•¥å¿ƒè·³ï¼Œå¼·åˆ¶æŠ“ä¸€æ¬¡ï¼ˆé©—æ”¶ï¼è£œè³‡æ–™ç”¨ï¼‰
//   node cloud-fallback.mjs --dry-run      ä¸é€ Telegramã€ä¸å¯«ç‹€æ…‹æª”ï¼Œåªå°å‡ºä¾†æª¢æŸ¥
//   node cloud-fallback.mjs --repo <ç›®éŒ„>   repo å·¥ä½œç›®éŒ„ï¼ˆé è¨­ï¼é€™æ”¯è…³æœ¬çš„ä¸Šä¸€å±¤ï¼‰
//   node cloud-fallback.mjs --limit 3      åªè·‘å‰ 3 å€‹åˆ‡åˆ†ï¼ˆå°æ¨£æœ¬æ¸¬è©¦ï¼›è³‡æ–™é‡ä¸å®Œæ•´ï¼‰
//
// éœ€è¦çš„ç’°å¢ƒè®Šæ•¸ï¼šTELEGRAM_BOT_TOKENï¼ˆæ²’æœ‰å°±åªå°ä¸é€ï¼‰ã€TELEGRAM_CHAT_IDï¼ˆé è¨­é˜¿å¤œçš„ chatï¼‰
//
// è¨­è¨ˆç†ç”±èˆ‡å–æ¨è¦‹ references/interface-hosting-design.md Â§ä¸ƒä¹‹å››ã€handoff Â§0bã€‚
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const has = n => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const REPO = argOf('repo', join(HERE, '..'));
const STATE = join(REPO, 'state');
const FORCE = has('force');
const DRY = has('dry-run');
const LIMIT = Number(argOf('limit', 0));
const HEARTBEAT = join(STATE, 'heartbeat.json');   // æœ¬æ©Ÿ PC çš„å¿ƒè·³ï¼ˆé›²ç«¯åªè®€ã€ä¸æ”¹å¯«ï¼‰
const BASELINE = join(STATE, 'baseline.tsv.gz');
const CLOUD = join(STATE, 'cloud.json');           // é›²ç«¯è‡ªå·±çš„ç´€éŒ„ï¼ˆå«ä¸Šæ¬¡ç™¼è¨Šæ™‚é–“ï¼‰
const FRESH_HOURS = Number(process.env.CEX_FRESH_HOURS || 24);
const STALE_BASE_HOURS = Number(process.env.CEX_STALE_BASE_HOURS || 48);
// é€™æ”¯æœƒé€²å…¬é–‹ repoï¼Œæ‰€ä»¥æ”¶è¨Šå°è±¡ä¸å¯«æ­»åœ¨é€™è£¡ï¼ˆèµ° secretsï¼›è¦‹ workflowï¼‰
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const utcNow = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const mytNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().replace('Z', '+08:00');
// firstStockDate æ˜¯ MYT æ™‚é–“ï¼Œå­—ä¸²æ ¼å¼æœªå¿…å¸¶æ™‚å€ â†’ çµ±ä¸€æ­£è¦åŒ–æˆ YYYY-MM-DDTHH:MM:SS å†æ¯”å¤§å°
const normTs = s => String(s || '').replace(' ', 'T').slice(0, 19);
const cutoff24h = () => normTs(new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString());
const hours = ms => +(ms / 3600e3).toFixed(1);
const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const log = m => console.log(`[${utcNow()}] ${m}`);

// â”€â”€ ç²¾ç°¡ç‹€æ…‹æª”çš„è®€å–ï¼ˆæ ¼å¼ç”± mirror.mjs --compact ç”¢ç”Ÿï¼‰â”€â”€
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

// â”€â”€ 1. å¿ƒè·³ï¼šæœ¬æ©Ÿé‚„åœ¨è·‘å°±ä¸è¦å‹• â”€â”€
const hb = readJson(HEARTBEAT);
const lastGoodMs = hb?.lastGoodRun ? Date.parse(hb.lastGoodRun) : null;
const pcAgeH = lastGoodMs ? hours(Date.now() - lastGoodMs) : null;
log(hb ? `å¿ƒè·³ï¼š${hb.source}ï¼${hb.lastGoodRun}ï¼ˆ${pcAgeH} å°æ™‚å‰ï¼Œ${hb.items ?? '?'} ç­†ï¼‰` : 'æ²’æœ‰å¿ƒè·³æª”ï¼ˆè¦–ç‚ºæœ¬æ©Ÿå¾žæœªæˆåŠŸæŠ“å–ï¼‰');

if (!FORCE && pcAgeH !== null && pcAgeH < FRESH_HOURS) {
  log(`æœ¬æ©Ÿè³‡æ–™é‚„åœ¨ ${FRESH_HOURS} å°æ™‚å…§ â†’ é›²ç«¯å‚™æ´ä¸åšä»»ä½•äº‹ï¼ˆä¸æŠ“å–ã€ä¸ç™¼è¨Šï¼‰ã€‚`);
  console.log('FALLBACK_SUMMARY ' + JSON.stringify({ action: 'skip', reason: 'fresh', pcAgeHours: pcAgeH }));
  process.exit(0);
}
log(FORCE ? 'ï¼ˆ--forceï¼šå¿½ç•¥å¿ƒè·³ï¼Œå¼·åˆ¶åŸ·è¡Œï¼‰' : `æœ¬æ©Ÿå·² ${pcAgeH} å°æ™‚æ²’æ›´æ–° â†’ å‚™æ´æŽ¥æ‰‹ã€‚`);

// â”€â”€ 2. è‡ªå·±æŠ“ä¸€æ¬¡å…¨ç«™ï¼ˆç”¨åŒä¸€æ”¯ mirrorï¼Œé¿å…å…©å¥—æŠ“å–é‚è¼¯ï¼‰â”€â”€
const tmpDir = process.env.CEX_HOME || join(REPO, '.tmp');
mkdirSync(tmpDir, { recursive: true });
const currentFile = join(tmpDir, 'current.tsv.gz');
const runId = mytNow().replace(/[-:T]/g, '').slice(0, 14);
const t0 = Date.now();
log(`é–‹å§‹æŠ“å–ï¼ˆscope=webï¼Œrun_id=${runId}ï¼‰â€¦`);
execFileSync(process.execPath, [
  join(HERE, 'mirror.mjs'), '--scope', 'web', '--compact', currentFile,
  ...(LIMIT ? ['--limit', String(LIMIT)] : []),
], { stdio: 'inherit', env: { ...process.env, CEX_RUN_ID: runId } });
const fetchSec = ((Date.now() - t0) / 1000).toFixed(0);
log(`æŠ“å–å®Œæˆï¼Œè€—æ™‚ ${fetchSec} ç§’`);

// â”€â”€ 3. è·Ÿé›²ç«¯å­˜ä¸‹ä¾†çš„ä¸Šæ¬¡ç‹€æ…‹æ¯”å° â”€â”€
const cur = readState(currentFile);
const prev = existsSync(BASELINE) ? readState(BASELINE) : null;
const prevMeta = readJson(CLOUD);
const baseAgeH = prevMeta?.at ? hours(Date.now() - Date.parse(prevMeta.at)) : null;
const rebuilt = !prev || baseAgeH === null || baseAgeH > STALE_BASE_HOURS;   // åŸºæº–å¤ªèˆŠ â†’ åªå ±è¿‘ 24hï¼Œé¿å…æ´—ç‰ˆ

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

// åŸºæº–å£žæŽ‰æ™‚åªä¿¡ä»»ã€Œè¿‘æœŸæ–°ä¸Šæž¶ã€ï¼›åŸºæº–æ­£å¸¸æ™‚ä¿¡ä»»å®Œæ•´è®Šå‹•å¸³
const listed = rebuilt ? arrivals : isNew;
log(`æ¯”å°ï¼šæœ¬æ¬¡ ${cur.map.size} ç­†ï½œæ–°ä¸Šæž¶ ${isNew.length}ï½œè³£å…‰/æ¶ˆå¤± ${gone.length}ï½œæ”¹åƒ¹ ${priceChanged.length}ï½œåº«å­˜è®Šå‹• ${qtyChanged.length}`
  + (rebuilt ? `ï½œåŸºæº–${prev ? `å·² ${baseAgeH} å°æ™‚` : 'ä¸å­˜åœ¨'} â†’ åªåˆ—è¿‘ 24 å°æ™‚æ–°ä¸Šæž¶ ${arrivals.length} ç­†` : ''));

// ç™¼è¨Šè¦å‰‡ï¼šâ‘  é€™æ˜¯é›»è…¦æ–·ç·šå¾Œçš„ç¬¬ä¸€æ¬¡æŽ¥æ‰‹ â†’ ä¸€å®šè¬› â‘¡ æœ‰ RM100+ æˆ–åº«å­˜â‰¤1 çš„è²¨ â†’ ä¸€å®šè¬›
// å…¶é¤˜ï¼ˆé›»è…¦ä¸€ç›´æ²’é–‹ã€åˆæ²’å¥½è²¨ï¼‰â†’ åªæ›´æ–°ç‹€æ…‹ã€ä¸æ‰“æ“¾ä»–ï¼ˆã€Œä¸ä¸»å‹•é€šçŸ¥ã€ï¼‹ã€Œç©ºæ‰‹è€Œå›žæ˜¯å¸¸æ…‹ã€ï¼‰
const worth = listed.filter(x => x.price >= 100 || x.qty <= 1);
const firstSincePc = !prevMeta || (lastGoodMs !== null && Date.parse(prevMeta.at) < lastGoodMs);
const notify = firstSincePc || worth.length > 0;
log(`ç™¼è¨Šåˆ¤æ–·ï¼š${notify ? 'è¦ç™¼' : 'ä¸ç™¼'}ï¼ˆ${firstSincePc ? 'é›»è…¦æ–·ç·šå¾Œç¬¬ä¸€æ¬¡' : `å¥½è²¨ ${worth.length} ç­†`}ï¼‰`);

// â”€â”€ 4. çµ„ Telegram è¨Šæ¯ â”€â”€
const fmt = x => `ãƒ»${x.name || '(ç„¡å)'}ï¼ˆ${x.cat || '?'}ï¼‰RM${x.price}`
  + (x.qty <= 1 ? 'ï½œåº«å­˜â‰¤1' : `ï½œåº«å­˜ ${x.qty}`) + (x.cash ? `ï½œè²·å– RM${x.cash}` : '');
const lines = [];
lines.push(`ðŸ›° CeX é›²ç«¯å‚™æ´æŽ¥æ‰‹${FORCE ? 'ï¼ˆæ‰‹å‹•å¼·åˆ¶ï¼‰' : ''}`);
lines.push(pcAgeH === null ? 'é›»è…¦å¾žæœªå›žå ±æˆåŠŸæŠ“å–' : `é›»è…¦æœ€å¾ŒæˆåŠŸæŠ“å–ï¼š${pcAgeH} å°æ™‚å‰`);
lines.push(`é›²ç«¯æŠ“å–ï¼š${cur.map.size} ç­†ï¼${fetchSec} ç§’`);
lines.push(rebuilt ? `ï¼ˆé›²ç«¯åŸºæº–${prev ? 'å·²é€¾ 48 å°æ™‚' : 'ä¸å­˜åœ¨'} â†’ é€™è¼ªåªåˆ—è¿‘ 24 å°æ™‚æ–°ä¸Šæž¶ï¼‰`
  : `æ–°ä¸Šæž¶ ${isNew.length}ï½œè³£å…‰ ${gone.length}ï½œæ”¹åƒ¹ ${priceChanged.length}ï½œåº«å­˜è®Šå‹• ${qtyChanged.length}`);

if (worth.length) {
  lines.push('â”€â”€â”€â”€â”€', 'ðŸ†• å€¼å¾—çœ‹çš„ï¼ˆRM100+ æˆ–åº«å­˜â‰¤1ï¼‰ï¼š');
  for (const x of worth.slice(0, 12)) lines.push(fmt(x));
  if (worth.length > 12) lines.push(`â€¦å¦æœ‰ ${worth.length - 12} ç­†`);
  if (listed.length > worth.length) lines.push(`ï¼ˆå…¶é¤˜ ${listed.length - worth.length} ç­†ä¸€èˆ¬å“ç•¥ï¼‰`);
} else {
  lines.push('â”€â”€â”€â”€â”€', 'ðŸ†• æ²’æœ‰ RM100+ æˆ–åº«å­˜â‰¤1 çš„ï¼ˆç©ºæ‰‹è€Œå›žæ˜¯å¸¸æ…‹ï¼‰');
}
if (!rebuilt && priceChanged.length) {
  lines.push('â”€â”€â”€â”€â”€', `ðŸ’° æ”¹åƒ¹ ${priceChanged.length} ç­†ï¼š`);
  for (const x of priceChanged.slice(0, 8)) lines.push(`ãƒ»${x.name}ï¼ˆ${x.cat}ï¼‰RM${x.from} â†’ RM${x.to}${x.to < x.from ? 'ï¼ˆé™ï¼‰' : 'ï¼ˆå‡ï¼‰'}`);
  if (priceChanged.length > 8) lines.push(`â€¦å¦æœ‰ ${priceChanged.length - 8} ç­†`);
}
const msg = lines.join('\n').slice(0, 3800);
console.log('\n===== Telegram è¨Šæ¯é è¦½ =====\n' + msg + '\n=============================\n');

let sent = null;
if (DRY) log('--dry-runï¼šä¸é€ Telegramã€ä¸å¯«ç‹€æ…‹æª”ã€‚');
else if (!notify) log('ä¸æ‰“æ“¾ï¼ˆç‹€æ…‹ç…§æ¨£æ›´æ–°ï¼Œåªæ˜¯ä¸ç™¼è¨Šï¼‰ã€‚');
else if (!TOKEN || !CHAT_ID) { log('âš ï¸ æ²’æœ‰ TELEGRAM_BOT_TOKENï¼TELEGRAM_CHAT_ID â†’ åªå°ä¸é€ï¼ˆç‹€æ…‹æª”ä»æœƒæ›´æ–°ï¼‰ã€‚'); }
else {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg, disable_web_page_preview: true }),
  });
  const j = await r.json();
  sent = { ok: !!j.ok, message_id: j.result?.message_id, error: j.ok ? null : j.description };
  log(sent.ok ? `âœ… Telegram å·²é€å‡ºï¼ˆmessage_id ${sent.message_id}ï¼‰` : `âŒ Telegram å¤±æ•—ï¼š${j.description}`);
  if (!sent.ok) process.exitCode = 1;
}

// â”€â”€ 5. æ›´æ–°ç‹€æ…‹ï¼ˆåªåœ¨çœŸçš„åšå®Œæ™‚å¯«ï¼›å¿ƒè·³æª”æ˜¯æœ¬æ©Ÿçš„ï¼Œé›²ç«¯åªè®€ä¸æ”¹ï¼‰â”€â”€
if (!DRY) {
  mkdirSync(STATE, { recursive: true });
  copyFileSync(currentFile, BASELINE);
  writeFileSync(CLOUD, JSON.stringify({
    at: utcNow(), runId, scope: 'web', items: cur.map.size,
    new: isNew.length, gone: gone.length, priceChanged: priceChanged.length, qtyChanged: qtyChanged.length,
    rebuilt, notified: !!sent?.ok, sent, fetchSec: +fetchSec,
  }, null, 1) + '\n');
  log('ç‹€æ…‹æª”å·²æ›´æ–°ï¼ˆbaseline.tsv.gzï¼cloud.jsonï¼‰');
}

console.log('FALLBACK_SUMMARY ' + JSON.stringify({
  action: 'ran', force: FORCE, items: cur.map.size, new: isNew.length, gone: gone.length,
  priceChanged: priceChanged.length, qtyChanged: qtyChanged.length, rebuilt, sent,
}));
