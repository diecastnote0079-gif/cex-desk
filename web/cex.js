/* CeX 資料層 — 2026-09-30
 *
 * 免 key、免後端、免瀏覽器外掛：直接 POST search.webuy.io 的 Algolia 索引（CORS 全開，實測 allow-origin: *）。
 * 實測（桌機）：抓全部遊戲片 16,202 筆 = 17 個請求、20.6 秒、打包 1.43 MB（gzip 0.38 MB）。
 *
 * 為什麼要自己切分：Algolia 單次 query 最多回 1000 筆，深頁無效（page=1 回 0），
 * 查詢參數 paginationLimitedTo 也不能覆蓋（實測 HTTP 400，官方訊息叫你用 index 設定或 browse）。
 * → 沿用 mirror.mjs 的做法：用「價格／庫存」等維度把大分類切成 ≤1000 筆的 shard（實測不漏筆數）。
 *
 * ⚠️ 分類過濾只能用 categoryFriendlyName（值帶冒號，如 "3DS Games: R2 ENG"）。
 *    categoryName 欄位存在但不能過濾，寫了會「HTTP 200 但回 0 筆」（2026-09-30 實測踩到）。
 */
(function (global) {
  'use strict';

  var EP = 'https://search.webuy.io/1/indexes/*/queries';
  var INDEX = 'prod_cex_my';
  var BASE = 'boxVisibilityOnWeb=1 AND boxSaleAllowed=1 AND sellPrice > 0';
  var PAGE = 1000;
  var PACE = 700;            // 自律節流（社群慣例 ≤1 req/s）
  var BATCH_SPLIT = 20;      // 一批幾個「切分」查詢
  var BATCH_FETCH = 6;       // 一批幾個「取件」查詢
  var RETRY = 3;

  // 回傳欄位（只留頁面真的會顯示的，控制下載量）→ 輸出格式與 items.json 相同
  var FIELDS = ['boxId', 'boxName', 'categoryFriendlyName', 'sellPrice',
    'cashPriceCalculated', 'collectionQuantity', 'firstStockDate', 'collectionStores'];
  var COLS = ['boxId', 'name', 'cat', 'price', 'cash', 'qty', 'stores', 'first'];

  var DIMS = [
    { attr: 'sellPrice', lo: 0, hi: 100000 },
    { attr: 'collectionQuantity', lo: 0, hi: 10000 },
    { attr: 'priceLastChanged_timestamp', lo: 0, hi: 3000000000 },
    { attr: 'ecomQuantity', lo: 0, hi: 10000 }
  ];

  var lastAt = 0;
  var stats = { posts: 0, queries: 0, chars: 0 };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  async function pace() {
    var wait = PACE - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
  }

  async function post(requests, onProgress) {
    var lastErr = null;
    for (var attempt = 1; attempt <= RETRY; attempt++) {
      try {
        await pace();
        stats.posts++;
        var res = await fetch(EP, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: requests })
        });
        if (res.status === 429) {
          var wait429 = 2000 * attempt;
          if (onProgress) onProgress({ note: '429 退讓中 ' + wait429 + 'ms' });
          await sleep(wait429);
          lastErr = new Error('429 Too Many Requests');
          continue;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var text = await res.text();
        stats.chars += text.length;
        var j = JSON.parse(text);
        if (j.message) throw new Error('Algolia: ' + j.message);
        if (!Array.isArray(j.results)) throw new Error('回應沒有 results（端點可能變了）');
        stats.queries += requests.length;
        return j.results;
      } catch (e) {
        lastErr = e;
        await sleep(500 * attempt);
      }
    }
    // 絕不把失敗當成「0 筆」
    throw new Error('CeX 查詢失敗（試了 ' + RETRY + ' 次）：' + (lastErr ? lastErr.message : '未知'));
  }

  function filterOf(cat, ranges) {
    var parts = [BASE];
    if (cat) parts.push('categoryFriendlyName:"' + cat + '"');
    for (var i = 0; i < ranges.length; i++) {
      parts.push(ranges[i].attr + ' >= ' + ranges[i].lo + ' AND ' + ranges[i].attr + ' < ' + ranges[i].hi);
    }
    return parts.join(' AND ');
  }

  function median(arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  }

  function childrenOf(it, res) {
    for (var i = it.ranges.length - 1; i >= 0; i--) {
      var r = it.ranges[i];
      var vals = (res.hits || []).map(function (h) { return h[r.attr]; })
        .filter(function (v) { return typeof v === 'number'; });
      var med = median(vals);
      if (med > r.lo && med < r.hi) {
        var mk = function (patch) {
          return {
            cat: it.cat,
            ranges: it.ranges.slice(0, i).concat([Object.assign({}, r, patch)], it.ranges.slice(i + 1))
          };
        };
        return [mk({ hi: med }), mk({ lo: med })];
      }
    }
    var used = {};
    it.ranges.forEach(function (r) { used[r.attr] = 1; });
    for (var k = 0; k < DIMS.length; k++) {
      if (!used[DIMS[k].attr]) {
        var next = { cat: it.cat, ranges: it.ranges.concat([DIMS[k]]) };
        return [next];
      }
    }
    return null;
  }

  var splitParams = function (it) {
    return 'query=&filters=' + encodeURIComponent(filterOf(it.cat, it.ranges)) +
      '&hitsPerPage=' + PAGE + '&attributesToRetrieve=' + DIMS.map(function (d) { return d.attr; }).join(',');
  };

  /** 把一組分類切成每個 ≤1000 筆的 shard */
  async function splitShards(cats, report) {
    var frontier = cats.map(function (c) { return { cat: c, ranges: [] }; });
    var shards = [];
    var round = 0;
    while (frontier.length) {
      round++;
      var got = [];
      for (var i = 0; i < frontier.length; i += BATCH_SPLIT) {
        var batch = frontier.slice(i, i + BATCH_SPLIT);
        var res = await post(batch.map(function (it) { return { indexName: INDEX, params: splitParams(it) }; }));
        for (var k = 0; k < res.length; k++) got.push({ it: batch[k], r: res[k] });
      }
      var next = [];
      for (var g = 0; g < got.length; g++) {
        var it = got[g].it, r = got[g].r, n = r.nbHits || 0;
        if (n <= PAGE) { it.n = n; shards.push(it); continue; }
        var kids = childrenOf(it, r);
        if (!kids) { it.n = n; shards.push(it); }   // 切不下去就照抓（不會漏，只是可能被截）
        else next = next.concat(kids);
      }
      if (report) report({ phase: 'split', round: round, done: shards.length, pending: next.length });
      frontier = next;
    }
    return shards;
  }

  function rowsOf(hits) {
    return hits.map(function (h) {
      return [
        h.boxId, h.boxName, h.categoryFriendlyName,
        h.sellPrice || 0, h.cashPriceCalculated || 0,
        h.collectionQuantity || 0,
        (h.collectionStores || []).length,
        h.firstStockDate || ''
      ];
    });
  }

  /** 抓一個分類（或一組分類）的全部商品，回傳 { cols, items } */
  async function fetchCategories(cats, report) {
    cats = (typeof cats === 'string') ? [cats] : cats;
    var t0 = Date.now();
    var posts0 = stats.posts;
    var shards = await splitShards(cats, report);
    var rows = [];
    var doneShards = 0, mismatches = [];
    for (var i = 0; i < shards.length; i += BATCH_FETCH) {
      var batch = shards.slice(i, i + BATCH_FETCH);
      var res = await post(batch.map(function (it) {
        return {
          indexName: INDEX,
          params: 'query=&filters=' + encodeURIComponent(filterOf(it.cat, it.ranges)) +
            '&hitsPerPage=' + PAGE + '&attributesToRetrieve=' + FIELDS.join(',')
        };
      }));
      for (var k = 0; k < res.length; k++) {
        var hits = res[k].hits || [];
        if (hits.length !== batch[k].n) {
          mismatches.push({ cat: batch[k].cat, expect: batch[k].n, got: hits.length });
        }
        rows = rows.concat(rowsOf(hits));
        doneShards++;
      }
      if (report) {
        report({
          phase: 'fetch', done: doneShards, total: shards.length,
          items: rows.length, posts: stats.posts, secs: (Date.now() - t0) / 1000
        });
      }
    }
    return { cols: COLS, items: rows, posts: stats.posts - posts0, secs: (Date.now() - t0) / 1000, mismatches: mismatches };
  }

  /** 通用即時查詢：回傳 hits（給搜尋、單一分類、非遊戲片分類用） */
  async function query(opts) {
    opts = opts || {};
    var filters = BASE;
    if (opts.cat) filters += ' AND categoryFriendlyName:"' + opts.cat + '"';
    if (opts.inStockOnly) filters += ' AND collectionQuantity > 0';
    var params = 'query=' + encodeURIComponent(opts.q || '') +
      '&filters=' + encodeURIComponent(filters) +
      '&hitsPerPage=' + (opts.limit || 300) +
      '&attributesToRetrieve=' + FIELDS.join(',');
    var res = await post([{ indexName: INDEX, params: params }]);
    var r = res[0] || {};
    return { hits: r.hits || [], nbHits: r.nbHits || 0 };
  }

  global.CEX = {
    COLS: COLS,
    stats: stats,
    query: query,
    fetchCategories: fetchCategories,
    /** 一次抓完全部遊戲片（阿夜要的「同步」按鈕） */
    syncGames: function (cats, report) { return fetchCategories(cats, report); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
