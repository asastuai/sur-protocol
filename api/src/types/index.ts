/**
 * SUR Protocol - Core Types
 *
 * These types mirror both the Solidity contracts and the Rust matching engine.
 * Precision model:
 *   - Prices: 6 decimals (USDC precision). $50,000 = 50_000_000_000n
 *   - Sizes: 8 decimals (SIZE_PRECISION). 1 BTC = 100_000_000n
 *   - All on-chain values are bigint (matching uint256/int256)
 */

// ============================================================
//                    PRECISION CONSTANTS
// ============================================================

export const PRICE_DECIMALS = 6;
export const SIZE_DECIMALS = 8;
export const PRICE_PRECISION = 10n ** 6n;
export const SIZE_PRECISION = 10n ** 8n;
export const BPS = 10_000n;

// ============================================================
//                       MARKET
// ============================================================

export interface MarketConfig {
  id: `0x${string}`;        // bytes32 market ID (keccak256 of name)
  name: string;              // e.g., "BTC-USD"
  baseAsset: string;
  quoteAsset: string;
  tickSize: bigint;          // minimum price increment
  lotSize: bigint;           // minimum size increment
  minSize: bigint;
  maxLeverage: number;
  makerFeeBps: number;
  takerFeeBps: number;
}

// ============================================================
//                       ORDERS
// ============================================================

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type TimeInForce = "GTC" | "IOC" | "FOK" | "PostOnly";
export type OrderStatus =
  | "open"
  | "partiallyFilled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface Order {
  id: string;                // UUID
  trader: `0x${string}`;    // Ethereum address
  marketId: `0x${string}`;
  side: Side;
  orderType: OrderType;
  price: bigint;             // 6 decimals (0 for market orders)
  size: bigint;              // 8 decimals (original size)
  remaining: bigint;         // 8 decimals (unfilled)
  timeInForce: TimeInForce;
  status: OrderStatus;
  nonce: bigint;             // on-chain nonce for EIP-712
  expiry: bigint;            // unix timestamp
  signature: `0x${string}`;  // EIP-712 signature
  createdAt: number;         // unix ms
  hidden: boolean;           // hidden orders don't appear in public orderbook
}

// ============================================================
//                    SIGNED ORDER (on-chain)
// ============================================================

/** Matches OrderSettlement.SignedOrder struct exactly */
export interface SignedOrderOnChain {
  trader: `0x${string}`;
  marketId: `0x${string}`;
  isLong: boolean;
  size: bigint;
  price: bigint;
  nonce: bigint;
  expiry: bigint;
  signature: `0x${string}`;
}

/** Matches OrderSettlement.MatchedTrade struct */
export interface MatchedTradeOnChain {
  maker: SignedOrderOnChain;
  taker: SignedOrderOnChain;
  executionPrice: bigint;
  executionSize: bigint;
}

// ============================================================
//                       TRADES
// ============================================================

export interface Trade {
  id: string;
  marketId: `0x${string}`;
  price: bigint;
  size: bigint;
  makerOrderId: string;
  takerOrderId: string;
  makerTrader: `0x${string}`;
  takerTrader: `0x${string}`;
  makerSide: Side;
  takerSide: Side;
  timestamp: number;
}

// ============================================================
//                    ORDERBOOK SNAPSHOT
// ============================================================

export interface PriceLevel {
  price: bigint;
  totalSize: bigint;
  orderCount: number;
}

export interface OrderbookSnapshot {
  marketId: `0x${string}`;
  bids: PriceLevel[];  // sorted descending (best bid first)
  asks: PriceLevel[];  // sorted ascending (best ask first)
  timestamp: number;
}

// ============================================================
//                    WS MESSAGE TYPES
// ============================================================

export type ClientMessage =
  | { type: "subscribe"; channels: string[] }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "submitOrder"; order: SubmitOrderRequest }
  | { type: "cancelOrder"; orderId: string }
  | { type: "getAccountDetails"; trader: `0x${string}` }
  | { type: "ping" };

export interface SubmitOrderRequest {
  trader: `0x${string}`;
  marketId: `0x${string}`;
  side: Side;
  orderType: OrderType;
  price: string;          // string to avoid JSON bigint issues
  size: string;
  timeInForce: TimeInForce;
  nonce: string;
  expiry: string;
  signature: `0x${string}`;
  hidden?: boolean;       // hidden orders don't appear in public orderbook
}

export type ServerMessage =
  | { type: "orderAccepted"; orderId: string; status: OrderStatus }
  | { type: "orderRejected"; orderId: string; reason: string }
  | { type: "orderCancelled"; orderId: string }
  | { type: "trade"; trade: TradeMessage }
  | { type: "orderbook"; snapshot: OrderbookSnapshot }
  | { type: "orderbookUpdate"; marketId: `0x${string}`; bids: PriceLevel[]; asks: PriceLevel[] }
  | { type: "accountDetails"; details: AccountDetailsMessage }
  | { type: "pong" }
  | { type: "error"; message: string };

export interface AccountDetailsMessage {
  trader: string;
  mode: "isolated" | "cross";
  totalEquity: string;
  totalInitialRequired: string;
  totalMaintenanceRequired: string;
  totalNotional: string;
  freeBalance: string;
  positionCount: number;
  totalUnrealizedPnl: string;
  isLiquidatable: boolean;
}

export interface TradeMessage {
  id: string;
  marketId: string;
  price: string;
  size: string;
  makerSide: Side;
  timestamp: number;
}

// ============================================================
//                   SETTLEMENT BATCH
// ============================================================

export interface SettlementBatch {
  id: number;
  trades: MatchedTradeOnChain[];
  createdAt: number;
  status: "pending" | "submitted" | "confirmed" | "failed";
  txHash?: `0x${string}`;
}

// ============================================================
//                     HELPERS
// ============================================================

/** Convert human-readable price to 6-decimal bigint */
export function toPrice(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e6));
}

/** Convert human-readable size to 8-decimal bigint */
export function toSize(amount: number): bigint {
  return BigInt(Math.round(amount * 1e8));
}

/** Convert 6-decimal bigint to human-readable price */
export function fromPrice(raw: bigint): number {
  return Number(raw) / 1e6;
}

/** Convert 8-decimal bigint to human-readable size */
export function fromSize(raw: bigint): number {
  return Number(raw) / 1e8;
}

/** Calculate notional: price * size / SIZE_PRECISION */
export function notional(price: bigint, size: bigint): bigint {
  return (price * size) / SIZE_PRECISION;
}
