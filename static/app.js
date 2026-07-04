"use strict";
const LC = LightweightCharts;
const C = {
  bg: "#131722", grid: "#1e222d", text: "#d1d4dc", text2: "#787b86", border: "#2a2e39",
  accent: "#2962ff", green: "#26a69a", red: "#ef5350",
  yellow: "#f0b90b", orange: "#ff9800", purple: "#e040fb", cyan: "#26c6da", blue: "#42a5f5",
};
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1D", "1W", "1M"];
// Grouped timeframes for the expandable dropdown (TradingView-style).
const TF_GROUPS = [
  { title: "MINUTES", items: ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m"] },
  { title: "HOURS", items: ["1h", "2h", "3h", "4h"] },
  { title: "DAYS", items: ["1D", "1W", "1M"] },
];
// A small set shown inline as quick-access favorites.
const TF_FAVORITES = ["1m", "15m", "1h", "1D", "1W"];
let currentTf = "1D";
let currentSymbol = "AAPL";
const SEP = 1;

// ─────────────────────────── Chart + base panes ───────────────────────
const chartEl = document.getElementById("chart");
const chart = LC.createChart(chartEl, {
  autoSize: true,
  layout: {
    background: { color: C.bg }, textColor: C.text2, fontSize: 11,
    fontFamily: '-apple-system, "Segoe UI", Roboto, sans-serif',
    panes: { separatorColor: C.border, separatorHoverColor: "#3a3f4b", enableResize: true },
  },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
  timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
  crosshair: {
    mode: LC.CrosshairMode.Normal,
    vertLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#363a45" },
    horzLine: { color: "#758696", width: 1, style: 3, labelBackgroundColor: "#363a45" },
  },
  handleScale: {
    mouseWheel: true, pinch: true,
    axisPressedMouseMove: { time: true, price: true },
    axisDoubleClickReset: { time: true, price: true },
  },
  handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
});

// Shared price-axis override (for wheel-over-axis vertical stretch)
let priceOverride = null;
function sharedAutoscale(orig) {
  const base = orig();
  if (!priceOverride) return base;
  const margins = base && base.margins ? base.margins : { above: 10, below: 10 };
  return { priceRange: { minValue: priceOverride.min, maxValue: priceOverride.max }, margins };
}

// Pane 0: candles + volume
const candleSeries = chart.addSeries(LC.CandlestickSeries, {
  upColor: C.green, downColor: C.red, borderVisible: false,
  wickUpColor: C.green, wickDownColor: C.red, autoscaleInfoProvider: sharedAutoscale,
}, 0);
const volumeSeries = chart.addSeries(LC.HistogramSeries, {
  priceFormat: { type: "volume" }, priceScaleId: "vol",
}, 0);
volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

const watermark = LC.createTextWatermark(chart.panes()[0], {
  horzAlign: "center", vertAlign: "center",
  lines: [{ text: "", color: "rgba(120,123,134,0.10)", fontSize: 62 }],
});

let lastData = null;

// ═══════════════════════════ Indicator instances ══════════════════════
// TradingView-style: each added indicator is an *instance* with its own
// inputs (length/source/…) and style (color/width/lineStyle/visible). The
// backend `/api/catalog` defines the available indicator types + their input
// schema; `/api/indicator` computes one instance's plots.

let CATALOG = {};                // type -> spec (from /api/catalog)
const instances = [];            // ordered list of live instances
let instSeq = 0;

const LINE_STYLE = { solid: 0, dotted: 1, dashed: 2 };  // LC LineStyle enum
const PLOT_PALETTE = [C.accent, C.orange, C.red, C.green, C.purple, C.cyan];

// Moving-average indicator types → get a random, high-contrast color on add so
// multiple MAs are easy to tell apart against the dark background.
const MA_TYPES = new Set(["sma", "ema", "wma", "hma", "vwma", "dema", "tema"]);

// Bright, saturated color via HSL with high lightness — always readable on the
// dark theme. Hue is random; lightness/saturation kept in a vivid band.
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
function randomContrastColor() {
  const hue = Math.floor(Math.random() * 360);
  const sat = 70 + Math.floor(Math.random() * 25);   // 70–95% saturation
  const light = 58 + Math.floor(Math.random() * 12);  // 58–70% lightness (bright on dark bg)
  return hslToHex(hue, sat, light);
}

function defaultStyleForPlots(plots, overlay, type) {
  const maRandom = MA_TYPES.has(type);
  // one style entry per plot; sensible default colors
  return plots.map((pk, i) => {
    if (PLOT_STYLE_HINTS[pk]) return { ...PLOT_STYLE_HINTS[pk] };
    return {
      color: maRandom ? randomContrastColor() : PLOT_PALETTE[i % PLOT_PALETTE.length],
      width: pk === "hist" ? 1 : 2,
      lineStyle: "solid",
      visible: true,
    };
  });
}
function defaultInputs(spec) {
  const o = {};
  (spec.inputs || []).forEach((inp) => { o[inp.key] = inp.default; });
  return o;
}

// ── Persistence (localStorage) ──
// Indicators are saved PER TICKER, so each symbol keeps its own layout. We
// also remember the last symbol so the app reopens where you left off.
const STORE_KEY = "tt.indicators.v3";   // { [SYMBOL]: [instance, ...] }
const LAST_SYMBOL_KEY = "tt.lastSymbol.v1";

function _readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}

function saveInstances() {
  try {
    const store = _readStore();
    store[currentSymbol] = instances.map((i) => ({
      type: i.type, inputs: i.inputs, style: i.style, visible: i.visible,
      stretch: i.stretch || 1, offset: i.offset || 0,
    }));
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (e) { /* storage may be unavailable */ }
}

function loadSavedInstances(symbol) {
  const store = _readStore();
  const arr = store[symbol || currentSymbol];
  return Array.isArray(arr) ? arr : null;
}

function saveLastSymbol(sym) {
  try { localStorage.setItem(LAST_SYMBOL_KEY, sym); } catch (e) {}
}
function loadLastSymbol() {
  try { return localStorage.getItem(LAST_SYMBOL_KEY) || null; } catch (e) { return null; }
}

// ── Watchlist (localStorage) ──
// Ordered list of symbols the user has starred. Seeded with a handful of
// popular tickers on first run so the list isn't empty.
const WATCHLIST_KEY = "tt.watchlist.v1";
const WATCHLIST_SEED = [
  "AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "NVDA", "META",
  "BTC-USD", "ETH-USD", "SPY", "QQQ",
];
function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (raw === null) return WATCHLIST_SEED.slice();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return WATCHLIST_SEED.slice(); }
}
function saveWatchlist(list) {
  try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list)); } catch (e) {}
}
function watchlistHas(sym) {
  return loadWatchlist().includes((sym || "").toUpperCase());
}
function addToWatchlist(sym) {
  sym = (sym || "").trim().toUpperCase();
  if (!sym) return;
  const list = loadWatchlist();
  if (!list.includes(sym)) { list.push(sym); saveWatchlist(list); }
}
function removeFromWatchlist(sym) {
  sym = (sym || "").toUpperCase();
  saveWatchlist(loadWatchlist().filter((s) => s !== sym));
}
function toggleWatchlist(sym) {
  sym = (sym || "").trim().toUpperCase();
  if (!sym) return false;
  if (watchlistHas(sym)) { removeFromWatchlist(sym); return false; }
  addToWatchlist(sym); return true;
}

// Drawings persist per ticker too (separate store, time-anchored coords).
const DRAW_KEY = "tt.drawings.v1";   // { [SYMBOL]: [serialized item, ...] }
function _readDrawStore() {
  try { return JSON.parse(localStorage.getItem(DRAW_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}
function saveDrawingsForSymbol(arr) {
  try {
    const store = _readDrawStore();
    store[currentSymbol] = arr;
    localStorage.setItem(DRAW_KEY, JSON.stringify(store));
  } catch (e) {}
}
function loadDrawingsForSymbol(symbol) {
  const store = _readDrawStore();
  const arr = store[symbol || currentSymbol];
  return Array.isArray(arr) ? arr : [];
}

// Chart layout (per ticker): price-scale zoom/pan + pane heights.
const LAYOUT_KEY = "tt.layout.v2";   // { [SYMBOL]: { priceOverride, paneFactors } }
function _readLayoutStore() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}
function currentPaneFactors() {
  try { return chart.panes().map((p) => { try { return p.getStretchFactor(); } catch (_) { return null; } }); }
  catch (e) { return null; }
}
function saveLayout() {
  try {
    const store = _readLayoutStore();
    store[currentSymbol] = {
      priceOverride: priceOverride ? { min: priceOverride.min, max: priceOverride.max } : null,
      paneFactors: currentPaneFactors(),
    };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(store));
  } catch (e) {}
}
function loadLayoutForSymbol(symbol) {
  const store = _readLayoutStore();
  const o = store[symbol || currentSymbol];
  return o && typeof o === "object" ? o : null;
}

function addInstance(type, saved) {
  const spec = CATALOG[type];
  if (!spec) return;
  // Start with only the always-present plots (plot0 / plot1 / hist). Optional
  // plots (e.g. RSI smoothing "ma"/"bb_*") are added by reconcilePlots() once
  // the backend confirms they're active — this avoids creating stray series.
  const initialPlots = spec.plots.filter((pk) => !PLOT_STYLE_HINTS[pk]);
  const plots = initialPlots.length ? initialPlots : spec.plots.slice();
  const inst = {
    id: "ind" + (++instSeq),
    type,
    name: spec.name,
    overlay: spec.overlay,
    plots: plots.slice(),
    plotStyle: spec.plotStyle,
    pane: spec.pane || {},
    inputs: defaultInputs(spec),
    style: defaultStyleForPlots(plots, spec.overlay, type),
    visible: true,
    series: [],        // LC series objects (one per plot)
    paneIndex: null,   // for oscillators
    data: null,        // last fetched plots
  };
  if (saved) {
    if (saved.inputs) inst.inputs = { ...inst.inputs, ...saved.inputs };
    if (saved.style && saved.style.length) inst.style = saved.style;
    if (typeof saved.visible === "boolean") inst.visible = saved.visible;
    if (typeof saved.stretch === "number") inst.stretch = saved.stretch;
    if (typeof saved.offset === "number") inst.offset = saved.offset;
  }
  instances.push(inst);
  layoutPanes();
  fetchInstance(inst);
  renderLegends();
  if (!saved) { saveInstances(); scheduleLayoutSave(); }
  return inst;
}

function removeInstance(inst) {
  inst.series.forEach((s) => { try { chart.removeSeries(s); } catch (e) {} });
  const i = instances.indexOf(inst);
  if (i >= 0) instances.splice(i, 1);
  layoutPanes();
  renderLegends();
  saveInstances();
  scheduleLayoutSave();
}

// Tear down all indicator instances without touching saved state (used when
// switching tickers — we then reload the new ticker's saved set).
function clearAllInstances() {
  instances.slice().forEach((inst) => {
    inst.series.forEach((s) => { try { chart.removeSeries(s); } catch (e) {} });
  });
  instances.length = 0;
  layoutPanes();
  renderLegends();
}

// Load the saved indicator set for the current symbol (per-ticker layout).
function loadInstancesForSymbol() {
  const saved = loadSavedInstances(currentSymbol);
  if (saved && saved.length) saved.forEach((s) => { if (CATALOG[s.type]) addInstance(s.type, s); });
}

// ── Pane assignment ──
// Pane 0 = price. Each non-overlay instance gets its own pane, in the order
// the instances were added. We recompute paneIndex on every add/remove.
function layoutPanes() {
  let next = 1;
  instances.forEach((inst) => {
    if (!inst.overlay) inst.paneIndex = next++;
    else inst.paneIndex = 0;
  });
  // ensure series live in the right pane; recreate if pane changed
  instances.forEach((inst) => ensureSeries(inst));
  sizePanes();
}

function makeSeriesFor(inst, plotKey, styleIdx) {
  const st = inst.style[styleIdx] || { color: C.accent, width: 2, lineStyle: "solid", visible: true };
  const paneIdx = inst.overlay ? 0 : inst.paneIndex;
  const common = {
    priceLineVisible: false, lastValueVisible: inst.overlay ? false : true,
    visible: inst.visible && st.visible,
  };
  if (plotKey === "hist") {
    const hopts = { ...common, lastValueVisible: false };
    // Oscillators: share the pane-wide provider so hist + lines co-scale.
    if (!inst.overlay) hopts.autoscaleInfoProvider = makeOscProvider(inst);
    return chart.addSeries(LC.HistogramSeries, hopts, paneIdx);
  }
  const opts = {
    ...common, color: st.color, lineWidth: st.width, lineStyle: LINE_STYLE[st.lineStyle] || 0,
    crosshairMarkerVisible: !inst.overlay,
  };
  if (inst.overlay) opts.autoscaleInfoProvider = sharedAutoscale;
  // Oscillators: every plot on the pane uses the SAME provider (the combined
  // pane range) so lines + histogram co-scale, and the whole pane can be
  // stretched vertically (inst.stretch) like the price pane.
  if (!inst.overlay) opts.autoscaleInfoProvider = makeOscProvider(inst);
  return chart.addSeries(LC.LineSeries, opts, paneIdx);
}

// Combined natural price range across ALL of an oscillator instance's plots
// (fixed for bounded oscillators like RSI/Stoch), so every series co-scales.
function oscBaseRange(inst) {
  if (inst.pane && inst.pane.range) return { min: inst.pane.range[0], max: inst.pane.range[1] };
  let mn = Infinity, mx = -Infinity;
  const data = inst.data || {};
  inst.plots.forEach((pk) => {
    const arr = data[pk]; if (!arr) return;
    for (const pt of arr) {
      const v = pt.value; if (v == null || !isFinite(v)) continue;
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
  });
  // include any bands (e.g. MACD zero line) so they stay visible
  (inst.pane && inst.pane.bands || []).forEach((b) => { if (b < mn) mn = b; if (b > mx) mx = b; });
  if (!isFinite(mn) || !isFinite(mx) || mn === mx) return null;
  return { min: mn, max: mx };
}

// Provider shared by every plot of an oscillator instance → uniform pane range.
function makeOscProvider(inst) {
  return (orig) => {
    const base = orig();
    const r = oscBaseRange(inst);
    if (!r) return base;
    const stretch = inst.stretch || 1;
    const off = inst.offset || 0;   // vertical pan (drag) offset, in value units
    const mid = (r.min + r.max) / 2 + off, half = ((r.max - r.min) / 2) * stretch;
    const margins = base && base.margins ? base.margins : { above: 8, below: 8 };
    return { priceRange: { minValue: mid - half, maxValue: mid + half }, margins };
  };
}

// Nudge an oscillator's price scale to re-run its provider (after stretch).
function applyOscAutoscale(inst) {
  inst.series.forEach((s) => {
    if (!s) return;
    const ps = s.priceScale();
    ps.applyOptions({ autoScale: false });
    ps.applyOptions({ autoScale: true });
  });
}

function ensureSeries(inst) {
  // (Re)create series if count/pane mismatch. Simple + robust: rebuild.
  const wantPane = inst.overlay ? 0 : inst.paneIndex;
  const needRebuild = inst.series.length !== inst.plots.length || inst._pane !== wantPane;
  if (needRebuild) {
    inst.series.forEach((s) => { try { chart.removeSeries(s); } catch (e) {} });
    inst.series = inst.plots.map((pk, i) => makeSeriesFor(inst, pk, i));
    inst._pane = wantPane;
    // price lines / bands for oscillator panes (only once, on first series)
    if (!inst.overlay && inst.pane && inst.pane.bands && inst.series[0]) {
      inst.pane.bands.forEach((b) => inst.series[0].createPriceLine({
        price: b, color: "rgba(180,185,196,0.9)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true,
      }));
    }
    if (inst.data) applyInstanceData(inst);
  } else {
    applyInstanceStyle(inst);
  }
}

function applyInstanceStyle(inst) {
  inst.plots.forEach((pk, i) => {
    const s = inst.series[i]; if (!s) return;
    const st = inst.style[i];
    const vis = inst.visible && st.visible;
    if (pk === "hist") { s.applyOptions({ visible: vis }); return; }
    s.applyOptions({ color: st.color, lineWidth: st.width, lineStyle: LINE_STYLE[st.lineStyle] || 0, visible: vis });
  });
}

function applyInstanceData(inst) {
  if (!inst.data) return;
  inst.plots.forEach((pk, i) => {
    const s = inst.series[i]; if (!s || !inst.data[pk]) return;
    s.setData(inst.data[pk]);
  });
  if (!inst.overlay) applyOscAutoscale(inst);
}

// Preferred style defaults for named smoothing plots (so an RSI MA line and
// its Bollinger bands look sensible without the user picking colors).
const PLOT_STYLE_HINTS = {
  ma: { color: C.yellow, width: 1, lineStyle: "solid", visible: true },
  bb_upper: { color: C.text2, width: 1, lineStyle: "dashed", visible: true },
  bb_lower: { color: C.text2, width: 1, lineStyle: "dashed", visible: true },
};

function reconcilePlots(inst, plotOrder) {
  // RSI (and future dynamic indicators) may return a different set/order of
  // plots depending on inputs. Keep styles for surviving plots, add defaults
  // for new ones, drop the rest. Series are rebuilt by ensureSeries().
  if (!plotOrder || !plotOrder.length) return false;
  const same = inst.plots.length === plotOrder.length && inst.plots.every((p, i) => p === plotOrder[i]);
  if (same) return false;
  const oldStyleByKey = {};
  inst.plots.forEach((pk, i) => { oldStyleByKey[pk] = inst.style[i]; });
  inst.plots = plotOrder.slice();
  inst.style = plotOrder.map((pk, i) => {
    if (oldStyleByKey[pk]) return oldStyleByKey[pk];
    if (PLOT_STYLE_HINTS[pk]) return { ...PLOT_STYLE_HINTS[pk] };
    return { color: PLOT_PALETTE[i % PLOT_PALETTE.length], width: pk === "hist" ? 1 : 2, lineStyle: "solid", visible: true };
  });
  return true;
}

async function fetchInstance(inst) {
  const qs = new URLSearchParams({ symbol: currentSymbol, tf: currentTf, type: inst.type });
  Object.entries(inst.inputs).forEach(([k, v]) => qs.set(k, v));
  try {
    const res = await fetch("/api/indicator?" + qs.toString());
    const data = await res.json();
    if (data.error) { setStatus("Indicator error: " + data.error, true); return; }
    inst.data = data.plots;
    const changed = reconcilePlots(inst, data.plotOrder);
    if (changed) ensureSeries(inst);   // plot set changed → rebuild series
    applyInstanceData(inst);
    renderLegends();
  } catch (e) { setStatus("Indicator error: " + e.message, true); }
}

function refetchAll() { instances.forEach(fetchInstance); }

// Track panes the user has manually resized (via separator drag) so we don't
// stomp their choice on every re-render.
let userResizedPanes = false;

function sizePanes() {
  if (userResizedPanes) return;
  applyPaneStretch();
  // Re-apply after layout settles — panes are created lazily when the first
  // series is added, so a synchronous call can run before the pane exists.
  requestAnimationFrame(applyPaneStretch);
}

function applyPaneStretch() {
  const ps = chart.panes();
  if (ps.length < 2) return;  // only the price pane → nothing to balance
  // Price pane keeps ~90% of the height; oscillator panes split the rest
  // evenly. Stretch factors are relative weights across all panes.
  const oscPanes = ps.length - 1;
  const PRICE_SHARE = 0.90;
  const priceFactor = (PRICE_SHARE / (1 - PRICE_SHARE)) * oscPanes; // e.g. 2 osc → 4.67
  try { ps[0].setStretchFactor(priceFactor); } catch (e) {}
  for (let i = 1; i < ps.length; i++) {
    try { ps[i].setStretchFactor(1); } catch (e) {}
  }
  _lastPaneFactors = currentPaneFactors();
}

// Restore a symbol's saved chart layout: price-scale zoom/pan + pane heights.
// Runs after instances (hence panes) are created and default sizing applied.
function applySavedLayout() {
  const L = loadLayoutForSymbol(currentSymbol);
  if (!L) return;
  // Price-scale vertical zoom/pan.
  if (L.priceOverride && isFinite(L.priceOverride.min) && isFinite(L.priceOverride.max)) {
    priceOverride = { min: L.priceOverride.min, max: L.priceOverride.max };
  }
  // Pane heights (stretch factors). Apply after panes settle.
  const apply = () => {
    const ps = chart.panes();
    if (Array.isArray(L.paneFactors) && L.paneFactors.length === ps.length) {
      let applied = false;
      ps.forEach((p, i) => {
        const f = L.paneFactors[i];
        if (typeof f === "number" && isFinite(f)) { try { p.setStretchFactor(f); applied = true; } catch (_) {} }
      });
      if (applied) userResizedPanes = true;   // keep our restored sizes
    }
    refreshPriceScale();
    instances.forEach((i) => { if (!i.overlay) applyOscAutoscale(i); });
    _lastPaneFactors = currentPaneFactors();
  };
  apply();
  requestAnimationFrame(apply);
}

// ─────────────────────────── Legends ──────────────────────────────────
const lgPrice = document.getElementById("lg-price");
const lgPanes = document.getElementById("lg-panes");

function fmtVol(v) {
  if (v == null) return "—";
  if (Math.abs(v) > 1e9) return (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) > 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) > 1e3) return (v / 1e3).toFixed(2) + "K";
  return Math.round(v).toLocaleString();
}
function inputSummary(inst) {
  const spec = CATALOG[inst.type];
  if (!spec) return "";
  return (spec.inputs || []).filter((i) => i.type !== "select" || i.key !== "source")
    .map((i) => inst.inputs[i.key]).join(" ");
}

