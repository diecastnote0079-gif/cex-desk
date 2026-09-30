// 產生「一頁介面」：單檔 HTML（資料內嵌，點兩下就開，不需要網路、不需要伺服器）
//
// 用法：node report.mjs [--out 路徑] [--days 14] [--min-price 100]
// 產出：D:\AI\cex-db\report\cex.html（固定檔名，桌面捷徑指這個）＋ 帶日期的副本
//
// 設計：資料壓縮成短鍵名（i=條碼 n=名稱 …），全站 7.6 萬筆約 6–8MB
//       分店名稱用字典索引，避免每筆重複存字串
import { openDb, utcNow } from './cex-db.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const DAYS = Number(arg('days', 14));
const MIN_PRICE = Number(arg('min-price', 100));
const OUTDIR = arg('out-dir', 'D:\\AI\\cex-db\\report');
const OUT = arg('out', join(OUTDIR, 'cex.html'));

const db = openDb();
const run = db.prepare(`SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1`).get();
if (!run) { console.error('還沒有任何抓取紀錄，先跑 node cex.mjs daily'); process.exit(2); }
const runId = run.run_id;

// 分店字典（用索引代替字串，省體積）
const storeDict = [];
const storeIdx = new Map();
const sid = name => { if (!storeIdx.has(name)) { storeIdx.set(name, storeDict.length); storeDict.push(name); } return storeIdx.get(name); };

// 商品（最新一次）
const items = db.prepare(`
  SELECT box_id, name, category_friendly, sell_price, cash_buy, qty, stores_json, first_stock, super_cat_friendly, discontinued
  FROM items WHERE run_id = ?`).all(runId);
const itemById = new Map();
const packed = items.map(x => {
  let st = [];
  try { st = (JSON.parse(x.stores_json || '[]') || []).map(sid); } catch {}
  const o = {
    i: x.box_id, n: x.name || '', c: x.category_friendly || '', p: x.sell_price ?? 0,
    f: x.cash_buy ?? null, q: x.qty ?? 0, st, d: (x.first_stock || '').slice(0, 16),
    g: x.super_cat_friendly || '', x: x.discontinued ? 1 : 0,
  };
  itemById.set(x.box_id, o);
  return o;
});

// 變動帳（最近 N 天）
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const changes = db.prepare(`SELECT * FROM changes WHERE detected_at > ? ORDER BY detected_at DESC`).all(since)
  .map(c => ({
    t: c.event, i: c.box_id, n: c.name || '', c: c.category_friendly || '',
    o: c.old_value ?? '', v: c.new_value ?? '', at: (c.detected_at || '').slice(0, 16),
    fs: (c.first_stock || '').slice(0, 16),
    p: itemById.get(c.box_id)?.p ?? (Number(c.old_value) || 0),
    st: itemById.get(c.box_id)?.st ?? [],
  }));

// 健康狀態
const health = db.prepare(`SELECT signal, status, detail FROM health WHERE run_id = ?`).all(runId);
const ageH = (Date.now() - Date.parse(run.started_at)) / 3600e3;

// 分店統計（只算遊戲類有貨、RM100+、庫存 ≤2 → 值得看的貨）
const storeStats = {};
for (const x of packed) {
  if (!/Games/.test(x.c) || x.q < 1 || x.p < MIN_PRICE || x.q > 2) continue;
  for (const s of x.st) (storeStats[s] ||= { n: 0, top: [] }).n++, (storeStats[s].top.length < 40) && storeStats[s].top.push(x.i);
}

const payload = {
  gen: utcNow(),
  dataAt: run.started_at,
  runId, scope: run.scope, total: run.items, ageH: +ageH.toFixed(2),
  health, stores: storeDict, items: packed, changes, storeStats, minPrice: MIN_PRICE,
};

