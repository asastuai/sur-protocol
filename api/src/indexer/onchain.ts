/**
 * SUR Protocol - Event Indexer
 *
 * Reads on-chain state from Base L2:
 * - Trader positions (via PerpEngine.getPosition)
 * - Vault balances
 * - Liquidation events
 * - Settlement events
 *
 * This data is served to the frontend via the WebSocket API.
 */

import { createPublicClient, http, type PublicClient, type Hex, type Chain } from "viem";
import { type Config, ENGINE_ABI, VAULT_ABI } from "../config/index.js";

export class OnChainIndexer {
  private client: PublicClient;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.client = createPublicClient({
      chain: config.chain as Chain,
      transport: http(config.rpcUrl),
    });
  }

  /** Get a trader's position in a market */
  async getPosition(
    marketId: Hex,
    trader: Hex
  ): Promise<{
    size: bigint;
    entryPrice: bigint;
    margin: bigint;
    unrealizedPnl: bigint;
    marginRatioBps: bigint;
  }> {
    const result = await this.client.readContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "getPosition",
      args: [marketId, trader],
    });

    return {
      size: result[0],
      entryPrice: result[1],
      margin: result[2],
      unrealizedPnl: result[3],
      marginRatioBps: result[4],
    };
  }

  /** Check if a position is liquidatable */
  async isLiquidatable(marketId: Hex, trader: Hex): Promise<boolean> {
    return this.client.readContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "isLiquidatable",
      args: [marketId, trader],
    });
  }

  /** Get a trader's vault balance */
  async getVaultBalance(trader: Hex): Promise<bigint> {
    return this.client.readContract({
      address: this.config.contracts.vault,
      abi: VAULT_ABI,
      functionName: "balances",
      args: [trader],
    });
  }

  /** Get unrealized PnL */
  async getUnrealizedPnl(marketId: Hex, trader: Hex): Promise<bigint> {
    return this.client.readContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "getUnrealizedPnl",
      args: [marketId, trader],
    });
  }

  /** Get current block number */
  async getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }
}
