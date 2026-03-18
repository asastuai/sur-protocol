// ============================================================
// src/utils/logger.ts — Logging + Report Generation
// ============================================================

import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'fs';
import type { Config } from '../config';
import type { Report } from '../types';
import type { MarketState, MarketStateV2 } from '../engines/market-brain';

export class Logger {
  private config: Config;
  private logFile: string;
  private tradeFile: string;
  private signalFile: string;
  private brainFile: string;

  constructor(config: Config) {
    this.config = config;

    // Create directories
    for (const dir of [config.LOG_DIR, config.REPORT_DIR]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const dateStr = new Date().toISOString().split('T')[0];
    this.logFile = `${config.LOG_DIR}/bot-${dateStr}.log`;
    this.tradeFile = `${config.LOG_DIR}/trades-${dateStr}.csv`;
    this.signalFile = `${config.LOG_DIR}/signals-${dateStr}.csv`;
    this.brainFile = `${config.LOG_DIR}/brain-${dateStr}.csv`;

    // CSV headers
    if (!existsSync(this.tradeFile)) {
      appendFileSync(this.tradeFile,
        'timestamp,id,symbol,side,entry_price,exit_price,quantity,leverage,' +
        'margin,pnl,pnl_pct,fees,net_pnl,duration_ms,close_reason,engine,tags\n'
      );
    }

    if (!existsSync(this.signalFile)) {
      appendFileSync(this.signalFile,
        'timestamp,type,side,price,conditions_met,ema_cross,rsi_confirm,' +
        'mfi_confirm,trend_align,volume_confirm,rsi,mfi,atr,bb_width,' +
        'leverage,stop_loss,take_profit\n'
      );
    }

    if (!existsSync(this.brainFile)) {
      appendFileSync(this.brainFile,
        'timestamp,regime,special_event,confidence,allowed_sides,bias,' +
        'lev_mult,size_mult,rsi_5m,rsi_1h,mfi_5m,bb_width,atr_pct,' +
        'mom_1h,mom_4h,vol_trend,consec_green,consec_red\n'
      );
    }
  }

  private write(level: string, msg: string) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg}`;

    if (this.config.VERBOSE || level !== 'DEBUG') {
      console.log(line);
    }

    appendFileSync(this.logFile, line + '\n');
  }

  info(msg: string) { this.write('INFO', msg); }
  warn(msg: string) { this.write('WARN', msg); }
  error(msg: string, err?: any) {
    this.write('ERROR', msg + (err ? ` ${err.message || err}` : ''));
  }
  debug(msg: string) { this.write('DEBUG', msg); }

  trade(msg: string) {
    this.write('TRADE', msg);
  }

  signal(msg: string) {
    this.write('SIGNAL', msg);
  }

  /**
   * Log a completed trade to CSV
   */
  logTradeCSV(trade: any) {
    const line = [
      new Date(trade.closeTime).toISOString(),
      trade.id,
      trade.symbol,
      trade.side,
      trade.entryPrice.toFixed(2),
      trade.exitPrice.toFixed(2),
      trade.quantity.toFixed(6),
      trade.leverage,
      trade.margin.toFixed(2),
      trade.pnl.toFixed(4),
      trade.pnlPct.toFixed(4),
      trade.fees.toFixed(6),
      trade.netPnl.toFixed(4),
      trade.duration,
      trade.closeReason,
      trade.engine || 'SCALP',
      (trade.tags || []).join('|'),
    ].join(',');

    appendFileSync(this.tradeFile, line + '\n');
  }

  /**
   * Log MarketBrain state to CSV (runs every 5 min)
   */
  logBrainCSV(state: MarketState | MarketStateV2) {
    // Refresh brain file path daily
    const dateStr = new Date().toISOString().split('T')[0];
    const todayBrainFile = `${this.config.LOG_DIR}/brain-${dateStr}.csv`;
    if (todayBrainFile !== this.brainFile) {
      this.brainFile = todayBrainFile;
      if (!existsSync(this.brainFile)) {
        appendFileSync(this.brainFile,
          'timestamp,regime,special_event,confidence,allowed_sides,bias,' +
          'lev_mult,size_mult,rsi_5m,rsi_1h,mfi_5m,bb_width,atr_pct,' +
          'mom_1h,mom_4h,vol_trend,consec_green,consec_red,' +
          'exhaustion_score,divergence_type,divergence_strength\n'
        );
      }
    }

    const m = state.metrics;
    // v3.0 extra fields (only present in MarketStateV2)
    const v2 = state as MarketStateV2;
    const exhaustionScore = v2.exhaustionScore ?? 0;
    const divType = v2.divergence?.type ?? 'NONE';
    const divStrength = v2.divergence?.strength ?? 0;

    const line = [
      new Date(state.timestamp).toISOString(),
      state.regime,
      state.specialEvent,
      state.confidence.toFixed(1),
      state.allowedSides,
      state.bias,
      state.leverageMultiplier.toFixed(2),
      state.positionSizeMultiplier.toFixed(2),
      m.rsi_5m.toFixed(2),
      m.rsi_1h.toFixed(2),
      m.mfi_5m.toFixed(2),
      m.bb_width_5m.toFixed(4),
      m.atr_pct.toFixed(4),
      m.momentum_1h_pct.toFixed(4),
      m.momentum_4h_pct.toFixed(4),
      m.volume_trend,
      m.consec_green_5m,
      m.consec_red_5m,
      exhaustionScore,
      divType,
      divStrength,
    ].join(',');

    appendFileSync(this.brainFile, line + '\n');
  }

  /**
   * Log a signal to CSV
   */
  logSignalCSV(signal: any) {
    const line = [
      new Date(signal.timestamp).toISOString(),
      signal.type,
      signal.side || 'NONE',
      signal.price.toFixed(2),
      signal.conditions.conditionsMet,
      signal.conditions.emaCross,
      signal.conditions.rsiConfirm,
      signal.conditions.mfiConfirm,
      signal.conditions.trendAlign,
      signal.conditions.volumeConfirm,
      signal.indicators.rsi.toFixed(2),
      signal.indicators.mfi.toFixed(2),
      signal.indicators.atr.toFixed(4),
      signal.indicators.bbWidth.toFixed(4),
      signal.suggestedLeverage,
      signal.stopLoss.toFixed(2),
      signal.takeProfit.toFixed(2),
    ].join(',');

    appendFileSync(this.signalFile, line + '\n');
  }

  /**
   * Save final report to JSON + human-readable text
   */
  saveReport(report: Report) {
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');

    // JSON report (for programmatic analysis)
    const jsonPath = `${this.config.REPORT_DIR}/report-${dateStr}.json`;
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));

    // Human-readable report
    const txtPath = `${this.config.REPORT_DIR}/report-${dateStr}.txt`;
    const txt = this.formatReport(report);
    writeFileSync(txtPath, txt);

    console.log('\n' + txt);
    this.info(`Reports saved to ${jsonPath} and ${txtPath}`);
  }

  private formatReport(r: Report): string {
    const hr = '═'.repeat(55);
    const line = '─'.repeat(55);
    const dur = r.durationHours.toFixed(1);
    const avgDurMin = (r.avgTradeDuration / 60000).toFixed(1);

    return `
╔${hr}╗
║   📊 PAPER TRADING REPORT — ${r.symbol.padEnd(24)}║
╚${hr}╝