const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CeX 判斷台</title>
<style>
 :root{--bg:#0f1319;--panel:#171e29;--line:#26313f;--fg:#e8eef7;--dim:#8fa0b5;--acc:#4da3ff;--good:#3fb950;--warn:#d29922;--bad:#f85149}
 *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font-family:"Segoe UI","Microsoft JhengHei",system-ui,sans-serif;font-size:14px}
 header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:10px;align-items:baseline}
 h1{font-size:17px;margin:0} .dim{color:var(--dim);font-size:12px}
 .badge{font-size:12px;padding:2px 8px;border-radius:10px;background:#1d2836;border:1px solid var(--line)}
 .badge.ok{color:var(--good);border-color:#1d4025} .badge.bad{color:var(--bad);border-color:#4a1f1c}
 nav{display:flex;gap:6px;padding:10px 14px;flex-wrap:wrap;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
 nav button{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 13px;cursor:pointer;font-size:13px}
 nav button.on{background:var(--acc);border-color:var(--acc);color:#04101f;font-weight:600}
 main{padding:14px 18px 60px}
 .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
 input,select{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}
 input{min-width:240px}
 .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:104px}
 .card b{display:block;font-size:20px;font-weight:600} .card span{font-size:12px;color:var(--dim)}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
 th{position:sticky;top:52px;background:#141b24;cursor:pointer;user-select:none;z-index:4}
 th:hover{background:#1b2532}
 tr:hover td{background:#151d27}
 .num{text-align:right} .mono{font-family:Consolas,monospace;color:#9fb0c6;font-size:12px}
 .tag{font-size:11px;padding:1px 6px;border-radius:5px;margin-right:4px;display:inline-block}
 .t-new{background:#123524;color:#7ee2a8} .t-restock{background:#0f2f3d;color:#7fd3f0} .t-out{background:#3a1d1a;color:#f3a99f}
 .t-price{background:#332a12;color:#f0d08a} .t-gone{background:#2a1d33;color:#c9a9f0} .t-other{background:#1d2836;color:#9fb0c6}
 .sec{margin:18px 0 6px;font-size:13px;color:var(--dim);letter-spacing:.4px}
 .empty{color:var(--dim);padding:24px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
 .store{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer}
 .store:hover{border-color:var(--acc)} .store b{font-size:15px} .store span{display:block;color:var(--dim);font-size:12px;margin-top:3px}
</style></head><body>
<header>
  <h1>CeX 判斷台</h1>
  <span class="dim" id="meta"></span>
  <span class="badge" id="healthBadge"></span>
</header>
<nav>
  <button data-tab="account" class="on">今天的帳</button>
  <button data-tab="find">找貨／查價</button>
  <button data-tab="rare">稀有池</button>
  <button data-tab="stores">分店</button>
  <button data-tab="health">資料健康</button>
</nav>
<main id="main"></main>
<script>
const P = ${JSON.stringify(payload)};
const S = P.stores;
const fmt = n => n==null?'':('RM'+n);
const storeNames = arr => arr.map(i=>S[i]).join(' / ');
const el = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

// 標題列
el('#meta').textContent = '資料：' + P.dataAt.replace('T',' ').slice(0,16) + ' UTC（' + P.ageH + ' 小時前）｜' + P.total.toLocaleString() + ' 筆';
const bad = P.health.filter(h=>h.status!=='OK');
const hb = el('#healthBadge');
hb.textContent = bad.length ? ('⚠️ ' + bad.map(b=>b.signal).join('、')) : '健康正常';
hb.className = 'badge ' + (bad.length?'bad':'ok');

const EV = {
  NEW:['新上架','t-new'], RESTOCK:['回架','t-restock'], QTY_UP:['進貨增加','t-restock'],
  SOLD_OUT:['賣光','t-out'], QTY_DOWN:['庫存減少','t-out'], GONE:['消失','t-gone'],
  PRICE_UP:['調漲','t-price'], PRICE_DOWN:['調降','t-price'], FLOOR_CHANGE:['保底變動','t-price'],
  STORE_CHANGE:['分店變動','t-other'], STATUS_CHANGE:['狀態變動','t-other'],
};
const evTag = e => { const [lbl,cls]=EV[e]||[e,'t-other']; return '<span class="tag '+cls+'">'+lbl+'</span>'; };

let sortK={k:'p',d:-1};
function sortRows(rows){ return rows.slice().sort((a,b)=>{const x=a[sortK.k],y=b[sortK.k];
  return (typeof x==='number'||typeof y==='number') ? ((x||0)-(y||0))*sortK.d : String(x||'').localeCompare(String(y||''))*sortK.d; }); }
function th(k,label,cls){ return '<th data-k="'+k+'"'+(cls?' class="'+cls+'"':'')+'>'+label+(sortK.k===k?(sortK.d>0?' ▲':' ▼'):'')+'</th>'; }

const TABS = {
  account(){
    const days = window.__days||3, q=(window.__q||'').toLowerCase();
    const list = P.changes.filter(c=>!q||c.n.toLowerCase().includes(q)||c.i.includes(q));
    const cnt = e => list.filter(c=>c.t===e).length;
    const since = { NEW:cnt('NEW'), RESTOCK:cnt('RESTOCK'), QTY_UP:cnt('QTY_UP'), SOLD_OUT:cnt('SOLD_OUT'),
                    QTY_DOWN:cnt('QTY_DOWN'), GONE:cnt('GONE'), PRICE_UP:cnt('PRICE_UP'), PRICE_DOWN:cnt('PRICE_DOWN'),
                    FLOOR_CHANGE:cnt('FLOOR_CHANGE'), STORE_CHANGE:cnt('STORE_CHANGE') };
    const cards = [['新上架',since.NEW],['有人賣給CeX',since.RESTOCK+since.QTY_UP],['被買走',since.SOLD_OUT+since.QTY_DOWN],
                   ['消失',since.GONE],['改價',since.PRICE_UP+since.PRICE_DOWN],['分店變動',since.STORE_CHANGE]];
    const html = '<div class="bar"><label class="dim">看最近</label><select id="days">'+
      [1,3,7,14].map(d=>'<option'+(days===d?' selected':'')+'>'+d+'</option>').join('')+
      '</select><label class="dim">天</label><input id="q" placeholder="搜尋遊戲名 / 條碼…" value="'+esc(window.__q||'')+'">'+
      '<span class="dim">共 '+list.length+' 筆變動</span></div>'+
      '<div class="cards">'+cards.map(([l,v])=>'<div class="card"><b>'+v+'</b><span>'+l+'</span></div>').join('')+'</div>';
    if(!list.length) return html+'<div class="empty">這段期間沒有任何變動（沒有值得看的）</div>';
    const groups=[['新上架',['NEW']],['有人拿貨來賣／進貨',['RESTOCK','QTY_UP']],['被買走',['SOLD_OUT','QTY_DOWN']],['消失／下架',['GONE']],['改價／保底',['PRICE_UP','PRICE_DOWN','FLOOR_CHANGE']],['分店／狀態',['STORE_CHANGE','STATUS_CHANGE']]];
    let body='';
    for(const [title,evs] of groups){
      const rows=sortRows(list.filter(c=>evs.includes(c.t)));
      if(!rows.length) continue;
      body+='<div class="sec">── '+title+'（'+rows.length+'）</div><table><thead><tr>'+
        th('t','事件')+th('c','分類')+th('n','名稱')+th('p','標價','num')+th('o','舊值','num')+th('v','新值','num')+th('at','偵測時間')+th('fs','首次上架')+'</tr></thead><tbody>'+
        rows.slice(0,80).map(c=>'<tr><td>'+evTag(c.t)+'</td><td class="dim">'+esc(c.c)+'</td><td>'+esc(c.n)+'</td>'+
          '<td class="num">'+fmt(c.p)+'</td><td class="num dim">'+esc(c.o)+'</td><td class="num">'+esc(c.v)+'</td>'+
          '<td class="dim">'+esc(c.at)+'</td><td class="dim">'+esc(c.fs)+'</td></tr>').join('')+
        '</tbody></table>'+(rows.length>80?'<div class="dim" style="padding:6px 0">… 另有 '+(rows.length-80)+' 筆</div>':'');
    }
    return html+body;
  },
  find(){
    const q=(window.__q||'').toLowerCase();
    let rows=q ? P.items.filter(x=>x.n.toLowerCase().includes(q)||x.i.includes(q)).slice(0,400)
               : P.items.filter(x=>x.q>0).sort((a,b)=>b.p-a.p).slice(0,200);
    rows=sortRows(rows);
    return '<div class="bar"><input id="q" placeholder="輸入遊戲名或條碼（例如 zelda / 4974365838300）" value="'+esc(window.__q||'')+'">'+
      '<label class="dim"><input type="checkbox" id="onlystock"'+(window.__stock?' checked':'')+'> 只看有貨</label>'+
      '<span class="dim">'+(q?'符合 '+rows.length+' 筆（最多顯示 400）':'沒輸入關鍵字時，顯示有貨且最貴的 200 筆')+'</span></div>'+
      (rows.length?'<table><thead><tr>'+th('c','分類')+th('n','名稱')+th('p','CeX標價','num')+th('f','保底收購','num')+th('q','庫存','num')+th('d','首次上架')+th('i','條碼')+th('st','哪家店')+'</tr></thead><tbody>'+
        rows.map(x=>'<tr><td class="dim">'+esc(x.c)+'</td><td>'+esc(x.n)+'</td><td class="num">'+fmt(x.p)+'</td>'+
          '<td class="num" style="color:var(--acc)">'+fmt(x.f)+'</td><td class="num">'+(x.q||'')+'</td><td class="dim">'+esc(x.d)+'</td>'+
          '<td class="mono">'+esc(x.i)+'</td><td class="dim">'+esc(storeNames(x.st).slice(0,60))+'</td></tr>').join('')+'</tbody></table>'
        :'<div class="empty">沒有符合的貨</div>');
  },
  rare(){
    const rows = sortRows(P.items.filter(x=>x.q>0&&x.q<=1&&x.p>=P.minPrice&&/Games/.test(x.c)));
    return '<div class="sec">遊戲片 × RM'+P.minPrice+'+ × 全馬只剩 1 件（'+rows.length+' 筆）— 值不值得收由你判斷</div>'+
      '<table><thead><tr>'+th('c','分類')+th('n','名稱')+th('p','CeX標價','num')+th('f','保底收購','num')+th('d','首次上架')+th('i','條碼')+th('st','哪家店')+'</tr></thead><tbody>'+
      rows.slice(0,300).map(x=>'<tr><td class="dim">'+esc(x.c)+'</td><td>'+esc(x.n)+'</td><td class="num">'+fmt(x.p)+'</td>'+
        '<td class="num" style="color:var(--acc)">'+fmt(x.f)+'</td><td class="dim">'+esc(x.d)+'</td><td class="mono">'+esc(x.i)+'</td>'+
        '<td class="dim">'+esc(storeNames(x.st).slice(0,60))+'</td></tr>').join('')+'</tbody></table>'+
      (rows.length>300?'<div class="dim" style="padding:6px 0">… 另有 '+(rows.length-300)+' 筆</div>':'');
  },
  stores(){
    const rows = Object.entries(P.storeStats).map(([i,v])=>({i:+i,n:v.n})).sort((a,b)=>b.n-a.n);
    return '<div class="sec">哪家店有最多「值得看的貨」（遊戲、庫存≤2、RM'+P.minPrice+'+）</div><div class="grid">'+
      rows.map(r=>'<div class="store" data-store="'+r.i+'"><b>'+esc(S[r.i])+'</b><span>'+r.n+' 件值得看</span></div>').join('')+'</div>'+
      '<div id="storeDetail"></div>';
  },
  health(){
    return '<div class="sec">資料健康（五個訊號）＋變動帳統計</div>'+
      '<table><thead><tr><th>訊號</th><th>狀態</th><th>說明</th></tr></thead><tbody>'+
      P.health.map(h=>'<tr><td>'+esc(h.signal)+'</td><td>'+(h.status==='OK'?'✅':'🟡')+' '+esc(h.status)+'</td><td class="dim">'+esc(h.detail)+'</td></tr>').join('')+
      '</tbody></table>'+
      '<div class="sec">變動帳累計（'+P.changes.length+' 筆，最近 14 天）</div>'+
      '<table><thead><tr><th>事件</th><th>筆數</th></tr></thead><tbody>'+
      Object.entries(P.changes.reduce((a,c)=>((a[c.t]=(a[c.t]||0)+1),a),{})).sort((a,b)=>b[1]-a[1])
        .map(([k,v])=>'<tr><td>'+evTag(k)+'</td><td>'+v+'</td></tr>').join('')+'</tbody></table>'+
      '<div class="sec">檔案資訊</div><table><tbody>'+
      '<tr><td>產生時間</td><td class="dim">'+esc(P.gen)+'</td></tr>'+
      '<tr><td>資料來源 run</td><td class="dim">'+esc(P.runId)+'（'+esc(P.scope)+'）</td></tr>'+
      '<tr><td>商品筆數</td><td class="dim">'+P.total.toLocaleString()+'</td></tr></tbody></table>';
  },
};

function renderTab(t){
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
  window.__tab=t;
  el('#main').innerHTML = TABS[t]();
  el('#main').querySelectorAll('th[data-k]').forEach(x=>x.onclick=()=>{
    const k=x.dataset.k; sortK={k,d: sortK.k===k?-sortK.d:-1}; renderTab(t);
  });
  const q=el('#q'); if(q) q.oninput=()=>{ window.__q=q.value; const p=q.selectionStart; renderTab(t); const n=el('#q'); if(n){n.focus(); n.setSelectionRange(p,p);} };
  const d=el('#days'); if(d) d.onchange=()=>{ window.__days=+d.value; renderTab(t); };
  const os=el('#onlystock'); if(os) os.onchange=()=>{ window.__stock=os.checked; renderTab(t); };
  el('#main').querySelectorAll('.store').forEach(x=>x.onclick=()=>{
    const i=+x.dataset.store, ids=P.storeStats[i]?.top||[];
    const rows=ids.map(id=>P.items.find(y=>y.i===id)).filter(Boolean).sort((a,b)=>b.p-a.p);
    el('#storeDetail').innerHTML='<div class="sec">'+esc(S[i])+' 值得看的貨（前 '+rows.length+'）</div>'+
      '<table><thead><tr><th>分類</th><th>名稱</th><th class="num">CeX標價</th><th class="num">保底收購</th><th class="num">庫存</th><th>條碼</th></tr></thead><tbody>'+
      rows.map(x=>'<tr><td class="dim">'+esc(x.c)+'</td><td>'+esc(x.n)+'</td><td class="num">'+fmt(x.p)+'</td><td class="num" style="color:var(--acc)">'+fmt(x.f)+'</td><td class="num">'+x.q+'</td><td class="mono">'+esc(x.i)+'</td></tr>').join('')+
      '</tbody></table>';
    el('#storeDetail').scrollIntoView({behavior:'smooth'});
  });
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>renderTab(b.dataset.tab));
window.__days=3;
renderTab('account');
</script></body></html>`;

mkdirSync(OUTDIR, { recursive: true });
writeFileSync(OUT, html);
const dated = join(OUTDIR, `cex-${runId}.html`);
writeFileSync(dated, html);
const mb = (html.length / 1048576).toFixed(1);
console.log(`介面已產生：${OUT}`);
console.log(`  ${packed.length.toLocaleString()} 筆商品｜${changes.length} 筆變動｜分店 ${storeDict.length} 家｜檔案 ${mb}MB`);
console.log(`  副本：${dated}`);