// Price-pane legend: OHLC + overlay indicator rows (with gear/eye/delete)
function renderPriceLegend(bar, volVal, prevClose, crosshairVals) {
  if (!lastData) { lgPrice.innerHTML = ""; return; }
  let html = "";
  if (bar) {
    const up = bar.close >= bar.open, col = up ? C.green : C.red;
    const chg = prevClose ? bar.close - prevClose : 0;
    const pct = prevClose ? (chg / prevClose) * 100 : 0;
    const sign = chg >= 0 ? "+" : "";
    html += `<div class="lg-row">` +
      `<b style="color:${C.text};font-size:13px">${lastData.symbol}</b>` +
      `<span class="k">${lastData.timeframe}</span>` +
      `<span style="color:${col};margin-left:8px">O<b> ${bar.open.toFixed(2)}</b>  H<b> ${bar.high.toFixed(2)}</b>  ` +
      `L<b> ${bar.low.toFixed(2)}</b>  C<b> ${bar.close.toFixed(2)}</b>  <b>${sign}${chg.toFixed(2)} (${sign}${pct.toFixed(2)}%)</b></span>` +
      `<span class="k">Vol <b style="color:${col}">${fmtVol(volVal)}</b></span></div>`;
  }
  instances.filter((i) => i.overlay).forEach((inst) => {
    html += indicatorLegendRow(inst, crosshairVals);
  });
  lgPrice.innerHTML = html;
  wireLegendButtons(lgPrice);
}

function indicatorLegendRow(inst, crosshairVals) {
  const vals = crosshairVals && crosshairVals[inst.id];
  let valTxt = "";
  inst.plots.forEach((pk, i) => {
    if (pk === "hist") return;
    const v = vals ? vals[pk] : null;
    if (v != null) valTxt += `<span class="k" style="color:${inst.style[i].color}">${(+v).toFixed(2)}</span>`;
  });
  const dim = inst.visible ? "" : "opacity:.45;";
  return `<div class="lg-row ind-row" data-id="${inst.id}" style="${dim}">` +
    `<span class="dot" style="background:${inst.style[0].color}"></span>` +
    `<b>${inst.name}</b><span class="k">${inputSummary(inst)}</span>${valTxt}` +
    `<span class="lg-btns">` +
      `<button class="lg-btn" data-act="eye" title="Hide/Show">${inst.visible ? EYE : EYE_OFF}</button>` +
      `<button class="lg-btn" data-act="cfg" title="Settings">${GEAR}</button>` +
      `<button class="lg-btn" data-act="del" title="Remove">${XICON}</button>` +
    `</span></div>`;
}

function wireLegendButtons(container) {
  container.querySelectorAll(".ind-row").forEach((row) => {
    const inst = instances.find((i) => i.id === row.dataset.id);
    if (!inst) return;
    row.querySelector('[data-act="eye"]').onclick = (e) => { e.stopPropagation(); inst.visible = !inst.visible; applyInstanceStyle(inst); renderLegends(); saveInstances(); };
    row.querySelector('[data-act="cfg"]').onclick = (e) => { e.stopPropagation(); openSettings(inst, e.currentTarget); };
    row.querySelector('[data-act="del"]').onclick = (e) => { e.stopPropagation(); removeInstance(inst); };
  });
}

function renderLegends(crosshairVals) {
  // Price pane: keep last bar unless crosshair provides one
  const n = lastData ? lastData.candles.length : 0;
  let bar = null, volVal = null, prevClose = null;
  if (n) {
    bar = lastData.candles[n - 1];
    const prev = n > 1 ? lastData.candles[n - 2] : bar;
    prevClose = prev.close;
    volVal = lastData.volume.length ? lastData.volume[lastData.volume.length - 1].value : null;
  }
  if (crosshairVals && crosshairVals.__bar) { bar = crosshairVals.__bar; volVal = crosshairVals.__vol; prevClose = crosshairVals.__prev; }
  renderPriceLegend(bar, volVal, prevClose, crosshairVals);

  // Oscillator panes: stacked rows under the price pane
  let html = "";
  try {
    let acc = chart.paneSize(0).height + SEP;
    instances.filter((i) => !i.overlay).forEach((inst) => {
      html += `<div class="lg-osc" style="top:${acc + 6}px">${indicatorLegendRow(inst, crosshairVals)}</div>`;
      acc += (chart.paneSize(inst.paneIndex).height || 110) + SEP;
    });
  } catch (e) {}
  lgPanes.innerHTML = html;
  wireLegendButtons(lgPanes);
}

// ─────────────────────────── Crosshair → legend values ────────────────
chart.subscribeCrosshairMove((param) => {
  const vals = {};
  const n = lastData ? lastData.candles.length : 0;
  if (n && param.time) {
    const bar = param.seriesData.get(candleSeries);
    const vol = param.seriesData.get(volumeSeries);
    if (bar) {
      vals.__bar = bar; vals.__vol = vol ? vol.value : null;
      const idx = lastData.candles.findIndex((c) => c.time === param.time);
      vals.__prev = idx > 0 ? lastData.candles[idx - 1].close : null;
    }
  }
  instances.forEach((inst) => {
    const o = {};
    inst.plots.forEach((pk, i) => {
      const s = inst.series[i]; if (!s) return;
      const d = param.time ? param.seriesData.get(s) : null;
      if (d) o[pk] = d.value;
    });
    vals[inst.id] = o;
  });
  renderLegends(vals);
});

// ─────────────────────────── Load + render ────────────────────────────
function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg; el.classList.toggle("error", isError);
}

// How far into the FUTURE to reserve empty space per timeframe (seconds). The
// span is scaled to the timeframe so intraday charts don't waste memory on
// thousands of whitespace bars while weekly/monthly reach far enough out.
const DAY = 86400, WEEK = 7 * DAY, YEAR = 365 * DAY;
const FUTURE_SPAN = {
  "1m": 1 * DAY, "2m": 2 * DAY, "3m": 3 * DAY, "5m": WEEK,
  "10m": 2 * WEEK, "15m": 2 * WEEK, "30m": 3 * WEEK, "45m": 4 * WEEK,
  "1h": 4 * WEEK, "2h": 6 * WEEK, "3h": 8 * WEEK, "4h": 12 * WEEK,
  "1D": 2 * YEAR, "1W": 10 * YEAR, "1M": 20 * YEAR,
};
function futureSpanFor(tf) { return FUTURE_SPAN[tf] || 2 * YEAR; }

// Generate empty future bars (whitespace: {time} only) extending a
// timeframe-appropriate distance to the right of the last real candle, so
// drawings can be anchored past the current data — mirroring TradingView's
// reserved future space. Uses the typical bar step; for daily+ we skip
// weekends to keep the projected dates realistic.
function buildFutureWhitespace(candles, tf) {
  if (!candles || candles.length < 2) return [];
  const n = candles.length;
  const last = candles[n - 1].time;
  // Robust step: median of the last several gaps (avoids weekend outliers).
  const gaps = [];
  for (let i = Math.max(1, n - 20); i < n; i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  const step = gaps[Math.floor(gaps.length / 2)] || DAY;
  const span = futureSpanFor(tf);
  // Bar count from the span, but hard-capped so intraday (where the calendar
  // span ÷ small step could be huge) never balloons memory. Each whitespace
  // bar is just {time}, so these caps are generous.
  const MAX_BARS = { intraday: 600, daily: 520, weekly: 520, monthly: 240 };
  let cap = MAX_BARS.daily;
  if (step < DAY) cap = MAX_BARS.intraday;
  else if (step >= 25 * DAY) cap = MAX_BARS.monthly;   // ~monthly bars
  else if (step >= 5 * DAY) cap = MAX_BARS.weekly;     // ~weekly bars
  const count = Math.min(cap, Math.max(1, Math.round(span / step)));
  const daily = step >= DAY;           // skip weekends for daily-and-up
  const out = [];
  let t = last;
  for (let i = 0; i < count; i++) {
    t += step;
    if (daily) {
      // Skip Sat(6)/Sun(0) so future daily dates fall on weekdays.
      let day = new Date(t * 1000).getUTCDay();
      while (day === 0 || day === 6) { t += DAY; day = new Date(t * 1000).getUTCDay(); }
    }
    out.push({ time: t });
  }
  return out;
}

// Position the view at the LATEST bars (right edge), like most charting apps,
// showing a recent window rather than the whole history. A small right margin
// keeps a peek of the reserved future space. `bars` controls how many recent
// candles are visible (defaults to ~160).
let _fitToken = 0;
function fitRealContent(bars = 160) {
  const real = window.__realBars || (window.__bars ? window.__bars.length : 0);
  if (real <= 0) { chart.timeScale().fitContent(); return; }
  const rightPad = 8;                       // peek into future whitespace
  const to = real - 1 + rightPad;
  const from = Math.max(-1, real - 1 - bars);
  const set = () => chart.timeScale().setVisibleLogicalRange({ from, to });
  // Indicator series load ASYNCHRONOUSLY and each setData() can trigger an
  // internal auto-scroll that yanks the view off the latest bar (worse on
  // intraday, where indicators resolve after our initial fit). Re-assert the
  // range across a few frames/ticks so we win those late scrolls. A token
  // guards against a newer load stomping an older one's timers.
  const myToken = ++_fitToken;
  // Only re-assert if the view got auto-scrolled AWAY from our target (a late
  // indicator setData bounced it). If the current right edge is already near
  // `to`, assume the user is intentionally positioned and leave it alone — so
  // we don't fight a deliberate scroll.
  const reassert = () => {
    if (myToken !== _fitToken) return;
    const cur = chart.timeScale().getVisibleLogicalRange();
    if (!cur || Math.abs(cur.to - to) > 2) set();
  };
  set();
  requestAnimationFrame(reassert);
  setTimeout(reassert, 60);
  setTimeout(reassert, 200);
  setTimeout(reassert, 500);
}

async function loadData() {
  const requested = document.getElementById("symbol").value.trim().toUpperCase() || "AAPL";
  const symbolChanged = requested !== currentSymbol;
  currentSymbol = requested;
  saveLastSymbol(currentSymbol);
  setStatus(`Loading ${currentSymbol} · ${currentTf} …`);
  try {
    const res = await fetch(`/api/data?symbol=${encodeURIComponent(currentSymbol)}&tf=${currentTf}`);
    const data = await res.json();
    if (data.error) { setStatus("Error: " + data.error, true); return; }
    lastData = data;
    const prevBars = window.__bars;   // snapshot for same-symbol re-anchoring
    // Reserve empty FUTURE bars (like TradingView) so drawings can be placed
    // and saved past the last real candle. These are whitespace points (time
    // only, no OHLC) that extend the time axis ~2 years to the right.
    const future = buildFutureWhitespace(data.candles, currentTf);
    window.__bars = data.candles.concat(future);
    window.__realBars = data.candles.length;   // count of actual (non-whitespace) bars
    // Volume aligned to bar index (Date Range tool sums this over a span).
    window.__vol = (data.volume || []).map((p) => (p && typeof p.value === "number" ? p.value : 0));
    priceOverride = null;
    candleSeries.setData(data.candles.concat(future));
    volumeSeries.setData(data.volume);
    watermark.applyOptions({ lines: [{ text: data.symbol, color: "rgba(120,123,134,0.10)", fontSize: 62 }] });
    // Switched tickers → swap in this symbol's own saved indicator layout.
    if (symbolChanged) {
      userResizedPanes = false;   // reset so default sizing applies unless saved
      clearAllInstances();
      loadInstancesForSymbol();
      drawings.loadDrawings(loadDrawingsForSymbol(currentSymbol));
    } else {
      refetchAll();   // same symbol (e.g. timeframe change) → recompute in place
      // Re-pin drawings to their timestamps in case the new data shifted bar
      // indices (e.g. more history loaded), so they stay on the same candles.
      if (drawings.reanchor) drawings.reanchor(prevBars);
      else drawings.redraw();
    }
    // Fit to the REAL bars only (the future whitespace would otherwise zoom
    // the view way out). A little right padding keeps a peek of future space.
    fitRealContent();
    sizePanes();
    applySavedLayout();
    renderLegends();
    drawings.redraw();
    if (typeof refreshWatchStar === "function") refreshWatchStar();
    setStatus(`${data.symbol} · ${data.timeframe} · ${data.candles.length} bars`);
  } catch (e) { setStatus("Error: " + e.message, true); }
}

// ─────────────────────────── Wheel-over-price stretch ─────────────────
function visiblePriceRange() {
  if (!lastData) return null;
  const lr = chart.timeScale().getVisibleLogicalRange();
  const n = lastData.candles.length;
  let from = 0, to = n - 1;
  if (lr) { from = Math.max(0, Math.floor(lr.from)); to = Math.min(n - 1, Math.ceil(lr.to)); }
  let mn = Infinity, mx = -Infinity;
  for (let i = from; i <= to; i++) {
    const c = lastData.candles[i]; if (!c) continue;
    if (c.low < mn) mn = c.low; if (c.high > mx) mx = c.high;
  }
  if (!isFinite(mn) || !isFinite(mx) || mn === mx) return null;
  return { min: mn, max: mx };
}
function refreshPriceScale() {
  const ps = candleSeries.priceScale();
  ps.applyOptions({ autoScale: false });
  ps.applyOptions({ autoScale: true });
}
// Which pane is the pointer over the price-axis column of? Returns the pane
// index (0 = price), or -1 if not over any price column. Panes are stacked
// top→bottom; we accumulate their heights to find the one under the cursor.
// Resolve which pane a client-Y falls in, using each pane's actual DOM element
// bounds (robust against separator / time-axis height that paneSize() omits).
function paneIndexAtClientY(clientY) {
  const panes = chart.panes();
  for (let i = 0; i < panes.length; i++) {
    let el = null;
    try { el = panes[i].getHTMLElement && panes[i].getHTMLElement(); } catch (_) {}
    if (el) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) return i;
    }
  }
  // Fallback: accumulate paneSize heights from the chart top.
  const rect = chartEl.getBoundingClientRect();
  const y = clientY - rect.top;
  let acc = 0;
  for (let i = 0; i < panes.length; i++) {
    let h; try { h = chart.paneSize(i).height; } catch (_) { h = 0; }
    if (y >= acc && y <= acc + h + SEP) return i;
    acc += h + SEP;
  }
  return -1;
}
function paneAtPriceColumn(e) {
  const rect = chartEl.getBoundingClientRect();
  const psW = candleSeries.priceScale().width();
  const x = e.clientX - rect.left;
  if (x < rect.width - psW - 2) return -1;   // not over the axis column
  return paneIndexAtClientY(e.clientY);
}

// Vertical stretch when scrolling over a pane's price axis.
// Pane 0 (price) uses the shared candle override; oscillator panes stretch
// their own series' price scale directly. Applied immediately per event for a
// smooth, 1:1 feel; persistence is debounced separately.
function stretchPane(paneIdx, factor) {
  if (paneIdx === 0) {
    if (!priceOverride) priceOverride = visiblePriceRange();
    if (!priceOverride) return;
    const mid = (priceOverride.min + priceOverride.max) / 2;
    let half = (priceOverride.max - priceOverride.min) / 2 * factor;
    priceOverride = { min: mid - half, max: mid + half };
    refreshPriceScale();
    drawings.redraw();   // keep drawings pinned to the new price coordinates
    if (typeof positionToolbar === "function") positionToolbar();
    scheduleLayoutSave();
    return;
  }
  const inst = instances.find((i) => !i.overlay && i.paneIndex === paneIdx);
  if (!inst || !inst.series[0]) return;
  inst.stretch = (inst.stretch || 1) * factor;
  applyOscAutoscale(inst);
  drawings.redraw();
  if (typeof positionToolbar === "function") positionToolbar();
  scheduleLayoutSave();
}

// Debounced persistence for interactive layout changes (wheel/drag), so we
// don't hammer localStorage on every event.
let _layoutSaveTimer = null;
function scheduleLayoutSave() {
  clearTimeout(_layoutSaveTimer);
  _layoutSaveTimer = setTimeout(() => { saveLayout(); saveInstances(); }, 250);
}

// Detect pane-separator resizes: after a mouseup, if the pane stretch factors
// changed vs. what we last knew, treat it as a manual resize and persist.
let _lastPaneFactors = null;
function paneFactorsChanged() {
  const cur = currentPaneFactors();
  if (!cur) return false;
  const prev = _lastPaneFactors;
  _lastPaneFactors = cur;
  if (!prev || prev.length !== cur.length) return false;   // layout count changed → not a user resize
  for (let i = 0; i < cur.length; i++) {
    if (typeof cur[i] === "number" && typeof prev[i] === "number" && Math.abs(cur[i] - prev[i]) > 1e-6) return true;
  }
  return false;
}
window.addEventListener("mouseup", () => {
  if (paneFactorsChanged()) { userResizedPanes = true; scheduleLayoutSave(); }
}, true);

function overPriceColumn(e) { return paneAtPriceColumn(e) === 0; }

// Dragging directly on the price axis should hand control back to the chart's
// native price scaling, so release our wheel-stretch override on axis grab.
chartEl.addEventListener("mousedown", (e) => {
  if (paneAtPriceColumn(e) === 0 && priceOverride) { priceOverride = null; refreshPriceScale(); }
}, true);

// Which pane (by index) is a client Y coordinate in? 0 = price pane. Panes are
// stacked top→bottom; accumulate heights. Returns -1 if outside.
function paneAtY(clientY) { return paneIndexAtClientY(clientY); }

