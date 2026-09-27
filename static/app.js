const state = { filter: "all", loading: false, data: null, expanded: null };

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

function formatAxisTime(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
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
  const rows = profileRows(coin);
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

function sideWord(side) {
  if (side === "bid") return "bids";
  if (side === "ask") return "asks";
  if (side === "buy") return "buys";
  if (side === "sell") return "sells";
  return "mixed";
}

function renderChart(coin, view, mode) {
  const chart = coin.chart || {};
  const candles = chart.candles || [];
  const bookRows = profileRows(coin);
  const rows = mode === "expanded" && bookRows.length ? bookRows : flowRows(coin);
  const expanded = mode === "expanded";
  const width = expanded ? 1100 : 960;
  const height = expanded ? 640 : 400;
  const pad = expanded ? { t: 18, b: 42, l: 78 } : { t: 16, b: 40, l: 68 };
  const detailW = expanded ? 196 : 132;
  const heatW = expanded ? 188 : 118;
  const gap = 16;
  const candleRight = width - detailW - heatW - gap;
  const plotH = height - pad.t - pad.b;
  const slot = (candleRight - pad.l) / candles.length;
  const y = (price) => pad.t + ((view.max - price) / ((view.max - view.min) || 1)) * plotH;
  const x = (index) => pad.l + slot * index + slot / 2;
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
  candles.forEach((candle, index) => {
    const up = candle.c >= candle.o;
    const color = up ? "#8fceab" : "#e39b8b";
    const center = x(index);
    const barW = Math.max(1.4, slot * 0.62);
    const top = y(Math.max(candle.o, candle.c));
    const bottom = y(Math.min(candle.o, candle.c));
    body += `<line x1="${center.toFixed(2)}" y1="${y(candle.h).toFixed(2)}" x2="${center.toFixed(2)}" y2="${y(candle.l).toFixed(2)}" stroke="${color}" stroke-width="1"/>`;
    body += `<rect x="${(center - barW / 2).toFixed(2)}" y="${Math.min(top, bottom).toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(1, Math.abs(bottom - top)).toFixed(2)}" fill="${color}"/>`;
  });

  for (const type of ["high", "low"]) {
    const points = (chart.swings || []).filter((swing) => swing.type === type);
    if (points.length < 2) continue;
    const path = points.map((swing, index) => `${index ? "L" : "M"}${x(swing.index).toFixed(1)},${y(swing.price).toFixed(1)}`).join(" ");
    body += `<path d="${path}" fill="none" stroke="${type === "high" ? "#e6b15c" : "#d5d0c4"}" stroke-width="1.2" opacity="0.75"/>`;
  }

  const swingLabels = [];
  for (const type of ["high", "low"]) {
    swingLabels.push(...(chart.swings || []).filter((swing) => swing.type === type && swing.relation).slice(-2));
  }
  for (const swing of swingLabels) {
    const lineY = y(swing.price);
    if (lineY < pad.t + 8 || lineY > axisY - 8) continue;
    const labelY = swing.type === "high" ? lineY - 6 : lineY + 12;
    body += `<text x="${x(swing.index).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" fill="#f4f1e8" font-size="${expanded ? 11 : 10}">${esc(swing.relation)}</text>`;
  }

  const maxNotional = rows.length ? Math.max(...rows.map((row) => row.notional)) : 1;
  const heatX = candleRight + gap;
  const baseline = heatX;
  const reach = (row) => baseline + 4 + (row.notional / maxNotional) * (heatW - 14);
  const ordered = [...rows].sort((left, right) => right.high - left.high);
  if (ordered.length) {
    const ridge = [[baseline, y(ordered[0].high)]];
    ordered.forEach((row, index) => {
      if (index > 0) {
        const gapTop = y(ordered[index - 1].low);
        const gapBottom = y(row.high);
        if (gapBottom - gapTop > 1.25) {
          ridge.push([baseline, gapTop]);
          ridge.push([baseline, gapBottom]);
        }
      }
      const xOut = reach(row);
      ridge.push([xOut, y(row.high)]);
      ridge.push([xOut, y(row.low)]);
    });
    ridge.push([baseline, y(ordered[ordered.length - 1].low)]);
    const ridgeD = ridge.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`).join(" ");
    const gradientId = `orders-${coin.base}-${mode}`;
    body += `<defs><linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${baseline.toFixed(1)}" y1="0" x2="${(baseline + heatW).toFixed(1)}" y2="0"><stop offset="0%" stop-color="rgb(243,209,90)"/><stop offset="52%" stop-color="rgb(226,74,42)"/><stop offset="100%" stop-color="rgb(110,24,20)"/></linearGradient></defs>`;
    body += `<path d="${ridgeD} Z" fill="url(#${gradientId})" opacity="0.94"/>`;
    body += `<path d="${ridgeD}" fill="none" stroke="rgba(255,236,214,0.82)" stroke-width="${expanded ? 1.7 : 1.35}" stroke-linejoin="round" stroke-linecap="round"/>`;
    body += `<g id="heat-hover"></g>`;
  }

  const lastY = y(view.last == null ? candles[candles.length - 1].c : candles[candles.length - 1].c);
  if (lastY >= pad.t && lastY <= axisY) {
    body += `<line x1="${pad.l}" y1="${lastY.toFixed(1)}" x2="${(heatX + heatW - 6).toFixed(1)}" y2="${lastY.toFixed(1)}" stroke="#e6b15c" stroke-dasharray="4 4" stroke-width="1"/>`;
  }
  body += `</g>`;

  const detailX = heatX + heatW + 8;
  const peaks = orderPeaks(rows)
    .map((row) => ({
      row,
      tipX: reach(row),
      midY: (y(row.high) + y(row.low)) / 2,
    }))
    .filter((peak) => peak.midY > pad.t + 10 && peak.midY < axisY - 8)
    .sort((left, right) => right.row.notional - left.row.notional);
  const limit = expanded ? 6 : 3;
  const labeled = [];
  for (const peak of peaks) {
    if (labeled.length >= limit) break;
    if (labeled.some((item) => Math.abs(item.midY - peak.midY) < (expanded ? 22 : 18))) continue;
    labeled.push(peak);
  }
  for (const peak of labeled) {
    const textY = peak.midY + 4;
    const volume = formatQuote(peak.row.notional);
    const price = formatPrice(peak.row.price, coin.price);
    const extra = expanded ? ` ${sideWord(peak.row.side)}` : "";
    body += `<circle cx="${peak.tipX.toFixed(1)}" cy="${peak.midY.toFixed(1)}" r="${expanded ? 3 : 2.2}" fill="#f4f1e8"/>`;
    body += `<text x="${detailX.toFixed(1)}" y="${textY.toFixed(1)}" fill="#f4f1e8" font-size="${expanded ? 12 : 10}">${esc(price)} · ${esc(volume)}${esc(extra)}</text>`;
  }

  body += `<line x1="${pad.l}" y1="${axisY}" x2="${candleRight}" y2="${axisY}" stroke="rgba(244,241,232,0.28)"/>`;
  for (let tick = 0; tick < 4; tick += 1) {
    const index = tick === 3 ? candles.length - 1 : Math.round((candles.length - 1) * (tick / 3));
    const tickX = x(index);
    const anchor = tick === 0 ? "start" : tick === 3 ? "end" : "middle";
    body += `<line x1="${tickX.toFixed(1)}" y1="${axisY}" x2="${tickX.toFixed(1)}" y2="${axisY + 5}" stroke="rgba(244,241,232,0.4)"/>`;
    body += `<text x="${tickX.toFixed(1)}" y="${axisY + 18}" text-anchor="${anchor}" fill="#c4bfb2" font-size="11">${esc(formatAxisTime(candles[index].t))}</text>`;
  }
  const label = expanded
    ? `role="img" aria-label="Expanded 4 hour ${esc(coin.base)} chart. Orders use the same price scale as the candles. Yellow is smaller size and dark red is larger."`
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
      min: view.min,
      max: view.max,
      rows: ordered,
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
    ? "Traded volume across this fund's full 4h range. Peaks show price and dollar size. Expand to scroll and zoom."
    : "Order flow covers this full 4h range. Peaks show price and dollar size. Expand to zoom into the resting book.";
  return `
    <div class="chart">
      <button type="button" class="chart-open" data-base="${esc(coin.base)}" aria-label="Expand the ${esc(coin.name)} 4 hour chart">
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

function drawDialog() {
  const dialog = document.querySelector("#chart-dialog");
  const open = state.expanded;
  const coin = open && findCoin(open.base);
  if (!coin) return;
  const bounds = chartBounds(coin);
  const view = clampWindow(open.min, open.max, bounds);
  open.min = view.min;
  open.max = view.max;
  view.last = bounds.last;
  const drawn = renderChart(coin, view, "expanded");
  open.geom = drawn.geom;
  open.bounds = bounds;
  dialog.querySelector("#dialog-base").textContent = coin.base;
  dialog.querySelector("#dialog-title").textContent = `${coin.name} · 4 hour`;
  dialog.querySelector("#dialog-stage").innerHTML = drawn.markup;
  const low = formatPrice(view.min, coin.price);
  const high = formatPrice(view.max, coin.price);
  dialog.querySelector("#dialog-range").textContent = `${low} – ${high}`;
}

function openChart(base) {
  const coin = findCoin(base);
  if (!coin) return;
  const bounds = chartBounds(coin);
  const view = focusWindow(bounds);
  state.expanded = { base, min: view.min, max: view.max, drag: null };
  drawDialog();
  const dialog = document.querySelector("#chart-dialog");
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("[data-act='close']").focus();
}

function closeChart() {
  hideTip();
  const dialog = document.querySelector("#chart-dialog");
  if (dialog.open) dialog.close();
}

function hideTip() {
  const tip = document.querySelector("#dialog-tip");
  if (tip) tip.hidden = true;
}

function zoomChart(factor, clientY) {
  const open = state.expanded;
  if (!open) return;
  const span = open.max - open.min;
  let anchor = (open.min + open.max) / 2;
  if (clientY != null && open.geom) {
    const svg = document.querySelector("#dialog-stage svg");
    const rect = svg.getBoundingClientRect();
    const y = ((clientY - rect.top) / rect.height) * open.geom.height;
    const ratio = (y - open.geom.padT) / open.geom.plotH;
    anchor = open.max - ratio * span;
  }
  const nextSpan = span * factor;
  const lowerRatio = (anchor - open.min) / (span || 1);
  const next = clampWindow(anchor - nextSpan * lowerRatio, anchor + nextSpan * (1 - lowerRatio), open.bounds);
  open.min = next.min;
  open.max = next.max;
  drawDialog();
}

function panChart(deltaPrice) {
  const open = state.expanded;
  if (!open) return;
  const next = clampWindow(open.min + deltaPrice, open.max + deltaPrice, open.bounds);
  open.min = next.min;
  open.max = next.max;
  drawDialog();
}

function priceDeltaFromPixels(pixels) {
  const open = state.expanded;
  const svg = document.querySelector("#dialog-stage svg");
  if (!open || !svg) return 0;
  const rect = svg.getBoundingClientRect();
  const span = open.max - open.min;
  return (pixels / rect.height) * span * (open.geom.height / open.geom.plotH);
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
  const hover = document.querySelector("#heat-hover");
  if (!open?.geom || !tip) return;
  const price = pointerPrice(event);
  const row = price == null ? null : open.geom.rows.find((item) => price <= item.high && price >= item.low);
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
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (!act || !state.expanded) return;
    if (act === "close") closeChart();
    if (act === "in") zoomChart(0.72);
    if (act === "out") zoomChart(1.4);
    if (act === "reset") {
      const coin = findCoin(state.expanded.base);
      const view = focusWindow(chartBounds(coin));
      state.expanded.min = view.min;
      state.expanded.max = view.max;
      drawDialog();
    }
  });
  dialog.addEventListener("wheel", (event) => {
    if (!state.expanded || !event.target.closest("#dialog-stage")) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) zoomChart(event.deltaY > 0 ? 1.12 : 0.88, event.clientY);
    else panChart(-priceDeltaFromPixels(event.deltaY));
  }, { passive: false });
  dialog.addEventListener("pointerdown", (event) => {
    if (!state.expanded || event.button !== 0 || !event.target.closest("#dialog-stage svg")) return;
    state.expanded.drag = { y: event.clientY, min: state.expanded.min, max: state.expanded.max };
    dialog.classList.add("dragging");
    dialog.setPointerCapture(event.pointerId);
  });
  dialog.addEventListener("pointermove", (event) => {
    const drag = state.expanded?.drag;
    if (!drag) {
      if (state.expanded && event.target.closest("#dialog-stage")) showTip(event);
      else hideTip();
      return;
    }
    hideTip();
    const delta = priceDeltaFromPixels(event.clientY - drag.y);
    const next = clampWindow(drag.min + delta, drag.max + delta, state.expanded.bounds);
    state.expanded.min = next.min;
    state.expanded.max = next.max;
    drawDialog();
    state.expanded.drag = drag;
  });
  const endDrag = () => {
    if (!state.expanded) return;
    state.expanded.drag = null;
    dialog.classList.remove("dragging");
  };
  dialog.addEventListener("pointerup", endDrag);
  dialog.addEventListener("pointercancel", endDrag);
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
