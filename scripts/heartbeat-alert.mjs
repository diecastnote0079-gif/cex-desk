// CeX 心跳告警（「死人開關」）——獨立於 daily，放雲端跑
//
// 角色：本機 PC 每 12 小時（08:30／20:00 MYT）抓一次並把心跳寫進 repo 的 state/heartbeat.json。
// 這支由 GitHub Actions 在 **09:00／15:00／21:00**（＝兩個預期時間之後各一次、中間一次）檢查：
//   預期時間 + grace（預設 30 分）過了，心跳卻還停在更早 → **發 Telegram**。
//
// 為什麼放雲端、不放在那台電腦上（業界標準，見 references/system-architecture.md §十）：
//  ・**告警器必須獨立於被監控的流程**——放同一台機器上，電腦一關，檢查也一起死。
//  ・dead-man's switch 的容忍度＝2×排程間隔；告警要看「**該跑而沒跑**」，不是等資料變舊。
//  ・grace 依實際抖動設（08:30 之後 30 分還沒動靜＝異常；給 5 分鐘只會教人忽略告警）。
//  ・**一次停機只叫一次**：用 --window 限制「只對剛過去的那個預期時間」告警，
//    所以 09:00 叫過之後，15:00 不會為同一件事再叫一次。
//
// 用法：
//   node heartbeat-alert.mjs --repo <repo 目錄>
//   node heartbeat-alert.mjs --dry-run                 只印不送
//   node heartbeat-alert.mjs --simulate-stale          假裝心跳是 48 小時前（驗收用）
//   node heartbeat-alert.mjs --now 2026-10-01T01:05:00Z --file <path>   指定時間／心跳檔（測試用）
//   node heartbeat-alert.mjs --grace 30 --window 6 --at "08:30,20:00"
//
// 環境變數：TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID（沒有就只印不送）
// 離開碼：0＝正常（含不告警）、2＝偵測到異常（已嘗試告警）
//
// ⚠️ 刻意**不**抽共用模組：送 Telegram 只有 8 行、變動頻率趨近 0，
//    抽出去反而要動 cloud-fallback.mjs 這支正在工作的關鍵腳本 → 風險大於收益。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendTelegram, reportSend } from './notify.mjs';

const has = n => process.argv.includes('--' + n);
const argOf = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const REPO = argOf('repo', join(process.cwd()));
const FILE = argOf('file', join(REPO, 'state', 'heartbeat.json'));
const GRACE_MIN = Number(argOf('grace', 30));                 // 預期時間之後的寬容
const WINDOW_H = Number(argOf('window', 6));                  // 只對「這麼近的」預期時間告警（避免重複叫）
const AT = argOf('at', '08:30,20:00').split(',').map(s => s.trim()).filter(Boolean);
const DRY = has('dry-run');
const SIMULATE = has('simulate-stale');
const NOW = has('now') ? new Date(argOf('now')) : new Date();

const log = m => console.log(`[${NOW.toISOString().replace(/\.\d+Z$/, 'Z')}] ${m}`);
const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

// ── 1. 最近一次「應該已經跑完」的預期時間（MYT＝UTC+8）──
const MYT_OFFSET = 8 * 3600e3;
const mytDay = ms => new Date(ms + MYT_OFFSET).toISOString().slice(0, 10);
function lastExpected(nowMs) {
  const candidates = [];
  for (const dayOffset of [0, -1]) {
    const day = new Date(nowMs + MYT_OFFSET + dayOffset * 86400e3).toISOString().slice(0, 10);
    for (const t of AT) candidates.push(Date.parse(`${day}T${t}:00+08:00`));
  }
  const past = candidates.filter(ms => ms <= nowMs);
  return past.length ? Math.max(...past) : null;
}

