// ============================================================
// backtester/sim-executor.ts — SUR Protocol Simulated Position Manager
// TP-First Exit System
//
// Fee structure: 0.06% taker per side (SUR Protocol on-chain fees)
// ============================================================

export type Side = 'LONG' | 'SHORT';

export interface SimPosition {
  id: string;
  engine: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  stopLoss: number;
  takeProfit: number;
  trailingActivated: boolean;
  trailingHighWater: number;
  trailingActivationPct: number;   // kept for compatibility, not used in v7 TP-first
  trailingCallbackPct: number;     // kept for compatibility, not used in v7 TP-first
  openTime: number;
  tags: string[];
  confidence: number;
  // v7.0 structural fields
  initialStopLoss: number;   // original SL price (for 1:1 R:R calculation)
  breakevenSet: boolean;     // whether SL has been moved to breakeven
  partialClosed: boolean;    // infrastructure (not used in v7 TP-first)
}

export interface SimTrade {
  id: string;
  engine: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  pnl: number;
  fees: number;
  netPnl: number;
  openTime: number;
  closeTime: number;
  closeReason: string;
  holdTimeMin: number;
  tags: string[];
}

export interface EngineSignal {
  engine: string;
  side: Side;
  price: number;
  leverage: number;
  margin: number;
  sl: number;
  tp: number;
  trailingActivationPct: number;
  trailingCallbackPct: number;
  tags: string[];
  confidence: number;
}

const TAKER_FEE = 0.0006; // 0.06% per side — SUR Protocol on-chain fee

// ── v7.0 TP-First configuration ──
// These can be overridden via environment variables for grid search
const TP_FIRST_CONFIG = {
  // Time exit: close if trade hasn't hit TP or SL after this many ms
  MAX_HOLD_MS: Number(process.env.MAX_HOLD_MS ?? 4 * 60 * 60_000),  // default 4h

  // Ratchet trailing callback percentages (tighter as profit grows)
  // Only active AFTER breakeven is set
  RATCHET_WIDE: Number(process.env.RATCHET_WIDE ?? 0.008),       // PnL < 0.5%
  RATCHET_MEDIUM: Number(process.env.RATCHET_MEDIUM ?? 0.006),   // PnL 0.5-1.0%
  RATCHET_TIGHT: Number(process.env.RATCHET_TIGHT ?? 0.004),     // PnL 1.0-1.5%
  RATCHET_ULTRA: Number(process.env.RATCHET_ULTRA ?? 0.003),     // PnL > 1.5%

  // Minimum hold before ratchet trailing can close (avoid noise)
  MIN_HOLD_FOR_TRAILING_MS: Number(process.env.MIN_HOLD_TRAILING ?? 120_000), // 2 min

  // Breakeven buffer (covers fees so breakeven isn't a tiny loss)
  BREAKEVEN_BUFFER_PCT: 0.0003,  // 0.03% above/below entry
};

export class SimExecutor {
  private capital: number;
  private openPositions: SimPosition[] = [];
  private closedTrades: SimTrade[] = [];
  private tradeCounter = 0;
  private peakCapital: number;
  private equityCurve: { time: number; equity: number }[] = [];
  private pendingPartialTrades: SimTrade[] = [];

  constructor(startingCapital: number) {
    this.capital = startingCapital;
    this.peakCapital = startingCapital;
  }

  open(params: {
    engine: string; side: Side; price: number; leverage: number;
    margin: number; sl: number; tp: number;
    trailingActivationPct: number; trailingCallbackPct: number;
    openTime: number; tags: string[]; confidence: number;
  }): SimPosition | null {
    if (params.margin > this.capital * 0.5) return null;
    if (this.capital < 50) return null;

    const notional = params.margin * params.leverage;
    const quantity = notional / params.price;

    const pos: SimPosition = {
      id: `BT-${++this.tradeCounter}`,
      engine: params.engine,
      side: params.side,
      entryPrice: params.price,
      quantity,
      leverage: params.leverage,
      margin: params.margin,
      stopLoss: params.sl,
      takeProfit: params.tp,
      trailingActivated: false,
      trailingHighWater: params.price,
      trailingActivationPct: params.trailingActivationPct,
      trailingCallbackPct: params.trailingCallbackPct,
      openTime: params.openTime,
      tags: params.tags,
      confidence: params.confidence,
      initialStopLoss: params.sl,
      breakevenSet: false,
      partialClosed: false,
    };

    this.openPositions.push(pos);
    return pos;
  }

  close(pos: SimPosition, price: number, reason: string, time: number): SimTrade {
    const entryNotional = pos.quantity * pos.entryPrice;
    const exitNotional = pos.quantity * price;
    const totalFees = (entryNotional + exitNotional) * TAKER_FEE;

    const rawPnl = pos.side === 'LONG'
      ? (price - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - price) * pos.quantity;

    const netPnl = rawPnl - totalFees;
    this.capital += netPnl;
    if (this.capital > this.peakCapital) this.peakCapital = this.capital;

    this.openPositions = this.openPositions.filter(p => p.id !== pos.id);
    this.equityCurve.push({ time, equity: this.capital });

    const trade: SimTrade = {
      id: pos.id, engine: pos.engine, side: pos.side,
      entryPrice: pos.entryPrice, exitPrice: price,
      quantity: pos.quantity, leverage: pos.leverage, margin: pos.margin,
      pnl: rawPnl, fees: totalFees, netPnl,
      openTime: pos.openTime, closeTime: time,
      closeReason: reason,
      holdTimeMin: Math.round((time - pos.openTime) / 60_000),
      tags: pos.tags,
    };

    this.closedTrades.push(trade);
    return trade;
  }

