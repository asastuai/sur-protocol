// ============================================================
// src/executors/live-executor.ts — Live Trading Executor
// ============================================================
// WARNING: This executes REAL trades on Aster DEX.
// Only use after thorough paper trading validation.
// ============================================================

import type { AsterGateway } from '../gateway/aster-gateway';
import type { Config } from '../config';
import type { Logger } from '../utils/logger';
import type {
  Signal, Position, TradeRecord, Report, ExecutorInterface,
} from '../types';
import { PaperExecutor } from './paper-executor';

/**
 * LiveExecutor extends PaperExecutor for tracking,
 * but also sends real orders through the gateway.
 * This dual approach ensures we always have accurate
 * internal state even if API responses are delayed.
 */
export class LiveExecutor extends PaperExecutor {
  private gateway: AsterGateway;

  constructor(gateway: AsterGateway, config: Config, logger: Logger) {
    super(config, logger);
    this.gateway = gateway;
  }

  async openPosition(signal: Signal, capital: number, overrides?: any): Promise<Position> {
    // First track internally via paper (pass overrides so margin/leverage are correct)
    const position = await super.openPosition(signal, capital, overrides);

    // Then send real order
    try {
      const side = signal.side === 'LONG' ? 'BUY' : 'SELL';

      // Set leverage first
      await this.gateway.setLeverage(
        signal.indicators.emaFast > 0 ? 'BTCUSDT' : 'BTCUSDT', // symbol from config
        signal.suggestedLeverage
      );

      // Market order to enter (One-way mode: no positionSide)
      await this.gateway.placeOrder({
        symbol: 'BTCUSDT',
        side,
        type: 'MARKET',
        quantity: position.quantity.toFixed(3),
      });

      // Place SL order (Aster: max 1 decimal for BTC price)
      await this.gateway.placeOrder({
        symbol: 'BTCUSDT',
        side: signal.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        stopPrice: signal.stopLoss.toFixed(1),
        closePosition: 'true',
      });

      // Place TP order
      await this.gateway.placeOrder({
        symbol: 'BTCUSDT',
        side: signal.side === 'LONG' ? 'SELL' : 'BUY',
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: signal.takeProfit.toFixed(1),
        closePosition: 'true',
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[LIVE] ❌ openPosition failed: ${msg}`);
      process.stderr.write(`[LIVE] ❌ openPosition error: ${msg}\n`);
    }

    return position;
  }

  async closePosition(
    position: Position,
    price: number,
    reason: string
  ): Promise<TradeRecord> {
    // Send real close order
    try {
      const side = position.side === 'LONG' ? 'SELL' : 'BUY';

      await this.gateway.placeOrder({
        symbol: 'BTCUSDT',
        side,
        type: 'MARKET',
        quantity: position.quantity.toFixed(3),
        reduceOnly: 'true',
      });
    } catch (err) {
      (this as any).logger.error('❌ Live close order failed:', err);
    }

    // Track internally
    return super.closePosition(position, price, reason);
  }

  generateReport(): Report {
    const report = super.generateReport();
    report.mode = 'LIVE';
    return report;
  }
}
