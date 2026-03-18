/**
 * @sur-protocol/sdk
 *
 * TypeScript SDK for SUR Protocol - the first Latin American perpetual futures DEX.
 *
 * Quick start:
 *
 *   import { SurClient } from "@sur-protocol/sdk";
 *
 *   const sur = new SurClient({
 *     rpcUrl: "https://sepolia.base.org",
 *     wsUrl: "ws://localhost:3002",
 *     contracts: { vault: "0x...", engine: "0x...", settlement: "0x..." },
 *   });
 *
 *   // Read a position
 *   const pos = await sur.getPosition("BTC-USD", "0xTrader...");
 *   console.log(`PnL: $${pos.pnl}`);
 *
 *   // Submit a signed order
 *   await sur.submitOrder(walletClient, {
 *     market: "BTC-USD",
 *     side: "buy",
 *     size: 1.5,       // 1.5 BTC
 *     price: 50000,     // $50,000
 *     leverage: 10,
 *   });
 *
 *   // Subscribe to trades
 *   sur.onTrade("BTC-USD", (trade) => {
 *     console.log(`${trade.side} ${trade.size} @ $${trade.price}`);
 *   });
 */

import {
  createPublicClient,
  http,
  keccak256,
  toHex,
  type PublicClient,
  type WalletClient,
  type Hex,
  type Chain,
} from "viem";
import { baseSepolia, base } from "viem/chains";

// ============================================================
//                    TYPES
// ============================================================

export interface SurClientConfig {
  rpcUrl: string;
  wsUrl?: string;
  chainId?: number;     // 84532 = Base Sepolia, 8453 = Base Mainnet
  contracts: {
    vault: Hex;
    engine: Hex;
    settlement: Hex;
    collateralManager?: Hex;  // optional: for yield-bearing collateral
    tradingVault?: Hex;       // optional: for vault/copy-trading
  };
}

export interface Position {
  market: string;
  trader: Hex;
  size: number;          // positive = long, negative = short
  side: "long" | "short" | "none";
  entryPrice: number;    // USD
  margin: number;        // USD
  unrealizedPnl: number; // USD
  marginRatio: number;   // basis points
  leverage: number;
  notional: number;
  isLiquidatable: boolean;
}

export interface VaultBalance {
  available: number;     // USDC, free to trade or withdraw
}

export interface MarketData {
  name: string;
  markPrice: number;
  indexPrice: number;
  openInterestLong: number;
  openInterestShort: number;
  active: boolean;
}

export type MarginMode = "isolated" | "cross";

export interface AccountDetails {
  mode: MarginMode;
  totalEquity: number;           // free balance + all position equity
  totalInitialRequired: number;  // sum of initial margin across all positions
  totalMaintenanceRequired: number;
  totalNotional: number;         // total USD exposure
  freeBalance: number;           // available in vault (not locked in positions)
  positionCount: number;
  totalUnrealizedPnl: number;
  marginRatio: number;           // totalEquity / totalMaintenanceRequired (> 1 = safe)
  isLiquidatable: boolean;
  availableMargin: number;       // equity - initialRequired (can open new positions with this)
  effectiveLeverage: number;     // totalNotional / totalEquity
}

export interface OrderInput {
  market: string;         // "BTC-USD"
  side: "buy" | "sell";
  size: number;           // in base asset (1.5 = 1.5 BTC)
  price: number;          // in USD ($50,000)
  orderType?: "limit" | "market";
  timeInForce?: "GTC" | "IOC" | "FOK" | "PostOnly";
  hidden?: boolean;       // hidden orders don't appear in the public orderbook
}

export interface TradeEvent {
  id: string;
  market: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  timestamp: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  total: number;
}

export interface VaultInfo {
  name: string;
  description: string;
  manager: Hex;
  isPaused: boolean;
  totalShares: bigint;
  totalEquity: number;         // USDC
  equityPerShare: number;      // USDC per share
  performanceFeeBps: number;
  managementFeeBps: number;
  depositorCount: number;
  createdAt: number;
}