// TradingView-style body PAN in BOTH directions at once, in ANY pane. A single
// body drag pans time (horizontal, native) AND value (vertical) together. In
// the price pane we shift `priceOverride`; in an oscillator pane we shift that
// instance's `offset`, so you can drag diagonally to reveal levels off-screen.
(function enableFreePan() {
  let armed = false, lastY = 0, valuePerPx = 0, panePriceOverride = false, panInst = null, rafPending = false;
  function flush() {
    rafPending = false;
    if (panePriceOverride) refreshPriceScale();
    else if (panInst) applyOscAutoscale(panInst);
    drawings.redraw();   // keep drawings pinned while panning vertically
  }
  function scheduleRefresh() { if (!rafPending) { rafPending = true; requestAnimationFrame(flush); } }
  chartEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (paneAtPriceColumn(e) >= 0) return;          // over an axis → native handles it
    const cv = document.getElementById("draw-canvas");
    if (cv && cv.style.pointerEvents === "auto") return;   // interacting with a drawing
    const paneIdx = paneAtY(e.clientY);
    if (paneIdx < 0) return;
    const rect = chartEl.getBoundingClientRect();
    const y = e.clientY - rect.top;
    if (paneIdx === 0) {
      // Price pane → use candle series to size value-per-pixel.
      const p1 = candleSeries.coordinateToPrice(y), p2 = candleSeries.coordinateToPrice(y + 1);
      if (p1 == null || p2 == null) return;
      valuePerPx = p1 - p2; panePriceOverride = true; panInst = null;
      if (!priceOverride) priceOverride = visiblePriceRange();
      if (!priceOverride) return;
    } else {
      // Oscillator pane → find its instance and use its primary series.
      const inst = instances.find((i) => !i.overlay && i.paneIndex === paneIdx);
      if (!inst || !inst.series[0]) return;
      const s = inst.series[0];
      const p1 = s.coordinateToPrice(y), p2 = s.coordinateToPrice(y + 1);
      if (p1 == null || p2 == null) return;
      valuePerPx = p1 - p2; panePriceOverride = false; panInst = inst;
      if (inst.offset == null) inst.offset = 0;
    }
    armed = true; lastY = e.clientY;
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!armed) return;
    const dy = e.clientY - lastY;
    if (dy === 0) return;                            // no vertical component this frame
    lastY = e.clientY;
    const shift = dy * valuePerPx;                   // drag down → reveal higher values
    if (panePriceOverride) {
      priceOverride = { min: priceOverride.min + shift, max: priceOverride.max + shift };
    } else if (panInst) {
      panInst.offset = (panInst.offset || 0) + shift;
    }
    scheduleRefresh();
  });
  window.addEventListener("mouseup", () => {
    if (armed) scheduleLayoutSave();
    armed = false; panInst = null;
  });
})();

chartEl.addEventListener("wheel", (e) => {
  const paneIdx = paneAtPriceColumn(e);
  if (paneIdx < 0) return;
  e.preventDefault(); e.stopPropagation();
  // Fixed, consistent step per wheel notch (smooth + predictable). The scale
  // refresh is still coalesced per animation frame for responsiveness.
  stretchPane(paneIdx, e.deltaY > 0 ? 1.1 : 1 / 1.1);
}, { capture: true, passive: false });
// Clicking empty chart space (where the drawing overlay isn't capturing
// pointer events) should dismiss any selected drawing + its floating toolbar.
chartEl.addEventListener("mousedown", (e) => {
  if (e.target.closest && e.target.closest("#draw-toolbar")) return;   // toolbar clicks
  if (drawings.deselectAt) drawings.deselectAt(e.clientX, e.clientY);
}, true);
chartEl.addEventListener("dblclick", (e) => {
  // A drawing under the cursor takes priority (opens its settings).
  if (drawings.editAt && drawings.editAt(e.clientX, e.clientY)) { e.preventDefault(); e.stopPropagation(); return; }
  const paneIdx = paneAtPriceColumn(e);
  if (paneIdx < 0) return;
  if (paneIdx === 0) { priceOverride = null; refreshPriceScale(); scheduleLayoutSave(); return; }
  const inst = instances.find((i) => !i.overlay && i.paneIndex === paneIdx);
  if (inst) { inst.stretch = 1; inst.offset = 0; applyOscAutoscale(inst); scheduleLayoutSave(); }
}, true);

