// 變動事件的**判定規則單一來源**（電腦與手機共用）
//
// 為什麼要有這支：伺服器端的 `ledger.mjs` 是用 SQL 寫的（跑在 SQLite 上），手機端是瀏覽器裡的 JS。
// 兩邊各寫一份判定邏輯 → 遲早漂移（同一筆變動，電腦說有、手機說沒有）。所以規則集中在這裡：
//  ・伺服器：`ledger-parity.mjs` 拿它跟 SQL 的結果**每天對帳**（逐事件比數量，不一致就告警）
//  ・手機：瀏覽器直接 import 這一支同一個檔（發布流程會把它複製到 web/）
//
// 規則必須與 `ledger.mjs` 的 SQL 區塊**逐條對應**（含 NULL 語義），改這裡就要同步想 SQL 那份。
//
// ⚠️ 零依賴、不碰 Node／DOM API（瀏覽器要能直接跑）。
//
// 用法：
//   const events = diffRows(prevRows, curRows);              // 全部事件
//   const events = diffRows(prev, cur, { fields: { stores: false, status: false } });  // 手機：只算拿得到的欄位

/** 事件定義：key → { label, field, test(p, c) }。順序與 ledger.mjs 的 SQL 區塊一致。 */
export const RULES = [
  { key: 'NEW', label: '新增（上次沒有這個 box_id）', field: '', test: (p, c) => !p && !!c },
  { key: 'GONE', label: '消失（賣掉／下架）', field: '', test: (p, c) => !!p && !c },
  { key: 'PRICE_UP', label: '改價：調漲', field: 'price', test: (p, c) => num(p.price) !== null && num(c.price) !== null && num(c.price) > num(p.price) },
  { key: 'PRICE_DOWN', label: '改價：調降', field: 'price', test: (p, c) => num(p.price) !== null && num(c.price) !== null && num(c.price) < num(p.price) },
  { key: 'RESTOCK', label: '回架（0 → 有貨）', field: 'qty', test: (p, c) => num(p.qty) === 0 && num(c.qty) > 0 },
  { key: 'SOLD_OUT', label: '賣光（有貨 → 0）', field: 'qty', test: (p, c) => num(p.qty) > 0 && num(c.qty) === 0 },
  { key: 'QTY_UP', label: '庫存增加（>0，非回架）', field: 'qty', test: (p, c) => num(p.qty) > 0 && num(c.qty) > num(p.qty) },
  { key: 'QTY_DOWN', label: '庫存減少（>0，非賣光）', field: 'qty', test: (p, c) => num(p.qty) > 0 && num(c.qty) > 0 && num(c.qty) < num(p.qty) },
  { key: 'FLOOR_CHANGE', label: '保底價變動（CeX 買取價）', field: 'cash', test: (p, c) => isNot(p.cash, c.cash) },
  { key: 'STORE_CHANGE', label: '上架分店變動', field: 'stores', test: (p, c) => isNot(p.stores, c.stores) },
  { key: 'STATUS_CHANGE', label: '狀態變動（停產／可買可賣旗標）', field: 'status', test: (p, c) => isNot(statusKey(p), statusKey(c)) },
];

/** 欄位開關：哪些欄位這一端拿得到（拿不到就不要產生該事件，不要假裝有比） */
export const DEFAULT_FIELDS = { price: true, qty: true, cash: true, stores: true, status: true };

const num = v => (v === null || v === undefined || v === '' ? null : Number(v));
/** SQL 的 `IS NOT`：NULL-safe 不等於（NULL vs NULL＝false；NULL vs 值＝true） */
function isNot(a, b) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return false;
  if (an !== bn) return true;
  return String(a) !== String(b);
}
const statusKey = r => {
  if (!r) return null;
  const d = r.discontinued, b = r.buyAllowed;
  if (d === null || d === undefined) return (b === null || b === undefined) ? null : 'disc=? buy=' + b;
  return `disc=${d} buy=${b === null || b === undefined ? '?' : b}`;
};

/**
 * 比對兩份快照，回傳變動事件。
 * @param {Array} prevRows 上一次的列（每列要有 boxId／price／qty／cash／stores／discontinued／buyAllowed）
 * @param {Array} curRows  這一次的列
 * @param {{fields?: object}} [opts]
 * @returns {Array<{event, boxId, name, cat, field, oldValue, newValue, first}>}
 */
export function diffRows(prevRows, curRows, opts = {}) {
  const fields = { ...DEFAULT_FIELDS, ...(opts.fields || {}) };
  const prev = new Map((prevRows || []).map(r => [String(r.boxId), r]));
  const cur = new Map((curRows || []).map(r => [String(r.boxId), r]));
  const out = [];
  const push = (rule, p, c) => {
    if (rule.field && fields[rule.field] === false) return;
    const src = c || p;
    out.push({
      event: rule.key, boxId: String((c || p).boxId),
      name: src.name ?? null, cat: src.cat ?? src.categoryFriendlyName ?? null,
      field: rule.field, first: src.first ?? src.firstStockDate ?? null,
      oldValue: oldVal(rule, p), newValue: newVal(rule, c, p),
    });
  };
  // 以 cur 為主掃一遍（含 NEW／改價／庫存），再補 GONE
  for (const [boxId, c] of cur) {
    const p = prev.get(boxId) || null;
    for (const rule of RULES) {
      if (rule.key === 'GONE') continue;      // GONE 在下面單獨處理
      if (rule.key === 'NEW') { if (rule.test(p, c)) push(rule, p, c); continue; }
      if (!p) continue;                        // 沒有前一份可比
      if (rule.test(p, c)) push(rule, p, c);
    }
  }
  for (const [boxId, p] of prev) {
    if (cur.has(boxId)) continue;
    push(RULES.find(r => r.key === 'GONE'), p, null);
  }
  return out;
}

function oldVal(rule, p) {
  if (!p) return null;
  if (rule.field === 'price') return p.price ?? null;
  if (rule.field === 'qty') return rule.key === 'RESTOCK' ? 0 : (p.qty ?? null);
  if (rule.field === 'cash') return p.cash ?? null;
  if (rule.field === 'stores') return p.stores ?? null;
  if (rule.field === 'status') return statusKey(p);
  return null;
}
function newVal(rule, c, p) {
  if (!c) return null;
  if (rule.field === 'price') return c.price ?? null;
  if (rule.field === 'qty') return rule.key === 'SOLD_OUT' ? 0 : (c.qty ?? null);
  if (rule.field === 'cash') return c.cash ?? null;
  if (rule.field === 'stores') return c.stores ?? null;
  if (rule.field === 'status') return statusKey(c);
  return null;
}

/** 逐事件計數（對帳用） */
export function countByEvent(events) {
  const n = {};
  for (const e of events) n[e.event] = (n[e.event] || 0) + 1;
  return n;
}
