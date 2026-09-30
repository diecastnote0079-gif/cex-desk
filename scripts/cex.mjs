// CeX 系統單一入口
//
//   node cex.mjs daily            抓 → 載入 → 對帳 → 健康檢查（排程用；寫日誌、不通知）
//   node cex.mjs account [--days 1]   輸出「今天的帳」：進貨／賣出／改價／新上架／消失
//   node cex.mjs status           最後一次抓取時間 + 健康狀態 + 最近變動數
//   node cex.mjs doctor           只跑健康檢查
//   node cex.mjs ledger           只跑對帳
//   node cex.mjs mirror [--scope all] [--full]   只抓資料
//   node cex.mjs query "SELECT …" 直接查資料庫
//
// 設計原則見 references/system-architecture.md（刻意做小：一個來源、一個使用者）
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, utcNow, LOG_DIR, MIRROR_DIR } from './cex-db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOGDIR = LOG_DIR;
const cmd = process.argv[2] || 'status';
const rest = process.argv.slice(3);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

const run = (script, args = [], opts = {}) =>
  execFileSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit', ...opts });

function log(msg, file = 'daily.log') {
  mkdirSync(LOGDIR, { recursive: true });
  appendFileSync(join(LOGDIR, file), `[${utcNow()}] ${msg}\n`);
}

/** 清掉太舊的原始檔（資料庫裡的結構化資料永久保留，只有體積大的 JSONL 會被清） */
function pruneMirrors(keepDays) {
  const dir = MIRROR_DIR;
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - keepDays * 86400e3;
  const gone = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const m = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) continue;
    const when = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
    if (when < cutoff) { rmSync(p, { recursive: true, force: true }); gone.push(name); }
  }
  return gone;
}

