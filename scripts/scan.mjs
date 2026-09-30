#!/usr/bin/env node
// CeX MY 掃描器：查詢 → 條碼解碼 → 庫存分層 → 表格輸出
// 用法（免 CDP、免 key，直接跑）：
//   node scan.mjs --query "drakengard"
//   node scan.mjs --prefix 819976            # 廠商條碼前綴掃描（LRG 等）
//   node scan.mjs --query "x" --in-stock     # 只看有貨
// 2026-09-30 換裝：底層改用 cex-api.mjs（免 key 直連），不再需要瀏覽器分頁。

import { queryOne, params as buildParams } from './cex-api.mjs';

const ATTRS = ["boxName","categoryName","sellPrice","ecomQuantity","boxId","stores","firstStockDate"];

// ── 條碼 → 真實區域（GS1 公司前綴；見 references/method.md §2）──
const PUBLISHER = {
  "810148": "Limited Run Games (近期)", "819976": "Limited Run Games (早期)",
  "810100": "NIS America",
  "662248": "Square Enix US", "013388": "Capcom US", "045496": "Nintendo",
  "711719": "Sony", "494887": "日本/亞洲", "471084": "台灣", "471301": "台灣",
  "458217": "日本", "497436": "日本", "402062": "德國", "351289": "法國",
  "505506": "英國", "506026": "英國", "506069": "英國", "505663": "英國",
  "370057": "法國", "339189": "德國", "880956": "韓國", "880945": "韓國",
};
function decodeRegion(box) {
  const b = String(box || "");
  if (!/^\d+$/.test(b)) return ["?", ""];
  const p6 = b.slice(0, 6);
  if (PUBLISHER[p6]) return [PUBLISHER[p6], "pub:" + p6];
  if (b.length === 12) return ["北美 (UPC-A)", "upc"];
  if (b.length === 13) {
    if (/^4[59]/.test(b)) return ["日本/亞洲", "ean45"];
    if (b.startsWith("471")) return ["台灣", "ean471"];
    if (b.startsWith("88")) return ["韓國", "ean88"];
    if (b.startsWith("50")) return ["英國", "ean50"];
    if (/^4[0-4]/.test(b)) return ["德國", "ean40"];
    if (/^3[0-7]/.test(b)) return ["法國", "ean30"];
    return ["其他 EAN", "ean"];
  }
  return ["?", "len" + b.length];
}
// ── 庫存分層 ──
function tier(q) {
  if (q <= 0) return "缺貨";
  if (q <= 2) return "💎稀缺";
  if (q <= 9) return "▪️中等";
  return "🗑️清倉";
}

// ── 主流程 ──
const argv = process.argv.slice(2);
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const prefix = arg("--prefix");
const query = arg("--query");
const inStock = argv.includes("--in-stock");
if (!prefix && !query) { console.error("用法: node scan.mjs --query <關鍵字> | --prefix <條碼前綴> [--in-stock]"); process.exit(2); }

// ⚠️ Algolia 的 params 必須是 query string（不是 JSON），否則整串會被當成一個詞。
const p = buildParams({
  query: String(prefix ? prefix : query),
  hitsPerPage: 1000,
  attributes: ATTRS,
});
const hits = (await queryOne(p)).hits || [];

let rows = hits.map((h) => {
  const [region, how] = decodeRegion(h.boxId);
  return {
    tier: tier(h.ecomQuantity), q: h.ecomQuantity, price: h.sellPrice,
    plat: (h.categoryName || "").replace(" Games", ""), region, how,
    stores: (h.stores || []).length, box: h.boxId, name: h.boxName,
  };
});
if (prefix) rows = rows.filter((r) => String(r.box).startsWith(String(prefix)));
if (inStock) rows = rows.filter((r) => r.q > 0);

const order = { "💎稀缺": 0, "▪️中等": 1, "🗑️清倉": 2, "缺貨": 3 };
rows.sort((a, b) => (order[a.tier] - order[b.tier]) || (a.q - b.q) || (b.price - a.price));

console.log(`\n命中 ${rows.length} 筆  ${prefix ? "前綴=" + prefix : "關鍵字=" + query}\n`);
console.log("層級     庫存  價格    平台          真實區域(條碼)          分店  條碼            名稱");
console.log("─".repeat(120));
for (const r of rows) {
  console.log(
    `${r.tier.padEnd(7)} ${String(r.q).padStart(3)}  RM${String(r.price).padEnd(5)} ${r.plat.padEnd(14).slice(0,14)} ` +
    `${r.region.padEnd(22).slice(0,22)} ${String(r.stores).padStart(3)}  ${String(r.box).padEnd(15).slice(0,15)} ${r.name}`
  );
}
const byTier = rows.reduce((a, r) => (a[r.tier] = (a[r.tier] || 0) + 1, a), {});
console.log(`\n分布: ${Object.entries(byTier).map(([k, v]) => k + "=" + v).join("  ")}`);
