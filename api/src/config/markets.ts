/**
 * SUR Protocol - Stock Perpetual Markets Configuration
 *
 * Adds US equity perpetuals alongside crypto markets.
 * These trade 24/7 (unlike traditional stocks) using Pyth oracle feeds.
 *
 * Key differences from crypto perps:
 * - Higher initial margin (10% vs 5%) — stocks are less volatile but less liquid on-chain
 * - Lower max leverage (10x vs 20x)
 * - Pyth stock feeds update during US market hours + extended hours
 * - After-hours feeds may have wider confidence intervals
 *
 * Pyth publishes stock prices from multiple data sources including
 * Nasdaq, NYSE, and CBOE. Feeds are available on Base L2.
 */

import { keccak256, toHex, type Hex } from "viem";

// ============================================================
//                    MARKET CONFIGS
// ============================================================

export interface StockMarketConfig {
  name: string;                // "AAPL-USD"
  displayName: string;         // "Apple Inc."
  ticker: string;              // "AAPL"
  marketId: Hex;               // keccak256 of name
  pythFeedId: Hex;             // Pyth price feed ID
  category: "tech" | "finance" | "auto" | "energy" | "index";
  initialMarginBps: number;    // 1000 = 10%
  maintenanceMarginBps: number;// 500 = 5%
  maxPositionSize: bigint;     // in SIZE_PRECISION (8 decimals)
  maxLeverage: number;
  tickSize: number;            // minimum price increment (USD)
  fundingIntervalSecs: number;
}

function makeMarketId(name: string): Hex {
  return keccak256(toHex(name)) as Hex;
}

// ============================================================
//   PYTH STOCK FEED IDs (Base Mainnet / Sepolia)
//   Source: https://pyth.network/price-feeds
// ============================================================