// ─────────────────────────── Drawing tools ────────────────────────────
// Transparent canvas stacked over the chart. Drawings live in {time,price}
// data-space so they stay pinned on pan/zoom. Selectable like TradingView:
// hover highlights, click selects (endpoint handles), drag handle/body to
// move, Delete removes.
const drawings = (() => {
  const cv = document.createElement("canvas");
  cv.id = "draw-canvas";
  cv.style.cssText = "position:absolute;inset:0;z-index:4;pointer-events:none";
  chartEl.appendChild(cv);
  const ctx = cv.getContext("2d");

  let tool = "cursor";
  const items = [];
  let draft = null, selected = null, hovered = null, drag = null;
  let onSelectChange = null;
  function notifySel() { if (onSelectChange) onSelectChange(selected); }

  const HANDLE_R = 5, HIT = 6;
  // Retracement levels. 0..1 are the classic retracement band; values <0 and
  // >1 project beyond the swing as extension support/resistance targets.
  const FIB = [
    -0.618, -0.382, -0.236, 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1,
    1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236,
  ];
  const FIB_COL = [
    // -0.618  -0.382   -0.236    0        0.236     0.382     0.5       0.618     0.786     1
    "#ec407a", "#ab47bc", "#7e57c2", "#787b86", "#f23645", "#ff9800", "#ffd54f", "#66bb6a", "#26c6da", "#787b86",
    // 1.272   1.414     1.618     2         2.618     3.618     4.236
    "#42a5f5", "#5c6bc0", "#7e57c2", "#ab47bc", "#ec407a", "#ff7043", "#ffa726",
  ];
  // Trend-based extension projection levels (from the C anchor). Negative
  // levels project the OPPOSITE direction of the impulse — i.e. for an
  // up-impulse they fall below C and act as SUPPORT targets (and vice-versa
  // for a down-impulse). Positive levels are the trend-continuation targets.
  const FIB_EXT = [
    -1.618, -1, -0.786, -0.618, -0.5, -0.382, -0.236, 0,
    0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618, 3.618, 4.236,
  ];
  const FIB_EXT_COL = [
    // -1.618  -1       -0.786    -0.618    -0.5      -0.382    -0.236     0
    "#d81b60", "#ec407a", "#ab47bc", "#7e57c2", "#5c6bc0", "#7986cb", "#9575cd", "#787b86",
    // 0.236   0.382     0.5       0.618     0.786     1
    "#f23645", "#ff9800", "#ffd54f", "#66bb6a", "#26c6da", "#787b86",
    // 1.272   1.414     1.618     2         2.618     3.618     4.236
    "#42a5f5", "#5c6bc0", "#7e57c2", "#ab47bc", "#ec407a", "#ff7043", "#ffa726",
  ];
  function hexA(hex, a) {
    const n = parseInt((hex || "#787b86").slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // Per-object level config: [{ value, color, on }]. Defaults come from the
  // constant tables above; each drawing carries its own editable copy.
  function defaultFibLevels() {
    return FIB.map((v, i) => ({ value: v, color: FIB_COL[i], on: true }));
  }
  function defaultFibExtLevels() {
    return FIB_EXT.map((v, i) => ({ value: v, color: FIB_EXT_COL[i], on: true }));
  }
  function defaultFibOpts() {
    return { trendLine: true, background: true, reverse: false, showPrices: true, showLevels: true, extend: "none" };
  }
  // Ensure a fib/fibext item has its config (older items / drafts).
  function ensureFibCfg(it) {
    if (!it.opts) it.opts = defaultFibOpts();
    if (!it.levels) it.levels = it.type === "fibext" ? defaultFibExtLevels() : defaultFibLevels();
    return it;
  }
  // Shared renderer for a set of horizontal fib levels between two prices.
  // basePrice = price at ratio 0, rng = price delta for ratio 1.
  function paintFibLevels(it, x0, x1, basePrice, rng) {
    const o = it.opts, levels = it.levels.filter((l) => l.on);
    if (it.opts.reverse) { basePrice = basePrice + rng; rng = -rng; }
    const rows = levels.map((l) => ({ l, y: priceToY(basePrice + l.value * rng) }))
      .filter((r) => r.y != null)
      .sort((a, b) => a.y - b.y);
    ctx.font = (it.fontSize || 11) + "px 'Segoe UI'";
    for (let i = 0; i < rows.length; i++) {
      const { l, y } = rows[i];
      if (o.background && i < rows.length - 1) {
        ctx.fillStyle = hexA(rows[i + 1].l.color, 0.12);
        ctx.fillRect(x0, y, x1 - x0, rows[i + 1].y - y);
      }
      ctx.strokeStyle = l.color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      if (o.showLevels || o.showPrices) {
        const price = basePrice + l.value * rng;
        const parts = [];
        if (o.showLevels) parts.push(l.value.toFixed(3));
        if (o.showPrices) parts.push(`(${price.toFixed(2)})`);
        ctx.fillStyle = l.color;
        ctx.fillText(parts.join(" "), x0 + 4, y - 3);
      }
    }
  }

  function resize() {
    const r = chartEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    cv.style.width = r.width + "px"; cv.style.height = r.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  // Drawings anchor on the time-scale's LOGICAL index (a continuous, always-
  // defined coordinate) rather than raw timestamps. This keeps objects visible
  // while dragging into empty space / off the last bar, where timeToCoordinate
  // would return null and the object would vanish.
  //
  // Both the price scale and the logical (time) scale are LINEAR maps to pixel
  // coordinates. Calling priceToCoordinate/logicalToCoordinate once per point
  // is wasteful (especially for fibs with many levels), and each stretch step
  // redraws everything. Instead we sample each transform ONCE per redraw and
  // reuse the affine coefficients (y = pm·price + pb, x = xm·logical + xb).
  const _ts = chart.timeScale();       // cache the API object
  let _pm = 0, _pb = 0, _xm = 0, _xb = 0, _coordOK = false;
  function rebuildCoordCache() {
    // Price → y: sample two prices; slope is constant across the axis.
    const y0 = candleSeries.priceToCoordinate(0);
    const y1 = candleSeries.priceToCoordinate(1);
    // Logical → x: sample two logical indices.
    const x0 = _ts.logicalToCoordinate ? _ts.logicalToCoordinate(0) : null;
    const x1 = _ts.logicalToCoordinate ? _ts.logicalToCoordinate(1) : null;
    if (y0 == null || y1 == null || x0 == null || x1 == null) { _coordOK = false; return; }
    _pm = y1 - y0; _pb = y0;          // y = pm·price + pb
    _xm = x1 - x0; _xb = x0;          // x = xm·logical + xb
    _coordOK = true;
  }
  function priceToY(price) { return _coordOK ? _pm * price + _pb : candleSeries.priceToCoordinate(price); }
  function logicalX(logical) {
    if (_coordOK) return _xm * logical + _xb;
    return _ts.logicalToCoordinate ? _ts.logicalToCoordinate(logical) : null;
  }
  function xToLogical(x) {
    if (_coordOK && _xm !== 0) return (x - _xb) / _xm;
    const l = _ts.coordinateToLogical(x);
    return l == null ? null : l;
  }
  function toXY(pt) {
    if (!pt) return null;
    const x = logicalX(pt.logical);
    const y = priceToY(pt.price);
    return (x == null || y == null || !isFinite(x) || !isFinite(y)) ? null : { x, y };
  }
  function yToPrice(y) {
    if (_coordOK && _pm !== 0) return (y - _pb) / _pm;
    return candleSeries.coordinateToPrice(y);
  }
  function pxToData(x, y, snap) {
    let logical = xToLogical(x);
    if (logical == null) return null;
    if (snap) logical = Math.round(logical);
    const price = yToPrice(y);
    return (price == null) ? null : { logical, price };
  }
  function mousePx(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  function stroke(A, B, color, width, dash) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.restore();
  }
  // Per-item color / width (set via the floating toolbar); fall back to the
  // renderer's original hardcoded default when unset.
  function col(it, fallback) { return it.color || fallback; }
  function wid(it, fallback) { return it.width || fallback; }
  function drawTrend(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    if (emph) stroke(A, B, "rgba(41,98,255,0.25)", 6);
    stroke(A, B, col(it, C.blue), wid(it, 1.5));
  }
  // Extend the segment A→B to the canvas edge in the given direction(s).
  function extendPoint(A, B, forward) {
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const big = (cv.clientWidth + cv.clientHeight) * 2;
    const from = forward ? B : A;
    const sign = forward ? 1 : -1;
    return { x: from.x + sign * ux * big, y: from.y + sign * uy * big };
  }
  function drawRay(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const end = extendPoint(A, B, true);
    if (emph) stroke(A, end, "rgba(41,98,255,0.25)", 6);
    stroke(A, end, col(it, C.blue), wid(it, 1.5));
  }
  function drawExtended(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const s = extendPoint(A, B, false), e = extendPoint(A, B, true);
    if (emph) stroke(s, e, "rgba(41,98,255,0.25)", 6);
    stroke(s, e, col(it, C.blue), wid(it, 1.5));
  }
  function drawVLineItem(it, emph) {
    const x = logicalX(it.a.logical); if (x == null) return;
    const h = cv.clientHeight;
    if (emph) stroke({ x, y: 0 }, { x, y: h }, "rgba(41,98,255,0.25)", 6);
    ctx.save(); ctx.strokeStyle = col(it, C.blue); ctx.lineWidth = wid(it, 1.5); ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.restore();
  }
  function drawCrossline(it, emph) {
    // horizontal + vertical through the anchor point
    drawHLineItem(it, emph);
    drawVLineItem(it, emph);
  }
  function drawEllipseItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2;
    const rx = Math.abs(B.x - A.x) / 2, ry = Math.abs(B.y - A.y) / 2;
    ctx.save();
    if (emph) { ctx.strokeStyle = "rgba(224,64,251,0.5)"; ctx.lineWidth = 5; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke(); }
    const ec = col(it, C.purple);
    ctx.strokeStyle = ec; ctx.fillStyle = hexA(ec, 0.10); ctx.lineWidth = wid(it, 1.5);
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  function drawArrowItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    if (emph) stroke(A, B, "rgba(41,98,255,0.25)", 6);
    const ac = col(it, C.blue), aw = wid(it, 2);
    stroke(A, B, ac, aw);
    // arrowhead at B
    const ang = Math.atan2(B.y - A.y, B.x - A.x), head = 11;
    ctx.save(); ctx.strokeStyle = ac; ctx.lineWidth = aw; ctx.beginPath();
    ctx.moveTo(B.x, B.y); ctx.lineTo(B.x - head * Math.cos(ang - 0.4), B.y - head * Math.sin(ang - 0.4));
    ctx.moveTo(B.x, B.y); ctx.lineTo(B.x - head * Math.cos(ang + 0.4), B.y - head * Math.sin(ang + 0.4));
    ctx.stroke(); ctx.restore();
  }
  function drawBrushItem(it, emph) {
    if (!it.pts || it.pts.length < 2) return;
    ctx.save(); ctx.strokeStyle = emph ? "rgba(41,98,255,0.6)" : col(it, C.blue);
    ctx.lineWidth = emph ? 4 : wid(it, 2); ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    let started = false;
    for (const p of it.pts) { const P = toXY(p); if (!P) continue; if (!started) { ctx.moveTo(P.x, P.y); started = true; } else ctx.lineTo(P.x, P.y); }
    ctx.stroke(); ctx.restore();
  }
  // Long/Short position: entry (a) → target/stop derived from b. Green profit
  // zone toward the target, red risk zone toward the stop.
  function drawPositionItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const isLong = it.type === "longpos";
    const entryY = A.y, targetY = B.y;
    // stop is mirrored on the opposite side of entry by half the reward distance
    const risk = Math.abs(targetY - entryY) * 0.5;
    const stopY = isLong ? entryY + risk : entryY - risk;
    const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x), w = x1 - x0 || 60;
    const profTop = Math.min(entryY, targetY), profH = Math.abs(targetY - entryY);
    const riskTop = Math.min(entryY, stopY), riskH = Math.abs(stopY - entryY);
    ctx.save();
    ctx.fillStyle = "rgba(38,166,154,0.18)"; ctx.fillRect(x0, profTop, w, profH);
    ctx.fillStyle = "rgba(239,83,80,0.18)"; ctx.fillRect(x0, riskTop, w, riskH);
    ctx.strokeStyle = C.green; ctx.lineWidth = 1; ctx.strokeRect(x0, profTop, w, profH);
    ctx.strokeStyle = C.red; ctx.strokeRect(x0, riskTop, w, riskH);
    // entry line
    ctx.strokeStyle = emph ? "#fff" : C.text2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(x0, entryY); ctx.lineTo(x1, entryY); ctx.stroke(); ctx.setLineDash([]);
    const rr = riskH ? (profH / riskH) : 0;
    ctx.fillStyle = C.text; ctx.font = "11px 'Segoe UI'";
    ctx.fillText(`${isLong ? "Long" : "Short"}  Target ${it.b.price.toFixed(2)}  R:R ${rr.toFixed(2)}`, x0 + 4, profTop - 4);
    ctx.restore();
  }
  // Sum of volume between two logical indices (inclusive), using __vol.
  function volumeBetween(la, lb) {
    const vol = window.__vol || [];
    if (!vol.length) return 0;
    let lo = Math.round(Math.min(la, lb)), hi = Math.round(Math.max(la, lb));
    lo = Math.max(0, lo); hi = Math.min(vol.length - 1, hi);
    let s = 0;
    for (let i = lo; i <= hi; i++) s += vol[i] || 0;
    return s;
  }
  // Compact volume formatting: 7.1B, 950M, 12.3K …
  function fmtVol(v) {
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(2) + "K";
    return String(Math.round(v));
  }
  // Calendar days between two anchor times (uses persisted time when live,
  // else derives from bar spacing at the logical indices).
  function daysBetween(it) {
    const ta = anchorTime(it.a), tb = anchorTime(it.b);
    if (ta == null || tb == null) return null;
    return Math.abs(Math.round((tb - ta) / 86400));
  }
  function anchorTime(pt) {
    // Prefer the stored epoch time if present; else map logical→time.
    if (pt && typeof pt.time === "number") return pt.time;
    return logicalToTime(pt.logical);
  }

  // TradingView-style Date Range: a fixed-height band spanning the two time
  // anchors with a horizontal arrow through the middle, dashed vertical
  // boundary lines, and a centered label showing bars, calendar days, and
  // summed volume. Price Range / Date & Price Range stay as boxes.
  function drawDateRangeItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x);
    // Band is centred vertically on the midpoint of the two anchors, fixed height.
    const cy = (A.y + B.y) / 2;
    const H = 26;                       // fixed band height (px)
    const yTop = cy - H / 2, yBot = cy + H / 2;
    const ac = C.accent;
    ctx.save();
    // Dashed vertical boundary lines across the pane.
    ctx.strokeStyle = hexA(ac, 0.5); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, 0); ctx.lineTo(x0, cv.clientHeight);
    ctx.moveTo(x1, 0); ctx.lineTo(x1, cv.clientHeight);
    ctx.stroke(); ctx.setLineDash([]);
    // Band fill + border.
    ctx.fillStyle = hexA(ac, 0.12);
    ctx.fillRect(x0, yTop, x1 - x0, H);
    ctx.strokeStyle = ac; ctx.lineWidth = emph ? 2.5 : 1;
    ctx.strokeRect(x0, yTop, x1 - x0, H);
    // Horizontal arrow through the middle (points toward the drag direction).
    const rightward = B.x >= A.x;
    const ax0 = rightward ? x0 + 3 : x1 - 3;
    const ax1 = rightward ? x1 - 3 : x0 + 3;
    ctx.strokeStyle = ac; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(ax0, cy); ctx.lineTo(ax1, cy); ctx.stroke();
    const ah = 5, dir = rightward ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(ax1, cy); ctx.lineTo(ax1 - dir * ah, cy - ah);
    ctx.moveTo(ax1, cy); ctx.lineTo(ax1 - dir * ah, cy + ah);
    ctx.stroke();
    // Endpoint handle dot on the start side.
    ctx.fillStyle = "#fff"; ctx.strokeStyle = ac; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(A.x, cy, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Label box centred below the band: "N bars, Xd" + "Vol …".
    const la = chart.timeScale().coordinateToLogical(A.x);
    const lb = chart.timeScale().coordinateToLogical(B.x);
    const bars = (la != null && lb != null) ? Math.abs(Math.round(lb - la)) : 0;
    const d = daysBetween(it);
    const vol = (la != null && lb != null) ? volumeBetween(la, lb) : 0;
    const line1 = d != null ? `${bars} bars, ${d}d` : `${bars} bars`;
    const line2 = `Vol ${fmtVol(vol)}`;
    ctx.font = "11px 'Segoe UI'";
    const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 16;
    const lh = 15, boxH = lh * 2 + 6, cx = (x0 + x1) / 2;
    const bx = cx - w / 2, by = yBot + 8;
    ctx.fillStyle = "rgba(30,34,45,0.92)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, w, boxH, 5); ctx.fill(); }
    else ctx.fillRect(bx, by, w, boxH);
    ctx.fillStyle = C.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(line1, cx, by + lh / 2 + 3);
    ctx.fillText(line2, cx, by + lh + lh / 2 + 3);
    ctx.restore();
  }

  // Draw a centred multi-line label box; returns nothing. `lines` may carry a
  // per-line color; falls back to C.text.
  function drawLabelBox(cx, cy, lines) {
    ctx.save();
    ctx.font = "11px 'Segoe UI'";
    const lh = 15, pad = 6;
    const w = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 16;
    const boxH = lh * lines.length + pad;
    const bx = cx - w / 2, by = cy - boxH / 2;
    ctx.fillStyle = "rgba(30,34,45,0.92)";
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, w, boxH, 5); ctx.fill(); }
    else ctx.fillRect(bx, by, w, boxH);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    lines.forEach((l, i) => {
      ctx.fillStyle = l.color || C.text;
      ctx.fillText(l.text, cx, by + pad / 2 + lh * i + lh / 2);
    });
    ctx.restore();
  }

  // TradingView-style Price Range: a band spanning the two prices with a
  // vertical arrow through the middle and a centred label showing the price
  // change and percentage (green up / red down).
  function drawPriceRangeItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x);
    const y0 = Math.min(A.y, B.y), y1 = Math.max(A.y, B.y);
    const up = it.b.price >= it.a.price;
    const clr = up ? C.green : C.red;
    ctx.save();
    // Dashed horizontal boundary lines across the pane at each price.
    ctx.strokeStyle = hexA(clr, 0.5); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, A.y); ctx.lineTo(cv.clientWidth, A.y);
    ctx.moveTo(0, B.y); ctx.lineTo(cv.clientWidth, B.y);
    ctx.stroke(); ctx.setLineDash([]);
    // Band fill + border.
    ctx.fillStyle = hexA(clr, 0.12);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = clr; ctx.lineWidth = emph ? 2.5 : 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // Vertical arrow through the middle, pointing toward B's price.
    const cx = (x0 + x1) / 2;
    const ay0 = A.y, ay1 = B.y;
    ctx.strokeStyle = clr; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, ay0); ctx.lineTo(cx, ay1); ctx.stroke();
    const ah = 5, dir = ay1 >= ay0 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(cx, ay1); ctx.lineTo(cx - ah, ay1 - dir * ah);
    ctx.moveTo(cx, ay1); ctx.lineTo(cx + ah, ay1 - dir * ah);
    ctx.stroke();
    // Endpoint handle dot at the start price.
    ctx.fillStyle = "#fff"; ctx.strokeStyle = clr; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, A.y, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // Label with price change and %, centred on the band midpoint.
    const dP = it.b.price - it.a.price, dPct = it.a.price ? (dP / it.a.price) * 100 : 0;
    const txt = `${dP >= 0 ? "+" : ""}${dP.toFixed(2)} (${dPct >= 0 ? "+" : ""}${dPct.toFixed(2)}%)`;
    drawLabelBox(cx, (y0 + y1) / 2, [{ text: txt, color: clr }]);
    ctx.restore();
  }

  // TradingView-style Date & Price Range: a full box over both dimensions with
  // a centred label combining price change/% and bars/days/volume.
  function drawDatePriceRangeItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x);
    const y0 = Math.min(A.y, B.y), y1 = Math.max(A.y, B.y);
    const up = it.b.price >= it.a.price;
    const clr = up ? C.green : C.red;
    ctx.save();
    ctx.fillStyle = hexA(clr, 0.12);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = clr; ctx.lineWidth = emph ? 2.5 : 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    // Diagonal arrow from A to B.
    ctx.strokeStyle = clr; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    const ang = Math.atan2(B.y - A.y, B.x - A.x), ah = 7;
    ctx.beginPath();
    ctx.moveTo(B.x, B.y); ctx.lineTo(B.x - ah * Math.cos(ang - 0.4), B.y - ah * Math.sin(ang - 0.4));
    ctx.moveTo(B.x, B.y); ctx.lineTo(B.x - ah * Math.cos(ang + 0.4), B.y - ah * Math.sin(ang + 0.4));
    ctx.stroke();
    // Label: price change / % on line 1, bars/days/volume on line 2.
    const dP = it.b.price - it.a.price, dPct = it.a.price ? (dP / it.a.price) * 100 : 0;
    const la = chart.timeScale().coordinateToLogical(A.x);
    const lb = chart.timeScale().coordinateToLogical(B.x);
    const bars = (la != null && lb != null) ? Math.abs(Math.round(lb - la)) : 0;
    const d = daysBetween(it);
    const vol = (la != null && lb != null) ? volumeBetween(la, lb) : 0;
    const l1 = `${dP >= 0 ? "+" : ""}${dP.toFixed(2)} (${dPct >= 0 ? "+" : ""}${dPct.toFixed(2)}%)`;
    const l2 = `${d != null ? `${bars} bars, ${d}d` : `${bars} bars`}  ·  Vol ${fmtVol(vol)}`;
    drawLabelBox((x0 + x1) / 2, (y0 + y1) / 2, [{ text: l1, color: clr }, { text: l2 }]);
    ctx.restore();
  }

  function drawRangeItem(it, emph) {
    if (it.type === "daterange") return drawDateRangeItem(it, emph);
    if (it.type === "pricerange") return drawPriceRangeItem(it, emph);
    return drawDatePriceRangeItem(it, emph);   // rangebox
  }
  function drawHLineItem(it, emph) {
    const y = priceToY(it.a.price); if (y == null) return;
    const w = cv.clientWidth;
    if (emph) stroke({ x: 0, y }, { x: w, y }, "rgba(240,185,11,0.25)", 6);
    const hc = col(it, C.yellow);
    ctx.save(); ctx.strokeStyle = hc; ctx.lineWidth = wid(it, 1.5); ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = hc; ctx.font = "11px 'Segoe UI'";
    ctx.fillText(it.a.price.toFixed(2), 6, y - 4); ctx.restore();
  }
  function drawRectItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.abs(B.x - A.x), h = Math.abs(B.y - A.y);
    ctx.save();
    if (emph) { ctx.strokeStyle = "rgba(255,152,0,0.5)"; ctx.lineWidth = 5; ctx.strokeRect(x, y, w, h); }
    const rc = col(it, C.orange);
    ctx.strokeStyle = rc; ctx.fillStyle = hexA(rc, 0.12); ctx.lineWidth = wid(it, 1);
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.restore();
  }
  function drawFibItem(it, emph) {
    ensureFibCfg(it);
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    // Direction follows the drag: level 0 at point A, level 1 at point B.
    const p0 = it.a.price, rng = it.b.price - it.a.price;
    let x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x);
    if (it.opts.extend === "right") x1 = cv.clientWidth;
    else if (it.opts.extend === "left") x0 = 0;
    else if (it.opts.extend === "both") { x0 = 0; x1 = cv.clientWidth; }
    ctx.save();
    if (emph) stroke(A, B, "rgba(41,98,255,0.3)", 6);
    // dashed diagonal trend line connecting the two anchor points
    if (it.opts.trendLine) {
      ctx.strokeStyle = "#9aa0aa"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.setLineDash([]);
    }
    paintFibLevels(it, x0, x1, p0, rng);
    ctx.restore();
  }
  // Trend-based Fib Extension: 3 points A→B→C. The A→B move defines 100%;
  // levels are projected from C. Points stored as a, b, c.
  function drawFibExtItem(it, emph) {
    ensureFibCfg(it);
    const A = toXY(it.a), B = toXY(it.b), C = it.c ? toXY(it.c) : null;
    if (!A || !B) return;
    ctx.save();
    // guide lines A→B→C
    if (it.opts.trendLine) {
      ctx.strokeStyle = "#9aa0aa"; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); if (C) ctx.lineTo(C.x, C.y); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (!it.c) { ctx.restore(); return; }   // still placing the 3rd point
    const move = it.b.price - it.a.price;    // 100% of the A→B move
    let x0 = Math.min(A.x, B.x, C.x), x1 = Math.max(A.x, B.x, C.x);
    if (it.opts.extend === "right") x1 = cv.clientWidth;
    else if (it.opts.extend === "left") x0 = 0;
    else if (it.opts.extend === "both") { x0 = 0; x1 = cv.clientWidth; }
    paintFibLevels(it, x0, x1, it.c.price, move);
    if (emph) { stroke(A, B, "rgba(41,98,255,0.3)", 6); stroke(B, C, "rgba(41,98,255,0.3)", 6); }
    ctx.restore();
  }
  function drawMeasureItem(it, emph) {
    const A = toXY(it.a), B = toXY(it.b); if (!A || !B) return;
    const up = it.b.price >= it.a.price;
    const col = up ? "rgba(38,166,154,0.9)" : "rgba(239,83,80,0.9)";
    const fill = up ? "rgba(38,166,154,0.12)" : "rgba(239,83,80,0.12)";
    const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y), w = Math.abs(B.x - A.x), h = Math.abs(B.y - A.y);
    ctx.save();
    if (emph) { ctx.strokeStyle = col; ctx.lineWidth = 5; ctx.globalAlpha = 0.4; ctx.strokeRect(x, y, w, h); ctx.globalAlpha = 1; }
    ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
    const dPrice = it.b.price - it.a.price, dPct = it.a.price ? (dPrice / it.a.price) * 100 : 0;
    let bars = "";
    const la = chart.timeScale().coordinateToLogical(A.x), lb = chart.timeScale().coordinateToLogical(B.x);
    if (la != null && lb != null) bars = `  ${Math.abs(Math.round(lb - la))} bars`;
    const label = `${dPrice >= 0 ? "+" : ""}${dPrice.toFixed(2)} (${dPct >= 0 ? "+" : ""}${dPct.toFixed(2)}%)${bars}`;
    ctx.fillStyle = col; ctx.font = "bold 11px 'Segoe UI'";
    ctx.fillText(label, x + 4, y + h / 2); ctx.restore();
  }
  function drawTextItem(it, emph) {
    const A = toXY(it.a); if (!A) return;
    ctx.save(); ctx.font = "13px 'Segoe UI'";
    if (emph) { ctx.fillStyle = "rgba(41,98,255,0.25)"; const w = ctx.measureText(it.text).width; ctx.fillRect(A.x + 2, A.y - 13, w + 4, 17); }
    ctx.fillStyle = C.text; ctx.fillText(it.text, A.x + 4, A.y); ctx.restore();
  }

  // ── Multi-point patterns (XABCD, Elliott, cycles, …) ──────────────────
  // A pattern is a polyline over `it.pts`. Its spec defines how many vertices
  // it needs, the label for each vertex, and whether the shape is filled.
  const PATTERN_SPECS = {
    // Chart patterns
    xabcd:      { n: 5, labels: ["X", "A", "B", "C", "D"], fill: true, name: "XABCD Pattern" },
    cypher:     { n: 5, labels: ["X", "A", "B", "C", "D"], fill: true, name: "Cypher Pattern" },
    headshoulders: { n: 7, labels: ["", "LS", "", "H", "", "RS", ""], fill: false, name: "Head and Shoulders" },
    abcd:       { n: 4, labels: ["A", "B", "C", "D"], fill: true, name: "ABCD Pattern" },
    triangle:   { n: 4, labels: ["A", "B", "C", "D"], fill: true, name: "Triangle Pattern" },
    threedrives:{ n: 7, labels: ["", "1", "", "2", "", "3", ""], fill: false, name: "Three Drives Pattern" },
    // Elliott waves
    ell_impulse:   { n: 6, labels: ["0", "1", "2", "3", "4", "5"], fill: false, name: "Elliott Impulse Wave (1-2-3-4-5)" },
    ell_correction:{ n: 4, labels: ["0", "A", "B", "C"], fill: false, name: "Elliott Correction Wave (A-B-C)" },
    ell_triangle:  { n: 6, labels: ["0", "A", "B", "C", "D", "E"], fill: false, name: "Elliott Triangle Wave (A-B-C-D-E)" },
    ell_double:    { n: 4, labels: ["0", "W", "X", "Y"], fill: false, name: "Elliott Double Combo (W-X-Y)" },
    ell_triple:    { n: 6, labels: ["0", "W", "X", "Y", "X", "Z"], fill: false, name: "Elliott Triple Combo (W-X-Y-X-Z)" },
  };
  function patternPts(it) { return it.pts || []; }

  // Draw a small rounded ratio label (TradingView style) centred at (x, y).
  function drawRatioLabel(x, y, text, lc) {
    if (!isFinite(x) || !isFinite(y)) return;
    ctx.save();
    ctx.font = "bold 11px 'Segoe UI'";
    const padX = 6, padY = 3, w = ctx.measureText(text).width;
    const bx = x - w / 2 - padX, by = y - 8 - padY, bw = w + padX * 2, bh = 16 + padY * 2 - 8;
    ctx.fillStyle = hexA(lc, 0.16);
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 4); ctx.fill(); }
    else ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = lc;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, x, by + bh / 2);
    ctx.restore();
  }

  // ABCD-family ratio annotations. For 4 named points A,B,C,D this shows the
  // BC/AB retracement (between A and C) and the CD/BC projection (between B
  // and D), matching TradingView's ABCD / XABCD labels.
  function drawAbcdRatios(it, ptsXY, lc) {
    const raw = patternPts(it);
    // Locate the A,B,C,D indices: last four points of the pattern.
    const spec = PATTERN_SPECS[it.type];
    if (!spec) return;
    const n = raw.length;
    if (n < spec.n) return;   // only annotate a completed pattern
    const iA = spec.n - 4, iB = spec.n - 3, iC = spec.n - 2, iD = spec.n - 1;
    const A = raw[iA], B = raw[iB], C = raw[iC], D = raw[iD];
    const pA = ptsXY[iA], pB = ptsXY[iB], pC = ptsXY[iC], pD = ptsXY[iD];
    if (!A || !B || !C || !D || !pA || !pB || !pC || !pD) return;
    const ab = Math.abs(B.price - A.price);
    const bc = Math.abs(C.price - B.price);
    const cd = Math.abs(D.price - C.price);
    if (ab > 1e-9) {
      const r = (bc / ab).toFixed(3);
      drawRatioLabel((pA.x + pC.x) / 2, (pA.y + pC.y) / 2, r, lc);
    }
    if (bc > 1e-9) {
      const r = (cd / bc).toFixed(3);
      drawRatioLabel((pB.x + pD.x) / 2, (pB.y + pD.y) / 2, r, lc);
    }
  }

  function drawPatternItem(it, emph) {
    const spec = PATTERN_SPECS[it.type]; if (!spec) return;
    const pts = patternPts(it).map(toXY);
    const valid = pts.filter((p) => p);
    if (valid.length < 1) return;
    const lc = col(it, C.blue), lw = wid(it, 2);
    ctx.save();
    // emphasis underlay
    if (emph) {
      ctx.strokeStyle = "rgba(41,98,255,0.3)"; ctx.lineWidth = lw + 4; ctx.lineJoin = "round";
      ctx.beginPath();
      valid.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.stroke();
    }
    // fill (only when all points placed, for filled patterns)
    if (spec.fill && valid.length >= 3 && valid.length === spec.n) {
      ctx.fillStyle = hexA(lc, 0.10);
      ctx.beginPath();
      valid.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath(); ctx.fill();
    }
    // polyline
    ctx.strokeStyle = lc; ctx.lineWidth = lw; ctx.lineJoin = "round";
    ctx.beginPath();
    valid.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.stroke();
    // vertex dots + labels
    ctx.font = "bold 11px 'Segoe UI'";
    pts.forEach((p, i) => {
      if (!p) return;
      const label = (spec.labels[i] != null) ? spec.labels[i] : String(i + 1);
      ctx.fillStyle = lc;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
      if (label) {
        // place label just above/below the vertex depending on neighbor slope
        const prev = pts[i - 1], up = prev ? p.y <= prev.y : true;
        ctx.fillStyle = C.text;
        ctx.fillText(label, p.x + 5, p.y + (up ? -6 : 14));
      }
    });
    // ABCD / XABCD ratio annotations (BC/AB and CD/BC).
    if ((it.type === "abcd" || it.type === "xabcd") && valid.length === spec.n) {
      drawAbcdRatios(it, pts, lc);
    }
    ctx.restore();
  }

  // Cycles: sine line (2 pts → period + amplitude), cyclic lines (2 pts →
  // repeated verticals), time cycles (2 pts → repeated verticals w/ curve).
  function drawSineItem(it, emph) {
    const pts = patternPts(it); if (pts.length < 2) return;
    const A = toXY(pts[0]), B = toXY(pts[1]); if (!A || !B) return;
    const lc = col(it, C.cyan), lw = wid(it, 2);
    const halfPeriod = B.x - A.x, amp = (A.y - B.y);
    if (Math.abs(halfPeriod) < 1) return;
    ctx.save(); ctx.strokeStyle = lc; ctx.lineWidth = lw; if (emph) { ctx.lineWidth = lw + 3; ctx.globalAlpha = 0.4; }
    ctx.beginPath();
    const x0 = 0, x1 = cv.clientWidth;
    for (let x = x0; x <= x1; x += 2) {
      const phase = ((x - A.x) / (2 * halfPeriod)) * Math.PI;
      const y = A.y - amp * Math.sin(phase);
      if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.restore();
  }
  function drawCyclicItem(it, emph) {
    const pts = patternPts(it); if (pts.length < 2) return;
    const A = toXY(pts[0]), B = toXY(pts[1]); if (!A || !B) return;
    const step = B.x - A.x; if (Math.abs(step) < 2) return;
    const lc = col(it, C.purple), lw = wid(it, 1.5), h = cv.clientHeight;
    ctx.save(); ctx.strokeStyle = lc; ctx.lineWidth = emph ? lw + 3 : lw; if (emph) ctx.globalAlpha = 0.4;
    ctx.setLineDash(it.type === "timecycles" ? [] : [4, 4]);
    for (let k = 0, x = A.x; x <= cv.clientWidth && k < 200; k++, x = A.x + k * step) {
      if (x < 0) continue;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.restore();
  }

  // Andrews' Pitchfork: 3 points. P0 is the pivot; the median line runs from
  // P0 through the midpoint of P1–P2. Two "tine" lines start at P1 and P2 and
  // run parallel to the median. All three rays extend to the right edge.
  function drawPitchforkItem(it, emph) {
    const pts = patternPts(it);
    const P0 = pts[0] && toXY(pts[0]);
    const P1 = pts[1] && toXY(pts[1]);
    const P2 = pts[2] && toXY(pts[2]);
    if (!P0 || !P1) return;
    const lc = col(it, C.orange), lw = wid(it, 2);
    ctx.save();
    ctx.lineJoin = "round";
    if (!P2) {
      // Only two points placed so far → preview the base line P0→P1.
      ctx.strokeStyle = lc; ctx.lineWidth = emph ? lw + 3 : lw;
      ctx.beginPath(); ctx.moveTo(P0.x, P0.y); ctx.lineTo(P1.x, P1.y); ctx.stroke();
      ctx.restore(); return;
    }
    const M = { x: (P1.x + P2.x) / 2, y: (P1.y + P2.y) / 2 };
    // Direction of the median line (P0 → M), extended far to the right.
    let dx = M.x - P0.x, dy = M.y - P0.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const FAR = (cv.clientWidth + cv.clientHeight) * 2;   // long enough to leave the pane
    const ray = (from) => ({ x: from.x + dx * FAR, y: from.y + dy * FAR });
    const mEnd = ray(M), t1End = ray(P1), t2End = ray(P2);

    // Translucent fill between the two outer tines.
    ctx.fillStyle = hexA(lc, 0.08);
    ctx.beginPath();
    ctx.moveTo(P1.x, P1.y); ctx.lineTo(t1End.x, t1End.y);
    ctx.lineTo(t2End.x, t2End.y); ctx.lineTo(P2.x, P2.y);
    ctx.closePath(); ctx.fill();

    if (emph) {
      ctx.strokeStyle = hexA(lc, 0.3); ctx.lineWidth = lw + 4;
      ctx.beginPath();
      ctx.moveTo(P0.x, P0.y); ctx.lineTo(M.x, M.y);
      ctx.moveTo(P1.x, P1.y); ctx.lineTo(P2.x, P2.y);
      ctx.stroke();
    }
    ctx.strokeStyle = lc; ctx.lineWidth = lw;
    // Handle base line P1–P2.
    ctx.beginPath(); ctx.moveTo(P1.x, P1.y); ctx.lineTo(P2.x, P2.y); ctx.stroke();
    // Median line P0 → M → far.
    ctx.beginPath(); ctx.moveTo(P0.x, P0.y); ctx.lineTo(mEnd.x, mEnd.y); ctx.stroke();
    // Parallel tines from P1 and P2.
    ctx.beginPath(); ctx.moveTo(P1.x, P1.y); ctx.lineTo(t1End.x, t1End.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(P2.x, P2.y); ctx.lineTo(t2End.x, t2End.y); ctx.stroke();
    ctx.restore();
  }

  const RENDER = {
    trendline: drawTrend, ray: drawRay, extended: drawExtended,
    hline: drawHLineItem, vline: drawVLineItem, crossline: drawCrossline,
    rectangle: drawRectItem, ellipse: drawEllipseItem, arrow: drawArrowItem,
    brush: drawBrushItem, fibonacci: drawFibItem, fibext: drawFibExtItem, measure: drawMeasureItem,
    longpos: drawPositionItem, shortpos: drawPositionItem,
    pricerange: drawRangeItem, daterange: drawRangeItem, rangebox: drawRangeItem,
    text: drawTextItem,
    sine: drawSineItem, cyclic: drawCyclicItem, timecycles: drawCyclicItem,
    pitchfork: drawPitchforkItem,
  };
  // Every PATTERN_SPECS key renders through the shared polyline renderer.
  Object.keys(PATTERN_SPECS).forEach((k) => { RENDER[k] = drawPatternItem; });
  function isPattern(t) { return !!PATTERN_SPECS[t]; }
  // Multi-point (pts-based) tools that aren't patterns: cycles + pitchfork.
  // How many points each one needs to be committed.
  const MULTIPT_N = { sine: 2, cyclic: 2, timecycles: 2, pitchfork: 3 };
  function isMultiPt(t) { return isPattern(t) || MULTIPT_N[t] != null; }
  function renderItem(it, emph) { (RENDER[it.type] || (() => {}))(it, emph); }

  function handlePoints(it) {
    const out = [];
    if (it.type === "brush") return out;   // freehand: no endpoint handles
    if (it.type === "vline") { const x = logicalX(it.a.logical); if (x != null) out.push({ key: "p1", x, y: cv.clientHeight / 2 }); return out; }
    // Multi-point tools (patterns / cycles / pitchfork): one handle per vertex.
    if (isMultiPt(it.type)) {
      (it.pts || []).forEach((q, i) => { const P = toXY(q); if (P) out.push({ key: "v" + i, x: P.x, y: P.y }); });
      return out;
    }
    const A = toXY(it.a);
    if (A) out.push({ key: "p1", x: A.x, y: A.y });
    if (it.b !== undefined) { const B = toXY(it.b); if (B) out.push({ key: "p2", x: B.x, y: B.y }); }
    if (it.c !== undefined) { const Cp = toXY(it.c); if (Cp) out.push({ key: "p3", x: Cp.x, y: Cp.y }); }
    return out;
  }
  function drawHandles(it) {
    ctx.save();
    handlePoints(it).forEach((p) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = "#fff"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = C.accent; ctx.stroke();
    });
    ctx.restore();
  }
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hitHandle(it, mx, my) {
    for (const p of handlePoints(it)) if (Math.hypot(mx - p.x, my - p.y) <= HANDLE_R + 3) return p.key;
    return null;
  }
  function hitItem(it, mx, my) {
    // Pitchfork: hit near the base line, median, or either tine ray.
    if (it.type === "pitchfork") {
      const p = it.pts || [];
      const P0 = p[0] && toXY(p[0]), P1 = p[1] && toXY(p[1]), P2 = p[2] && toXY(p[2]);
      if (!P0 || !P1) return null;
      if (!P2) return distToSeg(mx, my, P0.x, P0.y, P1.x, P1.y) <= HIT ? "body" : null;
      const M = { x: (P1.x + P2.x) / 2, y: (P1.y + P2.y) / 2 };
      let dx = M.x - P0.x, dy = M.y - P0.y; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      const FAR = (cv.clientWidth + cv.clientHeight) * 2;
      const ray = (f) => ({ x: f.x + dx * FAR, y: f.y + dy * FAR });
      const segs = [[P1, P2], [P0, ray(M)], [P1, ray(P1)], [P2, ray(P2)]];
      for (const [a, b] of segs) if (distToSeg(mx, my, a.x, a.y, b.x, b.y) <= HIT) return "body";
      return null;
    }
    // Cycle tools: vertical repeated lines / sine — hit near their anchors.
    if (it.type === "sine" || it.type === "cyclic" || it.type === "timecycles") {
      const p = it.pts || [];
      for (let i = 1; i < p.length; i++) {
        const P = toXY(p[i - 1]), Q = toXY(p[i]); if (!P || !Q) continue;
        if (distToSeg(mx, my, P.x, P.y, Q.x, Q.y) <= HIT) return "body";
      }
      if (it.type !== "sine" && p[0]) { const P = toXY(p[0]); if (P && Math.abs(mx - P.x) <= HIT) return "body"; }
      return null;
    }
    // Multi-point patterns: hit near any polyline segment.
    if (isPattern(it.type)) {
      const p = (it.pts || []).map(toXY);
      for (let i = 1; i < p.length; i++) {
        if (!p[i - 1] || !p[i]) continue;
        if (distToSeg(mx, my, p[i - 1].x, p[i - 1].y, p[i].x, p[i].y) <= HIT) return "body";
      }
      return null;
    }
    const A = toXY(it.a);
    if (it.type === "hline") return A && Math.abs(my - A.y) <= HIT ? "body" : null;
    if (it.type === "vline") { const x = logicalX(it.a.logical); return x != null && Math.abs(mx - x) <= HIT ? "body" : null; }
    if (it.type === "crossline") {
      if (!A) return null;
      const x = logicalX(it.a.logical);
      if (Math.abs(my - A.y) <= HIT) return "body";
      if (x != null && Math.abs(mx - x) <= HIT) return "body";
      return null;
    }
    if (it.type === "text") {
      if (!A) return null;
      ctx.font = "13px 'Segoe UI'"; const w = ctx.measureText(it.text || "").width;
      return (mx >= A.x && mx <= A.x + w + 8 && my >= A.y - 14 && my <= A.y + 4) ? "body" : null;
    }
    if (it.type === "brush") {
      if (!it.pts) return null;
      for (let i = 1; i < it.pts.length; i++) {
        const P = toXY(it.pts[i - 1]), Q = toXY(it.pts[i]); if (!P || !Q) continue;
        if (distToSeg(mx, my, P.x, P.y, Q.x, Q.y) <= HIT) return "body";
      }
      return null;
    }
    const B = toXY(it.b); if (!A || !B) return null;
    if (it.type === "trendline" || it.type === "ray" || it.type === "extended" || it.type === "arrow") {
      return distToSeg(mx, my, A.x, A.y, B.x, B.y) <= HIT ? "body" : null;
    }
    // Fibs are hit only near a level line or the trend/guide line — NOT across
    // the whole filled box, so the chart stays draggable through the bands.
    if (it.type === "fibonacci") {
      ensureFibCfg(it);
      let x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x);
      if (it.opts.extend === "right") x1 = cv.clientWidth;
      else if (it.opts.extend === "left") x0 = 0;
      else if (it.opts.extend === "both") { x0 = 0; x1 = cv.clientWidth; }
      if (mx >= x0 - HIT && mx <= x1 + HIT) {
        const base = it.a.price, rng = it.b.price - it.a.price;
        for (const l of it.levels) {
          if (!l.on) continue;
          const y = priceToY(base + l.value * rng);
          if (y != null && Math.abs(my - y) <= HIT) return "body";
        }
      }
      if (it.opts.trendLine && distToSeg(mx, my, A.x, A.y, B.x, B.y) <= HIT) return "body";
      return null;
    }
    if (it.type === "fibext") {
      ensureFibCfg(it);
      const Cp = it.c ? toXY(it.c) : null;
      if (it.opts.trendLine) {
        if (distToSeg(mx, my, A.x, A.y, B.x, B.y) <= HIT) return "body";
        if (Cp && distToSeg(mx, my, B.x, B.y, Cp.x, Cp.y) <= HIT) return "body";
      }
      if (Cp) {
        let x0 = Math.min(A.x, B.x, Cp.x), x1 = Math.max(A.x, B.x, Cp.x);
        if (it.opts.extend === "right") x1 = cv.clientWidth;
        else if (it.opts.extend === "left") x0 = 0;
        else if (it.opts.extend === "both") { x0 = 0; x1 = cv.clientWidth; }
        if (mx >= x0 - HIT && mx <= x1 + HIT) {
          const move = it.b.price - it.a.price, base = it.c.price;
          for (const l of it.levels) {
            if (!l.on) continue;
            const y = priceToY(base + l.value * move);
            if (y != null && Math.abs(my - y) <= HIT) return "body";
          }
        }
      }
      return null;
    }
    const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x), y0 = Math.min(A.y, B.y), y1 = Math.max(A.y, B.y);
    if (mx >= x0 - HIT && mx <= x1 + HIT && my >= y0 - HIT && my <= y1 + HIT) return "body";
    return null;
  }
  function pick(mx, my) {
    // Ignore clicks below the price pane (over oscillator sub-panes).
    if (my > pricePaneBottom() + HANDLE_R) return null;
    if (selected) { const h = hitHandle(selected, mx, my); if (h) return { item: selected, part: h }; }
    for (let i = items.length - 1; i >= 0; i--) { const part = hitItem(items[i], mx, my); if (part) return { item: items[i], part }; }
    return null;
  }
  // Bottom of the PRICE pane (pane 0) in canvas-local px. Drawings live in the
  // price pane, so we clip to it — otherwise fib levels whose price maps below
  // the pane bleed over the oscillator sub-panes.
  function pricePaneBottom() {
    try {
      const panes = chart.panes();
      if (panes && panes.length > 1) {
        const el = panes[0].getHTMLElement && panes[0].getHTMLElement();
        if (el) {
          const pr = el.getBoundingClientRect();
          const cr = cv.getBoundingClientRect();
          const b = pr.bottom - cr.top;   // pane bottom relative to canvas top
          if (isFinite(b) && b > 0) return Math.min(b, cv.clientHeight);
        }
      }
    } catch (_) {}
    return cv.clientHeight;   // single pane → whole canvas
  }
  function redraw() {
    if (!cv.clientWidth) return;
    rebuildCoordCache();   // sample affine transforms once for this frame
    ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
    ctx.save();
    // Clip everything to the price pane so drawings don't overlap oscillators.
    const clipH = pricePaneBottom();
    ctx.beginPath(); ctx.rect(0, 0, cv.clientWidth, clipH); ctx.clip();
    items.forEach((it) => renderItem(it, it === hovered || it === selected));
    if (draft) renderItem(draft, false);
    if (selected) drawHandles(selected);
    ctx.restore();
  }
  function setCapture(on) { cv.style.pointerEvents = on ? "auto" : "none"; }
  let onToolChange = null;
  function setTool(t) {
    tool = t; draft = null;
    if (t !== "cursor") { selected = null; notifySel(); }
    setCapture(t !== "cursor");
    cv.style.cursor = t === "cursor" ? "default" : "crosshair";
    if (onToolChange) onToolChange(t);
    redraw();
  }
  // When the overlay is capturing pointer events (a tool is armed, or hovering
  // a drawing), the chart's own canvas never receives wheel events, so zoom
  // stops working. Forward wheel here to zoom the time scale around the cursor,
  // mirroring lightweight-charts' native behaviour. The price-axis vertical
  // stretch is handled separately by the chartEl handler and takes priority.
  cv.addEventListener("wheel", (e) => {
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;
    e.preventDefault(); e.stopPropagation();
    const m = mousePx(e);
    const pivot = ts.coordinateToLogical(m.x);
    const p = (pivot == null) ? (range.from + range.to) / 2 : pivot;
    // Wheel up (deltaY < 0) → zoom in; down → zoom out. Match LC's ~10%/notch.
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    const from = p - (p - range.from) * factor;
    const to = p + (range.to - p) * factor;
    if (to - from > 0.5) ts.setVisibleLogicalRange({ from, to });
    redraw();
  }, { passive: false });
  chartEl.addEventListener("mousemove", (e) => {
    if (tool !== "cursor" || drag || draft) return;
    const m = mousePx(e); const hit = pick(m.x, m.y);
    hovered = hit ? hit.item : null;
    setCapture(!!hit);
    cv.style.cursor = hit ? (hit.part === "body" ? "move" : "pointer") : "default";
    redraw();
  });
  // While the overlay is capturing pointer events (tool armed, or hovering /
  // dragging a drawing), the chart's own canvas gets no mousemove, so the
  // native crosshair (the two perpendicular dashed lines) freezes/vanishes.
  // Forward the cursor to the chart so the crosshair keeps tracking.
  function forwardCrosshair(e) {
    if (cv.style.pointerEvents !== "auto") return;   // chart already sees it
    if (!chart.setCrosshairPosition) return;
    const m = mousePx(e);
    const price = candleSeries.coordinateToPrice(m.y);
    const logical = chart.timeScale().coordinateToLogical(m.x);
    if (price == null || logical == null) { if (chart.clearCrosshairPosition) chart.clearCrosshairPosition(); return; }
    const t = logicalToTime(logical);
    try { chart.setCrosshairPosition(price, t, candleSeries); } catch (_) {}
  }
  cv.addEventListener("mousemove", forwardCrosshair);
  cv.addEventListener("mouseleave", () => { if (chart.clearCrosshairPosition) chart.clearCrosshairPosition(); });
  cv.addEventListener("mousedown", (e) => {
    const m = mousePx(e);
    if (tool === "cursor") {
      const hit = pick(m.x, m.y);
      if (hit) {
        selected = hit.item;
        drag = { mode: hit.part, startPx: m, orig: JSON.parse(JSON.stringify({ a: hit.item.a, b: hit.item.b, c: hit.item.c, pts: hit.item.pts })) };
        e.preventDefault(); e.stopPropagation(); redraw(); notifySel();
      } else if (selected) {
        selected = null; redraw(); notifySel();   // click empty space → deselect
      }
      return;
    }
    const pt = pxToData(m.x, m.y, true); if (!pt) return;
    // Single-click tools: place immediately.
    if (tool === "hline" || tool === "vline" || tool === "crossline") {
      const it = { type: tool, a: pt }; items.push(it); selected = it; setTool("cursor"); saveDrawings(); notifySel(); return;
    }
    if (tool === "text") {
      const str = prompt("Text:"); if (str) { const it = { type: "text", a: pt, text: str }; items.push(it); selected = it; saveDrawings(); }
      setTool("cursor"); return;
    }
    // Freehand brush: start collecting points; committed on mouseup.
    if (tool === "brush") { draft = { type: "brush", pts: [pt] }; e.preventDefault(); e.stopPropagation(); redraw(); return; }
    // Three-point tool: Fib Extension (A -> B -> C).
    if (tool === "fibext") {
      if (!draft) draft = { type: "fibext", a: pt, b: pt };
      else if (draft.c === undefined) { draft.b = pt; draft.c = pt; }
      else { draft.c = pt; ensureFibCfg(draft); items.push(draft); selected = draft; draft = null; setTool("cursor"); saveDrawings(); notifySel(); }
      redraw(); return;
    }
    // N-point tools: chart patterns / Elliott (from spec), and the 2-point
    // cycle tools (sine, cyclic lines, time cycles). Click to drop each vertex;
    // the last vertex tracks the cursor until the count is reached.
    const nNeeded = isPattern(tool) ? PATTERN_SPECS[tool].n : (MULTIPT_N[tool] || 0);
    if (nNeeded) {
      if (!draft) { draft = { type: tool, pts: [pt, pt] }; }   // first anchor + moving point
      else {
        // Fix the moving point at the clicked spot.
        draft.pts[draft.pts.length - 1] = pt;
        if (draft.pts.length >= nNeeded) {
          // All vertices placed → commit.
          items.push(draft); selected = draft; draft = null; setTool("cursor"); saveDrawings(); notifySel();
        } else {
          // More vertices to go → add a fresh moving point that tracks the cursor.
          draft.pts.push(pt);
        }
      }
      redraw(); return;
    }
    // Two-point tools.
    if (!draft) draft = { type: tool, a: pt, b: pt };
    else {
      draft.b = pt;
      if (draft.type === "fibonacci") ensureFibCfg(draft);
      items.push(draft); selected = draft; draft = null; setTool("cursor"); saveDrawings(); notifySel();
    }
    redraw();
  });
  cv.addEventListener("mousemove", (e) => {
    const m = mousePx(e);
    if (drag && selected) {
      if (drag.mode && drag.mode[0] === "v") {          // multi-point vertex handle
        const idx = parseInt(drag.mode.slice(1), 10);
        const pt = pxToData(m.x, m.y, true);
        if (pt && selected.pts && selected.pts[idx]) selected.pts[idx] = pt;
      } else if (drag.mode === "p1" || drag.mode === "p2" || drag.mode === "p3") {
        const pt = pxToData(m.x, m.y, true);
        if (pt) selected[drag.mode === "p1" ? "a" : drag.mode === "p2" ? "b" : "c"] = pt;
      } else if (drag.mode === "body") {
        const now = pxToData(m.x, m.y, false), start = pxToData(drag.startPx.x, drag.startPx.y, false);
        if (now && start) {
          const dl = now.logical - start.logical, dp = now.price - start.price;
          if (drag.orig.pts) {
            selected.pts = drag.orig.pts.map((p) => ({ logical: p.logical + dl, price: p.price + dp }));
          } else {
            selected.a = { logical: drag.orig.a.logical + dl, price: drag.orig.a.price + dp };
            if (drag.orig.b) selected.b = { logical: drag.orig.b.logical + dl, price: drag.orig.b.price + dp };
            if (drag.orig.c) selected.c = { logical: drag.orig.c.logical + dl, price: drag.orig.c.price + dp };
          }
        }
      }
      e.preventDefault(); e.stopPropagation(); redraw(); notifySel(); return;
    }
    if (draft) {
      if (draft.type === "brush") { const pt = pxToData(m.x, m.y, false); if (pt) draft.pts.push(pt); }
      else if (draft.type === "fibext") {
        const pt = pxToData(m.x, m.y, true); if (pt) { if (draft.c !== undefined) draft.c = pt; else draft.b = pt; }
      } else if (isMultiPt(draft.type)) {
        const pt = pxToData(m.x, m.y, true); if (pt && draft.pts && draft.pts.length) draft.pts[draft.pts.length - 1] = pt;
      } else { const pt = pxToData(m.x, m.y, true); if (pt) draft.b = pt; }
      redraw();
    }
  });
  let onEdit = null;
  cv.addEventListener("dblclick", (e) => {
    const m = mousePx(e); const hit = pick(m.x, m.y);
    // Prefer a direct hit; otherwise, if something is already selected, edit it
    // (double-clicking a thin fib level exactly can be finicky).
    const target = hit ? hit.item : selected;
    if (target) { selected = target; redraw(); notifySel(); if (onEdit) onEdit(target); e.preventDefault(); e.stopPropagation(); }
  });
  window.addEventListener("mouseup", () => {
    if (draft && draft.type === "brush") {
      if (draft.pts.length > 1) { items.push(draft); selected = draft; saveDrawings(); }
      draft = null; setTool("cursor"); redraw(); notifySel(); return;
    }
    if (drag) { drag = null; if (tool === "cursor") setCapture(false); saveDrawings(); notifySel(); }
  });
  window.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    // Ctrl+Z / Cmd+Z → undo the last drawing change.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      undo(); e.preventDefault(); return;
    }
    if (e.key === "Escape") { draft = null; selected = null; setTool("cursor"); redraw(); notifySel(); }
    if ((e.key === "Delete" || e.key === "Backspace") && selected) {
      const i = items.indexOf(selected); if (i >= 0) items.splice(i, 1);
      selected = null; hovered = null; redraw(); saveDrawings(); notifySel(); e.preventDefault();
    }
  });
  // ── Persistence ──────────────────────────────────────────────────────
  // Points are anchored on a logical index (continuous) at runtime, but we
  // persist a stable `time` per point so drawings survive reload / data
  // refresh. On load, time → logical via the current bar array.
  // NOTE: logicalToTime and timeToLogical MUST be exact inverses so a
  // save→load round-trip doesn't move a drawing. Two rules make that hold:
  //   1) Never round `logical` — preserve the fractional (sub-bar) part.
  //   2) Off-data (before bar 0 / after the last bar) uses ONE consistent
  //      edge step in BOTH directions (leading step before the data, trailing
  //      step after it), so extrapolation inverts cleanly.
  function _leadStep(bars) { return bars.length > 1 ? (bars[1].time - bars[0].time) : 86400; }
  function _tailStep(bars) { return bars.length > 1 ? (bars[bars.length - 1].time - bars[bars.length - 2].time) : 86400; }
  function logicalToTime(logical) {
    const bars = window.__bars || [];
    if (!bars.length) return logical;
    const n = bars.length;
    if (logical <= 0) return bars[0].time + logical * _leadStep(bars);
    if (logical >= n - 1) return bars[n - 1].time + (logical - (n - 1)) * _tailStep(bars);
    // Interpolate between the two surrounding real bars (keeps sub-bar frac).
    const a = Math.floor(logical), frac = logical - a;
    return bars[a].time + frac * (bars[a + 1].time - bars[a].time);
  }
  function timeToLogical(time) {
    const bars = window.__bars || [];
    if (!bars.length) return 0;
    const n = bars.length;
    if (time <= bars[0].time) return (time - bars[0].time) / _leadStep(bars);
    if (time >= bars[n - 1].time) return (n - 1) + (time - bars[n - 1].time) / _tailStep(bars);
    // Binary-search the bracketing bars, then interpolate.
    let lo = 0, hi = n - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].time === time) return m; if (bars[m].time < time) lo = m + 1; else hi = m - 1; }
    const a = Math.max(0, hi), b = Math.min(n - 1, lo);
    if (a === b) return a;
    return a + (time - bars[a].time) / (bars[b].time - bars[a].time);
  }
  function encPt(p) { return { time: logicalToTime(p.logical), price: p.price }; }
  function decPt(p) { return { logical: timeToLogical(p.time), price: p.price }; }

  // Time↔logical against an EXPLICIT bar array (not window.__bars). Used by
  // reanchor() so we can convert using the OLD bars, then the NEW bars. Mirrors
  // logicalToTime exactly (no rounding, consistent edge steps).
  function logicalToTimeIn(bars, logical) {
    if (!bars || !bars.length) return logical;
    const n = bars.length;
    if (logical <= 0) return bars[0].time + logical * _leadStep(bars);
    if (logical >= n - 1) return bars[n - 1].time + (logical - (n - 1)) * _tailStep(bars);
    const a = Math.floor(logical), frac = logical - a;
    return bars[a].time + frac * (bars[a + 1].time - bars[a].time);
  }
  // Re-pin every point to the SAME timestamp when the bar array changes on a
  // same-symbol refetch (e.g. more history prepended → indices shift). We read
  // each point's time from the previous bars, then map that time onto the new
  // bars (now already in window.__bars). Points on real bars stay exact; only
  // the continuous `logical` is corrected for the new offset.
  function reanchor(prevBars) {
    if (!prevBars || !prevBars.length) return;
    const remap = (p) => {
      if (!p) return p;
      const t = logicalToTimeIn(prevBars, p.logical);
      return { logical: timeToLogical(t), price: p.price };
    };
    items.forEach((it) => {
      if (it.a) it.a = remap(it.a);
      if (it.b) it.b = remap(it.b);
      if (it.c) it.c = remap(it.c);
      if (it.pts) it.pts = it.pts.map(remap);
    });
    redraw();
  }
  function serialize() {
    return items.map((it) => {
      const o = { type: it.type };
      if (it.a) o.a = encPt(it.a);
      if (it.b) o.b = encPt(it.b);
      if (it.c) o.c = encPt(it.c);
      if (it.pts) o.pts = it.pts.map(encPt);
      if (it.text != null) o.text = it.text;
      if (it.color) o.color = it.color;
      if (it.width) o.width = it.width;
      if (it.levels) o.levels = it.levels.map((l) => ({ value: l.value, color: l.color, on: l.on }));
      if (it.opts) o.opts = Object.assign({}, it.opts);
      if (it.fontSize) o.fontSize = it.fontSize;
      return o;
    });
  }
  function deserialize(arr) {
    return (arr || []).map((o) => {
      const it = { type: o.type };
      if (o.a) it.a = decPt(o.a);
      if (o.b) it.b = decPt(o.b);
      if (o.c) it.c = decPt(o.c);
      if (o.pts) it.pts = o.pts.map(decPt);
      if (o.text != null) it.text = o.text;
      if (o.color) it.color = o.color;
      if (o.width) it.width = o.width;
      if (o.levels) it.levels = o.levels.map((l) => ({ value: l.value, color: l.color, on: l.on }));
      if (o.opts) it.opts = Object.assign({}, o.opts);
      if (o.fontSize) it.fontSize = o.fontSize;
      return it;
    });
  }
  let onSave = null;
  // Undo history: a stack of serialized snapshots. history[last] is always the
  // current committed state; undo() restores the previous snapshot. Bounded so
  // it never grows unbounded across a long session.
  const history = [];
  const HISTORY_MAX = 100;
  let restoring = false;   // guard so restoreState()'s save doesn't re-push
  function pushHistory() {
    if (restoring) return;
    const snap = JSON.stringify(serialize());
    if (history.length && history[history.length - 1] === snap) return;   // no-op
    history.push(snap);
    if (history.length > HISTORY_MAX) history.shift();
  }
  function restoreState(snap) {
    restoring = true;
    items.length = 0; draft = null; selected = null; hovered = null;
    deserialize(JSON.parse(snap)).forEach((it) => items.push(it));
    redraw(); notifySel();
    if (onSave) onSave(serialize());   // persist the reverted state
    restoring = false;
  }
  function undo() {
    if (history.length < 2) {   // nothing before the current state
      if (history.length === 1) { restoreState(history[0]); }
      return;
    }
    history.pop();                              // drop current state
    restoreState(history[history.length - 1]);  // restore previous
  }
  function saveDrawings() {
    pushHistory();
    if (onSave) onSave(serialize());
  }
  function loadDrawings(arr) {
    items.length = 0; draft = null; selected = null; hovered = null;
    deserialize(arr).forEach((it) => items.push(it));
    redraw(); notifySel();
    // Seed history with the loaded state (baseline for undo on this symbol).
    history.length = 0; pushHistory();
  }
  function clearAll() { items.length = 0; draft = null; selected = null; hovered = null; redraw(); saveDrawings(); }
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => redraw());
  chart.subscribeCrosshairMove(() => { if (draft || drag) redraw(); });
  new ResizeObserver(resize).observe(chartEl);
  resize();
  // Bounding rect (in client coords) of an item, for anchoring the toolbar.
  function itemRect(it) {
    const pts = [];
    ["a", "b", "c"].forEach((k) => { if (it[k]) { const p = toXY(it[k]); if (p) pts.push(p); } });
    if (it.pts) it.pts.forEach((q) => { const p = toXY(q); if (p) pts.push(p); });
    if (it.type === "hline" || it.type === "crossline") { const y = priceToY(it.a.price); if (y != null) { pts.push({ x: 0, y }); pts.push({ x: cv.clientWidth, y }); } }
    if (it.type === "vline" || it.type === "crossline") { const x = logicalX(it.a.logical); if (x != null) { pts.push({ x, y: 0 }); pts.push({ x, y: cv.clientHeight }); } }
    if (!pts.length) return null;
    const r = cv.getBoundingClientRect();
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { left: r.left + Math.min(...xs), right: r.left + Math.max(...xs), top: r.top + Math.min(...ys), bottom: r.top + Math.max(...ys) };
  }
  return {
    setTool, clearAll, redraw, loadDrawings, saveDrawings, undo,
    getTool: () => tool,
    getSelected: () => selected,
    setSelected: (it) => { selected = it; redraw(); notifySel(); },
    updateSelected: () => { redraw(); saveDrawings(); notifySel(); },
    // Floating-toolbar support.
    setSelectChangeHandler: (fn) => { onSelectChange = fn; },
    getSelectedRect: () => (selected ? itemRect(selected) : null),
    setSelectedStyle: (props) => {
      if (!selected) return;
      if (props.color != null) selected.color = props.color;
      if (props.width != null) selected.width = props.width;
      redraw(); saveDrawings();
    },
    deleteSelected: () => {
      if (!selected) return;
      const i = items.indexOf(selected); if (i >= 0) items.splice(i, 1);
      selected = null; hovered = null; redraw(); saveDrawings(); notifySel();
    },
    openEditor: () => { if (selected && onEdit) onEdit(selected); },
    setToolChangeHandler: (fn) => { onToolChange = fn; },
    setSaveHandler: (fn) => { onSave = fn; },
    setEditHandler: (fn) => { onEdit = fn; },
    // Pick + open the editor for whatever drawing is under the given client
    // coords. Used by a chartEl-level dblclick so it works even when the
    // overlay isn't currently capturing pointer events.
    editAt: (clientX, clientY) => {
      const r = cv.getBoundingClientRect();
      const hit = pick(clientX - r.left, clientY - r.top);
      const target = hit ? hit.item : null;
      if (target) { selected = target; redraw(); if (onEdit) onEdit(target); return true; }
      return false;
    },
    // Deselect if the given client point isn't over any drawing. Used by a
    // chartEl-level listener so clicking empty chart space (where the overlay
    // isn't capturing events) still dismisses the selection + floating toolbar.
    deselectAt: (clientX, clientY) => {
      if (!selected) return;
      const r = cv.getBoundingClientRect();
      const hit = pick(clientX - r.left, clientY - r.top);
      if (!hit) { selected = null; hovered = null; redraw(); notifySel(); }
    },
    encPt, logicalToTime, timeToLogical, reanchor,
    ensureFibCfg,
    // Auto-place a Fib from detected swing pivots. `kind` is "fibonacci"
    // (2 pivots → retracement) or "fibext" (3 pivots → trend-based extension).
    // `pivots` is [{time, price}, …] in chronological order.
    addFibAuto: (kind, pivots) => {
      const need = kind === "fibext" ? 3 : 2;
      if (!pivots || pivots.length < need) return false;
      const mk = (pv) => ({ logical: timeToLogical(pv.time), price: pv.price });
      // Use the chosen anchors as given (already ordered); if a longer list is
      // passed, fall back to the most recent `need` pivots.
      const last = pivots.length === need ? pivots : pivots.slice(-need);
      let it;
      if (kind === "fibext") {
        it = { type: "fibext", a: mk(last[0]), b: mk(last[1]), c: mk(last[2]) };
      } else {
        it = { type: "fibonacci", a: mk(last[0]), b: mk(last[1]) };
      }
      if (!isFinite(it.a.logical) || !isFinite(it.b.logical)) return false;
      ensureFibCfg(it);
      items.push(it); selected = it; setTool("cursor");
      redraw(); saveDrawings(); notifySel();
      return true;
    },
  };
})();

