// shot-mobile.mjs — 用手機尺寸截 CeX 手機頁（給「改完 UI 要看成品」用）
//
// 為什麼要這支：改完前端不能只看 log 或程式碼——**要看畫面上真的長什麼樣**。
// 跟 webtest-mobile.mjs 同一套 CDP 作法（獨立 headless Chromium、獨立 temp profile、不碰使用者的瀏覽器）。
//
// 用法：
//   CHROME_PATH=C:\...\thorium.exe node shot-mobile.mjs --url http://127.0.0.1:8799/ --tab chg --out shot.png
//   （--tab 可選 all|new|chg；--full 連整頁一起截；預設只截視窗）
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, def = '') => { const i = process.argv.indexOf('--' + name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const has = name => process.argv.includes('--' + name);

const CHROME = process.env.CHROME_PATH || 'C:\\Users\\GIll\\AppData\\Local\\Thorium\\Application\\thorium.exe';
const URL_ = arg('url', 'https://diecastnote0079-gif.github.io/cex-desk/');
const TAB = arg('tab', '');
const OUT = arg('out', join(tmpdir(), 'cex-shot.png'));
const PORT = Number(arg('port', '9345'));
const FULL = has('full');
const W = Number(arg('w', '428')), H = Number(arg('h', '900'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'cex-shot-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const consoleMsgs = [];
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 逾時')); } }, 60000);
  });
}
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

try {
  ws = new WebSocket(await findPage());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    // 收集 console（抓頁面裡的錯誤用）
    if (m.method === 'Runtime.consoleAPICalled') {
      const lvl = m.params.type;
      const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if (lvl === 'error' || lvl === 'warning') consoleMsgs.push(`[${lvl}] ${txt}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      consoleMsgs.push(`[exception] ${d.text || ''} ${d.exception?.description || ''}`.slice(0, 400));
    }
    // 頁面跳 alert 會把整個頁面卡住——一律記下來並按掉
    if (m.method === 'Page.javascriptDialogOpening') {
      consoleMsgs.push(`[dialog] ${m.params.message}`.slice(0, 400));
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
    // ⚠️ 瀏覽器自己的 JS 錯誤（語法錯誤、載入失敗）走 Log 域，不走 Runtime.consoleAPICalled
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry || {};
      if (e.level === 'error' || e.level === 'warning') {
        consoleMsgs.push(`[log:${e.level}] ${e.text} ${e.url ? '(' + e.url + ':' + e.lineNumber + ')' : ''}`.slice(0, 400));
      }
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });

  await send('Page.navigate', { url: URL_ });
  // 等資料真的載完（變動帳／清單都要抓 GitHub raw；首次載入可能十幾秒）
  // 上限 8 秒就好——要測「按同步」的流程時，別把預算都花在這裡
  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    const t = await send('Runtime.evaluate', {
      expression: `(function(){var l=document.querySelector('#list'); return l?l.innerText:'';})()`,
      returnByValue: true,
    });
    const s = t.result?.value || '';
    if (s && !/載入中|還沒|本機還沒有/.test(s)) break;
  }

  if (TAB) {
    const clicked = await send('Runtime.evaluate', {
      expression: `(function(){var b=document.querySelector('button[data-tab="${TAB}"]'); if(!b) return false; b.click(); return true;})()`,
      returnByValue: true,
    });
    console.log(`${TAB} tab clicked: ${clicked.result?.value === true}`);
    await sleep(2500);
  }

  // 可選：收合指定的事件分組（驗折疊功能用），例如 --toggle NEW,QTY_UP
  const TOGGLE = arg('toggle', '');
  if (TOGGLE) {
    for (const id of TOGGLE.split(',')) {
      const r = await send('Runtime.evaluate', {
        expression: `(function(){var e=document.querySelector('.grp[data-grp="${id.trim()}"]'); if(!e) return false; e.click(); return true;})()`,
        returnByValue: true,
      });
      console.log(`toggle ${id}: ${r.result?.value === true}`);
      await sleep(1200);
    }
  }

  // 可選：點任意選擇器（逗號分隔多個），例如 --click ".qseg button[data-q=down]"
  const CLICK = arg('click', '');
  if (CLICK) {
    for (const sel of CLICK.split('|')) {
      const r = await send('Runtime.evaluate', {
        expression: `(function(){var e=document.querySelector(${JSON.stringify(sel.trim())}); if(!e) return false; e.click(); return true;})()`,
        returnByValue: true,
      });
      console.log(`click ${sel.trim()}: ${r.result?.value === true}`);
      await sleep(1200);
    }
  }

  // 可選：捲到某個位置（看下面的分組）--scroll 1600
  const SCROLL = Number(arg('scroll', '0'));
  if (SCROLL) {
    await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${SCROLL});`, returnByValue: true });
    await sleep(900);
  }

  // 可選：截圖前再等幾毫秒（例如等「同步遊戲片」抓完）--wait 45000
  const WAIT = Number(arg('wait', '0'));
  if (WAIT) await sleep(WAIT);

  // 可選：印出任意表達式的結果（驗資料用）--eval "document.querySelectorAll('#g1 option').length"
  const EVAL = arg('eval', '');
  if (EVAL) {
    const r = await send('Runtime.evaluate', { expression: EVAL, returnByValue: true });
    const v = r.result?.value;
    console.log('eval →', typeof v === 'string' ? v : JSON.stringify(v));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: FULL });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`saved: ${OUT}`);

  // 順便把畫面上看得到的重點文字印出來，方便對照
  const txt = await send('Runtime.evaluate', {
    expression: `(function(){var l=document.querySelector('#list'); return l?l.innerText.replace(/\\n{2,}/g,'\\n').slice(0,1200):null;})()`,
    returnByValue: true,
  });
  console.log('--- #list 文字（前 1200 字）---');
  console.log(txt.result?.value || '(空的)');
  if (consoleMsgs.length) {
    console.log('--- 頁面 console（錯誤／警告，最後 15 條）---');
    console.log(consoleMsgs.slice(-15).join('\n'));
  }
} finally {
  try { chrome.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
