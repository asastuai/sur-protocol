/**
 * SUR Protocol - Settlement Pipeline
 *
 * Takes matched trades from the engine and submits them to
 * OrderSettlement.sol on Base L2.
 *
 * Flow:
 * 1. Engine produces Trade objects when orders match
 * 2. Pipeline converts them to MatchedTradeOnChain structs
 * 3. Accumulates into batches (configurable interval/size)
 * 4. Submits batch to OrderSettlement.settleBatch() or settleOne()
 * 5. Monitors tx confirmation
 * 6. Emits events for the WebSocket server to relay
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Hex,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Config, SETTLEMENT_ABI } from "../config/index.js";
import type { Trade, Order, MatchedTradeOnChain, SignedOrderOnChain, SettlementBatch } from "../types/index.js";
import { EventEmitter } from "events";
import { insertTrade } from "../db/supabase.js";

// ============================================================
//                  SETTLEMENT PIPELINE
// ============================================================

export class SettlementPipeline extends EventEmitter {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private account: ReturnType<typeof privateKeyToAccount>;
  private config: Config;

  // Pending trades waiting to be batched
  private pendingTrades: Array<{
    trade: Trade;
    makerOrder: Order;
    takerOrder: Order;
  }> = [];

  // Batch management
  private batchTimer: NodeJS.Timeout | null = null;
  private batchCounter = 0;
  private batches: Map<number, SettlementBatch> = new Map();

  // Order lookup for converting trades to on-chain structs
  private orderCache: Map<string, Order> = new Map();

  private running = false;

  constructor(config: Config) {
    super();
    this.config = config;

    this.account = privateKeyToAccount(config.operatorPrivateKey);

    this.publicClient = createPublicClient({
      chain: config.chain as Chain,
      transport: http(config.rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: config.chain as Chain,
      transport: http(config.rpcUrl),
    });
  }

  // ============================================================
  //                    LIFECYCLE
  // ============================================================

  start(): void {
    if (this.running) return;
    this.running = true;

    // Flush pending trades on interval
    this.batchTimer = setInterval(() => {
      this.flushBatch().catch((err) => {
        this.emit("error", `Batch flush failed: ${err}`);
      });
    }, this.config.batchIntervalMs);

    this.emit("started");
  }

  stop(): void {
    this.running = false;
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    this.emit("stopped");
  }

  // ============================================================
  //               TRADE QUEUEING
  // ============================================================

  /** Cache an order for later conversion to on-chain struct */
  cacheOrder(order: Order): void {
    this.orderCache.set(order.id, order);
  }

  /** Queue a matched trade for settlement */
  queueTrade(trade: Trade, makerOrder: Order, takerOrder: Order): void {
    this.pendingTrades.push({ trade, makerOrder, takerOrder });

    // Auto-flush if batch is full
    if (this.pendingTrades.length >= this.config.maxBatchSize) {
      this.flushBatch().catch((err) => {
        this.emit("error", `Auto-flush failed: ${err}`);
      });
    }
  }

  // ============================================================
  //               BATCH CREATION & SUBMISSION
  // ============================================================

  async flushBatch(): Promise<void> {
    if (this.pendingTrades.length === 0) return;

    // Take all pending trades
    const toSettle = [...this.pendingTrades];
    this.pendingTrades = [];

    const batchId = this.batchCounter++;
    const onChainTrades = toSettle.map(({ trade, makerOrder, takerOrder }) =>
      this.toOnChainTrade(trade, makerOrder, takerOrder)
    );

    const batch: SettlementBatch = {
      id: batchId,
      trades: onChainTrades,
      createdAt: Date.now(),
      status: "pending",
    };

    this.batches.set(batchId, batch);
    this.emit("batchCreated", batch);

    try {
      const txHash = await this.submitBatch(onChainTrades);
      batch.txHash = txHash;
      batch.status = "submitted";
      this.emit("batchSubmitted", { batchId, txHash });

      // Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
      });

      if (receipt.status === "success") {
        batch.status = "confirmed";
        this.emit("batchConfirmed", { batchId, txHash, blockNumber: receipt.blockNumber });

        // Persist trades to Supabase
        for (const { trade, makerOrder } of toSettle) {
          insertTrade({
            market: makerOrder.marketId,
            price: Number(trade.price) / 1e6,
            size: Number(trade.size) / 1e8,
            side: trade.makerSide,
            maker_order_id: trade.makerOrderId,
            taker_order_id: trade.takerOrderId,
            tx_hash: txHash,
          }).catch(() => {}); // non-blocking
        }
      } else {
        batch.status = "failed";
        this.emit("batchFailed", { batchId, txHash, reason: "Transaction reverted" });
      }
    } catch (err) {
      batch.status = "failed";
      this.emit("batchFailed", { batchId, reason: String(err) });

      // Re-queue failed trades
      this.pendingTrades.push(...toSettle);
    }
  }

  private async submitBatch(trades: MatchedTradeOnChain[]): Promise<Hex> {
    if (trades.length === 1) {
      // Single trade: use settleOne (cheaper gas)
      const hash = await this.walletClient.writeContract({
        address: this.config.contracts.settlement,
        abi: SETTLEMENT_ABI,
        functionName: "settleOne",
        args: [trades[0]],
        chain: this.config.chain,
        account: this.account,
      });
      return hash;
    } else {
      // Multiple trades: use settleBatch
      const hash = await this.walletClient.writeContract({
        address: this.config.contracts.settlement,
        abi: SETTLEMENT_ABI,
        functionName: "settleBatch",
        args: [trades],
        chain: this.config.chain,
        account: this.account,
      });
      return hash;
    }
  }

  // ============================================================
  //                TYPE CONVERSION
  // ============================================================

  private toOnChainTrade(
    trade: Trade,
    makerOrder: Order,
    takerOrder: Order
  ): MatchedTradeOnChain {
    return {
      maker: this.toSignedOrder(makerOrder),
      taker: this.toSignedOrder(takerOrder),
      executionPrice: trade.price,
      executionSize: trade.size,
    };
  }

  private toSignedOrder(order: Order): SignedOrderOnChain {
    return {
      trader: order.trader,
      marketId: order.marketId,
      isLong: order.side === "buy",
      size: order.size,
      price: order.price,
      nonce: order.nonce,
      expiry: order.expiry,
      signature: order.signature,
    };
  }

  // ============================================================
  //                    QUERIES
  // ============================================================

  getPendingCount(): number {
    return this.pendingTrades.length;
  }

  getBatch(batchId: number): SettlementBatch | undefined {
    return this.batches.get(batchId);
  }

  getStats(): {
    totalBatches: number;
    pendingTrades: number;
    confirmed: number;
    failed: number;
  } {
    let confirmed = 0;
    let failed = 0;
    for (const batch of this.batches.values()) {
      if (batch.status === "confirmed") confirmed++;
      if (batch.status === "failed") failed++;
    }
    return {
      totalBatches: this.batchCounter,
      pendingTrades: this.pendingTrades.length,
      confirmed,
      failed,
    };
  }
}
