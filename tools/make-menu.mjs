// 產生手機頁的分類選單（web/menu.js）—— 資料來自本地 CeX 庫的最新一次鏡像
//   node tools/make-menu.mjs
//
// 選單結構：
//   遊戲片        → 平台（可查全部）→ 區域（可查單一區域）
//   遊戲機與配件 / 電腦 / 電子 / 手機 → 單層分類
// 每項都帶「筆數」與「現在有貨數」，讓使用者按之前就知道會剩幾筆。
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'web', 'menu.js');
const DB = process.env.CEX_DB || 'D:\\AI\\cex-db\\cex.sqlite';

const db = new DatabaseSync(DB);
const rows = db.prepare(`
  SELECT super_cat_friendly sc, category_friendly cf, COUNT(*) n,
         SUM(CASE WHEN qty > 0 THEN 1 ELSE 0 END) ins
  FROM latest_items GROUP BY sc, cf ORDER BY sc, cf`).all();
db.close();

const platforms = {};          // 遊戲片：平台 → 區域清單
const others = { Gaming: [], Computing: [], Electronics: [], Phones: [] };

for (const r of rows) {
  // 遊戲片＝分類名含 "Games"。兩種寫法：`3DS Games: R2 ENG`（有區域）、`PC Games`（沒有）
  const m = String(r.cf).match(/^(.+?)\s+Games(?:\s*:\s*(.+))?$/);
  if (m) {
    const p = m[1].trim();
    (platforms[p] = platforms[p] || []).push({ label: (m[2] || '—').trim(), cat: r.cf, n: r.n, ins: r.ins });
  } else {
    (others[r.sc] = others[r.sc] || []).push({ label: r.cf, cat: r.cf, n: r.n, ins: r.ins });
  }
}

const sum = (a, k) => a.reduce((t, x) => t + (x[k] || 0), 0);
const gamePlatforms = Object.keys(platforms)
  .map(p => {
    const kids = platforms[p].sort((a, b) => b.n - a.n);
    return { label: p, cats: kids.map(k => k.cat), n: sum(kids, 'n'), ins: sum(kids, 'ins'), children: kids };
  })
  .sort((a, b) => b.n - a.n);

const menu = {
  generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  groups: [
    { key: 'games', label: '遊戲片', platforms: gamePlatforms },
    { key: 'console', label: '遊戲機與配件', items: others.Gaming.sort((a, b) => b.n - a.n) },
    { key: 'computing', label: '電腦', items: others.Computing.sort((a, b) => b.n - a.n) },
    { key: 'electronics', label: '電子', items: others.Electronics.sort((a, b) => b.n - a.n) },
    { key: 'phones', label: '手機', items: others.Phones.sort((a, b) => b.n - a.n) }
  ]
};

menu.gameCats = gamePlatforms.flatMap(p => p.cats);   // 同步鈕要抓的清單

writeFileSync(OUT, 'window.MENU = ' + JSON.stringify(menu) + ';\n', 'utf8');

const line = [];
line.push(`平台 ${gamePlatforms.length} 個｜遊戲片分類 ${menu.gameCats.length} 個｜遊戲片 ${sum(gamePlatforms, 'n').toLocaleString()} 筆（有貨 ${sum(gamePlatforms, 'ins').toLocaleString()}）`);
for (const g of menu.groups.slice(1)) line.push(`${g.label} ${g.items.length} 類／${sum(g.items, 'n').toLocaleString()} 筆`);
console.log(line.join('\n'));
console.log(`→ ${OUT}`);