  Mode:             ${r.mode}
  Duration:         ${dur} hours
  Period:           ${new Date(r.startTime).toLocaleString()} →
                    ${new Date(r.endTime).toLocaleString()}

${line}
  💰 CAPITAL
${line}
  Starting:         $${r.startingCapital.toFixed(2)}
  Final:            $${r.finalCapital.toFixed(2)}
  Total PnL:        $${r.totalPnl.toFixed(2)} (${r.totalPnlPct >= 0 ? '+' : ''}${r.totalPnlPct.toFixed(2)}%)
  Max Drawdown:     $${r.maxDrawdown.toFixed(2)} (${r.maxDrawdownPct.toFixed(2)}%)

${line}
  📈 TRADES
${line}
  Total Trades:     ${r.totalTrades}
  Winning:          ${r.winningTrades} (${r.winRate.toFixed(1)}%)
  Losing:           ${r.losingTrades}
  Avg Win:          $${r.avgWin.toFixed(2)}
  Avg Loss:         $${r.avgLoss.toFixed(2)}
  Profit Factor:    ${r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)}
  Avg Duration:     ${avgDurMin} min

${line}
  🎯 SIGNALS
${line}
  Signals Generated: ${r.signalsGenerated}
  Signals Acted On:  ${r.signalsActedOn}
  Circuit Breaker:   ${r.circuitBreakerTriggered ? '🚨 YES' : '✅ No'}

${r.bestTrade ? `
${line}
  🏆 BEST TRADE
${line}
  Side:             ${r.bestTrade.side}
  Entry:            $${r.bestTrade.entryPrice.toFixed(2)}
  Exit:             $${r.bestTrade.exitPrice.toFixed(2)}
  PnL:              $${r.bestTrade.netPnl.toFixed(2)} (${r.bestTrade.pnlPct.toFixed(2)}%)
  Duration:         ${(r.bestTrade.duration / 60000).toFixed(1)} min
` : ''}
${r.worstTrade ? `
${line}
  💀 WORST TRADE
${line}
  Side:             ${r.worstTrade.side}
  Entry:            $${r.worstTrade.entryPrice.toFixed(2)}
  Exit:             $${r.worstTrade.exitPrice.toFixed(2)}
  PnL:              $${r.worstTrade.netPnl.toFixed(2)} (${r.worstTrade.pnlPct.toFixed(2)}%)
  Duration:         ${(r.worstTrade.duration / 60000).toFixed(1)} min
` : ''}
${line}
  📋 ALL TRADES
${line}
${r.trades.map((t, i) =>
  `  ${(i+1).toString().padStart(3)}. ${t.side.padEnd(5)} | ` +
  `$${t.entryPrice.toFixed(0)} → $${t.exitPrice.toFixed(0)} | ` +
  `${t.netPnl >= 0 ? '+' : ''}$${t.netPnl.toFixed(2)} (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%) | ` +
  `${t.closeReason} | ${(t.duration / 60000).toFixed(1)}min`
).join('\n') || '  No trades executed.'}

${'─'.repeat(55)}
⚠️  DISCLAIMER: Paper trading results do not guarantee
    live performance. Past results ≠ future results.
    Always use proper risk management.
${'─'.repeat(55)}
`;
  }
}