  /** drain partial trades for CB/AG tracking in run.ts */
  drainPartialTrades(): SimTrade[] {
    const out = this.pendingPartialTrades.slice();
    this.pendingPartialTrades = [];
    return out;
  }

  // ════════════════════════════════════════════════════════════
  // v7.0 TP-FIRST EXIT SYSTEM
  // 
  // Exit priority:
  //   1. SL (hard stop loss — always active)
  //   2. TP (take profit — PRIMARY profit mechanism)
  //   3. Breakeven SL move at 1:1 R:R
  //   4. Ratchet trailing ONLY after breakeven (protection, not profit)
  //   5. Time exit (force close if nothing happened)
  //   6. Liquidation (emergency)
  // ════════════════════════════════════════════════════════════

  updatePositions(currentPrice: number, currentTime: number): { pos: SimPosition; reason: string }[] {
    const toClose: { pos: SimPosition; reason: string }[] = [];
    const cfg = TP_FIRST_CONFIG;

    for (const pos of this.openPositions) {
      const holdTimeMs = currentTime - pos.openTime;

      // ── 1. HARD SL (always active, non-negotiable) ──
      if (pos.side === 'LONG' && currentPrice <= pos.stopLoss) {
        toClose.push({ pos, reason: 'SL' }); continue;
      }
      if (pos.side === 'SHORT' && currentPrice >= pos.stopLoss) {
        toClose.push({ pos, reason: 'SL' }); continue;
      }

      // ── 2. TP — PRIMARY exit mechanism ──
      if (pos.takeProfit > 0) {
        if (pos.side === 'LONG' && currentPrice >= pos.takeProfit) {
          toClose.push({ pos, reason: 'TP' }); continue;
        }
        if (pos.side === 'SHORT' && currentPrice <= pos.takeProfit) {
          toClose.push({ pos, reason: 'TP' }); continue;
        }
      }

      // ── 3. BREAKEVEN SL — move SL to entry when trade reaches 1:1 R:R ──
      if (!pos.breakevenSet) {
        const initialRisk = Math.abs(pos.entryPrice - pos.initialStopLoss);
        const currentProfit = pos.side === 'LONG'
          ? currentPrice - pos.entryPrice
          : pos.entryPrice - currentPrice;

        if (currentProfit >= initialRisk) {
          // Trade reached 1:1 R:R → protect the position
          const feeBuf = pos.entryPrice * cfg.BREAKEVEN_BUFFER_PCT;
          pos.stopLoss = pos.side === 'LONG'
            ? pos.entryPrice + feeBuf
            : pos.entryPrice - feeBuf;
          pos.breakevenSet = true;
          // Initialize high water mark from current price
          pos.trailingHighWater = currentPrice;
        }
      }

      // ── 4. RATCHET TRAILING — only AFTER breakeven (protection, not profit) ──
      if (pos.breakevenSet) {
        // Update high water mark
        if (pos.side === 'LONG' && currentPrice > pos.trailingHighWater) {
          pos.trailingHighWater = currentPrice;
        }
        if (pos.side === 'SHORT' && currentPrice < pos.trailingHighWater) {
          pos.trailingHighWater = currentPrice;
        }

        // Calculate profit % to determine ratchet tightness
        const pricePnlPct = pos.side === 'LONG'
          ? (currentPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - currentPrice) / pos.entryPrice;

        // Ratchet: callback tightens as profit grows
        let callbackPct: number;
        if (pricePnlPct > 0.015)      callbackPct = cfg.RATCHET_ULTRA;   // > 1.5%: ultra tight
        else if (pricePnlPct > 0.010)  callbackPct = cfg.RATCHET_TIGHT;   // > 1.0%: tight
        else if (pricePnlPct > 0.005)  callbackPct = cfg.RATCHET_MEDIUM;  // > 0.5%: medium
        else                            callbackPct = cfg.RATCHET_WIDE;    // < 0.5%: wide (near breakeven)

        if (pos.side === 'LONG') {
          const trailPrice = pos.trailingHighWater * (1 - callbackPct);
          // Only trail-close after minimum hold time
          if (holdTimeMs >= cfg.MIN_HOLD_FOR_TRAILING_MS && currentPrice <= trailPrice) {
            toClose.push({ pos, reason: 'TRAILING' }); continue;
          }
        } else {
          const trailPrice = pos.trailingHighWater * (1 + callbackPct);
          if (holdTimeMs >= cfg.MIN_HOLD_FOR_TRAILING_MS && currentPrice >= trailPrice) {
            toClose.push({ pos, reason: 'TRAILING' }); continue;
          }
        }
      }

      // ── 5. TIME EXIT — force close if trade is indecisive ──
      if (holdTimeMs >= cfg.MAX_HOLD_MS) {
        toClose.push({ pos, reason: 'TIME_EXIT' }); continue;
      }

      // ── 6. LIQUIDATION check (emergency) ──
      const pnlPctLev = pos.side === 'LONG'
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * pos.leverage
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100 * pos.leverage;
      const liqPct = (1 / pos.leverage) * 100 * 0.9;
      if (Math.abs(pnlPctLev) >= liqPct && pnlPctLev < 0) {
        toClose.push({ pos, reason: 'LIQUIDATION' }); continue;
      }
    }

    return toClose;
  }

  getOpenPositions() { return this.openPositions; }
  getOpenByEngine(e: string) { return this.openPositions.filter(p => p.engine === e); }
  getCapital() { return this.capital; }
  getTrades() { return this.closedTrades; }
  getPeakCapital() { return this.peakCapital; }
  getEquityCurve() { return this.equityCurve; }
  getTradesLastHour(engine: string, now: number) {
    return this.closedTrades.filter(t => t.engine === engine && t.closeTime > now - 3_600_000).length;
  }
}