export interface VaultPosition {
  shares: bigint;
  usdcValue: number;
  totalDeposited: number;
  totalWithdrawn: number;
  pnl: number;
}

export interface OrderbookSnapshot {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  midPrice: number;
}

// ============================================================
//                    CONSTANTS
// ============================================================

export const PRICE_PRECISION = 1e6;
export const SIZE_PRECISION = 1e8;

export function toPrice(usd: number): bigint {
  return BigInt(Math.round(usd * PRICE_PRECISION));
}

export function toSize(amount: number): bigint {
  return BigInt(Math.round(amount * SIZE_PRECISION));
}

export function fromPrice(raw: bigint): number {
  return Number(raw) / PRICE_PRECISION;
}

export function fromSize(raw: bigint): number {
  return Number(raw) / SIZE_PRECISION;
}

export function marketId(name: string): Hex {
  return keccak256(toHex(name, { size: null })) as Hex;
}

// ============================================================
//                    ABIs (minimal)
// ============================================================

const ENGINE_ABI = [
  {
    type: "function", name: "getPosition", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }],
    outputs: [
      { name: "size", type: "int256" }, { name: "entryPrice", type: "uint256" },
      { name: "margin", type: "uint256" }, { name: "unrealizedPnl", type: "int256" },
      { name: "marginRatioBps", type: "uint256" },
    ],
  },
  {
    type: "function", name: "isLiquidatable", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "getUnrealizedPnl", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function", name: "markets", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "id", type: "bytes32" }, { name: "name", type: "string" },
      { name: "active", type: "bool" }, { name: "initialMarginBps", type: "uint256" },
      { name: "maintenanceMarginBps", type: "uint256" }, { name: "maxPositionSize", type: "uint256" },
      { name: "markPrice", type: "uint256" }, { name: "indexPrice", type: "uint256" },
      { name: "lastPriceUpdate", type: "uint256" }, { name: "cumulativeFunding", type: "int256" },
      { name: "lastFundingUpdate", type: "uint256" }, { name: "fundingIntervalSecs", type: "uint256" },
      { name: "openInterestLong", type: "uint256" }, { name: "openInterestShort", type: "uint256" },
    ],
  },
  {
    type: "function", name: "marketCount", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  // Cross-margin
  {
    type: "function", name: "traderMarginMode", stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "uint8" }],  // 0 = ISOLATED, 1 = CROSS
  },
  {
    type: "function", name: "setMarginMode", stateMutability: "nonpayable",
    inputs: [{ name: "mode", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function", name: "getAccountDetails", stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [
      { name: "mode", type: "uint8" }, { name: "totalEquity", type: "int256" },
      { name: "totalInitialRequired", type: "uint256" }, { name: "totalMaintenanceRequired", type: "uint256" },
      { name: "totalNotional", type: "uint256" }, { name: "freeBalance", type: "uint256" },
      { name: "positionCount", type: "uint256" }, { name: "totalUnrealizedPnl", type: "int256" },
    ],
  },
  {
    type: "function", name: "getAccountEquity", stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [
      { name: "equity", type: "int256" }, { name: "totalMaintRequired", type: "uint256" },
    ],
  },
  {
    type: "function", name: "isAccountLiquidatable", stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "getActiveMarketCount", stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "addMargin", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function", name: "removeMargin", stateMutability: "nonpayable",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;

const VAULT_ABI = [
  {
    type: "function", name: "balances", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const EIP712_DOMAIN = { name: "SUR Protocol", version: "1" } as const;

const COLLATERAL_ABI = [

const VAULT_CONTRACT_ABI = [
  {
    type: "function", name: "getVaultInfo", stateMutability: "view",
    inputs: [{ name: "vaultId", type: "bytes32" }],
    outputs: [
      { name: "name", type: "string" }, { name: "description", type: "string" },
      { name: "manager", type: "address" }, { name: "isPaused", type: "bool" },
      { name: "totalShares", type: "uint256" }, { name: "totalEquity", type: "uint256" },
      { name: "equityPerShare", type: "uint256" }, { name: "performanceFeeBps", type: "uint256" },
      { name: "managementFeeBps", type: "uint256" }, { name: "depositorCount", type: "uint256" },
      { name: "createdAt", type: "uint256" },
    ],
  },
  {
    type: "function", name: "getDepositorInfo", stateMutability: "view",
    inputs: [{ name: "vaultId", type: "bytes32" }, { name: "depositor", type: "address" }],
    outputs: [
      { name: "shares", type: "uint256" }, { name: "usdcValue", type: "uint256" },
      { name: "depositTimestamp", type: "uint256" }, { name: "totalDeposited", type: "uint256" },
      { name: "totalWithdrawn", type: "uint256" }, { name: "pnl", type: "int256" },
    ],
  },
  {
    type: "function", name: "vaultCount", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "getVaultId", stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }], outputs: [{ type: "bytes32" }],
  },
] as const;
  {
    type: "function", name: "getCollateralValue", stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "getTraderCollateral", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }, { name: "trader", type: "address" }],
    outputs: [
      { name: "amount", type: "uint256" }, { name: "creditedUsdc", type: "uint256" },
      { name: "currentValue", type: "uint256" },
    ],
  },
  {
    type: "function", name: "getSupportedTokens", stateMutability: "view",
    inputs: [], outputs: [{ type: "address[]" }],
  },
] as const;
const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" }, { name: "marketId", type: "bytes32" },
    { name: "isLong", type: "bool" }, { name: "size", type: "uint256" },
    { name: "price", type: "uint256" }, { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

// ============================================================
//                    SUR CLIENT
// ============================================================

export class SurClient {
  private publicClient: PublicClient;
  private config: SurClientConfig;
  private chain: Chain;
  private ws: WebSocket | null = null;
  private wsListeners: Map<string, Set<(data: any) => void>> = new Map();
  private nonceCounter = 1;

  constructor(config: SurClientConfig) {
    this.config = config;
    this.chain = config.chainId === 8453 ? base : baseSepolia;
    this.publicClient = createPublicClient({
      chain: this.chain,
      transport: http(config.rpcUrl),
    });
  }

  // ============================================================
  //                  READ: POSITIONS
  // ============================================================

  /** Get a trader's position in a market */
  async getPosition(market: string, trader: Hex): Promise<Position> {
    const mId = marketId(market);

    const [result, liquidatable] = await Promise.all([
      this.publicClient.readContract({
        address: this.config.contracts.engine,
        abi: ENGINE_ABI,
        functionName: "getPosition",
        args: [mId, trader],
      }),
      this.publicClient.readContract({
        address: this.config.contracts.engine,
        abi: ENGINE_ABI,
        functionName: "isLiquidatable",
        args: [mId, trader],
      }).catch(() => false),
    ]);

    const size = fromSize(result[0] >= 0n ? result[0] : -result[0]);
    const signed = Number(result[0]) / SIZE_PRECISION;
    const entry = fromPrice(result[1]);
    const margin = fromPrice(result[2]);
    const pnl = Number(result[3]) / PRICE_PRECISION;
    const ratioRaw = Number(result[4]);
    const notional = entry * size;
    const leverage = margin > 0 ? notional / margin : 0;

    return {
      market,
      trader,
      size: signed,
      side: result[0] > 0n ? "long" : result[0] < 0n ? "short" : "none",
      entryPrice: entry,
      margin,
      unrealizedPnl: pnl,
      marginRatio: ratioRaw,
      leverage: Math.round(leverage * 10) / 10,
      notional,
      isLiquidatable: liquidatable as boolean,
    };
  }

  // ============================================================
  //                  READ: BALANCE
  // ============================================================

  /** Get a trader's vault balance (available USDC) */
  async getBalance(trader: Hex): Promise<VaultBalance> {
    const raw = await this.publicClient.readContract({
      address: this.config.contracts.vault,
      abi: VAULT_ABI,
      functionName: "balances",
      args: [trader],
    });
    return { available: fromPrice(raw) };
  }

  // ============================================================
  //                  READ: MARKET
  // ============================================================

  /** Get market data (prices, open interest) */
  async getMarket(market: string): Promise<MarketData> {
    const result = await this.publicClient.readContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "markets",
      args: [marketId(market)],
    });

    return {
      name: result[1],
      markPrice: fromPrice(result[6]),
      indexPrice: fromPrice(result[7]),
      openInterestLong: fromSize(result[12]),
      openInterestShort: fromSize(result[13]),
      active: result[2],
    };
  }

  // ============================================================
  //                  READ: CROSS MARGIN
  // ============================================================

  /** Get the trader's current margin mode */
  async getMarginMode(trader: Hex): Promise<MarginMode> {
    const raw = await this.publicClient.readContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "traderMarginMode",
      args: [trader],
    });
    return Number(raw) === 1 ? "cross" : "isolated";
  }

  /** Get comprehensive cross-margin account details */
  async getAccountDetails(trader: Hex): Promise<AccountDetails> {
    const result = await this.publicClient.readContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "getAccountDetails",
      args: [trader],
    });

    const mode: MarginMode = Number(result[0]) === 1 ? "cross" : "isolated";
    const totalEquity = Number(result[1]) / PRICE_PRECISION;
    const totalInitialRequired = fromPrice(result[2]);
    const totalMaintenanceRequired = fromPrice(result[3]);
    const totalNotional = fromPrice(result[4]);
    const freeBalance = fromPrice(result[5]);
    const positionCount = Number(result[6]);
    const totalUnrealizedPnl = Number(result[7]) / PRICE_PRECISION;

    const marginRatio = totalMaintenanceRequired > 0
      ? totalEquity / totalMaintenanceRequired
      : Infinity;
    const isLiquidatable = totalMaintenanceRequired > 0 && totalEquity < totalMaintenanceRequired;
    const availableMargin = Math.max(0, totalEquity - totalInitialRequired);
    const effectiveLeverage = totalEquity > 0 ? totalNotional / totalEquity : 0;

    return {
      mode, totalEquity, totalInitialRequired, totalMaintenanceRequired,
      totalNotional, freeBalance, positionCount, totalUnrealizedPnl,
      marginRatio: Math.round(marginRatio * 100) / 100,
      isLiquidatable, availableMargin,
      effectiveLeverage: Math.round(effectiveLeverage * 10) / 10,
    };
  }

  // ============================================================
  //                  WRITE: MARGIN MODE
  // ============================================================

  /**
   * Switch between isolated and cross margin mode.
   * Can only be called when the trader has NO open positions.
   *
   * Example:
   *   await sur.setMarginMode(walletClient, "cross");
   */
  async setMarginMode(walletClient: WalletClient, mode: MarginMode): Promise<string> {
    if (!walletClient.account) throw new Error("Wallet has no account");

    // setMarginMode is called directly on PerpEngine by the trader
    const modeValue = mode === "cross" ? 1 : 0;

    const hash = await walletClient.writeContract({
      address: this.config.contracts.engine,
      abi: ENGINE_ABI,
      functionName: "setMarginMode",
      args: [modeValue],
    });

    return hash;
  }

  // ============================================================
  //                  WRITE: ORDERS
  // ============================================================

  /**
   * Sign and submit an order via WebSocket.
   *
   * Example:
   *   await sur.submitOrder(walletClient, {
   *     market: "BTC-USD",
   *     side: "buy",
   *     size: 1.5,
   *     price: 50000,
   *   });
   */
  async submitOrder(walletClient: WalletClient, order: OrderInput): Promise<string> {
    if (!walletClient.account) throw new Error("Wallet has no account");

    const trader = walletClient.account.address;
    const mId = marketId(order.market);
    const sizeRaw = toSize(order.size);
    const priceRaw = order.orderType === "market" ? 0n : toPrice(order.price);
    const nonce = BigInt(this.nonceCounter++);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);

    // Sign EIP-712
    const signature = await walletClient.signTypedData({
      domain: { ...EIP712_DOMAIN, chainId: this.chain.id, verifyingContract: this.config.contracts.settlement },
      types: ORDER_TYPES,
      primaryType: "Order",
      message: { trader, marketId: mId, isLong: order.side === "buy", size: sizeRaw, price: priceRaw, nonce, expiry },
    });

    // Send via WebSocket
    this.wsSend({
      type: "submitOrder",
      order: {
        trader,
        marketId: mId,
        side: order.side,
        orderType: order.orderType || "limit",
        price: priceRaw.toString(),
        size: sizeRaw.toString(),
        timeInForce: order.timeInForce || "GTC",
        nonce: nonce.toString(),
        expiry: expiry.toString(),
        signature,
        hidden: order.hidden || false,
      },
    });

    return `order_${nonce}`;
  }

  /** Cancel an open order */
  cancelOrder(orderId: string): void {
    this.wsSend({ type: "cancelOrder", orderId });
  }

  // ============================================================
  //                  WEBSOCKET: REAL-TIME
  // ============================================================

  /** Connect to the WebSocket API */
  connect(): void {
    if (!this.config.wsUrl) throw new Error("wsUrl not configured");
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.config.wsUrl);

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.dispatchEvent(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connect(), 3000);
    };
  }

  /** Subscribe to a market's orderbook and trades */
  subscribe(market: string): void {
    const mId = marketId(market);
    this.wsSend({ type: "subscribe", channels: [`orderbook:${mId}`, `trades:${mId}`] });
  }

  /** Listen for trade events */
  onTrade(market: string, callback: (trade: TradeEvent) => void): () => void {
    const channel = `trade:${marketId(market)}`;
    return this.addListener(channel, callback);
  }

  /** Listen for orderbook updates */
  onOrderbook(market: string, callback: (book: OrderbookSnapshot) => void): () => void {
    const channel = `orderbook:${marketId(market)}`;
    return this.addListener(channel, callback);
  }

  /** Listen for order status changes */
  onOrderStatus(callback: (status: { orderId: string; status: string; error?: string }) => void): () => void {
    return this.addListener("orderStatus", callback);
  }

  /** Disconnect WebSocket */
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  // ============================================================
  //                  READ: COLLATERAL
  // ============================================================

  /**
   * Get a trader's yield-bearing collateral deposits.
   * Requires collateralManager address in config.
   */
  async getCollateralValue(trader: Hex): Promise<number> {
    if (!this.config.contracts.collateralManager) return 0;
    const raw = await this.publicClient.readContract({
      address: this.config.contracts.collateralManager,
      abi: COLLATERAL_ABI,
      functionName: "getCollateralValue",
      args: [trader],
    });
    return fromPrice(raw);
  }

  /** Get details of a specific collateral deposit */
  async getCollateralDeposit(token: Hex, trader: Hex): Promise<{
    amount: bigint; creditedUsdc: number; currentValue: number;
  }> {
    if (!this.config.contracts.collateralManager) {
      return { amount: 0n, creditedUsdc: 0, currentValue: 0 };
    }
    const [amount, credited, current] = await this.publicClient.readContract({
      address: this.config.contracts.collateralManager,
      abi: COLLATERAL_ABI,
      functionName: "getTraderCollateral",
      args: [token, trader],
    });
    return {
      amount,
      creditedUsdc: fromPrice(credited),
      currentValue: fromPrice(current),
    };
  }

  // ============================================================
  //                  READ: VAULTS
  // ============================================================

  /** Get vault information */
  async getVaultInfo(vaultId: Hex): Promise<VaultInfo | null> {
    if (!this.config.contracts.tradingVault) return null;
    const result = await this.publicClient.readContract({
      address: this.config.contracts.tradingVault,
      abi: VAULT_CONTRACT_ABI,
      functionName: "getVaultInfo",
      args: [vaultId],
    });
    return {
      name: result[0],
      description: result[1],
      manager: result[2] as Hex,
      isPaused: result[3],
      totalShares: result[4],
      totalEquity: fromPrice(result[5]),
      equityPerShare: Number(result[6]) / 1e18,
      performanceFeeBps: Number(result[7]),
      managementFeeBps: Number(result[8]),
      depositorCount: Number(result[9]),
      createdAt: Number(result[10]),
    };
  }

  /** Get a depositor's position in a vault */
  async getVaultPosition(vaultId: Hex, depositor: Hex): Promise<VaultPosition> {
    if (!this.config.contracts.tradingVault) {
      return { shares: 0n, usdcValue: 0, totalDeposited: 0, totalWithdrawn: 0, pnl: 0 };
    }
    const result = await this.publicClient.readContract({
      address: this.config.contracts.tradingVault,
      abi: VAULT_CONTRACT_ABI,
      functionName: "getDepositorInfo",
      args: [vaultId, depositor],
    });
    return {
      shares: result[0],
      usdcValue: fromPrice(result[1]),
      totalDeposited: fromPrice(result[3]),
      totalWithdrawn: fromPrice(result[4]),
      pnl: Number(result[5]) / PRICE_PRECISION,
    };
  }

  // ============================================================
  //                  PRIVATE
  // ============================================================

  private wsSend(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data, (_k, v) => typeof v === "bigint" ? v.toString() : v));
    } else {
      console.warn("[SurSDK] WebSocket not connected. Call sur.connect() first.");
    }
  }

  private addListener(channel: string, callback: (data: any) => void): () => void {
    if (!this.wsListeners.has(channel)) this.wsListeners.set(channel, new Set());
    this.wsListeners.get(channel)!.add(callback);
    return () => this.wsListeners.get(channel)?.delete(callback);
  }

  private dispatchEvent(msg: any): void {
    switch (msg.type) {
      case "trade": {
        const t = msg.trade;
        const event: TradeEvent = {
          id: t.id,
          market: t.marketId,
          price: Number(t.price) / PRICE_PRECISION,
          size: Number(t.size) / SIZE_PRECISION,
          side: t.makerSide === "sell" ? "buy" : "sell",
          timestamp: t.timestamp,
        };
        const channel = `trade:${t.marketId}`;
        this.wsListeners.get(channel)?.forEach((cb) => cb(event));
        break;
      }
      case "orderbookUpdate":
      case "orderbook": {
        const snapshot = msg.snapshot || msg;
        const book: OrderbookSnapshot = {
          bids: (snapshot.bids || []).map(parseBL),
          asks: (snapshot.asks || []).map(parseBL),
          spread: 0,
          midPrice: 0,
        };
        if (book.bids[0] && book.asks[0]) {
          book.spread = book.asks[0].price - book.bids[0].price;
          book.midPrice = (book.asks[0].price + book.bids[0].price) / 2;
        }
        const mId = snapshot.marketId || msg.marketId;
        this.wsListeners.get(`orderbook:${mId}`)?.forEach((cb) => cb(book));
        break;
      }
      case "orderAccepted":
        this.wsListeners.get("orderStatus")?.forEach((cb) => cb({ orderId: msg.orderId, status: msg.status }));
        break;
      case "orderRejected":
        this.wsListeners.get("orderStatus")?.forEach((cb) => cb({ orderId: msg.orderId, status: "rejected", error: msg.reason }));
        break;
      case "orderCancelled":
        this.wsListeners.get("orderStatus")?.forEach((cb) => cb({ orderId: msg.orderId, status: "cancelled" }));
        break;
    }
  }
}

function parseBL(l: any): OrderbookLevel {
  return {
    price: typeof l.price === "number" ? l.price : Number(l.price) / PRICE_PRECISION,
    size: typeof l.totalSize === "number" ? l.totalSize : Number(l.totalSize) / SIZE_PRECISION,
    total: 0,
  };
}

// ============================================================
//                    EXPORTS
// ============================================================

export { marketId as getMarketId };
export default SurClient;
