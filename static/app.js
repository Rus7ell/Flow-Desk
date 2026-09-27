const state = { filter: "all", loading: false, data: null, expanded: null };
const pointers = new Map();
let drawQueued = false;

const FILTERS = [
  ["all", "All"],
  ["aligned_bullish", "Aligned up"],
  ["aligned_bearish", "Aligned down"],
  ["mixed", "Mixed"],
];

const deskEl = document.querySelector("#desk");
const summaryEl = document.querySelector("#summary");
const filtersEl = document.querySelector("#filters");
const railEl = document.querySelector("#rail");
const stampEl = document.querySelector("#stamp");
const refreshBtn = document.querySelector("#refresh");

refreshBtn.addEventListener("click", () => load(true));

function esc(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function priceDigits(reference) {
  const abs = Math.abs(reference || 0);
  if (abs >= 100) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.1) return 4;
  return 6;
}

function formatPrice(value, reference) {
  if (value == null || Number.isNaN(value)) return "—";
  const digits = priceDigits(reference == null ? value : reference);
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

function formatQuote(value) {
  if (value == null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatIndicator(value) {
  if (value == null || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : 6;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function formatDist(pct) {
  if (pct == null) return "—";
  const sign = pct > 0 ? "+" : "";
  if (Math.abs(pct) < 0.1) return `${sign}${(pct * 100).toFixed(0)} bps`;
  return `${sign}${pct.toFixed(2)}%`;
}

function formatPct(ratio) {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(0)}%`;
}

function matches(coin) {
  if (state.filter === "all") return true;
  if (coin.error) return false;
  return coin.alignment.bias === state.filter;
}

function renderFilters() {
  filtersEl.innerHTML = FILTERS.map(([id, label]) => {
    const pressed = state.filter === id ? "true" : "false";
    return `<button type="button" class="chip" data-filter="${id}" aria-pressed="${pressed}">${label}</button>`;
  }).join("");
  filtersEl.querySelectorAll(".chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      render({ keepScroll: false });
    });
  });
}

function renderRail(coins) {
  const visible = coins.filter(matches);
  railEl.innerHTML = visible.map((coin) => (
    `<a href="#coin-${esc(coin.base)}" data-coin="${esc(coin.base)}">${esc(coin.base)}</a>`
  )).join("");
}

function renderSummary(data) {
  summaryEl.textContent = data.summary || "";
  const when = new Date(data.generated_at);
  const clock = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const age = data.age_seconds ? ` · cached ${data.age_seconds}s` : "";
  const stale = data.stale ? " · last good read" : "";
  stampEl.textContent = clock ? `Updated ${clock}${age}${stale}` : "Updated";
}

const CHART_FRAMES = [
  ["15m", "15m", "15 minute"],
  ["1h", "1h", "1 hour"],
  ["4h", "4h", "4 hour"],
  ["1d", "1D", "1 day"],
];

function frameLabel(interval) {
  return CHART_FRAMES.find((frame) => frame[0] === interval)?.[2] || "4 hour";
}

function formatAxisTime(ms, interval) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  if (interval === "1d") return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  if (interval === "15m" || interval === "1h") {
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" });
}

function profileRows(coin) {
  const chart = coin.chart || {};
  const profile = chart.profile || [];
  return profile.length ? profile : (chart.heatmap || []);
}

function flowRows(coin) {
  const flow = (coin.chart || {}).flow || [];
  return flow.length ? flow : profileRows(coin);
}

function chartBounds(coin) {
  const candles = (coin.chart || {}).candles || [];
  const rows = [...profileRows(coin), ...flowRows(coin)];
  const levels = ((coin.chart || {}).levels || []).map((level) => level.price);
  const highs = [
    ...candles.map((candle) => candle.h),
    ...levels,
    ...rows.map((row) => row.high),
  ];
  const lows = [
    ...candles.map((candle) => candle.l),
    ...levels,
    ...rows.map((row) => row.low),
  ];
  let fullMax = Math.max(...highs);
  let fullMin = Math.min(...lows);
  const span = fullMax - fullMin || Math.abs(fullMax) || 1;
  fullMax += span * 0.045;
  fullMin -= span * 0.045;
  const last = candles.length ? candles[candles.length - 1].c : (fullMin + fullMax) / 2;
  let bookMin = null;
  let bookMax = null;
  if (rows.length) {
    const rawMax = Math.max(...rows.map((row) => row.high));
    const rawMin = Math.min(...rows.map((row) => row.low));
    const bookSpan = Math.max(rawMax - rawMin, Math.abs(last) * 0.0008);
    bookMax = rawMax + bookSpan * 0.06;
    bookMin = rawMin - bookSpan * 0.06;
  }
  return { fullMin, fullMax, bookMin, bookMax, last };
}

function clampWindow(min, max, bounds) {
  const fullSpan = bounds.fullMax - bounds.fullMin || 1;
  const minSpan = Math.max(fullSpan / 56, Math.abs(bounds.last || 1) * 0.00025);
  let span = Math.max(minSpan, Math.min(fullSpan, max - min));
  const mid = (min + max) / 2;
  min = mid - span / 2;
  max = mid + span / 2;
  if (min < bounds.fullMin) {
    max += bounds.fullMin - min;
    min = bounds.fullMin;
  }
  if (max > bounds.fullMax) {
    min -= max - bounds.fullMax;
    max = bounds.fullMax;
  }
  min = Math.max(bounds.fullMin, min);
  max = Math.min(bounds.fullMax, max);
  if (max - min < minSpan) {
    const center = (min + max) / 2;
    min = Math.max(bounds.fullMin, center - minSpan / 2);
    max = Math.min(bounds.fullMax, min + minSpan);
  }
  return { min, max };
}

function focusWindow(bounds) {
  if (bounds.bookMin == null) return { min: bounds.fullMin, max: bounds.fullMax };
  const fullSpan = bounds.fullMax - bounds.fullMin;
  const mid = (bounds.bookMin + bounds.bookMax) / 2;
  const bookSpan = Math.max(bounds.bookMax - bounds.bookMin, Math.abs(bounds.last) * 0.0015);
  const span = Math.min(fullSpan, bookSpan * 1.08);
  let min = mid - span / 2;
  let max = mid + span / 2;
  if (bounds.last < min || bounds.last > max) {
    min = Math.min(min, bounds.last - span * 0.12);
    max = Math.max(max, bounds.last + span * 0.12);
  }
  return clampWindow(min, max, bounds);
}

function orderPeaks(rows) {
  const ordered = [...rows].sort((left, right) => left.price - right.price);
  const indexes = [];
  let start = 0;
  while (start < ordered.length) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].notional === ordered[start].notional) end += 1;
    const before = start > 0 ? ordered[start - 1].notional : -Infinity;
    const after = end + 1 < ordered.length ? ordered[end + 1].notional : -Infinity;
    if (ordered[start].notional > before && ordered[start].notional > after) {
      indexes.push(Math.floor((start + end) / 2));
    }
    start = end + 1;
  }
  const largest = Math.max(...ordered.map((row) => row.notional), 1);
  return indexes
    .map((index) => ordered[index])
    .filter((row) => row.notional >= largest * 0.18);
}

function mergeHistory(older, fresh) {
  const byTime = new Map();
  for (const candle of older || []) byTime.set(candle.t, candle);
  for (const candle of fresh || []) byTime.set(candle.t, candle);
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

function carryCharts(previous, incoming) {
  if (!previous) return;
  const prior = new Map();
  const remember = (item) => {
    if (!item?.chart || !item.base) return;
    const frames = { ...(item.chart.frames || {}) };
    if (item.chart.history?.length) frames["4h"] = item.chart.history;
    if (Object.keys(frames).length) prior.set(`${item.market || "spot"}:${item.base}`, frames);
  };
  for (const coin of previous.coins || []) {
    remember(coin);
    remember(coin.etf);
  }
  const apply = (item) => {
    if (!item?.chart || !item.base) return;
    const oldFrames = prior.get(`${item.market || "spot"}:${item.base}`);
    if (!oldFrames) return;
    item.chart.frames = item.chart.frames || {};
    for (const [interval, oldHist] of Object.entries(oldFrames)) {
      const fresh = interval === "4h" ? item.chart.history : item.chart.frames[interval];
      const merged = mergeHistory(oldHist, fresh);
      item.chart.frames[interval] = merged;
      if (interval === "4h") item.chart.history = merged;
      const open = state.expanded;
      const sameChart = open
        && open.base === item.base
        && (open.market || "spot") === (item.market || "spot")
        && (open.interval || "4h") === interval;
      const addedFront = merged.findIndex((candle) => candle.t === oldHist[0]?.t);
      if (sameChart && addedFront > 0) {
        open.start += addedFront;
        open.end += addedFront;
        if (open.drag) {
          open.drag.start += addedFront;
          open.drag.end += addedFront;
        }
        if (open.pinch) {
          open.pinch.start += addedFront;
          open.pinch.end += addedFront;
        }
      }
    }
  };
  for (const coin of incoming.coins || []) {
    apply(coin);
    apply(coin.etf);
  }
}

function activeInterval(coin) {
  const open = state.expanded;
  if (!open || !coin) return "4h";
  if (open.base === coin.base && (open.market || "spot") === (coin.market || "spot")) return open.interval || "4h";
  return "4h";
}

function frameCandles(coin, interval) {
  const chart = coin.chart || (coin.chart = {});
  if (!chart.frames) chart.frames = {};
  const key = interval || "4h";
  if (key === "4h") {
    if (chart.frames["4h"]?.length) {
      chart.history = chart.frames["4h"];
      return chart.frames["4h"];
    }
    if (Array.isArray(chart.history) && chart.history.length) {
      chart.frames["4h"] = chart.history;
      return chart.history;
    }
    chart.history = (chart.candles || []).map((candle) => ({ ...candle }));
    chart.frames["4h"] = chart.history;
    return chart.history;
  }
  return chart.frames[key] || [];
}

function historyCandles(coin) {
  return frameCandles(coin, activeInterval(coin));
}

function buildFlow(candles) {
  const binCount = 480;
  if (candles.length < 2) return [];
  let low = Infinity;
  let high = -Infinity;
  for (const candle of candles) {
    if (candle.l < low) low = candle.l;
    if (candle.h > high) high = candle.h;
  }
  const span = high - low;
  if (!(span > 0)) return [];
  const step = span / binCount;
  const bins = Array.from({ length: binCount }, (_, index) => ({
    low: low + index * step,
    high: low + (index + 1) * step,
    buy: 0,
    sell: 0,
  }));
  for (const candle of candles) {
    const total = Number(candle.quote_volume) || 0;
    if (total <= 0) continue;
    const buy = Math.min(total, Number(candle.taker_buy_quote) || 0);
    const sell = total - buy;
    const candleLow = Number(candle.l);
    const candleHigh = Number(candle.h);
    const candleSpan = candleHigh - candleLow;
    if (candleSpan <= 0) {
      const index = Math.min(binCount - 1, Math.max(0, Math.floor((candleLow - low) / step)));
      bins[index].buy += buy;
      bins[index].sell += sell;
      continue;
    }
    let first = Math.max(0, Math.floor((candleLow - low) / step));
    let last = Math.min(binCount - 1, Math.floor((candleHigh - low) / step));
    if (candleHigh <= bins[last].low && last > first) last -= 1;
    for (let index = first; index <= last; index += 1) {
      const item = bins[index];
      const overlap = Math.min(candleHigh, item.high) - Math.max(candleLow, item.low);
      if (overlap <= 0) continue;
      const share = overlap / candleSpan;
      item.buy += buy * share;
      item.sell += sell * share;
    }
  }
  const populated = bins.filter((item) => item.buy + item.sell > 0);
  if (!populated.length) return [];
  const largest = Math.max(...populated.map((item) => item.buy + item.sell)) || 1;
  const profile = [];
  for (const item of populated) {
    const notional = item.buy + item.sell;
    if (notional < largest * 0.0012) continue;
    let side = "mixed";
    if (item.buy > item.sell * 1.15) side = "buy";
    else if (item.sell > item.buy * 1.15) side = "sell";
    profile.push({
      low: item.low,
      high: item.high,
      price: (item.low + item.high) / 2,
      notional,
      side,
    });
  }
  return profile;
}

function ensureFlow(coin, candles) {
  const chart = coin.chart || {};
  const first = candles[0]?.t;
  const last = candles[candles.length - 1]?.t;
  const cache = chart._flow;
  if (cache && cache.n === candles.length && cache.first === first && cache.last === last) return cache.rows;
  const built = buildFlow(candles);
  const rows = built.length ? built : (activeInterval(coin) === "4h" ? flowRows(coin) : []);
  chart._flow = { n: candles.length, first, last, rows };
  return rows;
}

function detectSwings(candles) {
  const left = 3;
  const right = 3;
  const swings = [];
  if (candles.length < left + right + 1) return swings;
  for (let index = left; index < candles.length - right; index += 1) {
    let leftHigh = -Infinity;
    let rightHigh = -Infinity;
    let leftLow = Infinity;
    let rightLow = Infinity;
    for (let pos = index - left; pos < index; pos += 1) {
      leftHigh = Math.max(leftHigh, candles[pos].h);
      leftLow = Math.min(leftLow, candles[pos].l);
    }
    for (let pos = index + 1; pos <= index + right; pos += 1) {
      rightHigh = Math.max(rightHigh, candles[pos].h);
      rightLow = Math.min(rightLow, candles[pos].l);
    }
    if (candles[index].h > leftHigh && candles[index].h >= rightHigh) {
      swings.push({ index, price: candles[index].h, type: "high" });
    }
    if (candles[index].l < leftLow && candles[index].l <= rightLow) {
      swings.push({ index, price: candles[index].l, type: "low" });
    }
  }
  swings.sort((a, b) => a.index - b.index || (a.type === "high" ? -1 : 1));
  let lastHigh = null;
  let lastLow = null;
  for (const swing of swings) {
    if (swing.type === "high") {
      if (lastHigh != null) {
        swing.relation = swing.price > lastHigh ? "HH" : swing.price < lastHigh ? "LH" : "EH";
      }
      lastHigh = swing.price;
    } else {
      if (lastLow != null) {
        swing.relation = swing.price > lastLow ? "HL" : swing.price < lastLow ? "LL" : "EL";
      }
      lastLow = swing.price;
    }
  }
  for (const side of ["high", "low"]) {
    const matching = swings.filter((swing) => swing.type === side && swing.relation);
    for (const swing of matching.slice(0, -3)) swing.relation = null;
  }
  return swings;
}

function ensureSwings(coin, candles) {
  const chart = coin.chart || {};
  const first = candles[0]?.t;
  const cache = chart._swings;
  if (cache && cache.n === candles.length && cache.first === first) return cache.rows;
  const rows = detectSwings(candles);
  chart._swings = { n: candles.length, first, rows };
  return rows;
}

function candleExtent(candles) {
  let min = Infinity;
  let max = -Infinity;
  for (const candle of candles) {
    if (candle.l < min) min = candle.l;
    if (candle.h > max) max = candle.h;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

function loadedExtent(coin) {
  const candles = historyCandles(coin);
  const flow = ensureFlow(coin, candles);
  const book = profileRows(coin);
  const extent = candleExtent(candles);
  const highs = [...flow.map((row) => row.high), ...book.map((row) => row.high)];
  const lows = [...flow.map((row) => row.low), ...book.map((row) => row.low)];
  if (extent) {
    highs.push(extent.max);
    lows.push(extent.min);
  }
  if (!highs.length) return extent;
  return { min: Math.min(...lows), max: Math.max(...highs) };
}

function fitPrice(min, max, coin, extent) {
  const anchor = Math.abs(coin.price || extent?.max || 1);
  const minSpan = anchor * 0.00035;
  if (!(max > min)) {
    const mid = Number.isFinite(min) ? min : anchor;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  if (max - min < minSpan) {
    const mid = (min + max) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
  }
  if (extent) {
    const dataSpan = Math.max(extent.max - extent.min, minSpan);
    const slack = Math.max(dataSpan * 0.75, (max - min) * 0.85);
    if (max > extent.max + slack) {
      const shift = max - (extent.max + slack);
      min -= shift;
      max -= shift;
    }
    if (min < extent.min - slack) {
      const shift = extent.min - slack - min;
      min += shift;
      max += shift;
    }
  }
  return { min, max };
}

function fitTime(start, end, length) {
  const count = Math.max(length, 1);
  let span = end - start;
  const minSpan = Math.min(18, count);
  const maxSpan = Math.max(minSpan, count + 80);
  if (!(span > 0)) span = Math.min(140, count);
  if (span < minSpan) {
    const mid = (start + end) / 2;
    start = mid - minSpan / 2;
    end = mid + minSpan / 2;
    span = minSpan;
  } else if (span > maxSpan) {
    const mid = (start + end) / 2;
    start = mid - maxSpan / 2;
    end = mid + maxSpan / 2;
    span = maxSpan;
  }
  const slack = Math.max(48, span * 0.85);
  if (end > count + slack) {
    const shift = end - (count + slack);
    start -= shift;
    end -= shift;
  }
  if (start < -slack) {
    const shift = -slack - start;
    start += shift;
    end += shift;
  }
  return { start, end };
}

function expandedHome(coin) {
  const candles = historyCandles(coin);
  const count = Math.min(36, candles.length);
  const start = Math.max(0, candles.length - count);
  const end = candles.length;
  const book = profileRows(coin);
  const slice = candles.slice(start, end);
  const highs = slice.map((candle) => candle.h);
  const lows = slice.map((candle) => candle.l);
  if (book.length) {
    highs.push(...book.map((row) => row.high));
    lows.push(...book.map((row) => row.low));
  }
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const span = max - min || Math.abs(coin.price) * 0.01 || 1;
  min -= span * 0.1;
  max += span * 0.1;
  return { start, end, min, max };
}

function mountainPath(ordered, yOf, reach, baseline) {
  if (!ordered.length) return "";
  const ridge = [[baseline, yOf(ordered[0].high)]];
  ordered.forEach((row, index) => {
    if (index > 0) {
      const gapTop = yOf(ordered[index - 1].low);
      const gapBottom = yOf(row.high);
      if (gapBottom - gapTop > 1.25) {
        ridge.push([baseline, gapTop]);
        ridge.push([baseline, gapBottom]);
      }
    }
    const xOut = reach(row);
    ridge.push([xOut, yOf(row.high)]);
    ridge.push([xOut, yOf(row.low)]);
  });
  ridge.push([baseline, yOf(ordered[ordered.length - 1].low)]);
  return ridge.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(" ");
}

function sideWord(side) {
  if (side === "bid") return "bids";
  if (side === "ask") return "asks";
  if (side === "buy") return "buys";
  if (side === "sell") return "sells";
  return "mixed";
}

function renderChart(coin, view, mode) {
  const chart = coin.chart || {};
  const expanded = mode === "expanded";
  const candles = expanded ? historyCandles(coin) : (chart.candles || []);
  const swings = expanded ? ensureSwings(coin, candles) : (chart.swings || []);
  const bookRows = profileRows(coin);
  const flow = expanded ? ensureFlow(coin, candles) : flowRows(coin);
  const width = expanded ? 1220 : 1100;
  const height = expanded ? 640 : 400;
  const pad = expanded ? { t: 18, b: 42, l: 78 } : { t: 16, b: 40, l: 68 };
  const detailW = expanded ? 360 : 320;
  const heatW = expanded ? 188 : 118;
  const gap = 16;
  const candleRight = width - detailW - heatW - gap;
  const plotH = height - pad.t - pad.b;
  const plotW = candleRight - pad.l;
  const start = view.start == null ? 0 : view.start;
  const end = view.end == null ? candles.length : view.end;
  const span = (end - start) || 1;
  const slot = plotW / span;
  const y = (price) => pad.t + ((view.max - price) / ((view.max - view.min) || 1)) * plotH;
  const x = (index) => pad.l + ((index - start) / span) * plotW + slot / 2;
  const axisY = height - pad.b;
  let body = "";
  const clipId = `plot-${coin.base}-${mode}`;
  body += `<defs><clipPath id="${clipId}"><rect x="${pad.l}" y="${pad.t}" width="${(width - pad.l - 8).toFixed(1)}" height="${plotH.toFixed(1)}"/></clipPath></defs>`;
  body += `<rect x="${pad.l}" y="${pad.t}" width="${(candleRight - pad.l).toFixed(1)}" height="${plotH.toFixed(1)}" fill="rgba(18,22,17,0.35)" rx="8"/>`;

  const tickCount = expanded ? 6 : 4;
  for (let tick = 1; tick < tickCount; tick += 1) {
    const price = view.max - (view.max - view.min) * (tick / tickCount);
    const lineY = y(price);
    body += `<line x1="${pad.l}" y1="${lineY.toFixed(1)}" x2="${(width - 8).toFixed(1)}" y2="${lineY.toFixed(1)}" stroke="rgba(244,241,232,0.06)"/>`;
    body += `<text x="${(pad.l - 8).toFixed(1)}" y="${(lineY + 4).toFixed(1)}" text-anchor="end" fill="#9a9486" font-size="${expanded ? 12 : 10}">${esc(formatPrice(price, coin.price))}</text>`;
  }

  body += `<g clip-path="url(#${clipId})">`;
  const firstVisible = Math.max(0, Math.floor(start) - 1);
  const lastVisible = Math.min(candles.length - 1, Math.ceil(end) + 1);
  for (let index = firstVisible; index <= lastVisible; index += 1) {
    const candle = candles[index];
    if (!candle) continue;
    const up = candle.c >= candle.o;
    const color = up ? "#8fceab" : "#e39b8b";
    const center = x(index);
    const barW = Math.max(1.4, Math.min(slot * 0.62, 14));
    const top = y(Math.max(candle.o, candle.c));
    const bottom = y(Math.min(candle.o, candle.c));
    body += `<line x1="${center.toFixed(2)}" y1="${y(candle.h).toFixed(2)}" x2="${center.toFixed(2)}" y2="${y(candle.l).toFixed(2)}" stroke="${color}" stroke-width="1"/>`;
    body += `<rect x="${(center - barW / 2).toFixed(2)}" y="${Math.min(top, bottom).toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(1, Math.abs(bottom - top)).toFixed(2)}" fill="${color}"/>`;
  }

  for (const type of ["high", "low"]) {
    const points = swings.filter((swing) => swing.type === type);
    if (points.length < 2) continue;
    const path = points.map((swing, index) => `${index ? "L" : "M"}${x(swing.index).toFixed(1)},${y(swing.price).toFixed(1)}`).join(" ");
    body += `<path d="${path}" fill="none" stroke="${type === "high" ? "#e6b15c" : "#d5d0c4"}" stroke-width="1.2" opacity="0.75"/>`;
  }

  const swingLabels = [];
  for (const type of ["high", "low"]) {
    const visible = swings.filter((swing) => {
      if (swing.type !== type || !swing.relation) return false;
      const center = x(swing.index);
      return center >= pad.l && center <= candleRight;
    });
    swingLabels.push(...visible.slice(-2));
  }
  for (const swing of swingLabels) {
    const center = x(swing.index);
    if (center < pad.l || center > candleRight) continue;
    const lineY = y(swing.price);
    if (lineY < pad.t + 8 || lineY > axisY - 8) continue;
    const labelY = swing.type === "high" ? lineY - 6 : lineY + 12;
    body += `<text x="${center.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="#f4f1e8" font-size="${expanded ? 11 : 10}">${esc(swing.relation)}</text>`;
  }

  const heatX = candleRight + gap;
  const baseline = heatX;
  const orderedFlow = [...flow].sort((left, right) => right.high - left.high);
  const orderedBook = [...bookRows].sort((left, right) => right.high - left.high);
  const flowMax = orderedFlow.length ? Math.max(...orderedFlow.map((row) => row.notional)) : 1;
  const bookMax = orderedBook.length ? Math.max(...orderedBook.map((row) => row.notional)) : 1;
  const flowReach = (row) => baseline + 4 + (row.notional / flowMax) * (heatW - 14);
  const bookReach = (row) => baseline + 4 + (row.notional / bookMax) * (heatW - 14);
  if (orderedFlow.length) {
    const ridgeD = mountainPath(orderedFlow, y, flowReach, baseline);
    const gradientId = `orders-${coin.base}-${mode}`;
    body += `<defs><linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${baseline.toFixed(1)}" y1="0" x2="${(baseline + heatW).toFixed(1)}" y2="0"><stop offset="0%" stop-color="rgb(243,209,90)"/><stop offset="52%" stop-color="rgb(226,74,42)"/><stop offset="100%" stop-color="rgb(110,24,20)"/></linearGradient></defs>`;
    body += `<path d="${ridgeD} Z" fill="url(#${gradientId})" opacity="${expanded ? 0.38 : 0.94}"/>`;
    body += `<path d="${ridgeD}" fill="none" stroke="${expanded ? "rgba(255,236,214,0.45)" : "rgba(255,236,214,0.82)"}" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  if (orderedBook.length && expanded) {
    for (const row of orderedBook) {
      const yHigh = y(row.high);
      const yLow = y(row.low);
      if (Math.max(yHigh, yLow) < pad.t - 6 || Math.min(yHigh, yLow) > axisY + 6) continue;
      const natural = Math.abs(yLow - yHigh);
      const barH = Math.max(natural, 1.15);
      const top = Math.min(yHigh, yLow) - (barH - natural) / 2;
      const barW = Math.max(4, bookReach(row) - baseline);
      body += `<rect x="${baseline.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="rgba(243,209,90,0.94)" stroke="#fff6cf" stroke-width="0.7"/>`;
    }
  } else if (orderedBook.length) {
    const ridgeD = mountainPath(orderedBook, y, bookReach, baseline);
    body += `<path d="${ridgeD} Z" fill="rgba(230,177,92,0.28)"/>`;
    body += `<path d="${ridgeD}" fill="none" stroke="rgba(230,177,92,0.9)" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  if (expanded) body += `<g id="heat-hover-dialog"></g>`;

  const lastClose = candles.length ? candles[candles.length - 1].c : view.last;
  const lastY = y(lastClose);
  if (lastY >= pad.t && lastY <= axisY) {
    body += `<line x1="${pad.l}" y1="${lastY.toFixed(1)}" x2="${(heatX + heatW - 6).toFixed(1)}" y2="${lastY.toFixed(1)}" stroke="#e6b15c" stroke-dasharray="4 4" stroke-width="1"/>`;
  }
  body += `</g>`;

  const detailX = heatX + heatW + 8;
  const peakSets = [
    [orderedFlow, flowReach],
    [orderedBook, bookReach],
  ];
  const peaks = [];
  for (const [series, reach] of peakSets) {
    for (const row of orderPeaks(series)) {
      const midY = (y(row.high) + y(row.low)) / 2;
      if (midY <= pad.t + 10 || midY >= axisY - 8) continue;
      peaks.push({ row, tipX: reach(row), midY });
    }
  }
  peaks.sort((left, right) => right.row.notional - left.row.notional);
  const limit = expanded ? 5 : 3;
  const labeled = [];
  const labelGap = expanded ? 64 : 58;
  for (const peak of peaks) {
    if (labeled.length >= limit) break;
    if (labeled.some((item) => Math.abs(item.midY - peak.midY) < labelGap)) continue;
    labeled.push(peak);
  }
  const flowFont = expanded ? 24 : 22;
  const sizeFont = expanded ? 20 : 18;
  for (const peak of labeled) {
    const volume = formatQuote(peak.row.notional);
    const price = formatPrice(peak.row.price, coin.price);
    const side = sideWord(peak.row.side);
    body += `<circle cx="${peak.tipX.toFixed(1)}" cy="${peak.midY.toFixed(1)}" r="${expanded ? 4.2 : 3.4}" fill="#f4f1e8"/>`;
    body += `<text x="${detailX.toFixed(1)}" y="${(peak.midY - 4).toFixed(1)}" fill="#f4f1e8" font-size="${flowFont}" font-weight="560">${esc(price)}</text>`;
    body += `<text x="${detailX.toFixed(1)}" y="${(peak.midY + sizeFont).toFixed(1)}" fill="#f4f1e8" font-size="${sizeFont}" font-weight="560">${esc(volume)} ${esc(side)}</text>`;
  }

  body += `<line x1="${pad.l}" y1="${axisY}" x2="${candleRight}" y2="${axisY}" stroke="rgba(244,241,232,0.28)"/>`;
  for (let tick = 0; tick < 4; tick += 1) {
    const index = Math.round(start + (span - 1) * (tick / 3));
    const candle = candles[Math.max(0, Math.min(candles.length - 1, index))];
    if (!candle) continue;
    const tickX = x(Math.max(0, Math.min(candles.length - 1, index)));
    const anchor = tick === 0 ? "start" : tick === 3 ? "end" : "middle";
    body += `<line x1="${tickX.toFixed(1)}" y1="${axisY}" x2="${tickX.toFixed(1)}" y2="${axisY + 5}" stroke="rgba(244,241,232,0.4)"/>`;
    const axisInterval = expanded ? activeInterval(coin) : "4h";
    body += `<text x="${tickX.toFixed(1)}" y="${axisY + 18}" text-anchor="${anchor}" fill="#c4bfb2" font-size="12">${esc(formatAxisTime(candle.t, axisInterval))}</text>`;
  }
  const label = expanded
    ? `role="img" aria-label="Expanded ${esc(frameLabel(activeInterval(coin)))} ${esc(coin.base)} chart. Drag to move through price and time. Pinch to zoom. Order flow uses this timeframe."`
    : `aria-hidden="true"`;
  const svg = `<svg class="plot" viewBox="0 0 ${width} ${height}" ${label}>${body}</svg>`;
  return {
    markup: svg,
    geom: {
      width,
      height,
      padT: pad.t,
      padL: pad.l,
      plotH,
      plotW,
      start,
      end,
      min: view.min,
      max: view.max,
      rows: [...orderedFlow, ...orderedBook],
    },
  };
}

function orderChart(coin) {
  const candles = (coin.chart || {}).candles || [];
  if (!candles.length) return "";
  const bounds = chartBounds(coin);
  const view = { min: bounds.fullMin, max: bounds.fullMax, last: bounds.last };
  const drawn = renderChart(coin, view, "preview");
  const note = coin.market === "etf"
    ? "Traded volume across this range. Expand to scroll earlier candles, including past the loaded edge."
    : "Order flow covers prices above and below the last trade. Expand to scroll earlier candles and the resting book.";
  return `
    <div class="chart">
      <button type="button" class="chart-open" data-base="${esc(coin.base)}" aria-label="Expand the ${esc(coin.name)} chart">
        <span class="expand-label">Expand</span>
        ${drawn.markup}
      </button>
      <p class="legend"><i class="heat-scale"></i><span>smaller</span><span>largest</span><span class="legend-note">${note}</span></p>
    </div>`;
}

function findCoin(base) {
  for (const coin of state.data?.coins || []) {
    if (coin.base === base && !coin.error) return coin;
    const etf = coin.etf;
    if (etf && etf.base === base && etf.available !== false && !etf.error) return etf;
  }
  return undefined;
}

function findSectionCoin(base) {
  return (state.data?.coins || []).find((coin) => coin.base === base || coin.etf?.base === base);
}

function liveCoin(coin) {
  for (const item of state.data?.coins || []) {
    if (item.symbol === coin.symbol && (item.market || "spot") === (coin.market || "spot") && !item.error) return item;
    const etf = item.etf;
    if (etf?.symbol === coin.symbol && etf.market === coin.market && etf.available !== false && !etf.error) return etf;
  }
  return coin;
}

function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    if (state.expanded) drawDialog();
  });
}

function drawDialog() {
  const dialog = document.querySelector("#chart-dialog");
  const open = state.expanded;
  const coin = open && findCoin(open.base);
  if (!coin) return;
  const candles = historyCandles(coin);
  const interval = open.interval || "4h";
  dialog.querySelectorAll("[data-tf]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.tf === interval ? "true" : "false");
  });
  dialog.querySelector("#dialog-base").textContent = coin.base;
  dialog.querySelector("#dialog-title").textContent = `${coin.name} · ${frameLabel(interval)}`;
  if (!candles.length) {
    open.geom = null;
    dialog.querySelector("#dialog-stage").innerHTML = `<p class="chart-wait">${open.loading ? "Loading candles…" : "No candles for this timeframe."}</p>`;
    dialog.querySelector("#dialog-range").textContent = open.loading ? "Loading candles…" : "No candles for this timeframe.";
    return;
  }
  const time = fitTime(open.start, open.end, candles.length);
  const price = fitPrice(open.min, open.max, coin, loadedExtent(coin));
  open.start = time.start;
  open.end = time.end;
  open.min = price.min;
  open.max = price.max;
  const drawn = renderChart(coin, { min: open.min, max: open.max, start: open.start, end: open.end }, "expanded");
  open.geom = drawn.geom;
  dialog.querySelector("#dialog-stage").innerHTML = drawn.markup;
  const first = candles[Math.max(0, Math.min(candles.length - 1, Math.floor(open.start)))];
  const last = candles[Math.max(0, Math.min(candles.length - 1, Math.ceil(open.end) - 1))];
  const when = first && last ? `${formatAxisTime(first.t, interval)} – ${formatAxisTime(last.t, interval)} · ` : "";
  const low = formatPrice(open.min, coin.price);
  const high = formatPrice(open.max, coin.price);
  const status = open.loading ? " · loading earlier candles" : open.exhausted && open.start < 1 ? " · no earlier candles" : "";
  dialog.querySelector("#dialog-range").textContent = `${when}${low} – ${high}${status}`;
}

function openChart(base) {
  const coin = findCoin(base);
  if (!coin || !historyCandles(coin).length) return;
  const home = expandedHome(coin);
  pointers.clear();
  state.expanded = {
    base,
    market: coin.market || "spot",
    interval: "4h",
    min: home.min,
    max: home.max,
    start: home.start,
    end: home.end,
    drag: null,
    pinch: null,
    loading: false,
    exhausted: false,
    pages: 0,
  };
  drawDialog();
  const dialog = document.querySelector("#chart-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("[data-act='close']").focus();
}

function closeChart() {
  hideTip();
  pointers.clear();
  const dialog = document.querySelector("#chart-dialog");
  dialog.classList.remove("dragging");
  if (dialog.open) dialog.close();
}

function hideTip() {
  const tip = document.querySelector("#dialog-tip");
  if (tip) tip.hidden = true;
}

function zoomChart(factor, clientX, clientY) {
  const open = state.expanded;
  const coin = open && findCoin(open.base);
  if (!open || !coin || !open.geom) return;
  const priceSpan = open.max - open.min;
  const timeSpan = open.end - open.start;
  let priceAnchor = (open.min + open.max) / 2;
  let timeAnchor = (open.start + open.end) / 2;
  const svg = document.querySelector("#dialog-stage svg");
  if (svg) {
    const rect = svg.getBoundingClientRect();
    if (clientY != null) {
      const y = ((clientY - rect.top) / rect.height) * open.geom.height;
      const ratio = (y - open.geom.padT) / open.geom.plotH;
      priceAnchor = open.max - ratio * priceSpan;
    }
    if (clientX != null) {
      const x = ((clientX - rect.left) / rect.width) * open.geom.width;
      const ratio = (x - open.geom.padL) / (open.geom.plotW || 1);
      timeAnchor = open.start + ratio * timeSpan;
    }
  }
  const nextPrice = priceSpan * factor;
  const lower = (priceAnchor - open.min) / (priceSpan || 1);
  const price = fitPrice(
    priceAnchor - nextPrice * lower,
    priceAnchor + nextPrice * (1 - lower),
    coin,
    loadedExtent(coin),
  );
  const nextTime = timeSpan * factor;
  const left = (timeAnchor - open.start) / (timeSpan || 1);
  const time = fitTime(
    timeAnchor - nextTime * left,
    timeAnchor + nextTime * (1 - left),
    historyCandles(coin).length,
  );
  open.min = price.min;
  open.max = price.max;
  open.start = time.start;
  open.end = time.end;
  scheduleDraw();
  requestOlderIfNeeded();
}

function panChart(deltaPrice) {
  const open = state.expanded;
  const coin = open && findCoin(open.base);
  if (!open || !coin) return;
  const next = fitPrice(open.min + deltaPrice, open.max + deltaPrice, coin, loadedExtent(coin));
  open.min = next.min;
  open.max = next.max;
  scheduleDraw();
  requestOlderIfNeeded();
}

function panTime(deltaIndex) {
  const open = state.expanded;
  const coin = open && findCoin(open.base);
  if (!open || !coin) return;
  const next = fitTime(open.start + deltaIndex, open.end + deltaIndex, historyCandles(coin).length);
  open.start = next.start;
  open.end = next.end;
  scheduleDraw();
  requestOlderIfNeeded();
}

function priceDeltaFromPixels(pixels, span) {
  const open = state.expanded;
  const svg = document.querySelector("#dialog-stage svg");
  if (!open?.geom || !svg) return 0;
  const rect = svg.getBoundingClientRect();
  const used = span == null ? open.max - open.min : span;
  return (pixels / rect.height) * used * (open.geom.height / open.geom.plotH);
}

function indexDeltaFromPixels(pixels, span) {
  const open = state.expanded;
  const svg = document.querySelector("#dialog-stage svg");
  if (!open?.geom || !svg) return 0;
  const rect = svg.getBoundingClientRect();
  const used = span == null ? open.end - open.start : span;
  return (pixels / rect.width) * used * (open.geom.width / (open.geom.plotW || 1));
}

function applyDrag(event) {
  const open = state.expanded;
  const drag = open?.drag;
  const coin = open && findCoin(open.base);
  if (!drag || !coin) return;
  const price = fitPrice(
    drag.min + priceDeltaFromPixels(event.clientY - drag.y, drag.max - drag.min),
    drag.max + priceDeltaFromPixels(event.clientY - drag.y, drag.max - drag.min),
    coin,
    loadedExtent(coin),
  );
  const dIndex = -indexDeltaFromPixels(event.clientX - drag.x, drag.end - drag.start);
  const time = fitTime(drag.start + dIndex, drag.end + dIndex, historyCandles(coin).length);
  open.min = price.min;
  open.max = price.max;
  open.start = time.start;
  open.end = time.end;
  scheduleDraw();
  requestOlderIfNeeded();
}

function applyPinch() {
  const open = state.expanded;
  const pinch = open?.pinch;
  if (!pinch || pointers.size < 2) return;
  const pts = [...pointers.values()];
  const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
  const factor = Math.min(4, Math.max(0.25, pinch.dist / Math.max(dist, 12)));
  open.min = pinch.min;
  open.max = pinch.max;
  open.start = pinch.start;
  open.end = pinch.end;
  zoomChart(factor, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
}

function beyondLoadedPrice(open, extent) {
  if (!extent) return false;
  const span = Math.max(extent.max - extent.min, Math.abs(extent.max) * 0.001);
  const margin = span * 0.08;
  return open.min < extent.min - margin || open.max > extent.max + margin;
}

function requestOlderIfNeeded() {
  const open = state.expanded;
  if (!open || open.loading || open.exhausted) return;
  const coin = findCoin(open.base);
  if (!coin) return;
  const candles = historyCandles(coin);
  const timeEdge = open.start < 2;
  const priceEdge = beyondLoadedPrice(open, candleExtent(candles));
  if (!timeEdge && !priceEdge) {
    open.pages = 0;
    return;
  }
  if ((open.pages || 0) >= 8) return;
  clearTimeout(open.olderTimer);
  open.olderTimer = setTimeout(() => loadOlder(), 160);
}

async function loadOlder() {
  const open = state.expanded;
  if (!open || open.loading || open.exhausted) return;
  const coin = findCoin(open.base);
  if (!coin) return;
  const candles = historyCandles(coin);
  if (!candles.length) return;
  const timeEdge = open.start < 2;
  const priceEdge = beyondLoadedPrice(open, candleExtent(candles));
  if (!timeEdge && !priceEdge) return;
  open.loading = true;
  open.pages = (open.pages || 0) + 1;
  scheduleDraw();
  const end = candles[0].t;
  const interval = open.interval || "4h";
  const market = coin.market === "etf" ? "etf" : "spot";
  try {
    const response = await fetch(`/api/history?symbol=${encodeURIComponent(coin.symbol)}&market=${market}&interval=${encodeURIComponent(interval)}&end=${end}&limit=500`);
    if (!response.ok) throw new Error("history");
    const payload = await response.json();
    if (state.expanded !== open || (open.interval || "4h") !== interval) return;
    const current = findCoin(open.base) || coin;
    const existing = frameCandles(current, interval);
    const seen = new Set(existing.map((candle) => candle.t));
    const older = (payload.candles || [])
      .filter((candle) => candle.t < end && !seen.has(candle.t))
      .sort((left, right) => left.t - right.t);
    if (!older.length) {
      open.exhausted = true;
      return;
    }
    const merged = mergeHistory(older, existing);
    const added = merged.findIndex((candle) => candle.t === existing[0].t);
    current.chart.frames = current.chart.frames || {};
    current.chart.frames[interval] = merged;
    if (interval === "4h") current.chart.history = merged;
    delete current.chart._flow;
    delete current.chart._swings;
    if (state.expanded === open && added > 0) {
      open.start += added;
      open.end += added;
      if (open.drag) {
        open.drag.start += added;
        open.drag.end += added;
      }
      if (open.pinch) {
        open.pinch.start += added;
        open.pinch.end += added;
      }
    }
  } catch (_error) {
    open.pages = Math.max(0, (open.pages || 1) - 1);
    return;
  } finally {
    open.loading = false;
    if (state.expanded === open) scheduleDraw();
  }
  if (state.expanded === open) requestOlderIfNeeded();
}

async function fetchLatestFrame(coin, interval) {
  const market = coin.market === "etf" ? "etf" : "spot";
  const response = await fetch(`/api/history?symbol=${encodeURIComponent(coin.symbol)}&market=${market}&interval=${encodeURIComponent(interval)}&limit=1000`);
  if (!response.ok) throw new Error("history");
  const payload = await response.json();
  const candles = (payload.candles || []).slice().sort((left, right) => left.t - right.t);
  const target = liveCoin(coin);
  const chart = target.chart || (target.chart = {});
  chart.frames = chart.frames || {};
  chart.frames[interval] = candles;
  if (interval === "4h") chart.history = candles;
  delete chart._flow;
  delete chart._swings;
  return candles;
}

async function setTimeframe(interval) {
  const open = state.expanded;
  const coin = open && findCoin(open.base);
  if (!open || !coin || (open.interval || "4h") === interval) return;
  open.interval = interval;
  open.exhausted = false;
  open.pages = 0;
  open.drag = null;
  open.pinch = null;
  pointers.clear();
  const token = (open.fetchToken || 0) + 1;
  open.fetchToken = token;
  let candles = frameCandles(coin, interval);
  if (!candles.length) {
    open.loading = true;
    drawDialog();
    try {
      candles = await fetchLatestFrame(coin, interval);
    } catch (_error) {
      candles = [];
    }
    if (state.expanded !== open || open.fetchToken !== token) return;
    open.loading = false;
  }
  if (!candles.length) {
    drawDialog();
    return;
  }
  const home = expandedHome(findCoin(open.base) || coin);
  open.start = home.start;
  open.end = home.end;
  open.min = home.min;
  open.max = home.max;
  drawDialog();
}

function pointerPrice(event) {
  const open = state.expanded;
  const svg = document.querySelector("#dialog-stage svg");
  if (!open?.geom || !svg) return null;
  const rect = svg.getBoundingClientRect();
  const y = ((event.clientY - rect.top) / rect.height) * open.geom.height;
  const ratio = (y - open.geom.padT) / open.geom.plotH;
  if (ratio < -0.02 || ratio > 1.02) return null;
  return open.max - ratio * (open.max - open.min);
}

function showTip(event) {
  const open = state.expanded;
  const tip = document.querySelector("#dialog-tip");
  const hover = document.querySelector("#heat-hover-dialog");
  if (!open?.geom || !tip) return;
  const price = pointerPrice(event);
  const matches = price == null ? [] : open.geom.rows.filter((item) => price <= item.high && price >= item.low);
  const row = matches.sort((left, right) => (left.high - left.low) - (right.high - right.low))[0] || null;
  if (!row || !hover) {
    tip.hidden = true;
    if (hover) hover.innerHTML = "";
    return;
  }
  const coin = findCoin(open.base);
  const y = (value) => open.geom.padT + ((open.max - value) / ((open.max - open.min) || 1)) * open.geom.plotH;
  const top = Math.min(y(row.high), y(row.low));
  const height = Math.max(2, Math.abs(y(row.low) - y(row.high)));
  hover.innerHTML = `<rect x="${open.geom.padL}" y="${top.toFixed(1)}" width="${(open.geom.width - open.geom.padL - 8).toFixed(1)}" height="${height.toFixed(1)}" fill="rgba(244,241,232,0.08)"/>`;
  tip.hidden = false;
  tip.innerHTML = `<strong>${esc(formatPrice(row.low, coin.price))} – ${esc(formatPrice(row.high, coin.price))}</strong><span>${esc(formatQuote(row.notional))} · ${esc(sideWord(row.side))}</span>`;
  const pad = 14;
  const width = tip.offsetWidth || 180;
  const left = Math.min(window.innerWidth - width - 8, event.clientX + pad);
  const topPx = Math.min(window.innerHeight - 64, event.clientY + pad);
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, topPx)}px`;
}

function bindChartDialog() {
  const dialog = document.querySelector("#chart-dialog");
  dialog.addEventListener("close", () => {
    state.expanded = null;
    hideTip();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeChart();
      return;
    }
    const tf = event.target.closest("[data-tf]")?.dataset.tf;
    if (tf && state.expanded) {
      setTimeframe(tf);
      return;
    }
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (!act || !state.expanded) return;
    if (act === "close") closeChart();
    if (act === "in") zoomChart(0.72);
    if (act === "out") zoomChart(1.4);
    if (act === "reset") {
      const coin = findCoin(state.expanded.base);
      const home = expandedHome(coin);
      state.expanded.min = home.min;
      state.expanded.max = home.max;
      state.expanded.start = home.start;
      state.expanded.end = home.end;
      state.expanded.exhausted = false;
      state.expanded.pages = 0;
      drawDialog();
    }
  });
  dialog.addEventListener("wheel", (event) => {
    if (!state.expanded || !event.target.closest("#dialog-stage")) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) zoomChart(event.deltaY > 0 ? 1.12 : 0.88, event.clientX, event.clientY);
    else {
      if (event.deltaX) panTime(-indexDeltaFromPixels(event.deltaX));
      if (event.deltaY) panChart(-priceDeltaFromPixels(event.deltaY));
    }
  }, { passive: false });
  dialog.querySelector("#dialog-stage").addEventListener("touchmove", (event) => {
    if (state.expanded && event.cancelable) event.preventDefault();
  }, { passive: false });
  dialog.addEventListener("pointerdown", (event) => {
    if (!state.expanded || event.button !== 0 || !event.target.closest("#dialog-stage")) return;
    if (event.cancelable) event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try { dialog.setPointerCapture(event.pointerId); } catch (_error) { /* The move events still reach the dialog. */ }
    dialog.classList.add("dragging");
    state.expanded.pages = 0;
    hideTip();
    if (pointers.size >= 2) {
      const pts = [...pointers.values()];
      state.expanded.drag = null;
      state.expanded.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        min: state.expanded.min,
        max: state.expanded.max,
        start: state.expanded.start,
        end: state.expanded.end,
      };
      return;
    }
    state.expanded.pinch = null;
    state.expanded.drag = {
      x: event.clientX,
      y: event.clientY,
      min: state.expanded.min,
      max: state.expanded.max,
      start: state.expanded.start,
      end: state.expanded.end,
    };
  });
  dialog.addEventListener("pointermove", (event) => {
    if (pointers.has(event.pointerId)) {
      if (event.cancelable) event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2 && state.expanded?.pinch) applyPinch();
      else if (state.expanded?.drag) applyDrag(event);
      return;
    }
    if (state.expanded && event.target.closest("#dialog-stage")) showTip(event);
    else hideTip();
  }, { passive: false });
  const endPointer = (event) => {
    if (!state.expanded) return;
    pointers.delete(event.pointerId);
    if (pointers.size >= 2) return;
    state.expanded.pinch = null;
    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      state.expanded.drag = {
        x: remaining.x,
        y: remaining.y,
        min: state.expanded.min,
        max: state.expanded.max,
        start: state.expanded.start,
        end: state.expanded.end,
      };
      return;
    }
    state.expanded.drag = null;
    dialog.classList.remove("dragging");
    requestOlderIfNeeded();
  };
  dialog.addEventListener("pointerup", endPointer);
  dialog.addEventListener("pointercancel", endPointer);
  document.addEventListener("keydown", (event) => {
    if (!state.expanded || event.key !== "Escape") return;
    event.preventDefault();
    closeChart();
  });
  dialog.addEventListener("keydown", (event) => {
    if (!state.expanded) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      panChart(-priceDeltaFromPixels(48));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      panChart(priceDeltaFromPixels(48));
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      panTime(-indexDeltaFromPixels(72));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      panTime(indexDeltaFromPixels(72));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomChart(0.8);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomChart(1.25);
    }
  });
}