// ── 2. 心跳 ──
const hb = readJson(FILE);
let lastGoodMs = hb?.lastGoodRun ? Date.parse(hb.lastGoodRun) : null;
if (SIMULATE) {
  lastGoodMs = NOW.getTime() - 48 * 3600e3;
  log('（--simulate-stale：假裝心跳是 48 小時前）');
}
// ── 1b. 兩份實作漂移？（SQL vs 共用規則；PC 的 daily 算好、publish 夾進心跳）──
// 同一組 run **只叫一次**（記在 state/parity-alerted.json，由 workflow 的「提交狀態」一起 commit）。
const par = hb?.parity;
if (par && par.ok === false && !SIMULATE) {
  const markFile = join(REPO, 'state', 'parity-alerted.json');
  const mark = readJson(markFile);
  if (mark && mark.runCur === par.runCur) {
    log(`漂移已通報過（run ${par.runCur}）→ 不重複叫。`);
  } else {
    const d = (par.diffs || []).map(x => `${x.event}：SQL=${x.sql}／JS=${x.js}`).join('、');
    const lines2 = [
      '🔔 CeX 變動判定「兩份實作」對不上（漂移）',
      '',
      `比對組：${par.runPrev} → ${par.runCur}`,
      `差異：${d || '(未提供明細)'}`,
      '',
      '意義：電腦（SQL）和手機（共用規則）算出來的變動數會不一樣 → 手機那份不可信。',
      '下一步：下一輪會再對一次；若持續不一致，要修規則（ledger-core.mjs 與 ledger.mjs 的對應）。',
    ];
    console.log('\n===== Telegram 訊息預覽（漂移）=====\n' + lines2.join('\n') + '\n');
    if (!DRY) {
      reportSend(log, await sendTelegram(lines2.join('\n')));
      try { writeFileSync(markFile, JSON.stringify({ runCur: par.runCur, at: NOW.toISOString() }, null, 1) + '\n'); } catch (e) { log('⚠️ 記號寫不進去：' + e.message); }
    }
    console.log('ALERT_SUMMARY ' + JSON.stringify({ alert: true, kind: 'parity-drift', runCur: par.runCur, diffs: par.diffs }));
    process.exit(2);
  }
}

const ageH = lastGoodMs ? +((NOW.getTime() - lastGoodMs) / 3600e3).toFixed(1) : null;
const fmtMyt = ms => new Date(ms + MYT_OFFSET).toISOString().slice(0, 16).replace('T', ' ') + ' MYT';

const expected = lastExpected(NOW.getTime());
if (expected === null) { log('找不到可比的預期時間 → 不判定。'); process.exit(0); }

const sinceExpectedMin = (NOW.getTime() - expected) / 60000;
const missed = lastGoodMs === null || lastGoodMs < expected;

log(`預期：${fmtMyt(expected)}（${sinceExpectedMin.toFixed(0)} 分鐘前）`);
log(hb ? `心跳：${hb.lastGoodRun}（${ageH} 小時前，${hb.items ?? '?'} 筆）` : `心跳：讀不到 ${FILE}（視為從未回報）`);

if (!missed) { log('✅ 正常：預期時間之後已有成功回報。'); console.log('ALERT_SUMMARY ' + JSON.stringify({ alert: false, reason: 'fresh', ageHours: ageH })); process.exit(0); }
if (sinceExpectedMin < GRACE_MIN) { log(`⏳ 還在 ${GRACE_MIN} 分鐘寬容內 → 先不叫。`); console.log('ALERT_SUMMARY ' + JSON.stringify({ alert: false, reason: 'within-grace' })); process.exit(0); }
if (!SIMULATE && sinceExpectedMin > WINDOW_H * 60) { log(`😴 錯過的是 ${(sinceExpectedMin / 60).toFixed(1)} 小時前的預期時間（超出 ${WINDOW_H} 小時窗口）→ 這輪不重複叫。`); console.log('ALERT_SUMMARY ' + JSON.stringify({ alert: false, reason: 'outside-window' })); process.exit(0); }

// ── 3. 組訊息（人話：發生什麼、影響什麼、下一步）──
const lines = [];
lines.push('🔔 CeX 系統異常：電腦沒有回報');
if (SIMULATE) lines.push('（⚠️ 驗收測試：假裝電腦 48 小時沒回報，不是真的壞掉）');
lines.push('');
lines.push(`應該在：${fmtMyt(expected)}（馬來西亞時間）完成一次抓取＋發布`);
lines.push(lastGoodMs === null ? '實際上：從來沒有成功回報過' : `實際上：最後一次成功是 ${fmtMyt(lastGoodMs)}（${ageH} 小時前）`);
lines.push('');
lines.push('可能原因（依機率）：');
lines.push('① 電腦沒開／排程沒跑');
lines.push('② 跑了但沒推上去（2026-10-01 08:30 那次就是這樣）');
lines.push('③ 網路或 GitHub 出問題');
lines.push('');
lines.push(`影響：手機頁還停在 ${lastGoodMs === null ? '未知' : fmtMyt(lastGoodMs)} 那一版`);
lines.push('下一步：下次開機時會自動補推；若一直沒動靜請告知。');
const msg = lines.join('\n').slice(0, 3800);

console.log('\n===== Telegram 訊息預覽 =====\n' + msg + '\n=============================\n');

// ── 4. 送出 ──
reportSend(log, await sendTelegram(msg, { dryRun: DRY }));

console.log('ALERT_SUMMARY ' + JSON.stringify({ alert: true, expectedMyt: fmtMyt(expected), ageHours: ageH, simulate: SIMULATE }));
process.exit(2);
