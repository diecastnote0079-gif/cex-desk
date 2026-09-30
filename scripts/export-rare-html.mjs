// 匯出「遊戲片稀有候選池」成單檔可排序 HTML（免 key、免 CDP）
// 用法：node export-rare-html.mjs [--min-price 100] [--max-qty 1] [--out 路徑.html] [--retro]
// 預設輸出 D:\AI\cex-db\exports\rare-games-YYYYMMDD-HHMM.html
import { queryOne, params, BASE_FILTER, IN_STOCK_FILTER } from './cex-api.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const has = n => process.argv.includes('--' + n);
const MIN = Number(arg('min-price', 100));
const MAXQ = Number(arg('max-qty', 1));
const RETRO = has('retro');
const RETRO_PLAT = ['PS2', 'PS3', 'PSP', 'VITA', '3DS', 'DS', 'WII', 'WIIU', 'X360'];
const now = new Date(Date.now() + 8 * 3600e3).toISOString();
const TODAY_MYT = now.slice(0, 10);
const stamp = now.slice(0, 16).replace(/[-:T]/g, '').slice(0, 12);
const OUT = arg('out', `D:\\AI\\cex-db\\exports\\rare-games-${stamp}.html`);

const r = await queryOne(params({
  hitsPerPage: 1000,
  filters: `${BASE_FILTER} AND ${IN_STOCK_FILTER} AND superCatFriendlyName:Gaming AND sellPrice >= ${MIN} AND collectionQuantity <= ${MAXQ}`,
  attributes: ['boxName', 'boxId', 'categoryName', 'categoryFriendlyName', 'sellPrice', 'previousPrice', 'collectionQuantity', 'collectionStores', 'firstStockDate', 'priceLastChanged', 'rating', 'discontinued'],
}));
let hits = (r.hits || []).filter(h => /Games/.test(h.categoryName || ''));
const platOf = h => String(h.categoryFriendlyName || h.categoryName || '').split(' Games')[0];
if (RETRO) hits = hits.filter(h => RETRO_PLAT.includes(platOf(h)));

const CE = /Col\.|Collector|Limited|Deluxe|Premium|Special Ed|Trilogy|Legacy|Anniversary|Ultimate/i;
const rows = hits.map(h => ({
  plat: platOf(h),
  reg: (String(h.categoryFriendlyName || '').match(/R\d(?:\s+\w+)?/) || ['—'])[0],
  name: h.boxName || '',
  price: h.sellPrice || 0,
  prev: h.previousPrice || 0,
  qty: h.collectionQuantity ?? 0,
  stores: (h.collectionStores || []).join(' / '),
  box: h.boxId || '',
  first: (h.firstStockDate || '').slice(0, 10),
  ce: CE.test(h.boxName || '') ? 1 : 0,
  fresh: (h.firstStockDate || '').startsWith(TODAY_MYT) ? 1 : 0,
  drop: (h.previousPrice || 0) > (h.sellPrice || 0) ? 1 : 0,
}));