function momentumBox(momentum) {
  if (!momentum) return "";
  const direction = momentum.direction || "Unclear";
  const tone = direction === "Up" ? "up" : direction === "Down" ? "down" : "unclear";
  const confidence = Math.max(0, Math.min(100, momentum.confidence || 0));
  return `
    <aside class="momentum ${tone}">
      <p class="hint">Momentum confidence</p>
      <p class="direction">${esc(direction)}</p>
      <p class="confidence-num">${confidence}</p>
      <div class="conf-track" aria-hidden="true"><i style="width:${confidence}%"></i></div>
      <p class="narrative">${esc(momentum.reason || "")}</p>
    </aside>`;
}

function findingsBlock(text, title = "What the data says") {
  const paragraphs = String(text || "").split(/\n\n+/).filter(Boolean);
  if (!paragraphs.length) return "";
  return `
    <section class="findings">
      <h3>${esc(title)}</h3>
      ${paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join("")}
    </section>`;
}

function coinSection(coin) {
  if (coin.error) {
    return `
      <section class="coin" id="coin-${esc(coin.base)}">
        <div class="coin-head">
          <div>
            <p class="base">${esc(coin.base)}</p>
            <p class="name">${esc(coin.name)}</p>
          </div>
        </div>
        <p class="narrative">${esc(coin.name)} did not load. ${esc(coin.error)}</p>
      </section>`;
  }
  const change = coin.change_pct;
  const changeClass = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const changeText = change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
  const range = coin.high == null ? "" : `24h ${formatPrice(coin.low, coin.price)} – ${formatPrice(coin.high, coin.price)}`;
  const volume = coin.quote_volume == null ? "" : ` · volume ${formatQuote(coin.quote_volume)}`;
  return `
    <section class="coin" id="coin-${esc(coin.base)}">
      <div class="coin-head">
        <div class="ident">
          <div class="base-row">
            <p class="base">${esc(coin.base)}</p>
            <span class="badge ${esc(coin.alignment.bias)}">${esc(coin.alignment.badge)}</span>
          </div>
          <p class="name">${esc(coin.name)}</p>
        </div>
        <div class="quote">
          <p class="price">${esc(formatPrice(coin.price))}</p>
          <p class="change ${changeClass}">${esc(changeText)}</p>
          <p class="stat-line">${esc(range)}${esc(volume)}</p>
        </div>
      </div>
      <div class="stage">
        ${orderChart(coin)}
        ${momentumBox(coin.momentum)}
      </div>
      ${findingsBlock(coin.findings)}
      ${etfBlock(coin)}
    </section>`;
}