// ─────────────────────────── Icons ────────────────────────────────────
const GEAR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>';
const EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10 10a2.5 2.5 0 003.5 3.5M6.7 6.7C4 8.4 2 12 2 12s3.5 7 10 7c2 0 3.7-.6 5.2-1.5M14 5.5C13.4 5.2 12.7 5 12 5 5.5 5 2 12 2 12"/></svg>';
const XICON = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// ─────────────────────────── Left rail (drawing tools) ────────────────
// SVG glyphs for each tool.
const TOOL_SVG = {
  cursor: '<path d="M4 3l7 16 2-7 7-2z"/>',
  trendline: '<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  ray: '<path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.6"/><path d="M17 4h3v3"/>',
  extended: '<path d="M2 22L22 2"/>',
  arrow: '<path d="M4 20L18 6"/><path d="M12 6h6v6"/>',
  hline: '<path d="M3 12h18"/><circle cx="12" cy="12" r="1.6"/>',
  vline: '<path d="M12 3v18"/><circle cx="12" cy="12" r="1.6"/>',
  crossline: '<path d="M12 3v18M3 12h18"/>',
  rectangle: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  brush: '<path d="M4 20c4 0 3-6 7-9s7-5 9-7"/><path d="M4 20l3-1"/>',
  fibonacci: '<path d="M3 5h18M3 9h18M3 12h18M3 15h18M3 19h18"/>',
  auto_fib: '<path d="M3 6h18M3 12h18M3 18h18"/><path d="M18 3l3 3-3 3"/>',
  auto_fibext: '<path d="M4 20l6-10 5 5"/><path d="M3 12h18"/><path d="M18 4l3 3-3 3"/>',
  fibext: '<path d="M4 20l6-10 5 5"/><path d="M3 8h18M3 12h18M3 16h18"/>',
  longpos: '<rect x="5" y="4" width="14" height="7" rx="1"/><rect x="5" y="13" width="14" height="7" rx="1"/><path d="M9 8h6"/>',
  shortpos: '<rect x="5" y="4" width="14" height="7" rx="1"/><rect x="5" y="13" width="14" height="7" rx="1"/><path d="M9 16h6"/>',
  measure: '<path d="M4 20L20 4"/><path d="M4 14l6 6M10 8l6 6"/>',
  pricerange: '<path d="M12 3v18"/><path d="M8 5h8M8 19h8"/>',
  daterange: '<path d="M3 12h18"/><path d="M5 8v8M19 8v8"/>',
  rangebox: '<rect x="4" y="4" width="16" height="16"/><path d="M4 12h16M12 4v16"/>',
  text: '<path d="M5 5h14M12 5v14"/>',
  pitchfork: '<path d="M4 20L14 6"/><path d="M8 4L20 12"/><path d="M4 12L18 20"/><circle cx="4" cy="20" r="1.4"/>',
  // patterns
  xabcd: '<path d="M3 18l4-10 5 8 4-12 5 14"/>',
  cypher: '<path d="M3 16l5-8 4 6 4-10 5 12"/>',
  headshoulders: '<path d="M3 18l3-4 3 2 3-8 3 8 3-2 3 4"/>',
  abcd: '<path d="M4 18l5-9 4 6 6-11"/>',
  triangle: '<path d="M4 18l8-12 8 12z"/>',
  threedrives: '<path d="M3 17l3-6 3 3 3-7 3 4 3-8"/>',
  ell_impulse: '<path d="M3 18l3-5 3 3 3-8 3 5 3-9"/>',
  ell_correction: '<path d="M4 8l5 9 4-6 5 8"/>',
  ell_triangle: '<path d="M3 12l4-5 3 8 4-9 4 7 3-4"/>',
  ell_double: '<path d="M3 16l4-8 4 6 4-8 5 8"/>',
  ell_triple: '<path d="M3 15l3-6 3 5 3-7 3 5 3-6 2 4"/>',
  // cycles
  cyclic: '<path d="M5 4v16M11 4v16M17 4v16"/>',
  timecycles: '<path d="M4 8a4 4 0 018 0 4 4 0 008 0M4 4v16M20 4v16"/>',
  sine: '<path d="M3 12c3-8 6 8 9 0s6-8 9 0"/>',
};
function toolSvg(key) { return `<svg viewBox="0 0 24 24">${TOOL_SVG[key] || TOOL_SVG.cursor}</svg>`; }