const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<title>CeX MY 稀有候選池 ${TODAY_MYT}</title>
<style>
 body{font-family:"Segoe UI","Microsoft JhengHei",sans-serif;margin:18px;background:#11151c;color:#e8edf5}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8b98ab;font-size:12px;margin-bottom:12px}
 .bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
 input,select{background:#1b2230;color:#e8edf5;border:1px solid #2c374a;border-radius:6px;padding:7px 9px;font-size:13px}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th,td{padding:6px 8px;border-bottom:1px solid #232c3a;text-align:left;white-space:nowrap}
 th{position:sticky;top:0;background:#171e29;cursor:pointer;user-select:none}
 th:hover{background:#22303f}
 tr:hover td{background:#1a2230}
 .num{text-align:right} .dim{color:#8b98ab}
 .tag{font-size:11px;padding:1px 5px;border-radius:4px;margin-right:3px}
 .t-new{background:#1f4d2b;color:#a9f0b8} .t-drop{background:#4d241f;color:#f7b8a9} .t-ce{background:#3a2f5c;color:#cbb6ff}
 .t-retro{background:#2a3a52;color:#a9cdf0}
 .mono{font-family:Consolas,monospace;font-size:12px;color:#9fb0c6}
</style></head><body>
<h1>CeX MY 稀有候選池 — 遊戲片 RM${MIN}+ × 庫存 ≤${MAXQ}</h1>
<div class="sub">抓取時間 ${now.replace('T', ' ').slice(0, 16)}（MYT）｜${rows.length} 筆｜只有庫存 ≤${MAXQ} 的才進這張表｜
「庫存 1」不等於稀有，判斷看 <b>分店數／是否限定版／條碼區域</b>；價格與出手由使用者定。</div>
<div class="bar">
 <input id="q" placeholder="搜尋遊戲名 / 條碼…" style="min-width:260px">
 <select id="p"><option value="">全部平台</option></select>
 <label style="font-size:13px;color:#8b98ab"><input type="checkbox" id="onlyce"> 只看收藏／限定版</label>
 <label style="font-size:13px;color:#8b98ab"><input type="checkbox" id="onlydrop"> 只看跌價</label>
 <label style="font-size:13px;color:#8b98ab"><input type="checkbox" id="onlyretro"> 只看復古／掌機</label>
</div>
<table id="t"><thead><tr>
 <th data-k="plat">平台</th><th data-k="reg">區域</th><th data-k="name">名稱</th>
 <th data-k="price" class="num">標價</th><th data-k="prev" class="num">前價</th><th data-k="qty" class="num">庫存</th>
 <th data-k="stores">分店</th><th data-k="box">條碼</th><th data-k="first">首見日</th></tr></thead><tbody></tbody></table>
<script>
const DATA=${JSON.stringify(rows)};
const RETRO=${JSON.stringify(RETRO_PLAT)};
const tbody=document.querySelector('#t tbody'), sel=document.querySelector('#p');
[...new Set(DATA.map(d=>d.plat))].sort().forEach(p=>{const o=document.createElement('option');o.value=p;o.textContent=p;sel.append(o)});
let key='price',dir=-1;
function render(){
  const q=document.querySelector('#q').value.toLowerCase(),p=sel.value,
        ce=document.querySelector('#onlyce').checked,dr=document.querySelector('#onlydrop').checked,rt=document.querySelector('#onlyretro').checked;
  let rows=DATA.filter(d=>(!q||d.name.toLowerCase().includes(q)||d.box.includes(q))&&(!p||d.plat===p)&&(!ce||d.ce)&&(!dr||d.drop)&&(!rt||RETRO.includes(d.plat)));
  rows.sort((a,b)=>{const x=a[key],y=b[key];return (typeof x==='number'? x-y : String(x).localeCompare(String(y)))*dir});
  tbody.innerHTML=rows.map(d=>{
    const tags=(d.fresh?'<span class="tag t-new">今天新品</span>':'')+(d.drop?'<span class="tag t-drop">跌價</span>':'')+(d.ce?'<span class="tag t-ce">限定/收藏版</span>':'')+(RETRO.includes(d.plat)?'<span class="tag t-retro">復古</span>':'');
    return \`<tr><td>\${d.plat}</td><td class="dim">\${d.reg}</td><td>\${tags}\${d.name}</td>
    <td class="num">\${d.price}</td><td class="num dim">\${d.prev||''}</td><td class="num">\${d.qty}</td>
    <td class="dim">\${d.stores}</td><td class="mono">\${d.box}</td><td class="dim">\${d.first}</td></tr>\`}).join('');
  document.querySelectorAll('th').forEach(th=>th.textContent=th.textContent.replace(/ [▲▼]$/,'')+(th.dataset.k===key?(dir>0?' ▲':' ▼'):''));
}
document.querySelectorAll('th').forEach(th=>th.onclick=()=>{const k=th.dataset.k;dir=(key===k?-dir:-1);key=k;render()});
['q','p','onlyce','onlydrop','onlyretro'].forEach(id=>document.getElementById(id).addEventListener('input',render));
render();
</script></body></html>`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`已寫入 ${OUT}（${rows.length} 筆｜限定/收藏 ${rows.filter(r => r.ce).length}｜跌價 ${rows.filter(r => r.drop).length}｜復古 ${rows.filter(r => RETRO_PLAT.includes(r.plat)).length}）`);