function quoteLine(item) {
  const change = item.change_pct;
  const changeClass = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const changeText = change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
  const range = item.high == null ? "" : `session ${formatPrice(item.low, item.price)} – ${formatPrice(item.high, item.price)}`;
  const volume = item.quote_volume == null ? "" : `${range ? " · " : ""}volume ${formatQuote(item.quote_volume)}`;
  return { changeClass, changeText, stat: `${range}${volume}` };
}

function etfBlock(coin) {
  const etf = coin.etf;
  if (!etf || etf.available === false) {
    const note = etf?.note || `No US spot ETF is listed for ${coin.name}.`;
    return `
      <section class="etf">
        <h3>ETF</h3>
        <p class="hint">${esc(note)}</p>
      </section>`;
  }
  if (etf.error) {
    return `
      <section class="etf">
        <h3>${esc(etf.base)}</h3>
        <p class="narrative">${esc(etf.name)} did not load. ${esc(etf.error)}</p>
      </section>`;
  }
  const quote = quoteLine(etf);
  return `
    <section class="etf">
      <div class="coin-head">
        <div class="ident">
          <div class="base-row">
            <p class="base">${esc(etf.base)}</p>
            <span class="badge ${esc(etf.alignment.bias)}">${esc(etf.alignment.badge)}</span>
          </div>
          <p class="name">${esc(etf.name)}</p>
        </div>
        <div class="quote">
          <p class="price etf-price">${esc(formatPrice(etf.price))}</p>
          <p class="change ${quote.changeClass}">${esc(quote.changeText)}</p>
          <p class="stat-line">${esc(quote.stat)}</p>
        </div>
      </div>
      <div class="stage">
        ${orderChart(etf)}
        ${momentumBox(etf.momentum)}
      </div>
      ${findingsBlock(etf.findings, "What the ETF data says")}
    </section>`;
}