export const STOCK_MARKETS: StockMarketConfig[] = [
  // ── TECH ──
  {
    name: "AAPL-USD",
    displayName: "Apple Inc.",
    ticker: "AAPL",
    marketId: makeMarketId("AAPL-USD"),
    pythFeedId: "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688" as Hex,
    category: "tech",
    initialMarginBps: 1000,    // 10% → 10x max leverage
    maintenanceMarginBps: 500, // 5%
    maxPositionSize: 100_000_00000000n, // 100,000 shares
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
  {
    name: "TSLA-USD",
    displayName: "Tesla Inc.",
    ticker: "TSLA",
    marketId: makeMarketId("TSLA-USD"),
    pythFeedId: "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1" as Hex,
    category: "auto",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxPositionSize: 50_000_00000000n,
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
  {
    name: "AMZN-USD",
    displayName: "Amazon.com Inc.",
    ticker: "AMZN",
    marketId: makeMarketId("AMZN-USD"),
    pythFeedId: "0xb5d0e0fa58a1fdc967f1a9bc7924cf3db30f480bdaf4546fdf73e8e8b1a9920c" as Hex,
    category: "tech",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxPositionSize: 50_000_00000000n,
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
  {
    name: "NVDA-USD",
    displayName: "NVIDIA Corp.",
    ticker: "NVDA",
    marketId: makeMarketId("NVDA-USD"),
    pythFeedId: "0x20a938f54b68f1f2ef18ea0328f6dd0747f8ea11486d22b021e83a900be89776" as Hex,
    category: "tech",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxPositionSize: 50_000_00000000n,
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
  {
    name: "MSFT-USD",
    displayName: "Microsoft Corp.",
    ticker: "MSFT",
    marketId: makeMarketId("MSFT-USD"),
    pythFeedId: "0xd0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1" as Hex,
    category: "tech",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxPositionSize: 50_000_00000000n,
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
  {
    name: "GOOG-USD",
    displayName: "Alphabet Inc.",
    ticker: "GOOG",
    marketId: makeMarketId("GOOG-USD"),
    pythFeedId: "0xe65ff435be2f83fdb38a4263d3e06e8c8e5d29342fdd5a5a6e4e9b5636a78f5e" as Hex,
    category: "tech",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxPositionSize: 50_000_00000000n,
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
  {
    name: "META-USD",
    displayName: "Meta Platforms Inc.",
    ticker: "META",
    marketId: makeMarketId("META-USD"),
    pythFeedId: "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b" as Hex,
    category: "tech",
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxPositionSize: 30_000_00000000n,
    maxLeverage: 10,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },

  // ── FINANCE ──
  {
    name: "COIN-USD",
    displayName: "Coinbase Global Inc.",
    ticker: "COIN",
    marketId: makeMarketId("COIN-USD"),
    pythFeedId: "0xffff00e31a041e569e04f0266aca30e4fef2baa02b3061fdddeb97edceb35bdc" as Hex,
    category: "finance",
    initialMarginBps: 1200,    // 12% — more volatile
    maintenanceMarginBps: 600,
    maxPositionSize: 30_000_00000000n,
    maxLeverage: 8,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },

  // ── INDEX (SPY as a proxy for S&P 500) ──
  {
    name: "SPY-USD",
    displayName: "S&P 500 ETF",
    ticker: "SPY",
    marketId: makeMarketId("SPY-USD"),
    pythFeedId: "0x19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5" as Hex,
    category: "index",
    initialMarginBps: 800,     // 8% — index is less volatile
    maintenanceMarginBps: 400,
    maxPositionSize: 10_000_00000000n,
    maxLeverage: 12,
    tickSize: 0.01,
    fundingIntervalSecs: 28800,
  },
];

// ============================================================
//                   CRYPTO MARKETS (existing)
// ============================================================

// ============================================================
//                   LEVERAGE TIER CONFIG
// ============================================================

export interface MarginTier {
  maxNotionalUsd: number;     // max notional for this tier. 0 = unlimited (last tier)
  initialMarginBps: number;
  maintenanceMarginBps: number;
  maxLeverage: number;        // derived: BPS / initialMarginBps
}

export interface MarketRiskConfig {
  tiers: MarginTier[];
  oiCapUsd: number;           // max total OI in USD. 0 = unlimited
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
      { maxNotionalUsd: 25_000,    maxLeverage: 30,  initialMarginBps: 333,  maintenanceMarginBps: 167 },
      { maxNotionalUsd: 100_000,   maxLeverage: 15,  initialMarginBps: 667,  maintenanceMarginBps: 333 },
      { maxNotionalUsd: 500_000,   maxLeverage: 5,   initialMarginBps: 2000, maintenanceMarginBps: 1000 },
      { maxNotionalUsd: 0,         maxLeverage: 3,   initialMarginBps: 3333, maintenanceMarginBps: 1667 },
    ],
    oiCapUsd: 1_000_000,
  },
};

export const CRYPTO_MARKETS = [
  {
    name: "BTC-USD",
    displayName: "Bitcoin",
    ticker: "BTC",
    marketId: makeMarketId("BTC-USD"),
    pythFeedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" as Hex,
    category: "crypto" as const,
    initialMarginBps: 200,      // Tier 1: 2% = 50x
    maintenanceMarginBps: 100,
    maxLeverage: 50,
    riskConfig: MARKET_RISK_CONFIGS["BTC-USD"],
  },
  {
    name: "ETH-USD",
    displayName: "Ethereum",
    ticker: "ETH",
    marketId: makeMarketId("ETH-USD"),
    pythFeedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" as Hex,
    category: "crypto" as const,
    initialMarginBps: 200,
    maintenanceMarginBps: 100,
    maxLeverage: 50,
    riskConfig: MARKET_RISK_CONFIGS["ETH-USD"],
  },
  {
    name: "SOL-USD",
    displayName: "Solana",
    ticker: "SOL",
    marketId: makeMarketId("SOL-USD"),
    pythFeedId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" as Hex,
    category: "crypto" as const,
    initialMarginBps: 333,
    maintenanceMarginBps: 167,
    maxLeverage: 30,
    riskConfig: MARKET_RISK_CONFIGS["SOL-USD"],
  },
];

// ============================================================
//                   YIELD-BEARING COLLATERAL
// ============================================================

export interface CollateralConfig {
  symbol: string;
  name: string;
  address: { mainnet: Hex; testnet: Hex };
  decimals: number;
  haircutBps: number;      // 9500 = 95% credited
  pythFeedId: Hex;         // for price oracle
  yieldSource: string;     // e.g., "Coinbase ETH Staking", "Lido"
  estimatedApy: number;    // approximate APY for display
}

export const YIELD_COLLATERALS: CollateralConfig[] = [
  {
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    address: {
      mainnet: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22" as Hex, // Base mainnet
      testnet: "0x0000000000000000000000000000000000000000" as Hex,   // TBD on Sepolia
    },
    decimals: 18,
    haircutBps: 9500,  // 95% — 5% discount for depeg risk
    pythFeedId: "0x15ecddd26d49e1a8f1de9376ebebc03916ede873447c1255d2d5891b92ce5717" as Hex,
    yieldSource: "Coinbase ETH Staking",
    estimatedApy: 3.2,
  },
  {
    symbol: "wstETH",
    name: "Wrapped Lido Staked ETH",
    address: {
      mainnet: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452" as Hex, // Base mainnet
      testnet: "0x0000000000000000000000000000000000000000" as Hex,
    },
    decimals: 18,
    haircutBps: 9500,
    pythFeedId: "0x6df640f3b8963d8f8358f791f352b8364513f6ab1cca5ed3f1f7b5448980e784" as Hex,
    yieldSource: "Lido Staking",
    estimatedApy: 3.5,
  },
  {
    symbol: "sUSDe",
    name: "Staked USDe (Ethena)",
    address: {
      mainnet: "0x211Cc4DD073734dA055fbF44a2b4667d5E5fE5d2" as Hex, // Base
      testnet: "0x0000000000000000000000000000000000000000" as Hex,
    },
    decimals: 18,
    haircutBps: 9000,  // 90% — stablecoin but with delta-neutral risk
    pythFeedId: "0xca3ba9a619a4b3755c10ac7d5e760275aa95e9823d38a84fedd416856cdba37c" as Hex,
    yieldSource: "Ethena Delta-Neutral",
    estimatedApy: 15.0,
  },
];

// ============================================================
//                   ALL MARKETS (combined)
// ============================================================

export const ALL_MARKETS = [
  ...CRYPTO_MARKETS.map(m => ({ ...m, type: "crypto" as const })),
  ...STOCK_MARKETS.map(m => ({ ...m, type: "stock" as const })),
];

export const ALL_PYTH_FEED_IDS = [
  ...CRYPTO_MARKETS.map(m => m.pythFeedId),
  ...STOCK_MARKETS.map(m => m.pythFeedId),
  ...YIELD_COLLATERALS.map(c => c.pythFeedId),
];
