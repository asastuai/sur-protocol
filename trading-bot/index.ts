// ============================================================
// SUR PROTOCOL — Trading Bot (adapted from Aster Momentum Scalp)
// ============================================================
// Runtime: Bun (bun run index.ts)
// Mode: --paper (default) | --live
// Engine: --engine=swing (default) | --engine=scalp
//
// This bot uses the same technical analysis engines (EMA, RSI, MFI,
// Bollinger Bands, ATR) but executes on SUR Protocol instead of Aster DEX.
//
// Price data: Binance public streams (SUR uses Binance feeds)
// Order execution: SUR Agent API (port 3003)
// ============================================================

import { MomentumScalpEngine } from './src/engines/momentum-scalp';
import { SwingEngine } from './src/engines/swing-engine';
import { SurGateway } from './src/gateway/sur-gateway';
import { PaperExecutor } from './src/executors/paper-executor';
import { LiveExecutor } from './src/executors/live-executor';
import { Logger } from './src/utils/logger';
import { loadConfig } from './src/config';

async function main() {
  const args = process.argv.slice(2);
  const isLive = args.includes('--live');
  const symbol = args.find(a => a.startsWith('--symbol='))?.split('=')[1] || 'BTCUSDT';
  const engineType = args.find(a => a.startsWith('--engine='))?.split('=')[1] || 'swing';
  const config = loadConfig();

  const logger = new Logger(config);

  console.log(`
  ╔═══════════════════════════════════════════════════════╗
  ║   SUR PROTOCOL — Trading Bot                          ║
  ║   Engine: ${engineType.toUpperCase().padEnd(44)}║
  ║   Mode: ${isLive ? 'LIVE TRADING' : 'PAPER TRADING'}                            ║
  ║   Symbol: ${symbol.padEnd(42)}║
  ║   Exchange: SUR Protocol (Base L2)                    ║
  ╚═══════════════════════════════════════════════════════╝
  `);

  if (isLive && !config.ASTER_API_KEY) {
    console.error('SUR_AGENT_ADDRESS required for live trading. Set in .env');
    process.exit(1);
  }

  // Gateway handles WebSocket + REST connections to SUR Protocol
  // Uses Binance for price feeds (same data SUR uses)
  // Uses SUR Agent API for order execution
  const gateway = new SurGateway(config, logger);

  // Executor handles order placement (paper = simulated, live = real on SUR)
  const executor = isLive
    ? new LiveExecutor(gateway as any, config, logger)
    : new PaperExecutor(config, logger);

  // Engine selector
  let engine: SwingEngine | MomentumScalpEngine;
  if (engineType === 'swing') {
    engine = new SwingEngine(gateway as any, executor, config, logger, symbol);
    logger.info(`[MAIN] Engine: SWING (${isLive ? 'LIVE' : 'PAPER'})`);
  } else if (engineType === 'scalp') {
    engine = new MomentumScalpEngine(gateway as any, executor, config, logger, symbol);
    logger.info(`[MAIN] Engine: SCALP (${isLive ? 'LIVE' : 'PAPER'})`);
  } else {
    console.error(`Unknown engine: ${engineType}. Use --engine=swing or --engine=scalp`);
    process.exit(1);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await engine.stop();
    const report = (executor as PaperExecutor).generateReport?.();
    if (report) logger.saveReport(report);
    console.log('\nFinal Report saved to ./reports/');
    process.exit(0);
  });

  // Connect WebSocket streams (Binance format — same candle/ticker data)
  await gateway.connect([
    `${symbol.toLowerCase()}@kline_1m`,
    `${symbol.toLowerCase()}@kline_5m`,
    `${symbol.toLowerCase()}@ticker`,
    `${symbol.toLowerCase()}@aggTrade`,
  ]);

  // Also connect to SUR WebSocket for order updates (live mode)
  if (isLive) {
    await gateway.connectSurWs();
  }

  // Load historical klines for indicator warmup
  await engine.warmup();

  // Start processing
  engine.start();

  console.log(`\nBot running on SUR Protocol. Press Ctrl+C to stop.\n`);
}

process.on('uncaughtException', (err) => {
  console.error(`[${new Date().toISOString()}] uncaughtException:`, err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${new Date().toISOString()}] unhandledRejection:`, reason);
  process.exit(1);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