function render(options = {}) {
  const data = state.data;
  if (!data) return;
  const y = options.keepScroll === false ? 0 : window.scrollY;
  renderFilters();
  renderSummary(data);
  const coins = data.coins || [];
  renderRail(coins);
  const visible = coins.filter(matches);
  const banner = data.stale ? `<p class="banner">The latest read failed. Showing the last complete desk.</p>` : "";
  const body = visible.length
    ? visible.map(coinSection).join("")
    : `<p class="loading">Nothing in this filter.</p>`;
  deskEl.innerHTML = banner + body;
  window.scrollTo(0, y);
  watchSections();
  if (state.expanded) {
    const subject = findCoin(state.expanded.base);
    const section = findSectionCoin(state.expanded.base);
    if (subject && section && matches(section)) drawDialog();
    else closeChart();
  }
}

let observer;
function watchSections() {
  if (observer) observer.disconnect();
  const links = [...railEl.querySelectorAll("a")];
  observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const id = visible.target.id.replace("coin-", "");
    links.forEach((link) => link.classList.toggle("active", link.dataset.coin === id));
  }, { rootMargin: "-20% 0px -60% 0px", threshold: [0.1, 0.25] });
  document.querySelectorAll(".coin").forEach((section) => observer.observe(section));
}

async function load(refresh) {
  if (state.loading) return;
  state.loading = true;
  refreshBtn.disabled = true;
  stampEl.textContent = refresh ? "Refreshing…" : "Reading candles, trades, and the visible book…";
  try {
    const response = await fetch(`/api/desk${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed (${response.status})`);
    }
    const incoming = await response.json();
    carryCharts(state.data, incoming);
    const unchanged = state.data
      && state.data.generated_at === incoming.generated_at
      && Boolean(state.data.stale) === Boolean(incoming.stale)
      && !refresh;
    state.data = incoming;
    if (unchanged) {
      renderSummary(state.data);
      return;
    }
    render();
  } catch (error) {
    if (!state.data) {
      deskEl.innerHTML = `<p class="banner">${esc(error.message)}</p>`;
      stampEl.textContent = "Not loaded";
    } else {
      stampEl.textContent = error.message;
    }
  } finally {
    state.loading = false;
    refreshBtn.disabled = false;
  }
}

deskEl.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-base]");
  if (!opener) return;
  openChart(opener.dataset.base);
});

bindChartDialog();
load(false);
setInterval(() => load(false), 60000);
