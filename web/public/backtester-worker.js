/**
 * SUR Protocol — Client-Side Backtester Web Worker
 * =================================================
 * Runs Monte Carlo backtests entirely in the browser.
 * Classic Web Worker (no modules, no imports, vanilla JS).
 *
 * Message protocol:
 *   IN:  { type: "run", config: { market, period, capital, mode, iterations, engines, candles } }
 *   OUT: { type: "progress", progress: Number }
 *   OUT: { type: "complete", results: { summary, engines, leaderboard, dailyPnl, trades } }
 *   OUT: { type: "error", error: String }
 *
 * candles format: [[timestamp, open, high, low, close, volume], ...]
 */

/* ============================================================
   CONSTANTS
   ============================================================ */

var DEFAULT_LEVERAGE = 5;
var FEE_RATE = 0.0006; // 0.06% taker fee per side
var MAX_CONCURRENT = 5;
var MAX_TRADES_PER_DAY = 20;
var CONFIDENCE_THRESHOLD = 60;

/* ============================================================
   INDICATOR HELPERS
   ============================================================ */

/**
 * Exponential Moving Average.
 * @param {number[]} data - Array of numeric values.
 * @param {number} period - Look-back length.
 * @returns {number[]} EMA array (same length as data; early values use SMA seed).
 */
