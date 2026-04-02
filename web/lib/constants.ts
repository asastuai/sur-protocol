/**
 * SUR Protocol - Frontend Constants
 *
 * Market configs, contract addresses, and precision helpers.
 * These must match the backend API and smart contracts exactly.
 */

import { keccak256, toHex, type Hex } from "viem";
import { baseSepolia, base } from "viem/chains";

// ============================================================
//                    ENVIRONMENT
// ============================================================

export const IS_TESTNET = process.env.NEXT_PUBLIC_CHAIN_ID !== "8453";
export const CHAIN = IS_TESTNET ? baseSepolia : base;
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3002";

// ============================================================
//                 CONTRACT ADDRESSES
// ============================================================

export const CONTRACTS = {
  vault: (process.env.NEXT_PUBLIC_VAULT_ADDRESS || "0x") as Hex,
  engine: (process.env.NEXT_PUBLIC_ENGINE_ADDRESS || "0x") as Hex,
  settlement: (process.env.NEXT_PUBLIC_SETTLEMENT_ADDRESS || "0x") as Hex,
} as const;

// ============================================================
//                    PRECISION
// ============================================================

export const PRICE_DECIMALS = 6;
export const SIZE_DECIMALS = 8;
export const PRICE_PRECISION = 10n ** 6n;
export const SIZE_PRECISION = 10n ** 8n;

/** "$50,000.00" → 50000000000n */
export function toPrice(dollars: number): bigint {
  return BigInt(Math.round(dollars * 1e6));
}

/** "1.5 BTC" → 150000000n */
export function toSize(amount: number): bigint {
  return BigInt(Math.round(amount * 1e8));
}

/** 50000000000n → 50000.00 */
export function fromPrice(raw: bigint | string): number {
  return Number(BigInt(raw)) / 1e6;
}

/** 150000000n → 1.5 */
export function fromSize(raw: bigint | string): number {
  return Number(BigInt(raw)) / 1e8;
}

