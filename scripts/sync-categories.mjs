// 同步 CeX MY 分類表 → references/catalog/categories.json
// 用法：node sync-categories.mjs
// 產出：所有分類（categoryId／名稱／精確筆數／superCat）+ 遊戲類清單（superCatName=Gaming）
// 目的：取代手寫 categoryId 表；人工只需維護「要監看哪些」。
import { discoverCategories } from './cex-api.mjs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'references', 'catalog', 'categories.json');

const d = await discoverCategories();
const gaming = d.categories.filter(c => c.superCatName === 'Gaming');
const payload = {
  generatedAt: new Date().toISOString(),
  source: 'search.webuy.io Algolia index prod_cex_my（免 key 直連）',
  note: 'nbHits 為精確值（每類各查一次）；facet 的估計值會低估約 1.2 萬筆（無 categoryId 的記錄）。',
  totalCategorized: d.totalFromCategories,
  superCats: d.superCats,
  gamingCategoryIds: gaming.map(c => c.categoryId),
  categories: d.categories,
};
writeFileSync(OUT, JSON.stringify(payload, null, 1));
console.log(`分類表已寫入 ${OUT}`);
console.log(`共 ${d.categories.length} 類｜精確合計 ${d.totalFromCategories} 筆｜遊戲類 ${gaming.length} 類 ${gaming.reduce((s, c) => s + c.nbHits, 0)} 筆`);
console.log('遊戲類前 8：' + gaming.slice(0, 8).map(c => `${c.categoryFriendlyName}=${c.nbHits}`).join(' | '));