// Grouped fly-out catalog. Each rail group remembers its last-picked tool.
const TOOL_GROUPS = [
  { id: "cursor", tools: [{ key: "cursor", label: "Cursor" }] },
  { id: "lines", title: "LINES", sections: [
    { title: "TREND LINES", tools: [
      { key: "trendline", label: "Trend Line", hint: "Alt+T" },
      { key: "ray", label: "Ray" },
      { key: "extended", label: "Extended Line" },
      { key: "arrow", label: "Arrow" },
    ] },
    { title: "LINES", tools: [
      { key: "hline", label: "Horizontal Line", hint: "Alt+H" },
      { key: "vline", label: "Vertical Line", hint: "Alt+V" },
      { key: "crossline", label: "Cross Line", hint: "Alt+C" },
    ] },
    { title: "PITCHFORK", tools: [
      { key: "pitchfork", label: "Pitchfork" },
    ] },
  ] },
  { id: "fib", title: "FIBONACCI", tools: [
    { key: "fibonacci", label: "Fib Retracement", hint: "Alt+F" },
    { key: "fibext", label: "Trend-Based Fib Extension" },
    { key: "auto_fib", label: "Auto Fib Retracement", action: "auto_fib" },
    { key: "auto_fibext", label: "Auto Trend-Based Fib Extension", action: "auto_fibext" },
  ] },
  { id: "shapes", title: "SHAPES", tools: [
    { key: "rectangle", label: "Rectangle" },
    { key: "ellipse", label: "Ellipse" },
    { key: "brush", label: "Brush" },
  ] },
  { id: "patterns", title: "PATTERNS", sections: [
    { title: "CHART PATTERNS", tools: [
      { key: "xabcd", label: "XABCD Pattern" },
      { key: "cypher", label: "Cypher Pattern" },
      { key: "headshoulders", label: "Head and Shoulders" },
      { key: "abcd", label: "ABCD Pattern" },
      { key: "triangle", label: "Triangle Pattern" },
      { key: "threedrives", label: "Three Drives Pattern" },
    ] },
    { title: "ELLIOTT WAVES", tools: [
      { key: "ell_impulse", label: "Elliott Impulse Wave (1-2-3-4-5)" },
      { key: "ell_correction", label: "Elliott Correction Wave (A-B-C)" },
      { key: "ell_triangle", label: "Elliott Triangle Wave (A-B-C-D-E)" },
      { key: "ell_double", label: "Elliott Double Combo (W-X-Y)" },
      { key: "ell_triple", label: "Elliott Triple Combo (W-X-Y-X-Z)" },
    ] },
    { title: "CYCLES", tools: [
      { key: "cyclic", label: "Cyclic Lines" },
      { key: "timecycles", label: "Time Cycles" },
      { key: "sine", label: "Sine Line" },
    ] },
  ] },
  { id: "positions", title: "FORECASTING", tools: [
    { key: "longpos", label: "Long Position" },
    { key: "shortpos", label: "Short Position" },
  ] },
  { id: "measure", title: "MEASURERS", tools: [
    { key: "measure", label: "Measure" },
    { key: "pricerange", label: "Price Range" },
    { key: "daterange", label: "Date Range" },
    { key: "rangebox", label: "Date & Price Range" },
  ] },
  { id: "text", title: "ANNOTATION", tools: [
    { key: "text", label: "Text" },
  ] },
];
const TOOL_ALIAS = {};