/** Format price for display: "$50,125.42" */
export function fmtPrice(raw: bigint | string | number): string {
  const n = typeof raw === "number" ? raw : fromPrice(raw as bigint);
  return n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format size for display: "1.5000" */
export function fmtSize(raw: bigint | string | number): string {
  const n = typeof raw === "number" ? raw : fromSize(raw as bigint);
  return n.toFixed(4);
}

// ============================================================
//                    MARKETS
// ============================================================

export function marketId(name: string): Hex {
  return keccak256(toHex(name)) as Hex;
}

export interface MarketMeta {
  id: Hex;
  name: string;
  baseAsset: string;
  quoteAsset: string;
  maxLeverage: number;
  tickSize: number;    // in dollars
  lotSize: number;     // in base asset
  makerFeeBps: number;
  takerFeeBps: number;
}

// ============================================================
//                LEVERAGE TIERS
// ============================================================

export interface LeverageTier {
  maxNotionalUsd: number; // max notional in USD for this tier. 0 = unlimited (last tier)
  maxLeverage: number;    // max leverage for this tier
  initialMarginBps: number; // basis points (200 = 2% = 50x)
  maintenanceMarginBps: number; // basis points
}

export interface MarketRiskConfig {
  tiers: LeverageTier[];
  oiCapUsd: number;       // max total OI in USD. 0 = unlimited
}

export const MARKET_RISK_CONFIGS: Record<string, MarketRiskConfig> = {
  "BTC-USD": {
    tiers: [
      { maxNotionalUsd: 100_000,   maxLeverage: 50,  initialMarginBps: 200,  maintenanceMarginBps: 100 },
      { maxNotionalUsd: 500_000,   maxLeverage: 25,  initialMarginBps: 400,  maintenanceMarginBps: 200 },
      { maxNotionalUsd: 2_000_000, maxLeverage: 10,  initialMarginBps: 1000, maintenanceMarginBps: 500 },
      { maxNotionalUsd: 0,         maxLeverage: 5,   initialMarginBps: 2000, maintenanceMarginBps: 1000 },
    ],
    oiCapUsd: 3_000_000,
  },
  "ETH-USD": {
    tiers: [
      { maxNotionalUsd: 50_000,    maxLeverage: 50,  initialMarginBps: 200,  maintenanceMarginBps: 100 },
      { maxNotionalUsd: 250_000,   maxLeverage: 25,  initialMarginBps: 400,  maintenanceMarginBps: 200 },
      { maxNotionalUsd: 1_000_000, maxLeverage: 10,  initialMarginBps: 1000, maintenanceMarginBps: 500 },
      { maxNotionalUsd: 0,         maxLeverage: 5,   initialMarginBps: 2000, maintenanceMarginBps: 1000 },
    ],
    oiCapUsd: 2_000_000,
  },
  "SOL-USD": {
    tiers: [
      { maxNotionalUsd: 50_000,    maxLeverage: 25,  initialMarginBps: 400,  maintenanceMarginBps: 200 },
      { maxNotionalUsd: 250_000,   maxLeverage: 10,  initialMarginBps: 1000, maintenanceMarginBps: 500 },
      { maxNotionalUsd: 0,         maxLeverage: 5,   initialMarginBps: 2000, maintenanceMarginBps: 1000 },
    ],
    oiCapUsd: 1_000_000,
  },
  "BNB-USD": {
    tiers: [
      { maxNotionalUsd: 50_000,    maxLeverage: 25,  initialMarginBps: 400,  maintenanceMarginBps: 200 },
      { maxNotionalUsd: 250_000,   maxLeverage: 10,  initialMarginBps: 1000, maintenanceMarginBps: 500 },
      { maxNotionalUsd: 0,         maxLeverage: 5,   initialMarginBps: 2000, maintenanceMarginBps: 1000 },
    ],
    oiCapUsd: 1_000_000,
  },
};

/** Calculate required margin using tiered brackets (like tax brackets) */
export function calculateTieredMargin(marketName: string, notionalUsd: number): number {
  const config = MARKET_RISK_CONFIGS[marketName];
  if (!config || config.tiers.length === 0) {
    // Fallback: use MarketMeta maxLeverage
    const market = MARKETS.find(m => m.name === marketName);
    return market ? notionalUsd / market.maxLeverage : notionalUsd / 20;
  }

  let totalMargin = 0;
  let remaining = notionalUsd;
  let prevMax = 0;

  for (const tier of config.tiers) {
    if (remaining <= 0) break;

    let tierSize: number;
    if (tier.maxNotionalUsd === 0) {
      // Last tier (unlimited)
      tierSize = remaining;
    } else {
      tierSize = Math.min(remaining, tier.maxNotionalUsd - prevMax);
    }

    totalMargin += tierSize * (tier.initialMarginBps / 10000);
    remaining -= tierSize;
    prevMax = tier.maxNotionalUsd;
  }

  return totalMargin;
}

/** Get max leverage for a given notional size */
export function getMaxLeverageForSize(marketName: string, notionalUsd: number): number {
  const config = MARKET_RISK_CONFIGS[marketName];
  if (!config || config.tiers.length === 0) {
    const market = MARKETS.find(m => m.name === marketName);
    return market?.maxLeverage || 20;
  }

  // The effective max leverage is determined by the highest tier the notional falls into
  for (const tier of config.tiers) {
    if (tier.maxNotionalUsd === 0 || notionalUsd <= tier.maxNotionalUsd) {
      return tier.maxLeverage;
    }
  }

  // Fallback to last tier
  return config.tiers[config.tiers.length - 1].maxLeverage;
}

/** Get effective leverage for a position (notional / required margin) */
export function getEffectiveLeverage(marketName: string, notionalUsd: number): number {
  const margin = calculateTieredMargin(marketName, notionalUsd);
  if (margin <= 0) return 0;
  return notionalUsd / margin;
}

export const MARKETS: MarketMeta[] = [
  {
    id: marketId("BTC-USD"),
    name: "BTC-USD",
    baseAsset: "BTC",
    quoteAsset: "USD",
    maxLeverage: 50,
    tickSize: 0.01,
    lotSize: 0.0001,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("ETH-USD"),
    name: "ETH-USD",
    baseAsset: "ETH",
    quoteAsset: "USD",
    maxLeverage: 50,
    tickSize: 0.01,
    lotSize: 0.001,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("SOL-USD"),
    name: "SOL-USD",
    baseAsset: "SOL",
    quoteAsset: "USD",
    maxLeverage: 25,
    tickSize: 0.01,
    lotSize: 0.01,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("BNB-USD"),
    name: "BNB-USD",
    baseAsset: "BNB",
    quoteAsset: "USD",
    maxLeverage: 25,
    tickSize: 0.01,
    lotSize: 0.01,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("XRP-USD"),
    name: "XRP-USD",
    baseAsset: "XRP",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("DOGE-USD"),
    name: "DOGE-USD",
    baseAsset: "DOGE",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.00001,
    lotSize: 10,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("ADA-USD"),
    name: "ADA-USD",
    baseAsset: "ADA",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("AVAX-USD"),
    name: "AVAX-USD",
    baseAsset: "AVAX",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.01,
    lotSize: 0.1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("LINK-USD"),
    name: "LINK-USD",
    baseAsset: "LINK",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.001,
    lotSize: 0.1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("SUI-USD"),
    name: "SUI-USD",
    baseAsset: "SUI",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("ARB-USD"),
    name: "ARB-USD",
    baseAsset: "ARB",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.0001,
    lotSize: 1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("OP-USD"),
    name: "OP-USD",
    baseAsset: "OP",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.001,
    lotSize: 0.1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("NEAR-USD"),
    name: "NEAR-USD",
    baseAsset: "NEAR",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.001,
    lotSize: 0.1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("UNI-USD"),
    name: "UNI-USD",
    baseAsset: "UNI",
    quoteAsset: "USD",
    maxLeverage: 20,
    tickSize: 0.001,
    lotSize: 0.1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
  {
    id: marketId("WIF-USD"),
    name: "WIF-USD",
    baseAsset: "WIF",
    quoteAsset: "USD",
    maxLeverage: 10,
    tickSize: 0.0001,
    lotSize: 1,
    makerFeeBps: 2,
    takerFeeBps: 6,
  },
];

export const DEFAULT_MARKET = MARKETS[0];

// Binance symbol mapping for real price feeds
export const BINANCE_SYMBOLS: Record<string, string> = {
  "BTC-USD": "btcusdt",
  "ETH-USD": "ethusdt",
  "SOL-USD": "solusdt",
  "BNB-USD": "bnbusdt",
  "XRP-USD": "xrpusdt",
  "DOGE-USD": "dogeusdt",
  "ADA-USD": "adausdt",
  "AVAX-USD": "avaxusdt",
  "LINK-USD": "linkusdt",
  "SUI-USD": "suiusdt",
  "ARB-USD": "arbusdt",
  "OP-USD": "opusdt",
  "NEAR-USD": "nearusdt",
  "UNI-USD": "uniusdt",
  "WIF-USD": "wifusdt",
};

export const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws";
export const BINANCE_REST_URL = "https://api.binance.com/api/v3";

// ============================================================
//                  EIP-712 CONFIG
// ============================================================

export const EIP712_DOMAIN = {
  name: "SUR Protocol",
  version: "1",
} as const;

export const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "isLong", type: "bool" },
    { name: "size", type: "uint256" },
    { name: "price", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;
