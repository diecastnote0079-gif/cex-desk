// CeX 手機頁的「自動驗收」腳本（本機、獨立 Chromium、不碰使用者瀏覽器）
//
// 用 CDP 驅動獨立設定檔的 Chromium，**從畫面上看得到的文字**做判定（不讀頁面內部變數——
// CDP 的 Runtime.evaluate 可能落在隔離環境、看不到頁面的 var）。
//
// 測「完整性守門」：?reset=1 歸零 → 普通網址同步（建基準）→ ?half=1 同步（模擬抓取中斷）
//   ✅ 期望：基準筆數不變、變動頁出現黃色警告、跳警告視窗
//
// 用法：CHROME_PATH=<chromium> node webtest-mobile.mjs [--headed]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || '';
if (!CHROME) { console.error('需要 CHROME_PATH（Chromium/Chrome 執行檔）'); process.exit(2); }
const BASE = process.env.CEX_WEB || 'https://diecastnote0079-gif.github.io/cex-desk/';
const PORT = Number(process.env.CDP_PORT || 9333);
const HEADED = process.argv.includes('--headed');
const profile = mkdtempSync(join(tmpdir(), 'cex-webtest-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  ...(HEADED ? [] : ['--headless=new']),
  '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map(), dialogs = [], logs = [];

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find(x => x.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('CDP 沒起來（連不上 ' + PORT + '）');
}
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 逾時')); } }, 90000);
  });
}
/** 讀「畫面上看得到的文字」（DOM 跨隔離環境都看得到） */
async function textOf(selector) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){var e=document.querySelector(${JSON.stringify(selector)}); return e?e.innerText.replace(/\\s+/g,' ').trim():null;})()`,
    returnByValue: true,
  });
  return r.result?.value ?? null;
}
async function click(selector) {
  const r = await send('Runtime.evaluate', {
    expression: `(function(){var e=document.querySelector(${JSON.stringify(selector)}); if(!e) return false; e.click(); return true;})()`,
    returnByValue: true,
  });
  return r.result?.value === true;
}
async function goto(url, waitMs) { await send('Page.navigate', { url }); await sleep(waitMs); }
const numFrom = (s, re) => { const m = String(s || '').match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '　→ ' + detail : ''}`); };

try {
  ws = new WebSocket(await findPage());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map(a => a.value).join(' '));
  };
  await send('Page.enable'); await send('Runtime.enable');
  console.log(`目標：${BASE}\n`);

  // ── 1. 歸零 ──
  console.log('【1】?reset=1 歸零');
  await goto(BASE + '?reset=1', 6000);
  const m1 = await textOf('#meta');
  console.log('   畫面：', m1);
  check('歸零後顯示「尚未同步」', /尚未同步/.test(m1 || ''), m1);
  check('版本標記 uiv13＋', /uiv1[3-9]/.test(await textOf('#ver') || ''), await textOf('#ver'));
  check('規則模組已載入（✓）', /規則模組 ✓/.test(m1 || ''), (m1 || '').slice(0, 60));

  // ── 2. 建基準（普通網址、完整同步）──
  console.log('\n【2】普通網址同步（建立基準）');
  await goto(BASE, 5000);
  await click('#sync');
  await sleep(30000);
  const m2 = await textOf('#meta');
  const n2 = numFrom(m2, /本機：([\d,]+) 筆遊戲片/);
  console.log('   畫面：', m2);
  check('同步完成，本機筆數 > 10000', n2 !== null && n2 > 10000, String(n2));
  // 注意：按鈕的「已同步」只顯示 2.5 秒就變回「同步遊戲片」→ 用資訊行判斷有沒有跑完
  check('資訊行顯示「本機同步 · N 秒」', /本機同步/.test(m2 || ''), (m2 || '').slice(0, 40));

  // ── 3. 模擬中斷（?half=1）──
  console.log('\n【3】?half=1 同步（模擬抓取中斷）');
  await goto(BASE + '?half=1', 5000);
  await click('#sync');
  await sleep(30000);
  const m3 = await textOf('#meta');
  const n3 = numFrom(m3, /本機：([\d,]+) 筆遊戲片/);
  console.log('   畫面：', m3);
  check('基準沒有被半份資料覆蓋', n3 === n2, `測前 ${n2} → 測後 ${n3}`);
  check('跳出不完整警告視窗', dialogs.some(d => /少太多|中斷/.test(d)), (dialogs[0] || '').slice(0, 60));
  check('console 記錄 half=1 生效', logs.some(l => /half=1/.test(l)), (logs.find(l => /half=1/.test(l)) || '').slice(0, 60));

  await click('[data-tab="chg"]');
  await sleep(1200);
  const chg = await textOf('#list');
  console.log('   變動頁：', (chg || '').slice(0, 120));
  check('變動頁出現黃色警告', /抓取中斷|不完整/.test(chg || ''), (chg || '').slice(0, 80));

  const bad = results.filter(r => !r.ok);
  console.log(`\n===== 結果：${results.length - bad.length}/${results.length} 通過 =====`);
  if (bad.length) console.log('未通過：', bad.map(b => b.name).join('、'));
  process.exitCode = bad.length ? 1 : 0;
} catch (e) {
  console.error('測試失敗：', e.message);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(process.exitCode || 0);
}