// Groups may declare `sections` (sub-headers, TradingView-style). Flatten them
// into a single `tools` list so the rail button / active-tool logic still works.
TOOL_GROUPS.forEach((g) => {
  if (g.sections && !g.tools) g.tools = g.sections.flatMap((s) => s.tools);
});
const TOOL_BY_KEY = {};
TOOL_GROUPS.forEach((g) => g.tools.forEach((t) => { TOOL_BY_KEY[t.key] = t; }));

const railEl = document.getElementById("rail");
const groupActive = {};   // groupId -> currently selected tool key

function selectTool(groupId, key) {
  const def = TOOL_BY_KEY[key];
  // Action items (e.g. "Auto Fib") run a command instead of arming a tool.
  if (def && def.action) { closeFlyout(); runToolAction(def.action); return; }
  groupActive[groupId] = key;
  const realKey = TOOL_ALIAS[key] || key;
  drawings.setTool(realKey);
  renderRail();
  closeFlyout();
}

// Fetch swing pivots from the backend and auto-place a Fib retracement /
// extension on the most SIGNIFICANT recent swing (largest move) that is
// currently visible — mirroring TradingView's Auto Fib behavior.
async function runToolAction(action) {
  if (action !== "auto_fib" && action !== "auto_fibext") return;
  const kind = action === "auto_fibext" ? "fibext" : "fibonacci";
  setStatus("Detecting swing pivots …");
  try {
    // TradingView's Auto Fib logic: asymmetric pivots (big left lookback) then
    // simply take the two most recent pivots (second_last → last). The large
    // lbL makes the swing big and stable, so no extra "pick largest" heuristic
    // is needed — this matches the official indicator's behavior.
    const res = await fetch(`/api/pivots?symbol=${encodeURIComponent(currentSymbol)}&tf=${currentTf}&method=tv&lbL=120&lbR=5`);
    const data = await res.json();
    if (data.error) { setStatus(`Pivot error: ${data.error}`); return; }
    const pivots = data.pivots || [];
    const need = kind === "fibext" ? 3 : 2;
    if (pivots.length < need) { setStatus(`Not enough swings found (${pivots.length}). Try a longer timeframe.`); return; }

    let chosen;
    if (kind === "fibonacci") {
      // TradingView Auto Fib Retracement: second_last → last pivot.
      chosen = pivots.slice(-2);
    } else {
      // Trend-based extension needs a VALID structure: impulse A→B, then a
      // PARTIAL pullback C (C stays between A and B — not a full reversal).
      // Otherwise it degenerates into a down/up retracement grid.
      chosen = chooseExtAnchors(pivots);
      if (!chosen) { setStatus("No valid impulse+pullback structure found for extension."); return; }
    }
    const ok = drawings.addFibAuto(kind, chosen);
    setStatus(ok ? `Auto ${kind === "fibext" ? "Fib Extension" : "Fib Retracement"} placed` : "Could not place auto fib");
  } catch (e) {
    setStatus(`Pivot fetch failed: ${e}`);
  }
}

// Pick A→B→C for a trend-based extension from the (major) pivot list.
// Valid structure: A→B impulse, then C a PARTIAL pullback that stays strictly
// between A and B in price (so the projection continues the A→B trend rather
// than reversing). Prefer the most recent such triple; fall back to the last
// three pivots if none qualifies.
function chooseExtAnchors(pivots) {
  for (let i = pivots.length - 3; i >= 0; i--) {
    const A = pivots[i], B = pivots[i + 1], C = pivots[i + 2];
    const lo = Math.min(A.price, B.price), hi = Math.max(A.price, B.price);
    // C must retrace part of A→B, not exceed A (full reversal) or B (no pullback).
    if (C.price > lo && C.price < hi) {
      const retr = Math.abs(C.price - B.price) / Math.abs(B.price - A.price);
      if (retr >= 0.15 && retr <= 0.9) return [A, B, C];
    }
  }
  // Fallback: if the latest pivot IS a partial pullback of the prior leg use
  // it; otherwise synthesize a 50% pullback C after the last major swing.
  const n = pivots.length;
  const A = pivots[n - 3], B = pivots[n - 2], C = pivots[n - 1];
  const lo = Math.min(A.price, B.price), hi = Math.max(A.price, B.price);
  if (C.price > lo && C.price < hi) return [A, B, C];
  // Use last swing A2→B2 and synthesize C at 50% retracement.
  const A2 = pivots[n - 2], B2 = pivots[n - 1];
  const synthC = { time: B2.time, price: B2.price - (B2.price - A2.price) * 0.5 };
  return [A2, B2, synthC];
}

function renderRail() {
  railEl.innerHTML = "";
  const cur = drawings.getTool();
  TOOL_GROUPS.forEach((g) => {
    const active = groupActive[g.id] || g.tools[0].key;
    const realActive = TOOL_ALIAS[active] || active;
    const wrap = document.createElement("div"); wrap.className = "rail-group";
    const btn = document.createElement("button");
    btn.className = "tool" + (realActive === cur ? " active" : "");
    btn.title = g.tools.find((t) => t.key === active)?.label || "";
    btn.innerHTML = toolSvg(active);
    btn.onclick = () => selectTool(g.id, active);
    wrap.appendChild(btn);
    if (g.tools.length > 1) {
      const arrow = document.createElement("button");
      arrow.className = "rail-arrow"; arrow.title = "More tools";
      arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg>';
      arrow.onclick = (e) => { e.stopPropagation(); openFlyout(g, wrap); };
      wrap.appendChild(arrow);
    }
    railEl.appendChild(wrap);
  });
  const railSep = document.createElement("div"); railSep.className = "rail-sep"; railEl.appendChild(railSep);
  const clrBtn = document.createElement("button");
  clrBtn.className = "tool"; clrBtn.title = "Remove all drawings"; clrBtn.style.color = C.red;
  clrBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
  clrBtn.onclick = () => drawings.clearAll();
  railEl.appendChild(clrBtn);
}

// Fly-out picker
const flyout = document.createElement("div");
flyout.id = "tool-flyout";
document.body.appendChild(flyout);
function openFlyout(group, anchorWrap) {
  const activeKey = groupActive[group.id] || group.tools[0].key;
  const row = (t) => {
    const on = activeKey === t.key;
    return `<div class="fly-row${on ? " on" : ""}" data-key="${t.key}">` +
      `<span class="fly-ic">${toolSvg(t.key)}</span>` +
      `<span class="fly-lb">${t.label}</span>` +
      `${t.hint ? `<span class="fly-hint">${t.hint}</span>` : ""}</div>`;
  };
  let html = "";
  if (group.sections) {
    // TradingView-style: one fly-out with sub-section headers inside it.
    group.sections.forEach((s) => {
      if (s.title) html += `<h4>${s.title}</h4>`;
      s.tools.forEach((t) => { html += row(t); });
    });
  } else {
    if (group.title) html += `<h4>${group.title}</h4>`;
    group.tools.forEach((t) => { html += row(t); });
  }
  flyout.innerHTML = html;
  const r = anchorWrap.getBoundingClientRect();
  flyout.style.left = (r.right + 6) + "px";
  flyout.style.top = r.top + "px";
  flyout.classList.add("open");
  flyout.querySelectorAll(".fly-row").forEach((row) => {
    row.onclick = () => selectTool(group.id, row.dataset.key);
  });
  // clamp bottom
  const fb = flyout.getBoundingClientRect();
  if (fb.bottom > window.innerHeight - 6) flyout.style.top = Math.max(6, window.innerHeight - fb.height - 6) + "px";
}
function closeFlyout() { flyout.classList.remove("open"); }
document.addEventListener("click", (e) => {
  if (!flyout.contains(e.target) && !e.target.closest(".rail-arrow")) closeFlyout();
});

// When a tool auto-completes (reverts to cursor), refresh the rail highlight.
drawings.setToolChangeHandler(() => renderRail());
drawings.setSaveHandler((arr) => saveDrawingsForSymbol(arr));
renderRail();

// Keyboard shortcuts (Alt + key) — matches the hints shown in the fly-outs.
const TOOL_SHORTCUTS = { t: ["lines", "trendline"], h: ["lines", "hline"], v: ["lines", "vline"], c: ["lines", "crossline"], f: ["fib", "fibonacci"] };
window.addEventListener("keydown", (e) => {
  if (!e.altKey) return;
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  const map = TOOL_SHORTCUTS[e.key.toLowerCase()];
  if (map) { e.preventDefault(); selectTool(map[0], map[1]); }
});

// ─────────────────────────── Timeframe bars ───────────────────────────
function setTimeframe(tf) {
  currentTf = tf;
  refreshTfActive();
  closeTfMenu();
  loadData();
}
function refreshTfActive() {
  document.querySelectorAll(".tf").forEach((x) => x.classList.toggle("active", x.dataset.tf === currentTf));
  // The dropdown caret button shows the current tf when it isn't a favorite.
  document.querySelectorAll(".tf-more-label").forEach((el) => {
    el.textContent = TF_FAVORITES.includes(currentTf) ? "" : currentTf;
  });
}

let tfMenuEl = null;
function closeTfMenu() { if (tfMenuEl) { tfMenuEl.classList.remove("open"); } }
function openTfMenu(anchorBtn) {
  if (!tfMenuEl) {
    tfMenuEl = document.createElement("div");
    tfMenuEl.id = "tf-menu";
    document.body.appendChild(tfMenuEl);
    document.addEventListener("click", (e) => {
      if (tfMenuEl && !tfMenuEl.contains(e.target) && !e.target.closest(".tf-more")) closeTfMenu();
    });
  }
  let html = "";
  TF_GROUPS.forEach((g) => {
    html += `<h4>${g.title}</h4>`;
    g.items.forEach((tf) => {
      html += `<div class="tf-menu-row${tf === currentTf ? " on" : ""}" data-tf="${tf}">${tf}</div>`;
    });
  });
  tfMenuEl.innerHTML = html;
  const r = anchorBtn.getBoundingClientRect();
  tfMenuEl.style.left = r.left + "px";
  tfMenuEl.style.top = (r.bottom + 4) + "px";
  tfMenuEl.classList.add("open");
  tfMenuEl.querySelectorAll(".tf-menu-row").forEach((row) => {
    row.onclick = () => setTimeframe(row.dataset.tf);
  });
  // clamp to viewport bottom
  const mb = tfMenuEl.getBoundingClientRect();
  if (mb.bottom > window.innerHeight - 6) tfMenuEl.style.top = Math.max(6, window.innerHeight - mb.height - 6) + "px";
}

function buildTf(container) {
  container.innerHTML = "";
  TF_FAVORITES.forEach((tf) => {
    const b = document.createElement("button");
    b.className = "tf" + (tf === currentTf ? " active" : "");
    b.textContent = tf; b.dataset.tf = tf;
    b.onclick = () => setTimeframe(tf);
    container.appendChild(b);
  });
  // Dropdown caret that expands to the full grouped list.
  const more = document.createElement("button");
  more.className = "tf tf-more";
  more.innerHTML = '<span class="tf-more-label"></span><svg viewBox="0 0 24 24" width="12" height="12" style="vertical-align:middle"><path d="M7 10l5 5 5-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  more.title = "More timeframes";
  more.onclick = (e) => { e.stopPropagation(); if (tfMenuEl && tfMenuEl.classList.contains("open")) closeTfMenu(); else openTfMenu(more); };
  container.appendChild(more);
}
buildTf(document.getElementById("tfs"));
buildTf(document.getElementById("tfs-bottom"));
refreshTfActive();

// ─────────────────────────── Indicators menu (add) ────────────────────
function buildIndicatorMenu() {
  const list = document.getElementById("ind-list");
  list.innerHTML = "";
  const groups = [
    { title: "MOVING AVERAGES", types: ["sma", "ema", "wma", "hma", "vwma", "dema", "tema"] },
    { title: "BANDS & CHANNELS", types: ["bb", "keltner", "donchian", "vwap"] },
    { title: "TREND (OVERLAY)", types: ["supertrend", "psar"] },
    { title: "OSCILLATORS", types: ["rsi", "macd", "stoch", "stochrsi", "kdj", "cci", "willr", "roc", "mom", "tsi", "ao"] },
    { title: "TREND STRENGTH / VOLATILITY", types: ["adx", "atr"] },
    { title: "VOLUME", types: ["obv", "mfi", "cmf"] },
  ];
  groups.forEach((g) => {
    const h = document.createElement("h4"); h.textContent = g.title; h.dataset.group = "1"; list.appendChild(h);
    g.types.forEach((t) => {
      const spec = CATALOG[t]; if (!spec) return;
      const row = document.createElement("div");
      row.className = "ind-add"; row.dataset.name = spec.name.toLowerCase();
      row.innerHTML = `<span>${spec.name}</span><span class="add-plus">+</span>`;
      row.onclick = () => { addInstance(t); document.getElementById("ind-menu").classList.remove("open"); };
      list.appendChild(row);
    });
  });
}
document.getElementById("ind-search").addEventListener("input", (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll("#ind-list .ind-add").forEach((r) => r.classList.toggle("hidden", q && !r.dataset.name.includes(q)));
  document.querySelectorAll('#ind-list h4[data-group]').forEach((h) => {
    let sib = h.nextElementSibling, any = false;
    while (sib && sib.classList.contains("ind-add")) { if (!sib.classList.contains("hidden")) { any = true; break; } sib = sib.nextElementSibling; }
    h.style.display = any ? "" : "none";
  });
});
const indMenu = document.getElementById("ind-menu");
// Center the indicator menu over the chart area (clamped to viewport).
function positionIndMenu() {
  const margin = 6;
  indMenu.style.left = "0px"; indMenu.style.top = "0px";
  const bw = indMenu.offsetWidth, bh = indMenu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = (chartEl && chartEl.isConnected) ? chartEl.getBoundingClientRect()
    : { left: 0, top: 0, width: vw, height: vh };
  let left = rect.left + (rect.width - bw) / 2;
  let top = rect.top + (rect.height - bh) / 2;
  left = Math.max(margin, Math.min(left, vw - bw - margin));
  top = Math.max(margin, Math.min(top, vh - bh - margin));
  indMenu.style.left = left + "px";
  indMenu.style.top = top + "px";
}
function openIndMenu() { indMenu.classList.add("open"); positionIndMenu(); document.getElementById("ind-search").focus(); }
function closeIndMenu() { indMenu.classList.remove("open"); }
document.getElementById("ind-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  if (indMenu.classList.contains("open")) closeIndMenu(); else openIndMenu();
});
document.getElementById("ind-close").addEventListener("click", (e) => { e.stopPropagation(); closeIndMenu(); });
document.addEventListener("click", (e) => { if (!indMenu.contains(e.target) && e.target.id !== "ind-toggle") closeIndMenu(); });
window.addEventListener("resize", () => { if (indMenu.classList.contains("open")) positionIndMenu(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && indMenu.classList.contains("open")) closeIndMenu(); });

// ─────────────────────────── Settings dialog ──────────────────────────
const dlg = document.getElementById("settings");
const dlgBox = dlg.querySelector(".dlg-box");
let dlgInst = null;
let dlgAnchor = null;
function openSettings(inst, anchorEl) {
  dlgInst = inst;
  dlgAnchor = anchorEl || null;
  document.getElementById("dlg-title").textContent = inst.name;
  buildInputsTab(inst);
  buildStyleTab(inst);
  showTab("inputs");
  dlg.classList.add("open");
  positionSettings(dlgAnchor);
}