function ema(data, period) {
  var out = new Array(data.length);
  if (data.length === 0) return out;
  var k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  var sum = 0;
  for (var i = 0; i < Math.min(period, data.length); i++) {
    sum += data[i];
    out[i] = sum / (i + 1); // partial SMA until we have enough bars
  }
  // EMA from period onward
  for (var i = period; i < data.length; i++) {
    out[i] = data[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * Simple Moving Average.
 * @param {number[]} data
 * @param {number} period
 * @returns {number[]} SMA array (NaN for indices < period-1).
 */
function sma(data, period) {
  var out = new Array(data.length);
  var sum = 0;
  for (var i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= period) sum -= data[i - period];
    out[i] = i >= period - 1 ? sum / period : NaN;
  }
  return out;
}

/**
 * Average True Range.
 * @param {Array} candles - [[ts, o, h, l, c, v], ...]
 * @param {number} period
 * @returns {number[]} ATR array.
 */
function atr(candles, period) {
  var trs = new Array(candles.length);
  for (var i = 0; i < candles.length; i++) {
    var h = candles[i][2];
    var l = candles[i][3];
    var prevC = i > 0 ? candles[i - 1][4] : candles[i][1];
    trs[i] = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
  }
  // Smoothed ATR (Wilder-style via EMA with period)
  return ema(trs, period);
}

/**
 * Rolling Standard Deviation.
 * @param {number[]} data
 * @param {number} period
 * @returns {number[]} stddev array (NaN for indices < period-1).
 */
function stddev(data, period) {
  var out = new Array(data.length);
  for (var i = 0; i < data.length; i++) {
    if (i < period - 1) { out[i] = NaN; continue; }
    var sum = 0;
    for (var j = i - period + 1; j <= i; j++) sum += data[j];
    var mean = sum / period;
    var sq = 0;
    for (var j = i - period + 1; j <= i; j++) sq += (data[j] - mean) * (data[j] - mean);
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

/**
 * Average Volume over look-back.
 * @param {Array} candles
 * @param {number} period
 * @returns {number[]}
 */
function avgVolume(candles, period) {
  var vols = candles.map(function (c) { return c[5]; });
  return sma(vols, period);
}

/* ============================================================
   TRADING ENGINES
   ============================================================ */

/**
 * Each engine function receives:
 *   (candles, index, indicators, params)
 * and returns null or { side, sl, tp, confidence }.
 *
 * `indicators` is a pre-computed object so engines share work.
 * `params` holds tunable numbers (varied during Monte Carlo).
 */

var ENGINE_DEFS = [
  {
    name: "Swing Rider",
    key: "swingRider",
    run: function (candles, i, ind, p) {
      if (i < 21) return null;
      var fastPrev = ind.ema9[i - 1];
      var fastCur = ind.ema9[i];
      var slowPrev = ind.ema21[i - 1];
      var slowCur = ind.ema21[i];
      var curATR = ind.atr14[i];
      if (!curATR || curATR === 0) return null;
      var close = candles[i][4];

      // Bullish crossover
      if (fastPrev <= slowPrev && fastCur > slowCur) {
        var sl = close - p.slMult * 1.5 * curATR;
        var risk = close - sl;
        return { side: "long", sl: sl, tp: close + p.tpRatio * 2.5 * risk, confidence: 70 };
      }
      // Bearish crossover
      if (fastPrev >= slowPrev && fastCur < slowCur) {
        var sl = close + p.slMult * 1.5 * curATR;
        var risk = sl - close;
        return { side: "short", sl: sl, tp: close - p.tpRatio * 2.5 * risk, confidence: 70 };
      }
      return null;
    }
  },
  {
    name: "Trend Rider",
    key: "trendRider",
    run: function (candles, i, ind, p) {
      if (i < 55) return null;
      var curATR = ind.atr14[i];
      if (!curATR || curATR === 0) return null;
      var close = candles[i][4];

      // EMA 50 slope over 5 bars
      var slope = (ind.ema50[i] - ind.ema50[i - 5]) / (5 * curATR);
      // ADX-like momentum: magnitude of directional movement
      var momentum = Math.abs(slope);
      if (momentum < 0.15) return null; // not trending enough

      var conf = Math.min(85, 55 + momentum * 100);
      if (slope > 0) {
        var sl = close - p.slMult * 2 * curATR;
        var risk = close - sl;
        return { side: "long", sl: sl, tp: close + p.tpRatio * 2 * risk, confidence: conf };
      } else {
        var sl = close + p.slMult * 2 * curATR;
        var risk = sl - close;
        return { side: "short", sl: sl, tp: close - p.tpRatio * 2 * risk, confidence: conf };
      }
    }
  },
  {
    name: "Mean Reversion",
    key: "meanReversion",
    run: function (candles, i, ind, p) {
      if (i < 20) return null;
      var curATR = ind.atr14[i];
      var sd = ind.stddev20[i];
      var mean = ind.sma20[i];
      if (!curATR || !sd || isNaN(sd) || isNaN(mean)) return null;
      var close = candles[i][4];

      var zScore = (close - mean) / sd;
      if (Math.abs(zScore) < 1.5) return null;

      var conf = Math.min(85, 60 + Math.abs(zScore) * 8);
      if (zScore > 2) {
        // Price far above mean → short (revert down)
        var sl = close + p.slMult * 1 * curATR;
        return { side: "short", sl: sl, tp: mean, confidence: conf };
      } else {
        // Price far below mean → long (revert up)
        var sl = close - p.slMult * 1 * curATR;
        return { side: "long", sl: sl, tp: mean, confidence: conf };
      }
    }
  },
  {
    name: "Breakout Hunter",
    key: "breakoutHunter",
    run: function (candles, i, ind, p) {
      if (i < 25) return null;
      var curATR = ind.atr14[i];
      if (!curATR || curATR === 0) return null;
      var close = candles[i][4];

      // Detect consolidation: current ATR < 85% of 20-bar ATR average
      var atrAvg = 0;
      for (var j = i - 19; j <= i; j++) atrAvg += (ind.atr14[j] || 0);
      atrAvg /= 20;
      if (curATR > atrAvg * 0.85) return null; // not consolidated enough

      // Range highs/lows over last 20 bars
      var rangeHigh = -Infinity, rangeLow = Infinity;
      for (var j = i - 19; j <= i; j++) {
        if (candles[j][2] > rangeHigh) rangeHigh = candles[j][2];
        if (candles[j][3] < rangeLow) rangeLow = candles[j][3];
      }

      // Breakout detection
      if (close > rangeHigh) {
        var sl = rangeLow;
        var risk = close - sl;
        if (risk <= 0) return null;
        return { side: "long", sl: sl, tp: close + p.tpRatio * 3 * risk, confidence: 72 };
      }
      if (close < rangeLow) {
        var sl = rangeHigh;
        var risk = sl - close;
        if (risk <= 0) return null;
        return { side: "short", sl: sl, tp: close - p.tpRatio * 3 * risk, confidence: 72 };
      }
      return null;
    }
  },
  {
    name: "Scalper",
    key: "scalper",
    run: function (candles, i, ind, p) {
      if (i < 14) return null;
      var curATR = ind.atr14[i];
      if (!curATR || curATR === 0) return null;
      var close = candles[i][4];
      var fastPrev = ind.ema5[i - 1];
      var fastCur = ind.ema5[i];
      var slowPrev = ind.ema13[i - 1];
      var slowCur = ind.ema13[i];

      if (fastPrev <= slowPrev && fastCur > slowCur) {
        var sl = close - p.slMult * 0.5 * curATR;
        var risk = close - sl;
        return { side: "long", sl: sl, tp: close + p.tpRatio * 1 * risk, confidence: 68 };
      }
      if (fastPrev >= slowPrev && fastCur < slowCur) {
        var sl = close + p.slMult * 0.5 * curATR;
        var risk = sl - close;
        return { side: "short", sl: sl, tp: close - p.tpRatio * 1 * risk, confidence: 68 };
      }
      return null;
    }
  },
  {
    name: "Momentum Burst",
    key: "momentumBurst",
    run: function (candles, i, ind, p) {
      if (i < 21) return null;
      var curATR = ind.atr14[i];
      var volAvg = ind.avgVol20[i];
      if (!curATR || !volAvg || isNaN(volAvg) || volAvg === 0) return null;
      var vol = candles[i][5];
      var close = candles[i][4];
      var open = candles[i][1];

      // Volume spike > 1.5x average
      if (vol < volAvg * 1.5) return null;

      // Strong price movement (body > 0.3x ATR)
      var body = Math.abs(close - open);
      if (body < curATR * 0.3) return null;

      var conf = Math.min(85, 65 + (vol / volAvg - 2) * 10);
      if (close > open) {
        var sl = close - p.slMult * 1.5 * curATR;
        var risk = close - sl;
        return { side: "long", sl: sl, tp: close + p.tpRatio * 2 * risk, confidence: conf };
      } else {
        var sl = close + p.slMult * 1.5 * curATR;
        var risk = sl - close;
        return { side: "short", sl: sl, tp: close - p.tpRatio * 2 * risk, confidence: conf };
      }
    }
  },
  {
    name: "Range Trader",
    key: "rangeTrader",
    run: function (candles, i, ind, p) {
      if (i < 30) return null;
      var curATR = ind.atr14[i];
      if (!curATR || curATR === 0) return null;
      var close = candles[i][4];

      // Identify support/resistance from last 30 bars highs/lows
      var highs = [], lows = [];
      for (var j = i - 29; j <= i; j++) {
        highs.push(candles[j][2]);
        lows.push(candles[j][3]);
      }
      highs.sort(function (a, b) { return b - a; });
      lows.sort(function (a, b) { return a - b; });

      // Resistance = average of top-5 highs, Support = average of bottom-5 lows
      var resistance = 0, support = 0;
      for (var j = 0; j < 5; j++) {
        resistance += highs[j];
        support += lows[j];
      }
      resistance /= 5;
      support /= 5;

      var range = resistance - support;
      if (range <= 0) return null;

      // Near support → long
      if (close < support + range * 0.1) {
        var sl = support - p.slMult * 0.5 * curATR;
        return { side: "long", sl: sl, tp: resistance, confidence: 70 };
      }
      // Near resistance → short
      if (close > resistance - range * 0.1) {
        var sl = resistance + p.slMult * 0.5 * curATR;
        return { side: "short", sl: sl, tp: support, confidence: 70 };
      }
      return null;
    }
  }
];

/* ============================================================
   PRE-COMPUTE INDICATORS
   ============================================================ */

function computeIndicators(candles, params) {
  var closes = candles.map(function (c) { return c[4]; });
  var ema9Period = Math.round(9 * (params.emaPeriodMult || 1));
  var ema21Period = Math.round(21 * (params.emaPeriodMult || 1));
  var ema50Period = Math.round(50 * (params.emaPeriodMult || 1));
  var ema5Period = Math.round(5 * (params.emaPeriodMult || 1));
  var ema13Period = Math.round(13 * (params.emaPeriodMult || 1));

  return {
    ema5: ema(closes, Math.max(2, ema5Period)),
    ema9: ema(closes, Math.max(2, ema9Period)),
    ema13: ema(closes, Math.max(2, ema13Period)),
    ema21: ema(closes, Math.max(2, ema21Period)),
    ema50: ema(closes, Math.max(2, ema50Period)),
    sma20: sma(closes, 20),
    stddev20: stddev(closes, 20),
    atr14: atr(candles, 14),
    avgVol20: avgVolume(candles, 20)
  };
}

/* ============================================================
   SIMULATION
   ============================================================ */

/**
 * Run one full simulation pass.
 * @param {Array} candles
 * @param {string[]} enabledEngines - engine keys to enable
 * @param {number} capital - starting capital (USD)
 * @param {object} params - tunable params { slMult, tpRatio, emaPeriodMult, confThreshold }
 * @param {function} onProgress - called with (currentBar, totalBars)
 * @returns {object} simulation results
 */
function simulate(candles, enabledEngines, capital, params, onProgress) {
  var indicators = computeIndicators(candles, params);

  // Filter engines — match by key OR by name (frontend sends names)
  var engines = ENGINE_DEFS.filter(function (e) {
    return enabledEngines.indexOf(e.key) !== -1 || enabledEngines.indexOf(e.name) !== -1;
  });
  if (engines.length === 0) engines = ENGINE_DEFS; // fallback: all

  var confThreshold = params.confThreshold || CONFIDENCE_THRESHOLD;

  // State
  var balance = capital;
  var positions = []; // open positions
  var allTrades = []; // closed trades
  var dailyMap = {};  // "YYYY-MM-DD" → { pnl, trades }
  var engineStats = {};
  var tradeId = 0;
  var liquidated = false; // account blown flag

  // Margin per position — use fraction of capital, not full capital
  var maxPositions = MAX_CONCURRENT;
  var marginPerPos = capital * 0.1; // 10% of capital per position (max 50% deployed)

  // Init engine stats
  engines.forEach(function (e) {
    engineStats[e.key] = { name: e.name, wins: 0, losses: 0, totalPnl: 0, totalWin: 0, totalLoss: 0, holdBars: 0, count: 0 };
  });

  // Daily trade counter
  var currentDay = "";
  var dailyTradeCount = 0;

  for (var i = 0; i < candles.length; i++) {
    if (liquidated) break;

    var candle = candles[i];
    var ts = candle[0];
    var high = candle[2];
    var low = candle[3];
    var close = candle[4];

    // Track day for trade-per-day limit
    var day = new Date(ts).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      dailyTradeCount = 0;
    }

    // --- Check account liquidation: if total equity < 5% of capital, stop ---
    var unrealizedPnl = 0;
    for (var up = 0; up < positions.length; up++) {
      var uPos = positions[up];
      var uSize = uPos.margin * DEFAULT_LEVERAGE;
      var uDiff = uPos.side === "long" ? (close - uPos.entryPrice) : (uPos.entryPrice - close);
      unrealizedPnl += (uDiff / uPos.entryPrice) * uSize;
    }
    var totalEquity = balance + unrealizedPnl;
    if (totalEquity < capital * 0.05) {
      // Account blown — force close everything at current price
      liquidated = true;
      for (var lp = 0; lp < positions.length; lp++) {
        var lPos = positions[lp];
        var lSize = lPos.margin * DEFAULT_LEVERAGE;
        var lDiff = lPos.side === "long" ? (close - lPos.entryPrice) : (lPos.entryPrice - close);
        var lPnl = (lDiff / lPos.entryPrice) * lSize - lPos.entryFee - lSize * FEE_RATE;
        balance += lPos.margin + lPnl;
        allTrades.push({
          id: lPos.id, engine: lPos.engine, side: lPos.side,
          entryPrice: lPos.entryPrice, exitPrice: close,
          pnl: lPnl, fees: lPos.entryFee + lSize * FEE_RATE,
          durationMin: (ts - lPos.entryTs) / 60000, exitReason: "liquidation"
        });
        var lEs = engineStats[lPos.engineKey];
        if (lEs) { lEs.count++; lEs.totalPnl += lPnl; if (lPnl > 0) { lEs.wins++; lEs.totalWin += lPnl; } else { lEs.losses++; lEs.totalLoss += Math.abs(lPnl); } }
      }
      positions = [];
      if (!dailyMap[day]) dailyMap[day] = { pnl: 0, trades: 0 };
      break;
    }

    // --- 1. Check open positions for SL/TP ---
    var remaining = [];
    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var exitPrice = null;
      var exitReason = null;

      if (pos.side === "long") {
        if (low <= pos.sl) { exitPrice = pos.sl; exitReason = "sl"; }
        else if (high >= pos.tp) { exitPrice = pos.tp; exitReason = "tp"; }
      } else {
        if (high >= pos.sl) { exitPrice = pos.sl; exitReason = "sl"; }
        else if (low <= pos.tp) { exitPrice = pos.tp; exitReason = "tp"; }
      }

      if (exitPrice !== null) {
        // Close position
        var sizeUsd = pos.margin * DEFAULT_LEVERAGE;
        var priceDiff = pos.side === "long" ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice);
        var rawPnl = (priceDiff / pos.entryPrice) * sizeUsd;
        var exitFee = sizeUsd * FEE_RATE;
        var netPnl = rawPnl - pos.entryFee - exitFee;

        balance += pos.margin + netPnl;

        var trade = {
          id: pos.id,
          engine: pos.engine,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice: exitPrice,
          pnl: netPnl,
          fees: pos.entryFee + exitFee,
          durationMin: (ts - pos.entryTs) / 60000,
          exitReason: exitReason
        };
        allTrades.push(trade);

        // Update engine stats
        var es = engineStats[pos.engineKey];
        if (es) {
          es.count++;
          es.totalPnl += netPnl;
          es.holdBars += (i - pos.entryBar);
          if (netPnl > 0) { es.wins++; es.totalWin += netPnl; }
          else { es.losses++; es.totalLoss += Math.abs(netPnl); }
        }

        // Daily PnL
        if (!dailyMap[day]) dailyMap[day] = { pnl: 0, trades: 0 };
        dailyMap[day].pnl += netPnl;
        dailyMap[day].trades++;
      } else {
        remaining.push(pos);
      }
    }
    positions = remaining;

    // --- 2. Run engines for signals ---
    if (positions.length < maxPositions && dailyTradeCount < MAX_TRADES_PER_DAY && balance > marginPerPos * 0.5) {
      for (var e = 0; e < engines.length; e++) {
        if (positions.length >= maxPositions) break;
        if (dailyTradeCount >= MAX_TRADES_PER_DAY) break;

        var signal = engines[e].run(candles, i, indicators, params);
        if (!signal) continue;
        if (signal.confidence < confThreshold) continue;

        // Validate SL/TP
        if (signal.side === "long") {
          if (signal.sl >= close || signal.tp <= close) continue;
        } else {
          if (signal.sl <= close || signal.tp >= close) continue;
        }

        // Don't open duplicate engine+side
        var dup = false;
        for (var pp = 0; pp < positions.length; pp++) {
          if (positions[pp].engineKey === engines[e].key && positions[pp].side === signal.side) { dup = true; break; }
        }
        if (dup) continue;

        // Open position — margin capped at marginPerPos or 20% of current balance
        var margin = Math.min(marginPerPos, balance * 0.2);
        if (margin < 1) continue;
        var sizeUsd = margin * DEFAULT_LEVERAGE;
        var entryFee = sizeUsd * FEE_RATE;

        balance -= margin;

        positions.push({
          id: ++tradeId,
          engine: engines[e].name,
          engineKey: engines[e].key,
          side: signal.side,
          entryPrice: close,
          entryTs: ts,
          entryBar: i,
          sl: signal.sl,
          tp: signal.tp,
          margin: margin,
          entryFee: entryFee
        });
        dailyTradeCount++;
      }
    }

    // --- 3. Progress reporting ---
    if (onProgress && (i % 1000 === 0 || (candles.length > 20 && i % Math.floor(candles.length / 20) === 0))) {
      onProgress(i, candles.length);
    }
  }

  // Force-close any remaining open positions at last close
  if (candles.length > 0) {
    var lastCandle = candles[candles.length - 1];
    var lastClose = lastCandle[4];
    var lastTs = lastCandle[0];
    var lastDay = new Date(lastTs).toISOString().slice(0, 10);

    for (var p = 0; p < positions.length; p++) {
      var pos = positions[p];
      var sizeUsd = pos.margin * DEFAULT_LEVERAGE;
      var priceDiff = pos.side === "long" ? (lastClose - pos.entryPrice) : (pos.entryPrice - lastClose);
      var rawPnl = (priceDiff / pos.entryPrice) * sizeUsd;
      var exitFee = sizeUsd * FEE_RATE;
      var netPnl = rawPnl - pos.entryFee - exitFee;
      balance += pos.margin + netPnl;

      allTrades.push({
        id: pos.id,
        engine: pos.engine,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: lastClose,
        pnl: netPnl,
        fees: pos.entryFee + exitFee,
        durationMin: (lastTs - pos.entryTs) / 60000,
        exitReason: "eod"
      });

      var es = engineStats[pos.engineKey];
      if (es) {
        es.count++;
        es.totalPnl += netPnl;
        es.holdBars += (candles.length - 1 - pos.entryBar);
        if (netPnl > 0) { es.wins++; es.totalWin += netPnl; }
        else { es.losses++; es.totalLoss += Math.abs(netPnl); }
      }

      if (!dailyMap[lastDay]) dailyMap[lastDay] = { pnl: 0, trades: 0 };
      dailyMap[lastDay].pnl += netPnl;
      dailyMap[lastDay].trades++;
    }
  }

  // --- Build results ---
  var totalTrades = allTrades.length;
  var wins = allTrades.filter(function (t) { return t.pnl > 0; }).length;
  var losses = totalTrades - wins;
  var grossWin = 0, grossLoss = 0;
  var netPnlTotal = 0;

  allTrades.forEach(function (t) {
    netPnlTotal += t.pnl;
    if (t.pnl > 0) grossWin += t.pnl;
    else grossLoss += Math.abs(t.pnl);
  });

  // Max drawdown — calculated relative to peak equity, capped at 100%
  var peak = capital;
  var equity = capital;
  var maxDd = 0;
  var maxDdPct = 0;

  allTrades.forEach(function (t) {
    equity += t.pnl;
    if (equity < 0) equity = 0; // can't go below zero
    if (equity > peak) peak = equity;
    var dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    var ddPct = peak > 0 ? Math.min(1, dd / peak) : 0; // cap at 100%
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  });

  // Sharpe ratio (annualized, daily returns)
  var dailyKeys = Object.keys(dailyMap).sort();
  var dailyReturns = dailyKeys.map(function (k) { return dailyMap[k].pnl / capital; });
  var sharpe = calcSharpe(dailyReturns);

  // Daily PnL array
  var cumPnl = 0;
  var dailyPnl = dailyKeys.map(function (k) {
    cumPnl += dailyMap[k].pnl;
    return { date: k, pnl: round2(dailyMap[k].pnl), trades: dailyMap[k].trades, cumPnl: round2(cumPnl) };
  });

  // Engine breakdown
  var engineResults = engines.map(function (e) {
    var s = engineStats[e.key];
    return {
      name: s.name,
      trades: s.count,
      winRate: s.count > 0 ? round2(s.wins / s.count * 100) : 0,
      profitFactor: s.totalLoss > 0 ? round2(s.totalWin / s.totalLoss) : s.totalWin > 0 ? Infinity : 0,
      netPnl: round2(s.totalPnl),
      avgWin: s.wins > 0 ? round2(s.totalWin / s.wins) : 0,
      avgLoss: s.losses > 0 ? round2(s.totalLoss / s.losses) : 0,
      avgHoldMin: s.count > 0 ? round2(s.holdBars * (candles.length > 1 ? (candles[1][0] - candles[0][0]) / 60000 : 1) / s.count) : 0
    };
  });

  return {
    summary: {
      netPnl: round2(netPnlTotal),
      returnPct: round2(netPnlTotal / capital * 100),
      winRate: totalTrades > 0 ? round2(wins / totalTrades * 100) : 0,
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : grossWin > 0 ? Infinity : 0,
      sharpe: round2(sharpe),
      maxDrawdown: round2(maxDd),
      maxDrawdownPct: round2(maxDdPct * 100),
      totalTrades: totalTrades
    },
    engines: engineResults,
    dailyPnl: dailyPnl,
    trades: allTrades.slice(-50).map(function (t) {
      return {
        id: t.id,
        engine: t.engine,
        side: t.side,
        entryPrice: round2(t.entryPrice),
        exitPrice: round2(t.exitPrice),
        pnl: round2(t.pnl),
        fees: round2(t.fees),
        durationMin: round2(t.durationMin),
        exitReason: t.exitReason
      };
    })
  };
}

/* ============================================================
   HELPER: SHARPE RATIO
   ============================================================ */

function calcSharpe(dailyReturns) {
  if (dailyReturns.length < 2) return 0;
  var sum = 0;
  for (var i = 0; i < dailyReturns.length; i++) sum += dailyReturns[i];
  var mean = sum / dailyReturns.length;
  var sq = 0;
  for (var i = 0; i < dailyReturns.length; i++) sq += (dailyReturns[i] - mean) * (dailyReturns[i] - mean);
  var stdDev = Math.sqrt(sq / (dailyReturns.length - 1));
  if (stdDev === 0) return 0;
  return (mean / stdDev) * Math.sqrt(365); // annualized
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ============================================================
   SIMPLE HASH FOR CONFIG IDENTIFICATION
   ============================================================ */

function hashConfig(params) {
  var str = [params.slMult, params.tpRatio, params.emaPeriodMult, params.confThreshold].join("|");
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

/* ============================================================
   MONTE CARLO / RANDOM SEARCH
   ============================================================ */

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/* runMonteCarlo is handled inline in the message handler below */

/* ============================================================
   MESSAGE HANDLER
   ============================================================ */

self.onmessage = function (event) {
  try {
    var msg = event.data;
    if (msg.type !== "run") return;

    var config = msg.config;
    var candles = config.candles;
    var capital = config.capital || 10000;
    var mode = config.mode || "single";
    var iterations = config.iterations || 100;
    var enabledEngines = config.engines || ENGINE_DEFS.map(function (e) { return e.key; });

    if (!candles || candles.length < 50) {
      self.postMessage({ type: "error", error: "Not enough candle data. Minimum 50 candles required, got " + (candles ? candles.length : 0) });
      return;
    }

    if (mode === "single") {
      // Single run with default params
      var params = {
        slMult: 1.0,
        tpRatio: 1.0,
        emaPeriodMult: 1.0,
        confThreshold: CONFIDENCE_THRESHOLD
      };

      var result = simulate(candles, enabledEngines, capital, params, function (current, total) {
        self.postMessage({ type: "progress", progress: Math.round(current / total * 100) });
      });

      self.postMessage({ type: "progress", progress: 100 });
      self.postMessage({
        type: "complete",
        results: {
          summary: result.summary,
          engines: result.engines,
          leaderboard: [],
          dailyPnl: result.dailyPnl,
          trades: result.trades
        }
      });

    } else {
      // Monte Carlo / Random Search — run N iterations with randomized params,
      // track the best parameter set by adjusted score, then re-simulate for full detail.
      // Score = Sharpe × sqrt(trades/10) — penalizes runs with too few trades.
      var fullLeaderboard = [];
      var bestScore = -Infinity;
      var bestParamsFound = null;
      var MIN_TRADES_FOR_RANK = 5; // ignore runs with fewer trades

      for (var iter = 0; iter < iterations; iter++) {
        var params = {
          slMult: randomBetween(0.5, 2.5),
          tpRatio: randomBetween(1.0, 3.5),
          emaPeriodMult: randomBetween(0.8, 1.2),
          confThreshold: Math.round(randomBetween(50, 75))
        };

        var result = simulate(candles, enabledEngines, capital, params, null);

        // Adjusted score: Sharpe weighted by trade count to avoid low-N flukes
        var tradeCount = result.summary.totalTrades;
        var adjustedScore = tradeCount >= MIN_TRADES_FOR_RANK
          ? result.summary.sharpe * Math.min(1, Math.sqrt(tradeCount / 20))
          : -999;

        if (adjustedScore > bestScore) {
          bestScore = adjustedScore;
          bestParamsFound = params;
        }

        fullLeaderboard.push({
          configHash: hashConfig(params),
          params: params,
          netPnl: result.summary.netPnl,
          sharpe: result.summary.sharpe,
          maxDd: result.summary.maxDrawdown,
          winRate: result.summary.winRate,
          profitFactor: result.summary.profitFactor,
          totalTrades: tradeCount,
          adjustedScore: adjustedScore
        });

        var progress = Math.round((iter + 1) / iterations * 100);
        if ((iter + 1) % Math.max(1, Math.floor(iterations / 20)) === 0 || iter === iterations - 1) {
          self.postMessage({ type: "progress", progress: progress });
        }
      }

      // Filter out runs with too few trades, sort by adjusted score, take top 10
      var ranked = fullLeaderboard.filter(function (e) { return e.totalTrades >= MIN_TRADES_FOR_RANK; });
      ranked.sort(function (a, b) { return b.adjustedScore - a.adjustedScore; });
      var top10 = ranked.slice(0, 10).map(function (entry, idx) {
        return {
          rank: idx + 1,
          configHash: entry.configHash,
          netPnl: round2(entry.netPnl),
          sharpe: round2(entry.sharpe),
          maxDd: round2(entry.maxDd),
          winRate: round2(entry.winRate),
          profitFactor: round2(entry.profitFactor)
        };
      });

      // Final detailed run with best params found (or defaults if none)
      var finalParams = bestParamsFound || { slMult: 1.0, tpRatio: 1.0, emaPeriodMult: 1.0, confThreshold: CONFIDENCE_THRESHOLD };
      var bestResult = simulate(candles, enabledEngines, capital, finalParams, null);

      self.postMessage({
        type: "complete",
        results: {
          summary: bestResult.summary,
          engines: bestResult.engines,
          leaderboard: top10,
          dailyPnl: bestResult.dailyPnl,
          trades: bestResult.trades
        }
      });
    }

  } catch (err) {
    self.postMessage({ type: "error", error: err.message || String(err) });
  }
};
