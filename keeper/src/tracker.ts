/**
 * SUR Keeper - Position Tracker
 *
 * Maintains an in-memory registry of all open positions by:
 * 1. On startup: scanning historical PositionOpened/Modified/Closed events
 * 2. Ongoing: watching new events in real-time via WebSocket subscription
 *
 * The scanner checks these tracked positions for liquidation opportunities.
 */

import {
  type PublicClient,
  type Hex,
  type Log,
  parseAbiItem,
} from "viem";
import { ENGINE_ABI } from "./abis.js";

// ============================================================
//                    TYPES
// ============================================================

export interface TrackedPosition {
  marketId: Hex;
  trader: Hex;
  size: bigint;        // int256, positive=long, negative=short
  entryPrice: bigint;
  margin: bigint;
  lastSeen: number;    // block number
}

// Key: "marketId:trader"
export type PositionKey = string;

function posKey(marketId: Hex, trader: Hex): PositionKey {
  return `${marketId}:${trader.toLowerCase()}`;
}

// ============================================================
//                    TRACKER
// ============================================================

export class PositionTracker {
  private positions: Map<PositionKey, TrackedPosition> = new Map();
  private client: PublicClient;
  private engineAddress: Hex;
  private lastSyncedBlock: bigint = 0n;

  constructor(client: PublicClient, engineAddress: Hex) {
    this.client = client;
    this.engineAddress = engineAddress;
  }

  // ---- Getters ----

  getAllPositions(): TrackedPosition[] {
    return [...this.positions.values()];
  }

  getPosition(marketId: Hex, trader: Hex): TrackedPosition | undefined {
    return this.positions.get(posKey(marketId, trader));
  }

  positionCount(): number {
    return this.positions.size;
  }

  getPositionsByMarket(marketId: Hex): TrackedPosition[] {
    return [...this.positions.values()].filter(p => p.marketId === marketId);
  }

  // ---- Initial Sync ----

  async syncFromEvents(fromBlock: bigint): Promise<void> {
    const currentBlock = await this.client.getBlockNumber();
    const CHUNK = 5000n;

    console.log(`[Tracker] Syncing events from block ${fromBlock} to ${currentBlock}...`);

    let start = fromBlock;
    while (start <= currentBlock) {
      const end = start + CHUNK > currentBlock ? currentBlock : start + CHUNK;

      // Fetch PositionOpened events
      const openedLogs = await this.client.getLogs({
        address: this.engineAddress,
        event: parseAbiItem("event PositionOpened(bytes32 indexed marketId, address indexed trader, int256 size, uint256 entryPrice, uint256 margin)"),
        fromBlock: start,
        toBlock: end,
      });

      for (const log of openedLogs) {
        this.handleOpened(log);
      }

      // Fetch PositionModified events
      const modifiedLogs = await this.client.getLogs({
        address: this.engineAddress,
        event: parseAbiItem("event PositionModified(bytes32 indexed marketId, address indexed trader, int256 oldSize, int256 newSize, uint256 newEntryPrice, uint256 newMargin, int256 realizedPnl)"),
        fromBlock: start,
        toBlock: end,
      });

      for (const log of modifiedLogs) {
        this.handleModified(log);
      }

      // Fetch PositionClosed events
      const closedLogs = await this.client.getLogs({
        address: this.engineAddress,
        event: parseAbiItem("event PositionClosed(bytes32 indexed marketId, address indexed trader, int256 closedSize, uint256 exitPrice, int256 realizedPnl)"),
        fromBlock: start,
        toBlock: end,
      });

      for (const log of closedLogs) {
        this.handleClosed(log);
      }

      // Fetch PositionLiquidated events
      const liqLogs = await this.client.getLogs({
        address: this.engineAddress,
        event: parseAbiItem("event PositionLiquidated(bytes32 indexed marketId, address indexed trader, address indexed keeper, int256 closedSize, uint256 price, int256 pnl, uint256 remainingMargin, uint256 keeperReward, uint256 insurancePayout, int256 badDebt)"),
        fromBlock: start,
        toBlock: end,
      });

      for (const log of liqLogs) {
        this.handleLiquidated(log);
      }

      start = end + 1n;
    }

    this.lastSyncedBlock = currentBlock;
    console.log(`[Tracker] Sync complete. ${this.positions.size} active positions tracked.`);
  }

