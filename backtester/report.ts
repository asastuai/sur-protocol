// ============================================================
// backtester/report.ts — SUR Protocol Backtest Report Generator
// ============================================================

import type { SimExecutor, SimTrade } from './sim-executor';

export function generateReport(
  exec: SimExecutor,
  startCapital: number,
  days: number,
  symbol: string,
  priceStart: number,
  priceEnd: number,
): string {
  const trades = exec.getTrades();
  const hr = '═'.repeat(62);
  const ln = '─'.repeat(62);

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const totalNet = trades.reduce((s, t) => s + t.netPnl, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max drawdown
  let peak = startCapital, maxDD = 0, running = startCapital;
  for (const t of trades) {
    running += t.netPnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe-ish (daily returns)
  const dailyPnl = new Map<string, number>();
  for (const t of trades) {
    const day = new Date(t.closeTime).toISOString().split('T')[0];
    dailyPnl.set(day, (dailyPnl.get(day) || 0) + t.netPnl);
  }
  const dailyReturns = [...dailyPnl.values()];
  const avgDaily = dailyReturns.length > 0 ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length : 0;
  const stdDaily = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, v) => s + (v - avgDaily) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(365) : 0;

  // Longest winning/losing streak
  let maxWinStreak = 0, maxLoseStreak = 0, ws = 0, ls = 0;
  for (const t of trades) {
    if (t.netPnl > 0) { ws++; ls = 0; maxWinStreak = Math.max(maxWinStreak, ws); }
    else { ls++; ws = 0; maxLoseStreak = Math.max(maxLoseStreak, ls); }
  }

  let r = `
╔${hr}╗
║  🔬  SUR PROTOCOL BACKTEST — ${symbol} — ${days} days
╚${hr}╝

  Period:            ${new Date(trades[0]?.openTime || 0).toISOString().split('T')[0]} → ${new Date(trades[trades.length - 1]?.closeTime || 0).toISOString().split('T')[0]}
  BTC Price:         $${priceStart.toFixed(0)} → $${priceEnd.toFixed(0)} (${(((priceEnd - priceStart) / priceStart) * 100).toFixed(2)}%)

  Starting Capital:  $${startCapital.toFixed(2)}
  Final Capital:     $${exec.getCapital().toFixed(2)}
  Net PnL:           $${totalNet.toFixed(2)} (${((totalNet / startCapital) * 100).toFixed(2)}%)
  Total Fees Paid:   $${totalFees.toFixed(2)}
  Max Drawdown:      $${maxDD.toFixed(2)} (${peak > 0 ? ((maxDD / peak) * 100).toFixed(2) : '0'}%)
  Annualized Sharpe: ${sharpe.toFixed(2)}
  Avg Daily PnL:     $${avgDaily.toFixed(2)}

${ln}
  📈 TRADE STATISTICS
${ln}
  Total Trades:      ${trades.length}
  Wins / Losses:     ${wins.length} / ${losses.length} (${trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(1) : 0}% WR)
  Profit Factor:     ${pf === Infinity ? '∞' : pf.toFixed(2)}
  Avg Win:           $${wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0.00'}
  Avg Loss:          $${losses.length > 0 ? (grossLoss / losses.length).toFixed(2) : '0.00'}
  Expectancy:        $${trades.length > 0 ? (totalNet / trades.length).toFixed(2) : '0.00'} per trade
  Trades/Day:        ${(trades.length / Math.max(days, 1)).toFixed(1)}
  Avg Hold Time:     ${trades.length > 0 ? (trades.reduce((s, t) => s + t.holdTimeMin, 0) / trades.length).toFixed(0) : '0'} min
  Win Streak:        ${maxWinStreak} | Lose Streak: ${maxLoseStreak}

${ln}
  🏗️ ENGINE BREAKDOWN (sorted by Net PnL)
${ln}
`;

  // Engine breakdown
  const engines = new Map<string, SimTrade[]>();
  for (const t of trades) {
    if (!engines.has(t.engine)) engines.set(t.engine, []);
    engines.get(t.engine)!.push(t);
  }

  const sorted = [...engines.entries()].sort((a, b) => {
    const pA = a[1].reduce((s, t) => s + t.netPnl, 0);
    const pB = b[1].reduce((s, t) => s + t.netPnl, 0);
    return pB - pA;
  });

  for (const [eng, et] of sorted) {
    const w = et.filter(t => t.netPnl > 0);
    const l = et.filter(t => t.netPnl <= 0);
    const gp = w.reduce((s, t) => s + t.netPnl, 0);
    const gl = Math.abs(l.reduce((s, t) => s + t.netPnl, 0));
    const net = et.reduce((s, t) => s + t.netPnl, 0);
    const fees = et.reduce((s, t) => s + t.fees, 0);
    const epf = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;
    const wr = et.length > 0 ? (w.length / et.length) * 100 : 0;
    const avgW = w.length > 0 ? gp / w.length : 0;
    const avgL = l.length > 0 ? gl / l.length : 0;
    const avgHold = et.reduce((s, t) => s + t.holdTimeMin, 0) / et.length;
    const emoji = net > 0 ? '🟢' : net < -5 ? '🔴' : '🟡';

    r += `\n  ${emoji} ${eng}\n`;
    r += `     Trades: ${et.length} | WR: ${wr.toFixed(0)}% | PF: ${epf.toFixed(2)} | Net: $${net.toFixed(2)} | Fees: $${fees.toFixed(2)}\n`;
    r += `     Avg Win: $${avgW.toFixed(2)} | Avg Loss: $${avgL.toFixed(2)} | Avg Hold: ${avgHold.toFixed(0)}min\n`;
  }

  // Exit reasons
  r += `\n${ln}\n  📋 EXIT REASONS\n${ln}\n`;
  const reasons = new Map<string, { count: number; pnl: number }>();
  for (const t of trades) {
    const e = reasons.get(t.closeReason) || { count: 0, pnl: 0 };
    e.count++; e.pnl += t.netPnl;
    reasons.set(t.closeReason, e);
  }
  for (const [reason, data] of [...reasons.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const emoji = data.pnl > 0 ? '🟢' : '🔴';
    r += `  ${emoji} ${reason.padEnd(16)} | ${String(data.count).padStart(4)} trades | $${data.pnl.toFixed(2)}\n`;
  }

  // Daily PnL table
  r += `\n${ln}\n  📅 DAILY PnL\n${ln}\n`;
  const sortedDays = [...dailyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let cumPnl = 0;
  for (const [day, pnl] of sortedDays) {
    cumPnl += pnl;
    const dayTrades = trades.filter(t => new Date(t.closeTime).toISOString().split('T')[0] === day).length;
    const emoji = pnl > 0 ? '🟢' : pnl < 0 ? '🔴' : '⚪';
    r += `  ${emoji} ${day} | $${pnl.toFixed(2).padStart(8)} | ${String(dayTrades).padStart(3)} trades | Cum: $${cumPnl.toFixed(2)}\n`;
  }

  // Worst trades
  r += `\n${ln}\n  💀 WORST 10 TRADES\n${ln}\n`;
  const worst = [...trades].sort((a, b) => a.netPnl - b.netPnl).slice(0, 10);
  for (const t of worst) {
    r += `  ${t.id} | ${t.engine.padEnd(16)} | ${t.side} | $${t.netPnl.toFixed(2).padStart(8)} | ${t.closeReason} | ${t.holdTimeMin}min\n`;
  }

  // Best trades
  r += `\n${ln}\n  🏆 BEST 10 TRADES\n${ln}\n`;
  const best = [...trades].sort((a, b) => b.netPnl - a.netPnl).slice(0, 10);
  for (const t of best) {
    r += `  ${t.id} | ${t.engine.padEnd(16)} | ${t.side} | $${t.netPnl.toFixed(2).padStart(8)} | ${t.closeReason} | ${t.holdTimeMin}min\n`;
  }

  // "Wasted" trades analysis (|PnL| < $1)
  const wasted = trades.filter(t => Math.abs(t.netPnl) < 1);
  const wastedFees = wasted.reduce((s, t) => s + t.fees, 0);
  r += `\n${ln}\n  ⚠️ MICRO-TRADE ANALYSIS (|PnL| < $1)\n${ln}\n`;
  r += `  Count: ${wasted.length} (${trades.length > 0 ? ((wasted.length / trades.length) * 100).toFixed(1) : 0}% of all trades)\n`;
  r += `  Fees wasted: $${wastedFees.toFixed(2)}\n`;
  r += `  Net PnL: $${wasted.reduce((s, t) => s + t.netPnl, 0).toFixed(2)}\n`;

  r += `\n${'═'.repeat(62)}\n`;

  return r;
}