// Center the popover over the chart area (clamped to the viewport). The anchor
// element is kept for API compatibility but no longer drives placement.
function positionSettings(anchorEl) {
  const margin = 6;
  // Clear any stale positioning and measure the box.
  dlgBox.style.right = ""; dlgBox.style.bottom = "";
  dlgBox.style.left = "0px"; dlgBox.style.top = "0px";
  const bw = dlgBox.offsetWidth, bh = dlgBox.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  // Center within the chart element when available, else the viewport.
  const rect = (chartEl && chartEl.isConnected) ? chartEl.getBoundingClientRect()
    : { left: 0, top: 0, width: vw, height: vh };
  let left = rect.left + (rect.width - bw) / 2;
  let top = rect.top + (rect.height - bh) / 2;
  // Clamp so it never spills off-screen.
  left = Math.max(margin, Math.min(left, vw - bw - margin));
  top = Math.max(margin, Math.min(top, vh - bh - margin));
  dlgBox.style.left = left + "px";
  dlgBox.style.top = top + "px";
}
function closeSettings() { dlg.classList.remove("open"); dlgInst = null; dlgAnchor = null; }
function showTab(which) {
  document.querySelectorAll(".dlg-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === which));
  document.getElementById("tab-inputs").style.display = which === "inputs" ? "" : "none";
  document.getElementById("tab-style").style.display = which === "style" ? "" : "none";
}
function buildInputsTab(inst) {
  const spec = CATALOG[inst.type];
  const box = document.getElementById("tab-inputs");
  box.innerHTML = "";
  if (!spec.inputs || !spec.inputs.length) { box.innerHTML = '<div class="dlg-empty">No inputs for this indicator.</div>'; return; }
  let lastGroup = null;
  spec.inputs.forEach((inp) => {
    if (inp.group && inp.group !== lastGroup) {
      const h = document.createElement("h5"); h.className = "dlg-group"; h.textContent = inp.group.toUpperCase();
      box.appendChild(h); lastGroup = inp.group;
    }
    const row = document.createElement("div"); row.className = "dlg-field";
    if (inp.enabledWhen) row.dataset.enabledWhen = JSON.stringify(inp.enabledWhen);
    const lab = document.createElement("label"); lab.textContent = inp.label; row.appendChild(lab);
    let el;
    if (inp.type === "select") {
      el = document.createElement("select");
      (inp.options || []).forEach((o) => { const opt = document.createElement("option"); opt.value = o; opt.textContent = o; el.appendChild(opt); });
      el.value = inst.inputs[inp.key];
    } else if (inp.type === "bool") {
      el = document.createElement("input"); el.type = "checkbox"; el.checked = !!inst.inputs[inp.key];
    } else {
      el = document.createElement("input"); el.type = "number";
      if (inp.type === "float") el.step = "0.1";
      el.value = inst.inputs[inp.key];
    }
    el.dataset.key = inp.key; el.dataset.type = inp.type;
    el.addEventListener("change", refreshConditionalFields);
    row.appendChild(el); box.appendChild(row);
  });
  refreshConditionalFields();
}

// Grey-out / disable fields whose `enabledWhen` predicate isn't satisfied by
// the current dialog values (e.g. RSI smoothing Length only active when a MA
// type is chosen; BB StdDev only for the Bollinger option).
function refreshConditionalFields() {
  const box = document.getElementById("tab-inputs");
  const current = {};
  box.querySelectorAll("[data-key]").forEach((el) => {
    current[el.dataset.key] = el.type === "checkbox" ? el.checked : el.value;
  });
  box.querySelectorAll(".dlg-field[data-enabled-when]").forEach((row) => {
    const cond = JSON.parse(row.dataset.enabledWhen);
    const val = current[cond.key];
    let ok = true;
    if ("equals" in cond) ok = val === cond.equals;
    if ("notEquals" in cond) ok = val !== cond.notEquals;
    row.classList.toggle("disabled", !ok);
    const field = row.querySelector("[data-key]");
    if (field) field.disabled = !ok;
  });
}
function buildStyleTab(inst) {
  const box = document.getElementById("tab-style");
  box.innerHTML = "";
  inst.plots.forEach((pk, i) => {
    if (pk === "hist") return;  // histogram color is data-driven
    const st = inst.style[i];
    const row = document.createElement("div"); row.className = "dlg-style-row"; row.dataset.idx = i;
    row.innerHTML =
      `<span class="dlg-plot">${inst.plots.length > 1 ? "Plot " + i : "Line"}</span>` +
      `<input type="checkbox" class="st-vis" ${st.visible ? "checked" : ""} title="Visible">` +
      `<input type="color" class="st-color" value="${toHex(st.color)}">` +
      `<select class="st-width" title="Width">${[1, 2, 3, 4].map((w) => `<option ${w === st.width ? "selected" : ""}>${w}</option>`).join("")}</select>` +
      `<select class="st-style" title="Line style">` +
        `<option value="solid" ${st.lineStyle === "solid" ? "selected" : ""}>Solid</option>` +
        `<option value="dashed" ${st.lineStyle === "dashed" ? "selected" : ""}>Dashed</option>` +
        `<option value="dotted" ${st.lineStyle === "dotted" ? "selected" : ""}>Dotted</option>` +
      `</select>`;
    box.appendChild(row);
  });
  if (!box.children.length) box.innerHTML = '<div class="dlg-empty">This indicator has data-driven colors.</div>';
}
function toHex(c) {
  // color inputs need #rrggbb; our palette already is, pass through
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = document.createElement("canvas").getContext("2d"); m.fillStyle = c; return m.fillStyle;
}
function applySettings() {
  if (!dlgInst) return;
  // inputs
  document.querySelectorAll("#tab-inputs [data-key]").forEach((el) => {
    const k = el.dataset.key, t = el.dataset.type;
    if (t === "select") dlgInst.inputs[k] = el.value;
    else if (t === "bool") dlgInst.inputs[k] = el.checked;
    else if (t === "float") dlgInst.inputs[k] = parseFloat(el.value);
    else dlgInst.inputs[k] = parseInt(el.value, 10);
  });
  // style
  document.querySelectorAll("#tab-style .dlg-style-row").forEach((row) => {
    const i = +row.dataset.idx, st = dlgInst.style[i];
    st.visible = row.querySelector(".st-vis").checked;
    st.color = row.querySelector(".st-color").value;
    st.width = +row.querySelector(".st-width").value;
    st.lineStyle = row.querySelector(".st-style").value;
  });
  applyInstanceStyle(dlgInst);
  fetchInstance(dlgInst);   // inputs changed → recompute
  renderLegends();
  saveInstances();
}
document.querySelectorAll(".dlg-tab").forEach((t) => t.onclick = () => showTab(t.dataset.tab));
document.getElementById("dlg-ok").onclick = () => { applySettings(); closeSettings(); };
document.getElementById("dlg-cancel").onclick = closeSettings;
document.getElementById("dlg-close").onclick = closeSettings;
document.getElementById("dlg-apply").onclick = applySettings;
dlg.querySelector(".dlg-backdrop").addEventListener("click", closeSettings);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && dlg.classList.contains("open")) closeSettings(); });
// Keep the popover glued to its anchor row if the window resizes.
window.addEventListener("resize", () => { if (dlg.classList.contains("open")) positionSettings(dlgAnchor); });

// ─────────────────────────── Drawing settings dialog ──────────────────
const DRAW_TITLES = {
  fibonacci: "Fib Retracement", fibext: "Trend-based fib extension",
  trendline: "Trend Line", ray: "Ray", extended: "Extended Line", arrow: "Arrow",
  hline: "Horizontal Line", vline: "Vertical Line", crossline: "Cross Line",
  rectangle: "Rectangle", ellipse: "Ellipse", brush: "Brush", text: "Text",
  measure: "Measure", longpos: "Long Position", shortpos: "Short Position",
  pricerange: "Price Range", daterange: "Date Range", rangebox: "Date & Price Range",
};
const drawDlg = document.getElementById("draw-settings");
let drawTarget = null;         // the drawing item being edited
let drawDraftLevels = null;    // working copy of levels
let drawDraftOpts = null;      // working copy of opts

function openDrawSettings(item) {
  if (isFib(item.type)) drawings.ensureFibCfg(item);
  drawTarget = item;
  drawDraftLevels = (item.levels || []).map((l) => ({ ...l }));
  drawDraftOpts = { ...(item.opts || {}) };
  document.getElementById("draw-title").textContent = DRAW_TITLES[item.type] || "Drawing";
  setDrawTab("style");
  buildDrawStyle();
  buildDrawCoords();
  drawDlg.classList.add("open");
  positionDrawSettings();
}
// Center the drawing settings box over the chart area (clamped to viewport).
function positionDrawSettings() {
  const box = drawDlg.querySelector(".dlg-box");
  if (!box) return;
  const margin = 6;
  box.style.right = ""; box.style.bottom = "";
  box.style.left = "0px"; box.style.top = "0px";
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = (chartEl && chartEl.isConnected) ? chartEl.getBoundingClientRect()
    : { left: 0, top: 0, width: vw, height: vh };
  let left = rect.left + (rect.width - bw) / 2;
  let top = rect.top + (rect.height - bh) / 2;
  left = Math.max(margin, Math.min(left, vw - bw - margin));
  top = Math.max(margin, Math.min(top, vh - bh - margin));
  box.style.left = left + "px";
  box.style.top = top + "px";
}
window.addEventListener("resize", () => { if (drawDlg.classList.contains("open")) positionDrawSettings(); });
function closeDrawSettings() { drawDlg.classList.remove("open"); drawTarget = null; }
function setDrawTab(which) {
  drawDlg.querySelectorAll(".dlg-tab").forEach((t) => t.classList.toggle("active", t.dataset.dtab === which));
  document.getElementById("dtab-style").style.display = which === "style" ? "" : "none";
  document.getElementById("dtab-coords").style.display = which === "coords" ? "" : "none";
}
function isFib(t) { return t === "fibonacci" || t === "fibext"; }

function buildDrawStyle() {
  const box = document.getElementById("dtab-style");
  box.innerHTML = "";
  if (!isFib(drawTarget.type)) {
    box.innerHTML = '<div class="dlg-empty">No style options for this drawing yet.</div>';
    return;
  }
  // Toggles
  const toggles = [
    ["trendLine", "Trend line"], ["background", "Background"],
    ["reverse", "Reverse"], ["showPrices", "Prices"], ["showLevels", "Levels"],
  ];
  toggles.forEach(([key, label]) => {
    const row = document.createElement("div"); row.className = "dlg-field";
    const lab = document.createElement("label"); lab.textContent = label;
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!drawDraftOpts[key];
    cb.onchange = () => { drawDraftOpts[key] = cb.checked; };
    row.appendChild(lab); row.appendChild(cb); box.appendChild(row);
  });
  // Extend
  const exRow = document.createElement("div"); exRow.className = "dlg-field";
  const exLab = document.createElement("label"); exLab.textContent = "Extend";
  const exSel = document.createElement("select");
  [["none", "Don't extend"], ["left", "Extend left"], ["right", "Extend right"], ["both", "Extend both"]]
    .forEach(([v, t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; exSel.appendChild(o); });
  exSel.value = drawDraftOpts.extend || "none";
  exSel.onchange = () => { drawDraftOpts.extend = exSel.value; };
  exRow.appendChild(exLab); exRow.appendChild(exSel); box.appendChild(exRow);

  // Levels grid
  const h = document.createElement("h5"); h.className = "dlg-group"; h.textContent = "LEVELS"; box.appendChild(h);
  const grid = document.createElement("div"); grid.className = "fib-grid";
  drawDraftLevels.forEach((lvl, i) => {
    const cell = document.createElement("div"); cell.className = "fib-lvl";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!lvl.on;
    cb.onchange = () => { lvl.on = cb.checked; };
    const num = document.createElement("input"); num.type = "number"; num.step = "0.001"; num.value = lvl.value;
    num.onchange = () => { const v = parseFloat(num.value); if (!isNaN(v)) lvl.value = v; };
    const col = document.createElement("input"); col.type = "color"; col.value = lvl.color;
    col.oninput = () => { lvl.color = col.value; };
    cell.appendChild(cb); cell.appendChild(num); cell.appendChild(col); grid.appendChild(cell);
  });
  box.appendChild(grid);
}

function buildDrawCoords() {
  const box = document.getElementById("dtab-coords");
  box.innerHTML = "";
  const keys = [["a", "#1 (price, bar)"], ["b", "#2 (price, bar)"], ["c", "#3 (price, bar)"]];
  keys.forEach(([k, label]) => {
    const pt = drawTarget[k]; if (!pt) return;
    const row = document.createElement("div"); row.className = "coord-row";
    const lab = document.createElement("span"); lab.className = "coord-label"; lab.textContent = label;
    const price = document.createElement("input"); price.type = "number"; price.step = "0.01"; price.value = pt.price.toFixed(2);
    price.dataset.pt = k; price.dataset.dim = "price";
    const bar = document.createElement("input"); bar.type = "number"; bar.step = "1";
    bar.value = Math.round(pt.logical); bar.dataset.pt = k; bar.dataset.dim = "bar";
    row.appendChild(lab); row.appendChild(price); row.appendChild(bar); box.appendChild(row);
  });
  if (!box.children.length) box.innerHTML = '<div class="dlg-empty">No coordinates.</div>';
}

function applyDrawSettings() {
  if (!drawTarget) return;
  if (isFib(drawTarget.type)) {
    drawTarget.levels = drawDraftLevels.map((l) => ({ ...l }));
    drawTarget.opts = { ...drawDraftOpts };
  }
  // Coordinates
  document.querySelectorAll("#dtab-coords .coord-row input").forEach((inp) => {
    const pt = drawTarget[inp.dataset.pt]; if (!pt) return;
    const v = parseFloat(inp.value); if (isNaN(v)) return;
    if (inp.dataset.dim === "price") pt.price = v;
    else pt.logical = v;
  });
  drawings.updateSelected();
  closeDrawSettings();
}

drawDlg.querySelectorAll(".dlg-tab").forEach((t) => t.addEventListener("click", () => setDrawTab(t.dataset.dtab)));
document.getElementById("draw-close").onclick = closeDrawSettings;
document.getElementById("draw-cancel").onclick = closeDrawSettings;
document.getElementById("draw-ok").onclick = applyDrawSettings;
drawDlg.querySelector(".dlg-backdrop").addEventListener("click", closeDrawSettings);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && drawDlg.classList.contains("open")) closeDrawSettings(); });
drawings.setEditHandler(openDrawSettings);

// ─────────────────────────── Floating drawing toolbar ─────────────────
// A TradingView-style mini toolbar that appears when a drawing is selected
// (single click). Provides quick color / line-width / settings / delete.
const dtBar = document.getElementById("draw-toolbar");
const dtColorBtn = document.getElementById("dt-color");
const dtColorInput = document.getElementById("dt-color-input");
const dtSwatch = dtColorBtn.querySelector(".dt-swatch");
const dtWidthBtn = document.getElementById("dt-width");
const dtWidthLabel = document.getElementById("dt-width-label");
const dtWidthMenu = document.getElementById("dt-width-menu");
document.getElementById("dt-settings").innerHTML = GEAR;
document.getElementById("dt-delete").innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';

// Drawings whose color/width the quick toolbar can meaningfully change.
const STYLEABLE = new Set([
  "trendline", "ray", "extended", "arrow", "hline", "vline", "crossline", "rectangle", "ellipse", "brush",
  "sine", "cyclic", "timecycles", "pitchfork",
  "xabcd", "cypher", "headshoulders", "abcd", "triangle", "threedrives",
  "ell_impulse", "ell_correction", "ell_triangle", "ell_double", "ell_triple",
]);
const DEFAULT_DRAW_COLOR = { hline: "#f0b90b", vline: "#2962ff", crossline: "#2962ff", rectangle: "#ff9800", ellipse: "#e040fb" };

function currentDrawColor(it) {
  return it.color || DEFAULT_DRAW_COLOR[it.type] || "#2962ff";
}
function positionToolbar() {
  const it = drawings.getSelected();
  if (!it) { dtBar.classList.remove("open"); dtWidthMenu.classList.remove("open"); return; }
  const rect = drawings.getSelectedRect();
  if (!rect) { dtBar.classList.remove("open"); return; }
  dtBar.classList.add("open");
  // Show/hide style controls depending on whether this type supports them.
  const styleable = STYLEABLE.has(it.type);
  dtColorBtn.style.display = styleable ? "" : "none";
  dtWidthBtn.style.display = styleable ? "" : "none";
  if (styleable) {
    dtSwatch.style.background = currentDrawColor(it);
    dtWidthLabel.textContent = (it.width || 2) + "px";
  }
  // Place above the drawing (or below if no room at top).
  const bw = dtBar.offsetWidth || 160, bh = dtBar.offsetHeight || 36;
  let left = (rect.left + rect.right) / 2 - bw / 2;
  let top = rect.top - bh - 8;
  if (top < 44) top = rect.bottom + 8;
  left = Math.max(6, Math.min(left, window.innerWidth - bw - 6));
  top = Math.max(6, Math.min(top, window.innerHeight - bh - 6));
  dtBar.style.left = left + "px";
  dtBar.style.top = top + "px";
}
drawings.setSelectChangeHandler(() => positionToolbar());
// Keep the toolbar glued to the drawing as the chart scrolls / resizes.
window.addEventListener("resize", positionToolbar);
chart.timeScale().subscribeVisibleLogicalRangeChange(positionToolbar);

dtColorBtn.addEventListener("click", () => {
  const it = drawings.getSelected(); if (!it) return;
  dtColorInput.value = currentDrawColor(it);
  dtColorInput.click();
});
dtColorInput.addEventListener("input", () => {
  drawings.setSelectedStyle({ color: dtColorInput.value });
  dtSwatch.style.background = dtColorInput.value;
});
dtWidthBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (dtWidthMenu.classList.contains("open")) { dtWidthMenu.classList.remove("open"); return; }
  dtWidthMenu.innerHTML = "";
  [1, 2, 3, 4].forEach((w) => {
    const b = document.createElement("button");
    b.textContent = w + "px";
    b.onclick = () => {
      drawings.setSelectedStyle({ width: w });
      dtWidthLabel.textContent = w + "px";
      dtWidthMenu.classList.remove("open");
    };
    dtWidthMenu.appendChild(b);
  });
  const r = dtWidthBtn.getBoundingClientRect();
  dtWidthMenu.style.left = r.left + "px";
  dtWidthMenu.style.top = (r.bottom + 4) + "px";
  dtWidthMenu.classList.add("open");
});
document.addEventListener("click", (e) => {
  if (!dtWidthMenu.contains(e.target) && e.target !== dtWidthBtn && !dtWidthBtn.contains(e.target)) dtWidthMenu.classList.remove("open");
});
document.getElementById("dt-settings").addEventListener("click", () => drawings.openEditor());
document.getElementById("dt-delete").addEventListener("click", () => drawings.deleteSelected());

// ─────────────────────────── Symbol / init ────────────────────────────
document.getElementById("symbol").addEventListener("keydown", (e) => { if (e.key === "Enter") loadData(); });

// ── Watchlist UI ──
const wlStar = document.getElementById("wl-star");
const wlToggle = document.getElementById("wl-toggle");
const wlMenu = document.getElementById("wl-menu");
const wlList = document.getElementById("wl-list");
const wlEmpty = document.getElementById("wl-empty");

// Reflect whether the current symbol is starred.
function refreshWatchStar() {
  const on = watchlistHas(currentSymbol);
  wlStar.classList.toggle("on", on);
  wlStar.title = on ? "Remove from watchlist" : "Add to watchlist";
}

// Build the dropdown rows from the stored list.
function renderWatchlist() {
  const list = loadWatchlist();
  wlList.innerHTML = "";
  wlEmpty.classList.toggle("hidden", list.length > 0);
  list.forEach((sym) => {
    const row = document.createElement("div");
    row.className = "wl-item" + (sym === currentSymbol ? " on" : "");
    const label = document.createElement("span");
    label.textContent = sym;
    const rm = document.createElement("button");
    rm.className = "wl-rm"; rm.title = "Remove"; rm.innerHTML = "&times;";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromWatchlist(sym);
      renderWatchlist();
      refreshWatchStar();
    });
    row.appendChild(label);
    row.appendChild(rm);
    row.addEventListener("click", () => {
      document.getElementById("symbol").value = sym;
      closeWlMenu();
      loadData();
    });
    wlList.appendChild(row);
  });
}

function positionWlMenu() {
  const r = wlToggle.getBoundingClientRect();
  wlMenu.style.left = Math.round(r.left) + "px";
  wlMenu.style.top = Math.round(r.bottom + 4) + "px";
}
function openWlMenu() {
  renderWatchlist();
  wlMenu.classList.add("open");
  positionWlMenu();
}
function closeWlMenu() { wlMenu.classList.remove("open"); }

wlStar.addEventListener("click", () => {
  const sym = document.getElementById("symbol").value.trim().toUpperCase() || currentSymbol;
  toggleWatchlist(sym);
  refreshWatchStar();
  if (wlMenu.classList.contains("open")) renderWatchlist();
});
wlToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  if (wlMenu.classList.contains("open")) closeWlMenu(); else openWlMenu();
});
document.getElementById("wl-close").addEventListener("click", (e) => { e.stopPropagation(); closeWlMenu(); });
document.addEventListener("mousedown", (e) => {
  if (!wlMenu.classList.contains("open")) return;
  if (e.target.closest && (e.target.closest("#wl-menu") || e.target.closest("#wl-toggle"))) return;
  closeWlMenu();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeWlMenu(); });
window.addEventListener("resize", () => { if (wlMenu.classList.contains("open")) positionWlMenu(); });

async function init() {
  try {
    const cat = await (await fetch("/api/catalog")).json();
    cat.forEach((spec) => { CATALOG[spec.type] = spec; });
  } catch (e) { setStatus("Failed to load indicator catalog: " + e.message, true); }
  buildIndicatorMenu();
  // Reopen the last-viewed ticker (falls back to AAPL on first ever run).
  const last = loadLastSymbol();
  if (last) document.getElementById("symbol").value = last;
  // Force the first load to be treated as a symbol change so the per-ticker
  // indicator layout is loaded (even when the last symbol is AAPL).
  currentSymbol = "\u0000";
  await loadData();
  // No default indicators — a fresh ticker starts as a clean price + volume
  // chart; saved layouts (per ticker) are restored automatically on load.
}
init();