  // ---- Real-time Event Watching ----

  async watchEvents(): Promise<void> {
    // Watch PositionOpened
    this.client.watchEvent({
      address: this.engineAddress,
      event: parseAbiItem("event PositionOpened(bytes32 indexed marketId, address indexed trader, int256 size, uint256 entryPrice, uint256 margin)"),
      onLogs: (logs) => logs.forEach(l => this.handleOpened(l)),
    });

    // Watch PositionModified
    this.client.watchEvent({
      address: this.engineAddress,
      event: parseAbiItem("event PositionModified(bytes32 indexed marketId, address indexed trader, int256 oldSize, int256 newSize, uint256 newEntryPrice, uint256 newMargin, int256 realizedPnl)"),
      onLogs: (logs) => logs.forEach(l => this.handleModified(l)),
    });

    // Watch PositionClosed
    this.client.watchEvent({
      address: this.engineAddress,
      event: parseAbiItem("event PositionClosed(bytes32 indexed marketId, address indexed trader, int256 closedSize, uint256 exitPrice, int256 realizedPnl)"),
      onLogs: (logs) => logs.forEach(l => this.handleClosed(l)),
    });

    // Watch PositionLiquidated
    this.client.watchEvent({
      address: this.engineAddress,
      event: parseAbiItem("event PositionLiquidated(bytes32 indexed marketId, address indexed trader, address indexed keeper, int256 closedSize, uint256 price, int256 pnl, uint256 remainingMargin, uint256 keeperReward, uint256 insurancePayout, int256 badDebt)"),
      onLogs: (logs) => logs.forEach(l => this.handleLiquidated(l)),
    });

    console.log("[Tracker] Watching real-time events...");
  }

  // ---- Verify on-chain (fallback for stale data) ----

  async verifyPosition(marketId: Hex, trader: Hex): Promise<TrackedPosition | null> {
    const result = await this.client.readContract({
      address: this.engineAddress,
      abi: ENGINE_ABI,
      functionName: "positions",
      args: [marketId, trader],
    });

    const [size, entryPrice, margin] = result;

    if (size === 0n) {
      this.positions.delete(posKey(marketId, trader));
      return null;
    }

    const pos: TrackedPosition = {
      marketId,
      trader,
      size,
      entryPrice,
      margin,
      lastSeen: Number(await this.client.getBlockNumber()),
    };

    this.positions.set(posKey(marketId, trader), pos);
    return pos;
  }

  // ---- Event Handlers ----

  private handleOpened(log: any): void {
    const { marketId, trader, size, entryPrice, margin } = log.args;
    this.positions.set(posKey(marketId, trader), {
      marketId,
      trader,
      size,
      entryPrice,
      margin,
      lastSeen: Number(log.blockNumber || 0),
    });
  }

  private handleModified(log: any): void {
    const { marketId, trader, newSize, newEntryPrice, newMargin } = log.args;
    const key = posKey(marketId, trader);

    if (newSize === 0n) {
      this.positions.delete(key);
    } else {
      this.positions.set(key, {
        marketId,
        trader,
        size: newSize,
        entryPrice: newEntryPrice,
        margin: newMargin,
        lastSeen: Number(log.blockNumber || 0),
      });
    }
  }

  private handleClosed(log: any): void {
    const { marketId, trader } = log.args;
    this.positions.delete(posKey(marketId, trader));
  }

  private handleLiquidated(log: any): void {
    const { marketId, trader } = log.args;
    this.positions.delete(posKey(marketId, trader));
  }
}