switch (cmd) {
  case 'mirror':
    run('mirror.mjs', [...rest, '--load']);
    break;

  case 'ledger':
    run('ledger.mjs', rest);
    break;

  case 'doctor':
    run('doctor.mjs', rest);
    break;

  case 'daily': {
    // 排程用：抓 → 載入 → 對帳 → 健康檢查。不通知，只留紀錄。
    const scope = arg('scope', 'web');
    const t0 = Date.now();
    log(`daily 開始（scope=${scope}）`);
    try {
      const out = execFileSync(process.execPath, [join(HERE, 'mirror.mjs'), '--scope', scope, '--load'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const last = out.trim().split(/\r?\n/).slice(-3).join(' | ');
      log(`mirror 完成：${last}`);
      const lg = execFileSync(process.execPath, [join(HERE, 'ledger.mjs'), '--scope', scope], { encoding: 'utf8' });
      log(`ledger：${lg.trim().split(/\r?\n/).slice(-2).join(' | ')}`);
      const dc = execFileSync(process.execPath, [join(HERE, 'doctor.mjs')], { encoding: 'utf8' });
      log(`doctor：${dc.trim().replace(/\s+/g, ' ')}`);
      // 發佈心跳＋腳本給雲端備援（cex-desk repo）。失敗不影響本機——本機才是主力。
      try {
        const pub = execFileSync(process.execPath, [join(HERE, 'publish.mjs')], { encoding: 'utf8' });
        log(`publish：${pub.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')}`);
      } catch (e) {
        log(`⚠️ publish 失敗（本機資料不受影響）：${String(e.stdout || e.stderr || e.message).slice(0, 300)}`);
      }
      // 手機頁資料（GitHub Pages 的 data 分支；內容只有 CeX 公開市價）
      try {
        const web = execFileSync(process.execPath, [join(HERE, 'publish-web.mjs')], { encoding: 'utf8' });
        log(`publish-web：${web.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]}`);
      } catch (e) {
        log(`⚠️ publish-web 失敗（本機資料不受影響）：${String(e.stdout || e.stderr || e.message).slice(0, 300)}`);
      }
      // 原始檔保留：預設留最近 7 天（資料庫裡的結構化資料永久保留；原始 JSONL 每份約 124MB）
      const keepDays = Number(arg('keep-days', 7));
      const pruned = pruneMirrors(keepDays);
      if (pruned.length) log(`保留最近 ${keepDays} 天原始檔，刪除 ${pruned.length} 份：${pruned.join(', ')}`);
      log(`daily 完成，耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      console.log(dc.trim());
    } catch (e) {
      const msg = (e.stdout || '') + (e.stderr || '') + e.message;
      log(`⚠️ daily 失敗：${String(msg).slice(0, 800)}`);
      console.error('daily 失敗，已寫入日誌：' + join(LOGDIR, 'daily.log'));
      console.error(String(msg).slice(0, 500));
      process.exit(1);
    }
    break;
  }

  case 'status': {
    const db = openDb();
    const r = db.prepare(`SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1`).get();
    if (!r) { console.log('還沒有任何抓取紀錄'); break; }
    const age = (Date.now() - Date.parse(r.started_at)) / 3600e3;
    const h = db.prepare('SELECT signal, status, detail FROM health WHERE run_id=?').all(r.run_id);
    const recent = db.prepare(`SELECT COUNT(*) c FROM changes WHERE detected_at > ?`).get(new Date(Date.now() - 86400e3).toISOString()).c;
    const icon = s => s === 'OK' ? '✅' : s === 'WARN' ? '🟡' : '🔴';
    console.log(`最新資料：${r.run_id}（範圍 ${r.scope}，${r.items} 筆，${age.toFixed(1)} 小時前）`);
    h.forEach(x => console.log(`  ${icon(x.status)} ${x.signal.padEnd(10)} ${x.detail}`));
    console.log(`過去 24 小時記錄到的變動：${recent} 筆`);
    break;
  }

  case 'account': {
    const days = Number(arg('days', 1));
    const db = openDb();
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    // 變動帳 join 商品表，才能顯示價格與庫存
    const rows = db.prepare(`
      SELECT ch.*, i.sell_price, i.qty AS cur_qty, i.cash_buy, i.stores_json AS cur_stores, i.category_name
      FROM changes ch
      LEFT JOIN items i ON i.run_id = ch.run_cur AND i.box_id = ch.box_id
      WHERE ch.detected_at > ?`).all(since);
    const r = db.prepare(`SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1`).get();
    const grp = {};
    for (const x of rows) (grp[x.event] ||= []).push(x);
    const n = e => (grp[e] || []).length;
    const age = r ? (Date.now() - Date.parse(r.started_at)) / 3600e3 : null;

    console.log(`===== CeX 帳（最近 ${days} 天）=====`);
    if (r) console.log(`資料時間：${r.started_at.replace('T', ' ').slice(0, 16)} UTC（${age.toFixed(1)} 小時前）｜範圍 ${r.scope}｜${r.items} 筆`);
    const bad = db.prepare(`SELECT signal, status, detail FROM health WHERE run_id=? AND status<>'OK'`).all(r?.run_id);
    console.log(bad.length ? `⚠️ 健康檢查：${bad.map(b => b.signal + '=' + b.status).join('、')}｜${bad.map(b => b.detail).join('；')}` : '健康檢查：全部正常');
    if (!rows.length) { console.log('\n這段期間沒有任何變動（沒有值得看的）'); break; }

    const priceOf = x => Number(x.event === 'GONE' ? x.old_value : (x.sell_price ?? 0)) || 0;
    const stores = x => { try { return JSON.parse(x.cur_stores || '[]').length; } catch { return 0; } };
    const line = x => {
      const p = priceOf(x);
      let mid;
      if (x.event === 'NEW') mid = `RM${p}`;
      else if (x.event === 'GONE') mid = `消失時 RM${x.old_value}`;
      else if (x.event.startsWith('PRICE')) mid = `RM${x.old_value}→RM${x.new_value}`;
      else if (x.event === 'STORE_CHANGE') mid = `${stores(x)} 家店`;
      else mid = `${x.old_value}→${x.new_value} 件`;
      return `  ${String(x.category_friendly || '').padEnd(20).slice(0, 20)} ${String(x.name || '').slice(0, 34).padEnd(36)} ${String(mid).padEnd(16)} ${p && x.event !== 'NEW' ? 'RM' + p : ''}`;
    };
    const show = (title, evs, limit = 12) => {
      const list = evs.flatMap(e => grp[e] || []).sort((a, b) => priceOf(b) - priceOf(a));
      if (!list.length) return;
      console.log(`\n── ${title}（${list.length}）──`);
      list.slice(0, limit).forEach(x => console.log(line(x)));
      if (list.length > limit) console.log(`  … 另有 ${list.length - limit} 筆`);
    };
    console.log(`\n【進】新上架 ${n('NEW')}｜回架 ${n('RESTOCK')}｜進貨增加 ${n('QTY_UP')}`);
    console.log(`【出】賣光 ${n('SOLD_OUT')}｜庫存減少 ${n('QTY_DOWN')}｜下架消失 ${n('GONE')}`);
    console.log(`【價】調漲 ${n('PRICE_UP')}｜調降 ${n('PRICE_DOWN')}｜保底變動 ${n('FLOOR_CHANGE')}`);
    console.log(`【其他】分店變動 ${n('STORE_CHANGE')}｜狀態變動 ${n('STATUS_CHANGE')}`);
    show('新上架（NEW）', ['NEW']);
    show('有人拿貨來賣／進貨（RESTOCK＋QTY_UP）', ['RESTOCK', 'QTY_UP']);
    show('被買走（SOLD_OUT＋QTY_DOWN）', ['SOLD_OUT', 'QTY_DOWN']);
    show('消失／下架（GONE）', ['GONE']);
    show('改價', ['PRICE_UP', 'PRICE_DOWN', 'FLOOR_CHANGE']);
    break;
  }

  case 'query': {
    const sql = rest.join(' ') || arg('sql', '');
    if (!sql) { console.error('用法: node cex.mjs query "SELECT …"'); process.exit(2); }
    run('cexq.mjs', [sql]);
    break;
  }

  default:
    console.log('指令：daily | account | status | doctor | ledger | mirror | query "SQL"');
}
