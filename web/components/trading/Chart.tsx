"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTrading } from "@/providers/TradingProvider";
import { BINANCE_SYMBOLS, BINANCE_REST_URL } from "@/lib/constants";

// ============================================================
//              LIVE CANDLE PERSISTENCE (localStorage)
// ============================================================

const LIVE_CANDLE_KEY_PREFIX = "sur_live_candles_";
const MAX_LIVE_CANDLES = 360; // 6 hours of 1-min candles

interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function loadLiveCandles(market: string): LiveCandle[] {
  try {
    const raw = localStorage.getItem(LIVE_CANDLE_KEY_PREFIX + market);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch { return []; }
}

function saveLiveCandles(market: string, candles: LiveCandle[]) {
  try {
    // Keep only the most recent entries
    const trimmed = candles.slice(-MAX_LIVE_CANDLES);
    localStorage.setItem(LIVE_CANDLE_KEY_PREFIX + market, JSON.stringify(trimmed));
  } catch {}
}

// ============================================================
//                    TIMEFRAMES
// ============================================================

const TIMEFRAMES = [
  { label: "1m", seconds: 60, binance: "1m" },
  { label: "5m", seconds: 300, binance: "5m" },
  { label: "15m", seconds: 900, binance: "15m" },
  { label: "30m", seconds: 1800, binance: "30m" },
  { label: "1H", seconds: 3600, binance: "1h" },
  { label: "4H", seconds: 14400, binance: "4h" },
  { label: "1D", seconds: 86400, binance: "1d" },
  { label: "1W", seconds: 604800, binance: "1w" },
];

// ============================================================
//          BINANCE REAL CANDLE DATA FETCHER
// ============================================================

interface CandleData {
  candles: any[];
  volume: any[];
}

// Cache fetched candles to avoid re-fetching on every re-render
const candleCache: Record<string, { data: CandleData; ts: number }> = {};
const CACHE_TTL = 30_000; // 30s cache

async function fetchBinanceCandles(market: string, binanceInterval: string): Promise<CandleData | null> {
  const symbol = BINANCE_SYMBOLS[market];
  if (!symbol) return null;

  const cacheKey = `${symbol}_${binanceInterval}`;
  const cached = candleCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  try {
    const url = `${BINANCE_REST_URL}/klines?symbol=${symbol.toUpperCase()}&interval=${binanceInterval}&limit=500`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.json();

    const candles: any[] = [];
    const volume: any[] = [];

    for (const k of raw) {
      const time = Math.floor(k[0] / 1000); // ms → seconds
      const open = parseFloat(k[1]);
      const high = parseFloat(k[2]);
      const low = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const vol = parseFloat(k[5]);

      candles.push({ time, open, high, low, close });
      volume.push({
        time,
        value: vol,
        color: close >= open ? "#3fb95040" : "#f8514940",
      });
    }

    const data = { candles, volume };
    candleCache[cacheKey] = { data, ts: Date.now() };
    return data;
  } catch {
    return null;
  }
}

// ============================================================
//               CHART TYPES
// ============================================================

const CHART_TYPES = [
  { key: "candles", label: "Candles", icon: <CandleIcon /> },
  { key: "line", label: "Line", icon: <LineIcon /> },
  { key: "area", label: "Area", icon: <AreaIcon /> },
];

// ============================================================
//          LEFT TOOLBAR DRAWING TOOLS
// ============================================================

const DRAW_TOOLS = [
  { key: "crosshair", label: "Crosshair", icon: <CrosshairIcon /> },
  { key: "trendline", label: "Trend Line", icon: <TrendLineIcon /> },
  { key: "horzline", label: "Horizontal Line", icon: <HorzLineIcon /> },
  { key: "ray", label: "Ray", icon: <RayIcon /> },
  { key: "fib", label: "Fib Retracement", icon: <FibIcon /> },
  { key: "text", label: "Text", icon: <TextIcon /> },
  { key: "measure", label: "Measure", icon: <MeasureIcon /> },
  { key: "brush", label: "Brush", icon: <BrushIcon /> },
  { key: "magnet", label: "Magnet Mode", icon: <MagnetIcon /> },
  { key: "zoom", label: "Zoom In", icon: <ZoomIcon /> },
  { key: "lock", label: "Lock Drawing", icon: <LockIcon /> },
  { key: "trash", label: "Remove Drawings", icon: <TrashIcon /> },
];

// ============================================================
//                  MAIN CHART COMPONENT
// ============================================================

interface ChartProps {
  market: string;
}

// ============================================================
//          DRAWING OVERLAY TYPES
// ============================================================

interface DrawingPoint {
  x: number; // pixel x
  y: number; // pixel y
  price: number;
  time: number;
}

interface Drawing {
  id: string;
  type: "trendline" | "ray" | "fib" | "measure" | "text" | "brush";
  points: DrawingPoint[];
  color: string;
  text?: string;
}

export function Chart({ market }: ChartProps) {
  // Refs for main chart
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const mainSeriesRef = useRef<any>(null);
  const currentCandleRef = useRef<any>(null);
  const priceLineRef = useRef<any>(null);

  // Refs for sub-panes (volume, RSI, MACD)
  const volContainerRef = useRef<HTMLDivElement>(null);
  const volChartRef = useRef<any>(null);
  const volSeriesRef = useRef<any>(null);
  const subContainerRef = useRef<HTMLDivElement>(null);
  const subChartRef = useRef<any>(null);

  // Drawing overlay
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const drawingInProgressRef = useRef<DrawingPoint[]>([]);
  const [magnetMode, setMagnetMode] = useState(false);
  const [lockDrawing, setLockDrawing] = useState(false);

  const [ready, setReady] = useState(false);
  const [selectedTf, setSelectedTf] = useState("1m");
  const [chartType, setChartType] = useState("candles");
  const [activeTool, setActiveTool] = useState("crosshair");
  const [activeTab, setActiveTab] = useState<"chart" | "depth" | "details">("chart");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [activeIndicators, setActiveIndicators] = useState<string[]>(["ma7", "ma30", "ma99", "sma9"]);
  const [volPaneH, setVolPaneH] = useState(80);
  const [subPaneH, setSubPaneH] = useState(100);
  const indicatorSeriesRef = useRef<Record<string, any[]>>({});
  const horzLinesRef = useRef<any[]>([]);
  const indicatorMenuRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);
  const liveCandlesRef = useRef<LiveCandle[]>([]);
  const { state } = useTrading();

  // Which sub-chart indicators are active?
  const hasSubIndicator = activeIndicators.some(k => ["rsi", "macd"].includes(k));

  // Close indicator menu on outside click
  useEffect(() => {
    if (!showIndicatorMenu) return;
    const handler = (e: MouseEvent) => {
      if (indicatorMenuRef.current && !indicatorMenuRef.current.contains(e.target as Node)) {
        setShowIndicatorMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showIndicatorMenu]);

  // Wait one frame for layout
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // ---- Shared chart config ----
  const getChartOpts = (w: number, h: number, showTimeAxis: boolean) => ({
    width: w, height: h,
    layout: { background: { color: "#1c1c20" }, textColor: "#6b7280", fontSize: 11, fontFamily: "DM Sans, system-ui, sans-serif" },
    grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    rightPriceScale: { borderColor: "#28282e", autoScale: true },
    timeScale: { borderColor: "#28282e", timeVisible: true, secondsVisible: false, barSpacing: 8, visible: showTimeAxis },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    crosshair: { mode: 0 },
  });

  // ===== CREATE ALL CHARTS =====
  useEffect(() => {
    if (!ready || !mainContainerRef.current || !volContainerRef.current) return;

    const charts: any[] = [];
    const observers: ResizeObserver[] = [];
    let lwc: any;

    import("lightweight-charts").then(async (mod) => {
      lwc = mod;
      const { createChart, ColorType } = mod;
      if (!mainContainerRef.current || !volContainerRef.current) return;

      // --- MAIN CHART ---
      const mainW = mainContainerRef.current.clientWidth || 800;
      const mainH = mainContainerRef.current.clientHeight || 300;
      const mainChart = createChart(mainContainerRef.current, {
        ...getChartOpts(mainW, mainH, !hasSubIndicator),
        layout: { background: { type: ColorType.Solid, color: "#1c1c20" }, textColor: "#6b7280", fontSize: 11, fontFamily: "DM Sans, system-ui, sans-serif" },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { borderColor: "#28282e", scaleMargins: { top: 0.05, bottom: 0.05 }, autoScale: true },
        crosshair: {
          mode: mod.CrosshairMode.Normal,
          vertLine: { color: "#0052FF60", width: 1, style: mod.LineStyle.Dashed, labelBackgroundColor: "#0052FF" },
          horzLine: { color: "#0052FF60", width: 1, style: mod.LineStyle.Dashed, labelBackgroundColor: "#0052FF" },
        },
        localization: {
          priceFormatter: (price: number) => price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        },
      });
      charts.push(mainChart);

      let mainSeries: any;
      if (chartType === "line") {
        mainSeries = mainChart.addLineSeries({ color: "#0052FF", lineWidth: 2 });
      } else if (chartType === "area") {
        mainSeries = mainChart.addAreaSeries({ topColor: "#0052FF30", bottomColor: "#0052FF05", lineColor: "#0052FF", lineWidth: 2 });
      } else {
        mainSeries = mainChart.addCandlestickSeries({
          upColor: "#3fb950", downColor: "#f85149",
          borderUpColor: "#3fb950", borderDownColor: "#f85149",
          wickUpColor: "#3fb95080", wickDownColor: "#f8514980",
        });
      }

      // Data — try Binance real candles first, fallback to generated
      const tfConfig = TIMEFRAMES.find(t => t.label === selectedTf) || TIMEFRAMES[0];
      let data: CandleData;
      const realData = await fetchBinanceCandles(market, tfConfig.binance);
      if (realData && realData.candles.length > 0) {
        data = realData;
      } else {
        // Fallback to generated data
        const basePrice = market.includes("ETH") ? 2500 : 100000;
        data = generateSampleData(market, tfConfig.seconds, basePrice);
      }

      const closes = data.candles.map((c: any) => ({ time: c.time, value: c.close }));

      if (chartType === "line" || chartType === "area") {
        mainSeries.setData(closes);
      } else {
        mainSeries.setData(data.candles);
      }

      if (data.candles.length > 0) {
        currentCandleRef.current = { ...data.candles[data.candles.length - 1] };
      }

      // Overlay indicators (MA, EMA, BB, VWAP)
      indicatorSeriesRef.current = {};
      const indLineOpts = { lastValueVisible: false, priceLineVisible: false };
      for (const ind of INDICATORS) {
        if (!activeIndicators.includes(ind.key)) continue;
        if (ind.type === "sub") continue; // sub-chart indicators handled separately

        if (ind.type === "bb") {
          const { upper, lower, mid } = calcBollinger(closes, ind.period, 2);
          const sUp = mainChart.addLineSeries({ ...indLineOpts, color: ind.color + "80", lineWidth: 1, lineStyle: 2 });
          const sLow = mainChart.addLineSeries({ ...indLineOpts, color: ind.color + "80", lineWidth: 1, lineStyle: 2 });
          const sMid = mainChart.addLineSeries({ ...indLineOpts, color: ind.color, lineWidth: 1 });
          sUp.setData(upper); sLow.setData(lower); sMid.setData(mid);
          indicatorSeriesRef.current[ind.key] = [sUp, sLow, sMid];
        } else if (ind.type === "vwap") {
          const s = mainChart.addLineSeries({ ...indLineOpts, color: ind.color, lineWidth: 1, lineStyle: 2 });
          s.setData(calcVWAP(data.candles));
          indicatorSeriesRef.current[ind.key] = [s];
        } else if (ind.type === "ema") {
          const s = mainChart.addLineSeries({ ...indLineOpts, color: ind.color, lineWidth: 1 });
          s.setData(calcEMA(closes, ind.period));
          indicatorSeriesRef.current[ind.key] = [s];
        } else {
          const s = mainChart.addLineSeries({ ...indLineOpts, color: ind.color, lineWidth: 1 });
          s.setData(calcSMA(closes, ind.period));
          indicatorSeriesRef.current[ind.key] = [s];
        }
      }

      mainChart.timeScale().fitContent();
      chartRef.current = mainChart;
      mainSeriesRef.current = mainSeries;

      // Resize main
      const mainObs = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) mainChart.applyOptions({ width, height });
      });
      mainObs.observe(mainContainerRef.current);
      observers.push(mainObs);

      // --- VOLUME PANE ---
      const volW = volContainerRef.current!.clientWidth || 800;
      const volH = volContainerRef.current!.clientHeight || 80;
      const volChart = createChart(volContainerRef.current!, {
        ...getChartOpts(volW, volH, !hasSubIndicator),
        layout: { background: { type: ColorType.Solid, color: "#1c1c20" }, textColor: "#6b7280", fontSize: 10, fontFamily: "DM Sans, system-ui, sans-serif" },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        rightPriceScale: { borderColor: "#28282e", scaleMargins: { top: 0.1, bottom: 0 }, autoScale: true },
      });
      charts.push(volChart);

      const volSeries = volChart.addHistogramSeries({
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volSeries.setData(data.volume);
      volChart.timeScale().fitContent();
      volChartRef.current = volChart;
      volSeriesRef.current = volSeries;

      const volObs = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        if (width > 0 && height > 0) volChart.applyOptions({ width, height });
      });
      volObs.observe(volContainerRef.current!);
      observers.push(volObs);

      // --- SUB-INDICATOR PANE (RSI / MACD) ---
      if (hasSubIndicator && subContainerRef.current) {
        const subW = subContainerRef.current.clientWidth || 800;
        const subH2 = subContainerRef.current.clientHeight || 100;
        const subChart = createChart(subContainerRef.current, {
          ...getChartOpts(subW, subH2, true),
          layout: { background: { type: ColorType.Solid, color: "#1c1c20" }, textColor: "#6b7280", fontSize: 10, fontFamily: "DM Sans, system-ui, sans-serif" },
          grid: { vertLines: { visible: false }, horzLines: { visible: false } },
          rightPriceScale: { borderColor: "#28282e", scaleMargins: { top: 0.1, bottom: 0.1 }, autoScale: true },
        });
        charts.push(subChart);

        if (activeIndicators.includes("rsi")) {
          const rsiData = calcRSI(closes, 14);
          const rsiSeries = subChart.addLineSeries({ color: "#f59e0b", lineWidth: 2, lastValueVisible: true, priceLineVisible: false });
          rsiSeries.setData(rsiData);
          // Overbought/oversold lines
          const ob = subChart.addLineSeries({ color: "#f8514940", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
          const os = subChart.addLineSeries({ color: "#3fb95040", lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
          if (rsiData.length > 0) {
            ob.setData([{ time: rsiData[0].time, value: 70 }, { time: rsiData[rsiData.length - 1].time, value: 70 }]);
            os.setData([{ time: rsiData[0].time, value: 30 }, { time: rsiData[rsiData.length - 1].time, value: 30 }]);
          }
        }

        if (activeIndicators.includes("macd")) {
          const { macdLine, signalLine, histogram } = calcMACD(closes);
          const macdSeries = subChart.addLineSeries({ color: "#0052FF", lineWidth: 2, lastValueVisible: false, priceLineVisible: false });
          const sigSeries = subChart.addLineSeries({ color: "#f59e0b", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
          const histSeries = subChart.addHistogramSeries({ lastValueVisible: false, priceLineVisible: false });
          macdSeries.setData(macdLine);
          sigSeries.setData(signalLine);
          histSeries.setData(histogram.map(h => ({ ...h, color: h.value >= 0 ? "#3fb95060" : "#f8514960" })));
        }

        subChart.timeScale().fitContent();
        subChartRef.current = subChart;

        const subObs = new ResizeObserver((entries) => {
          const { width, height } = entries[0].contentRect;
          if (width > 0 && height > 0) subChart.applyOptions({ width, height });
        });
        subObs.observe(subContainerRef.current);
        observers.push(subObs);
      }

      // --- SYNC TIME SCALES ---
      const syncTimeScales = (source: any, targets: any[]) => {
        source.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
          if (syncingRef.current || !range) return;
          syncingRef.current = true;
          targets.forEach((t) => {
            try { t.timeScale().setVisibleLogicalRange(range); } catch {}
          });
          syncingRef.current = false;
        });
      };

      const allCharts = charts.filter(Boolean);
      for (const c of allCharts) {
        syncTimeScales(c, allCharts.filter((x) => x !== c));
      }
    });

    return () => {
      // Persist live candles before cleanup
      if (liveCandlesRef.current.length > 0) {
        saveLiveCandles(market, liveCandlesRef.current);
      }
      observers.forEach((o) => o.disconnect());
      charts.forEach((c) => { try { c.remove(); } catch {} });
      chartRef.current = null;
      mainSeriesRef.current = null;
      volChartRef.current = null;
      volSeriesRef.current = null;
      subChartRef.current = null;
      currentCandleRef.current = null;
      priceLineRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, ready, selectedTf, chartType, activeIndicators.join(",")]);

  // ===== LIVE PRICE UPDATES =====
  useEffect(() => {
    if (!mainSeriesRef.current || state.markPrice <= 0) return;

    const price = state.markPrice;
    const tfConfig = TIMEFRAMES.find(t => t.label === selectedTf) || TIMEFRAMES[0];
    const interval = tfConfig.seconds;
    const now = Math.floor(Date.now() / 1000);
    const candleTime = Math.floor(now / interval) * interval;
    const current = currentCandleRef.current;

    if (chartType === "line" || chartType === "area") {
      mainSeriesRef.current.update({ time: candleTime, value: price });
    } else if (current && current.time === candleTime) {
      current.close = price;
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      mainSeriesRef.current.update({ ...current });
    } else {
      const newCandle = { time: candleTime, open: price, high: price, low: price, close: price };
      currentCandleRef.current = newCandle;
      mainSeriesRef.current.update(newCandle);
    }

    // Persist live candle at 1-min resolution to localStorage
    const liveMinTime = Math.floor(now / 60) * 60;
    const liveCandles = liveCandlesRef.current;
    const lastLive = liveCandles.length > 0 ? liveCandles[liveCandles.length - 1] : null;
    if (lastLive && lastLive.time === liveMinTime) {
      lastLive.close = price;
      lastLive.high = Math.max(lastLive.high, price);
      lastLive.low = Math.min(lastLive.low, price);
    } else {
      liveCandles.push({ time: liveMinTime, open: price, high: price, low: price, close: price });
      // Trim old entries
      if (liveCandles.length > MAX_LIVE_CANDLES) {
        liveCandlesRef.current = liveCandles.slice(-MAX_LIVE_CANDLES);
      }
    }
    // Throttle saves: write every 5th candle update
    if (liveCandles.length % 5 === 0) {
      saveLiveCandles(market, liveCandlesRef.current);
    }

    // Volume pane — no fake volume; only update when we have real volume data
    // (Real volume will come from the WebSocket feed when the backend is live)

    // Update last price line
    if (mainSeriesRef.current && price > 0) {
      if (priceLineRef.current) {
        try { mainSeriesRef.current.removePriceLine(priceLineRef.current); } catch {}
      }
      priceLineRef.current = mainSeriesRef.current.createPriceLine({
        price, color: "#0052FF", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "",
      });
    }
  }, [state.markPrice, selectedTf, chartType, market]);

  // Live mouse position for drawing preview
  const mousePosRef = useRef<{ x: number; y: number; price: number; time: number } | null>(null);
  const rafIdRef = useRef<number>(0);

  // ===== CORE DRAWING RENDERER (used for both final + preview) =====
  const drawShape = useCallback((
    ctx: CanvasRenderingContext2D,
    type: Drawing["type"],
    p1: DrawingPoint,
    p2: DrawingPoint,
    color: string,
    isPreview: boolean,
    chart: any,
    series: any,
  ) => {
    const coordToPixel = (p: DrawingPoint) => {
      try {
        const x = chart.timeScale().timeToCoordinate(p.time);
        const y = series.priceToCoordinate(p.price);
        if (x === null || y === null) return null;
        return { x: x as number, y: y as number };
      } catch { return null; }
    };

    const pt1 = coordToPixel(p1);
    const pt2 = coordToPixel(p2);
    if (!pt1 || !pt2) return;

    const alpha = isPreview ? 0.6 : 1;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = isPreview ? 1 : 1.5;

    if (type === "trendline") {
      ctx.strokeStyle = color;
      ctx.setLineDash(isPreview ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(pt1.x, pt1.y);
      ctx.lineTo(pt2.x, pt2.y);
      ctx.stroke();
      // Endpoints
      for (const pt of [pt1, pt2]) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      // Length label on preview
      if (isPreview) {
        const priceDiff = p2.price - p1.price;
        const pctDiff = (priceDiff / p1.price) * 100;
        ctx.fillStyle = "#e4e5eb";
        ctx.font = "10px JetBrains Mono, monospace";
        ctx.fillText(`${pctDiff >= 0 ? "+" : ""}${pctDiff.toFixed(2)}%`, pt2.x + 8, pt2.y - 6);
      }
    } else if (type === "ray") {
      const dx = pt2.x - pt1.x;
      const dy = pt2.y - pt1.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        const extend = 5000;
        ctx.strokeStyle = color;
        ctx.setLineDash(isPreview ? [6, 4] : []);
        ctx.beginPath();
        ctx.moveTo(pt1.x, pt1.y);
        ctx.lineTo(pt1.x + dx / len * extend, pt1.y + dy / len * extend);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pt1.x, pt1.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    } else if (type === "fib") {
      const diff = p2.price - p1.price;
      const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      const colors = ["#787B86", "#f85149", "#3fb950", "#3fb950", "#3fb950", "#f85149", "#787B86"];
      const chartW = ctx.canvas.width / (window.devicePixelRatio || 1);

      for (let i = 0; i < levels.length; i++) {
        const price = p2.price - diff * levels[i];
        const y = series.priceToCoordinate(price);
        if (y === null) continue;
        ctx.strokeStyle = colors[i] + (isPreview ? "60" : "90");
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(0, y as number);
        ctx.lineTo(chartW, y as number);
        ctx.stroke();
        ctx.fillStyle = colors[i];
        ctx.font = "10px DM Sans, system-ui";
        ctx.textAlign = "left";
        ctx.fillText(`${(levels[i] * 100).toFixed(1)}%  $${price.toFixed(0)}`, Math.max(pt1.x, pt2.x) + 8, (y as number) - 3);
      }
      ctx.setLineDash([]);
      // Vertical connecting line
      ctx.strokeStyle = "#787B8660";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pt1.x, pt1.y);
      ctx.lineTo(pt1.x, pt2.y);
      ctx.stroke();
      // Shaded region
      ctx.fillStyle = isPreview ? "#787B8608" : "#787B8610";
      ctx.fillRect(
        Math.min(pt1.x, pt2.x), Math.min(pt1.y, pt2.y),
        Math.abs(pt2.x - pt1.x) + 200, Math.abs(pt2.y - pt1.y)
      );
    } else if (type === "measure") {
      // Dashed box
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = "#787B86";
      const boxX = Math.min(pt1.x, pt2.x);
      const boxY = Math.min(pt1.y, pt2.y);
      const boxW = Math.abs(pt2.x - pt1.x);
      const boxH = Math.abs(pt2.y - pt1.y);
      // Shaded area
      const priceDiff = p2.price - p1.price;
      ctx.fillStyle = priceDiff >= 0 ? "#3fb95010" : "#f8514910";
      ctx.fillRect(boxX, boxY, boxW, boxH);
      ctx.strokeRect(boxX, boxY, boxW, boxH);
      ctx.setLineDash([]);
      // Label
      const pctDiff = (priceDiff / p1.price) * 100;
      const midX = (pt1.x + pt2.x) / 2;
      const midY = (pt1.y + pt2.y) / 2;
      // Background pill
      const labelW = 110;
      const labelH = 36;
      ctx.fillStyle = "#1c1c20EE";
      ctx.beginPath();
      const rx = midX - labelW / 2;
      const ry = midY - labelH / 2;
      ctx.roundRect(rx, ry, labelW, labelH, 4);
      ctx.fill();
      ctx.strokeStyle = "#28282e";
      ctx.lineWidth = 1;
      ctx.stroke();
      // Text
      ctx.fillStyle = priceDiff >= 0 ? "#3fb950" : "#f85149";
      ctx.font = "bold 12px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${priceDiff >= 0 ? "+" : ""}${pctDiff.toFixed(2)}%`, midX, midY - 2);
      ctx.fillStyle = "#9ca3af";
      ctx.font = "10px JetBrains Mono, monospace";
      ctx.fillText(`${priceDiff >= 0 ? "+" : "-"}$${Math.abs(priceDiff).toFixed(0)}`, midX, midY + 12);
      ctx.textAlign = "start";
    }

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }, []);

  // ===== FULL RENDER (final drawings + live preview) =====
  const renderAll = useCallback(() => {
    const canvas = canvasRef.current;
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    if (!canvas || !chart || !series) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const parentRect = canvas.parentElement?.getBoundingClientRect();
    if (!parentRect) return;

    const dpr = window.devicePixelRatio || 1;
    const w = parentRect.width;
    const h = parentRect.height;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const TOOL_COLORS: Record<string, string> = {
      trendline: "#0052FF",
      ray: "#f59e0b",
      fib: "#787B86",
      measure: "#787B86",
      brush: "#a855f7",
    };

    // Draw finalized drawings
    for (const d of drawings) {
      if (d.points.length < 2) continue;
      drawShape(ctx, d.type, d.points[0], d.points[1], d.color, false, chart, series);
    }

    // Draw live preview (first point placed, mouse moving)
    const inProgress = drawingInProgressRef.current;
    const mousePos = mousePosRef.current;
    if (inProgress.length === 1 && mousePos && ["trendline", "ray", "fib", "measure"].includes(activeTool)) {
      const color = TOOL_COLORS[activeTool] || "#0052FF";
      drawShape(ctx, activeTool as Drawing["type"], inProgress[0], mousePos as DrawingPoint, color, true, chart, series);
    }
  }, [drawings, activeTool, drawShape]);

  // Continuous render loop when drawing tool is active
  useEffect(() => {
    const isDrawingTool = ["trendline", "ray", "fib", "measure", "brush"].includes(activeTool);
    const needsLoop = isDrawingTool || drawings.length > 0;
    if (!needsLoop) return;

    let running = true;
    const loop = () => {
      if (!running) return;
      renderAll();
      rafIdRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      running = false;
      cancelAnimationFrame(rafIdRef.current);
    };
  }, [activeTool, renderAll]);

  // Re-render drawings when chart scrolls/zooms (for finalized drawings)
  useEffect(() => {
    if (!chartRef.current || drawings.length === 0) return;
    const chart = chartRef.current;
    const handler = () => renderAll();
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => {
      try { chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler); } catch {}
    };
  }, [drawings, renderAll]);

  // Track mouse position for live preview
  useEffect(() => {
    const container = mainContainerRef.current;
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    if (!container) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!chart || !series) return;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      try {
        const time = chart.timeScale().coordinateToTime(x);
        const price = series.coordinateToPrice(y);
        if (time !== null && price !== null) {
          mousePosRef.current = { x, y, price: price as number, time: time as number };
        }
      } catch {}
    };

    const onMouseLeave = () => {
      mousePosRef.current = null;
    };

    container.addEventListener("mousemove", onMouseMove);
    container.addEventListener("mouseleave", onMouseLeave);
    return () => {
      container.removeEventListener("mousemove", onMouseMove);
      container.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [ready, activeTool]);

  // Handle chart clicks for drawing tools
  const handleChartClick = useCallback((e: MouseEvent) => {
    const chart = chartRef.current;
    const series = mainSeriesRef.current;
    const container = mainContainerRef.current;
    if (!chart || !series || !container) return;
    if (!["trendline", "ray", "fib", "measure", "brush"].includes(activeTool)) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Convert pixel to price/time
    const ts = chart.timeScale();
    const time = ts.coordinateToTime(x);
    const price = series.coordinateToPrice(y);
    if (time === null || price === null) return;

    const point: DrawingPoint = { x, y, price: price as number, time: time as number };
    const inProgress = drawingInProgressRef.current;
    inProgress.push(point);

    if (inProgress.length >= 2) {
      const drawType = activeTool as Drawing["type"];
      const TOOL_COLORS: Record<string, string> = {
        trendline: "#0052FF",
        ray: "#f59e0b",
        fib: "#787B86",
        measure: "#787B86",
        brush: "#a855f7",
      };
      setDrawings(prev => [...prev, {
        id: `d_${Date.now()}`,
        type: drawType,
        points: [...inProgress],
        color: TOOL_COLORS[drawType] || "#0052FF",
      }]);
      drawingInProgressRef.current = [];
      mousePosRef.current = null;
      // After drawing, revert to crosshair unless lock mode
      if (!lockDrawing) {
        setActiveTool("crosshair");
      }
    }
  }, [activeTool, lockDrawing]);

  useEffect(() => {
    const container = mainContainerRef.current;
    if (!container) return;
    container.addEventListener("click", handleChartClick);
    return () => container.removeEventListener("click", handleChartClick);
  }, [handleChartClick]);

  // Escape key cancels in-progress drawing
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        drawingInProgressRef.current = [];
        mousePosRef.current = null;
        setActiveTool("crosshair");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleToolClick = (key: string) => {
    if (key === "trash") {
      // Remove all drawings + horizontal lines
      horzLinesRef.current.forEach((pl) => {
        try { mainSeriesRef.current?.removePriceLine(pl); } catch {}
      });
      horzLinesRef.current = [];
      setDrawings([]);
      drawingInProgressRef.current = [];
      // Clear canvas
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    if (key === "zoom" && chartRef.current) {
      chartRef.current.timeScale().fitContent();
      return;
    }
    if (key === "magnet") {
      setMagnetMode(!magnetMode);
      return;
    }
    if (key === "lock") {
      setLockDrawing(!lockDrawing);
      return;
    }
    if (key === "horzline" && mainSeriesRef.current && state.markPrice > 0) {
      // Add a horizontal line at current price
      const pl = mainSeriesRef.current.createPriceLine({
        price: state.markPrice,
        color: "#f59e0b",
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `H ${state.markPrice.toFixed(0)}`,
      });
      horzLinesRef.current.push(pl);
      return;
    }
    if (key === "text") {
      // Add text annotation at current price
      if (mainSeriesRef.current && state.markPrice > 0) {
        const pl = mainSeriesRef.current.createPriceLine({
          price: state.markPrice,
          color: "#a855f7",
          lineWidth: 1,
          lineStyle: 3,
          axisLabelVisible: true,
          title: "Note",
        });
        horzLinesRef.current.push(pl);
      }
      return;
    }
    drawingInProgressRef.current = []; // Reset any in-progress drawing
    setActiveTool(key);
  };

  const toggleIndicator = (id: string) => {
    setActiveIndicators((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  return (
    <div className={`flex flex-col h-full ${isFullscreen ? "fixed inset-0 z-50" : ""}`} style={{ background: "#1c1c20" }}>
      {/* ===== TOP TOOLBAR ===== */}
      <div className="flex items-center border-b border-[#28282e] flex-shrink-0 h-9">
        {/* Left section: timeframes + chart type + indicators */}
        <div className="flex items-center gap-0.5 px-2 flex-1 overflow-x-auto">
          {/* Timeframes */}
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.label}
              onClick={() => setSelectedTf(tf.label)}
              className={`px-2 py-1 text-[11px] rounded transition-colors whitespace-nowrap ${
                selectedTf === tf.label
                  ? "bg-sur-accent/15 text-sur-accent font-medium"
                  : "text-sur-muted hover:text-sur-text hover:bg-[#28282e]"
              }`}
            >
              {tf.label}
            </button>
          ))}

          <div className="w-px h-4 bg-[#28282e] mx-1" />

          {/* Chart type */}
          {CHART_TYPES.map((ct) => (
            <button
              key={ct.key}
              onClick={() => setChartType(ct.key)}
              title={ct.label}
              className={`p-1.5 rounded transition-colors ${
                chartType === ct.key
                  ? "text-sur-accent bg-sur-accent/10"
                  : "text-sur-muted hover:text-sur-text hover:bg-[#28282e]"
              }`}
            >
              {ct.icon}
            </button>
          ))}

          <div className="w-px h-4 bg-[#28282e] mx-1" />

          {/* Indicators button */}
          <div className="relative" ref={indicatorMenuRef}>
            <button
              onClick={() => setShowIndicatorMenu(!showIndicatorMenu)}
              className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                activeIndicators.length > 0
                  ? "text-sur-accent bg-sur-accent/10"
                  : "text-sur-muted hover:text-sur-text hover:bg-[#28282e]"
              }`}
            >
              <IndicatorIcon />
              <span>Indicators{activeIndicators.length > 0 ? ` (${activeIndicators.length})` : ""}</span>
            </button>
            {showIndicatorMenu && (
              <div className="absolute top-full left-0 mt-1 bg-sur-surface border border-sur-border rounded-lg shadow-2xl z-50 w-64 py-1.5 animate-fade-in">
                <div className="px-3 py-1.5 text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border mb-1">
                  Toggle Indicators
                </div>
                {INDICATORS.map((ind) => {
                  const isActive = activeIndicators.includes(ind.key);
                  return (
                    <button
                      key={ind.key}
                      onClick={() => toggleIndicator(ind.key)}
                      className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-white/[0.04] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-[2px] rounded-full flex-shrink-0" style={{ backgroundColor: ind.color }} />
                        <div>
                          <div className="text-[12px] font-medium text-sur-text">{ind.label}</div>
                          <div className="text-[10px] text-sur-muted">{ind.desc}</div>
                        </div>
                      </div>
                      <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        isActive ? "border-sur-accent bg-sur-accent/20" : "border-sur-border"
                      }`}>
                        {isActive && <span className="text-[8px] text-sur-accent">&#10003;</span>}
                      </div>
                    </button>
                  );
                })}
                {activeIndicators.length > 0 && (
                  <div className="border-t border-sur-border mt-1 pt-1 px-3">
                    <button
                      onClick={() => { setActiveIndicators([]); setShowIndicatorMenu(false); }}
                      className="w-full text-left py-1.5 text-[11px] text-sur-red hover:text-sur-red/80 transition-colors"
                    >
                      Clear All
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Settings */}
          <button className="p-1.5 rounded text-sur-muted hover:text-sur-text hover:bg-[#28282e] transition-colors" title="Settings">
            <SettingsIcon />
          </button>

          <div className="w-px h-4 bg-[#28282e] mx-1" />

          {/* Last Price label */}
          <span className="text-[11px] text-sur-accent font-medium px-1">
            Last Price
          </span>
        </div>

        {/* Right section: tabs + fullscreen */}
        <div className="flex items-center gap-1 px-2">
          {(["chart", "depth", "details"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-2.5 py-1 text-[11px] rounded transition-colors capitalize ${
                activeTab === tab
                  ? "text-sur-text font-medium"
                  : "text-sur-muted hover:text-sur-text"
              }`}
            >
              {tab === "chart" ? "Chart" : tab === "depth" ? "Depth" : "Details"}
            </button>
          ))}

          <div className="w-px h-4 bg-[#28282e] mx-1" />

          <button
            onClick={toggleFullscreen}
            className="p-1 rounded text-sur-muted hover:text-sur-text hover:bg-[#28282e] transition-colors"
            title="Fullscreen"
          >
            <FullscreenIcon />
          </button>
        </div>
      </div>

      {/* ===== MAIN AREA: LEFT TOOLBAR + CHART ===== */}
      <div className="flex-1 flex min-h-0">
        {/* Left drawing toolbar */}
        <div className="w-14 border-r border-[#28282e] flex flex-col items-center py-2 gap-1.5 flex-shrink-0 overflow-y-auto">
          {DRAW_TOOLS.map((tool) => {
            const isActive = activeTool === tool.key
              || (tool.key === "magnet" && magnetMode)
              || (tool.key === "lock" && lockDrawing);
            return (
              <button
                key={tool.key}
                onClick={() => handleToolClick(tool.key)}
                title={tool.label}
                className={`w-10 h-10 flex items-center justify-center rounded-md transition-colors ${
                  isActive
                    ? "text-sur-accent bg-sur-accent/15"
                    : "text-sur-muted hover:text-sur-text hover:bg-white/[0.06]"
                }`}
              >
                {tool.icon}
              </button>
            );
          })}
        </div>

        {/* Chart panes stacked vertically */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {/* Main price chart */}
          <div className="flex-1 min-h-0 relative">
            <div
              ref={mainContainerRef}
              className="absolute inset-0"
              style={{ cursor: ["trendline", "ray", "fib", "measure", "brush", "text"].includes(activeTool) ? "crosshair" : "default" }}
            />
            {/* Drawing overlay canvas */}
            <canvas
              ref={canvasRef}
              className="absolute inset-0 pointer-events-none z-20"
              style={{ width: "100%", height: "100%" }}
            />
            {/* Watermark + indicator legend */}
            <div className="absolute top-3 left-3 pointer-events-none select-none z-10">
              <div className="text-[13px] font-semibold text-white/10">{market}</div>
              <div className="text-[10px] text-white/5 mt-0.5">SUR Protocol</div>
              {activeIndicators.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-2">
                  {activeIndicators.map((key) => {
                    const ind = INDICATORS.find((i) => i.key === key);
                    if (!ind) return null;
                    return (
                      <span key={key} className="text-[10px] font-medium" style={{ color: ind.color + "99" }}>
                        {ind.label}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Volume pane resize handle */}
          <div
            className="h-[3px] bg-[#28282e] hover:bg-sur-accent/40 cursor-row-resize flex-shrink-0 relative group"
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = volPaneH;
              const onMove = (ev: MouseEvent) => setVolPaneH(Math.max(40, Math.min(200, startH - (ev.clientY - startY))));
              const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
              window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
            }}
          >
            <div className="absolute left-1/2 top-0 -translate-x-1/2 text-[8px] text-sur-muted opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">Vol</div>
          </div>

          {/* Volume pane */}
          <div className="flex-shrink-0 relative" style={{ height: volPaneH }}>
            <div ref={volContainerRef} className="absolute inset-0" />
            <div className="absolute top-1 left-2 text-[9px] text-sur-muted font-medium pointer-events-none z-10">Volume</div>
          </div>

          {/* Sub-indicator pane (RSI / MACD) */}
          {hasSubIndicator && (
            <>
              <div
                className="h-[3px] bg-[#28282e] hover:bg-sur-accent/40 cursor-row-resize flex-shrink-0"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = subPaneH;
                  const onMove = (ev: MouseEvent) => setSubPaneH(Math.max(60, Math.min(250, startH - (ev.clientY - startY))));
                  const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
                  window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
                }}
              />
              <div className="flex-shrink-0 relative" style={{ height: subPaneH }}>
                <div ref={subContainerRef} className="absolute inset-0" />
                <div className="absolute top-1 left-2 text-[9px] text-sur-muted font-medium pointer-events-none z-10">
                  {activeIndicators.includes("rsi") && "RSI(14)"}
                  {activeIndicators.includes("rsi") && activeIndicators.includes("macd") && " / "}
                  {activeIndicators.includes("macd") && "MACD(12,26,9)"}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================
//              SAMPLE DATA GENERATOR
// ============================================================

// ============================================================
//     DETERMINISTIC PRICE HISTORY (consistent across TFs)
// ============================================================

// Seeded PRNG (mulberry32) — same seed = same sequence every time
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate a stable seed from market name so BTC and ETH have different but consistent histories
function marketSeed(market: string): number {
  let h = 0;
  for (let i = 0; i < market.length; i++) {
    h = (Math.imul(31, h) + market.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

// Cache: one base tick array per market, generated once
// Versioned cache — bump version to regenerate data after algorithm changes
const CACHE_VERSION = 4;
const baseTickCache: Record<string, { ticks: number[]; volumes: number[]; startTime: number; v: number }> = {};

function getBaseTicks(market: string, targetEndPrice: number) {
  if (baseTickCache[market]?.v === CACHE_VERSION) return baseTickCache[market];

  const rng = mulberry32(marketSeed(market));
  const TOTAL_MINUTES = 60 * 24 * 10; // 10 days of 1-min ticks
  // Anchor to start-of-current-hour so data doesn't shift on every refresh
  const now = Math.floor(Date.now() / 1000);
  const currentHour = Math.floor(now / 3600) * 3600;
  const startTime = currentHour - TOTAL_MINUTES * 60;

  // Start near target with realistic range
  let price = targetEndPrice + (rng() - 0.5) * 400;
  const ticks: number[] = [];
  const volumes: number[] = [];

  for (let i = 0; i < TOTAL_MINUTES; i++) {
    const volatility = 3 + rng() * 10; // per-minute volatility
    const noise = (rng() - 0.5) * volatility;

    // Gentle mean-reversion toward target throughout, stronger near end
    const gap = targetEndPrice - price;
    const progress = i / TOTAL_MINUTES;
    const revertStrength = 0.002 + progress * 0.008; // gradually increases
    const revert = gap * revertStrength;

    price += noise + revert;
    ticks.push(price);
    volumes.push(rng() * 80 + 10);
  }

  // Smooth the last 60 ticks toward target instead of forcing a jump
  const smoothLen = Math.min(60, ticks.length);
  const lastRaw = ticks[ticks.length - smoothLen];
  for (let i = 0; i < smoothLen; i++) {
    const t = (i + 1) / smoothLen; // 0..1
    const idx = ticks.length - smoothLen + i;
    ticks[idx] = ticks[idx] * (1 - t * 0.5) + targetEndPrice * (t * 0.5);
  }
  ticks[ticks.length - 1] = targetEndPrice;

  const result = { ticks, volumes, startTime, v: CACHE_VERSION };
  baseTickCache[market] = result;
  return result;
}

function generateSampleData(market: string, intervalSeconds: number, targetEndPrice: number) {
  const { ticks, volumes, startTime } = getBaseTicks(market, targetEndPrice);
  const ticksPerCandle = Math.max(1, Math.round(intervalSeconds / 60));
  // Use a separate seeded PRNG for intra-candle spread so it's deterministic
  const spreadRng = mulberry32(marketSeed(market) + 7777);

  const candles: any[] = [];
  const volumeData: any[] = [];

  for (let i = 0; i < ticks.length; i += ticksPerCandle) {
    const slice = ticks.slice(i, i + ticksPerCandle);
    const volSlice = volumes.slice(i, i + ticksPerCandle);
    if (slice.length === 0) continue;

    const time = startTime + i * 60;
    let open = slice[0];
    let close = slice[slice.length - 1];
    let high = Math.max(...slice);
    let low = Math.min(...slice);

    // For single-tick candles (1m TF), OHLC are identical (a dot).
    // Add a small realistic spread so candles render with body + wicks.
    const spread = high - low;
    const midPrice = (open + close) / 2;
    // Variable spread per candle: 0.005% to 0.02% of price
    const spreadFactor = 0.00005 + spreadRng() * 0.00015;
    const minSpread = midPrice * spreadFactor;
    if (spread < minSpread) {
      const r1 = spreadRng();
      const r2 = spreadRng();
      // Asymmetric wicks for realism
      high = Math.max(open, close) + minSpread * r1 * 0.6;
      low = Math.min(open, close) - minSpread * r2 * 0.6;
      // Give the candle a body if open === close
      if (open === close) {
        const bodyDir = spreadRng() > 0.5 ? 1 : -1;
        const bodySize = minSpread * (0.15 + spreadRng() * 0.35);
        open = midPrice + bodyDir * bodySize * 0.5;
        close = midPrice - bodyDir * bodySize * 0.5;
      }
    }

    const vol = volSlice.reduce((a, b) => a + b, 0);

    candles.push({ time, open, high, low, close });
    volumeData.push({
      time,
      value: vol,
      color: close >= open ? "#3fb95038" : "#f8514938",
    });
  }

  return { candles, volume: volumeData };
}

// ============================================================
//                   INDICATORS CONFIG
// ============================================================

const INDICATORS = [
  { key: "ma7", label: "MA 7", desc: "Moving Average (7)", color: "#f59e0b", period: 7, type: "ma" },
  { key: "ma30", label: "MA 30", desc: "Moving Average (30)", color: "#0052FF", period: 30, type: "ma" },
  { key: "ma99", label: "MA 99", desc: "Moving Average (99)", color: "#8b5cf6", period: 99, type: "ma" },
  { key: "sma9", label: "SMA 9", desc: "Simple Moving Average (9)", color: "#ec4899", period: 9, type: "sma" },
  { key: "ema12", label: "EMA 12", desc: "Exponential Moving Average (12)", color: "#06b6d4", period: 12, type: "ema" },
  { key: "ema26", label: "EMA 26", desc: "Exponential Moving Average (26)", color: "#14b8a6", period: 26, type: "ema" },
  { key: "sma20", label: "SMA 20", desc: "Simple Moving Average (20)", color: "#f97316", period: 20, type: "sma" },
  { key: "sma50", label: "SMA 50", desc: "Simple Moving Average (50)", color: "#a855f7", period: 50, type: "sma" },
  { key: "bb", label: "Bollinger Bands", desc: "20-period, 2 std dev", color: "#6366f1", period: 20, type: "bb" },
  { key: "vwap", label: "VWAP", desc: "Volume Weighted Avg Price", color: "#22d3ee", period: 0, type: "vwap" },
  { key: "rsi", label: "RSI (14)", desc: "Relative Strength Index — separate pane", color: "#f59e0b", period: 14, type: "sub" },
  { key: "macd", label: "MACD", desc: "12/26/9 — separate pane", color: "#0052FF", period: 0, type: "sub" },
];

// ============================================================
//                 INDICATOR CALCULATIONS
// ============================================================

type TV = { time: any; value: number };

function calcSMA(data: TV[], period: number): TV[] {
  const result: TV[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j].value;
    result.push({ time: data[i].time, value: sum / period });
  }
  return result;
}

function calcEMA(data: TV[], period: number): TV[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: TV[] = [];
  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].value;
  let ema = sum / period;
  result.push({ time: data[period - 1].time, value: ema });
  for (let i = period; i < data.length; i++) {
    ema = data[i].value * k + ema * (1 - k);
    result.push({ time: data[i].time, value: ema });
  }
  return result;
}

function calcBollinger(data: TV[], period: number, mult: number) {
  const mid = calcSMA(data, period);
  const upper: TV[] = [];
  const lower: TV[] = [];
  for (let i = 0; i < mid.length; i++) {
    const dataIdx = i + period - 1;
    let sumSq = 0;
    for (let j = 0; j < period; j++) {
      const diff = data[dataIdx - j].value - mid[i].value;
      sumSq += diff * diff;
    }
    const std = Math.sqrt(sumSq / period);
    upper.push({ time: mid[i].time, value: mid[i].value + mult * std });
    lower.push({ time: mid[i].time, value: mid[i].value - mult * std });
  }
  return { upper, lower, mid };
}

function calcRSI(data: TV[], period: number): TV[] {
  if (data.length < period + 1) return [];
  const result: TV[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  // Seed
  for (let i = 1; i <= period; i++) {
    const delta = data[i].value - data[i - 1].value;
    if (delta > 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push({ time: data[period].time, value: 100 - 100 / (1 + rs0) });

  for (let i = period + 1; i < data.length; i++) {
    const delta = data[i].value - data[i - 1].value;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({ time: data[i].time, value: 100 - 100 / (1 + rs) });
  }
  return result;
}

function calcMACD(data: TV[]) {
  const ema12 = calcEMA(data, 12);
  const ema26 = calcEMA(data, 26);
  // Align: ema12 starts at index 11, ema26 at index 25. MACD = ema12 - ema26 from index 25 onward.
  const offset = 26 - 12; // 14
  const macdLine: TV[] = [];
  for (let i = 0; i < ema26.length; i++) {
    const e12val = ema12[i + offset]?.value;
    if (e12val === undefined) continue;
    macdLine.push({ time: ema26[i].time, value: e12val - ema26[i].value });
  }
  const signalLine = calcEMA(macdLine, 9);
  // Histogram = MACD - signal, aligned
  const sigOffset = macdLine.length - signalLine.length;
  const histogram: TV[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push({
      time: signalLine[i].time,
      value: macdLine[i + sigOffset].value - signalLine[i].value,
    });
  }
  return { macdLine, signalLine, histogram };
}

function calcVWAP(candles: any[]): TV[] {
  let cumPV = 0;
  let cumVol = 0;
  const result: TV[] = [];
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    const vol = Math.abs(c.close - c.open) + 1; // proxy volume from candle body
    cumPV += typical * vol;
    cumVol += vol;
    result.push({ time: c.time, value: cumPV / cumVol });
  }
  return result;
}

// ============================================================
//                   SVG ICONS (14x14)
// ============================================================

function CrosshairIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="7" cy="7" r="4.5" /><line x1="7" y1="0.5" x2="7" y2="3" /><line x1="7" y1="11" x2="7" y2="13.5" />
      <line x1="0.5" y1="7" x2="3" y2="7" /><line x1="11" y1="7" x2="13.5" y2="7" />
    </svg>
  );
}

function TrendLineIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <line x1="2" y1="11" x2="12" y2="3" /><circle cx="2" cy="11" r="1" fill="currentColor" /><circle cx="12" cy="3" r="1" fill="currentColor" />
    </svg>
  );
}

function HorzLineIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <line x1="1" y1="7" x2="13" y2="7" strokeDasharray="2 1.5" />
    </svg>
  );
}

function RayIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <line x1="2" y1="10" x2="13" y2="4" /><circle cx="2" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}

function FibIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeOpacity="0.7">
      <line x1="1" y1="2" x2="13" y2="2" /><line x1="1" y1="5" x2="13" y2="5" /><line x1="1" y1="7" x2="13" y2="7" />
      <line x1="1" y1="9.5" x2="13" y2="9.5" /><line x1="1" y1="12" x2="13" y2="12" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M3 3h8M7 3v9" strokeLinecap="round" />
    </svg>
  );
}

function MeasureIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1.5" y="5" width="11" height="4" rx="0.5" /><line x1="4" y1="6" x2="4" y2="8" />
      <line x1="7" y1="5.5" x2="7" y2="8.5" /><line x1="10" y1="6" x2="10" y2="8" />
    </svg>
  );
}

function BrushIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M9.5 2L12 4.5 5.5 11H3v-2.5L9.5 2z" /><line x1="8" y1="3.5" x2="10.5" y2="6" />
    </svg>
  );
}

function MagnetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4 2v4a3 3 0 006 0V2" /><line x1="4" y1="2" x2="4" y2="4" strokeWidth="2.5" />
      <line x1="10" y1="2" x2="10" y2="4" strokeWidth="2.5" />
    </svg>
  );
}

function ZoomIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="6" cy="6" r="4" /><line x1="9" y1="9" x2="12.5" y2="12.5" />
      <line x1="4" y1="6" x2="8" y2="6" /><line x1="6" y1="4" x2="6" y2="8" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="3" y="6.5" width="8" height="5.5" rx="1" /><path d="M5 6.5V4.5a2 2 0 014 0v2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2.5 4h9M5 4V2.5h4V4M3.5 4l.5 8h6l.5-8" /><line x1="6" y1="6" x2="6" y2="10" />
      <line x1="8" y1="6" x2="8" y2="10" />
    </svg>
  );
}

function CandleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1">
      <line x1="4" y1="1" x2="4" y2="13" /><rect x="2.5" y="4" width="3" height="5" fill="currentColor" rx="0.3" />
      <line x1="10" y1="2" x2="10" y2="12" /><rect x="8.5" y="5" width="3" height="4" rx="0.3" />
    </svg>
  );
}

function LineIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <polyline points="1,10 4,6 7,8 10,3 13,5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AreaIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
      <path d="M1 10 L4 6 L7 8 L10 3 L13 5 L13 12 L1 12Z" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function IndicatorIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <polyline points="1,9 3,5 5,7 8,2 10,6 13,4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="1,11 4,9 7,10 10,8 13,9" strokeLinecap="round" strokeLinejoin="round" opacity="0.4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="7" cy="7" r="2" /><path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.8 2.8l1 1M10.2 10.2l1 1M11.2 2.8l-1 1M3.8 10.2l-1 1" />
    </svg>
  );
}

function FullscreenIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <polyline points="1,5 1,1 5,1" /><polyline points="9,1 13,1 13,5" />
      <polyline points="13,9 13,13 9,13" /><polyline points="5,13 1,13 1,9" />
    </svg>
  );
}
