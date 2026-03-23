import { type Hex, type HttpTransportConfig } from "viem";
import { baseSepolia, base } from "viem/chains";
import { type MarketConfig, PRICE_PRECISION, SIZE_PRECISION } from "../types/index.js";
import { keccak256, toHex, http, fallback } from "viem";

// ============================================================
//                    ENVIRONMENT
// ============================================================

export interface Config {
  // Server
  port: number;
  wsPort: number;

  // Chain
  chain: typeof baseSepolia | typeof base;
  rpcUrl: string;
  rpcUrls: string[]; // primary + fallbacks

  // Contracts (set after deployment)
  contracts: {
    vault: Hex;
    engine: Hex;
    settlement: Hex;
    liquidator: Hex;
    insuranceFund: Hex;
    oracleRouter: Hex;
  };

  // Operator (private key that submits settlement batches)
  operatorPrivateKey: Hex;

  // Settlement
  batchIntervalMs: number;     // how often to flush settlement batches
  maxBatchSize: number;         // max trades per batch

  // Markets
  markets: MarketConfig[];
}

export function loadConfig(): Config {
  const isTestnet = process.env.NETWORK !== "mainnet";

  // Validate private key
  const operatorPk = process.env.OPERATOR_PRIVATE_KEY;
  if (!operatorPk || operatorPk === "0x" || !/^0x[a-fA-F0-9]{64}$/.test(operatorPk)) {
    console.error("[Fatal] OPERATOR_PRIVATE_KEY is missing or invalid.");
    console.error("  → Must be a 32-byte hex string (0x + 64 hex chars).");
    console.error("  → Set it in Railway env vars, NOT in .env files.");
    process.exit(1);
  }

  // Validate required contract addresses
  const requiredAddresses: Record<string, string | undefined> = {
    VAULT_ADDRESS: process.env.VAULT_ADDRESS,
    ENGINE_ADDRESS: process.env.ENGINE_ADDRESS,
    SETTLEMENT_ADDRESS: process.env.SETTLEMENT_ADDRESS,
  };

  for (const [name, value] of Object.entries(requiredAddresses)) {
    if (!value || value === "0x" || !/^0x[a-fA-F0-9]{40}$/.test(value)) {
      console.error(`[Fatal] ${name} is missing or invalid (got: "${value || ""}")`);
      console.error("  → Must be a valid Ethereum address (0x + 40 hex chars).");
      process.exit(1);
    }
  }

  // Validate RPC URL
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl && !isTestnet) {
    console.error("[Fatal] RPC_URL is required for mainnet.");
    process.exit(1);
  }

  // Parse fallback RPC URLs (comma-separated)
  const primaryRpc = rpcUrl || "https://sepolia.base.org";
  const fallbackRpcs = process.env.RPC_URLS_FALLBACK
    ? process.env.RPC_URLS_FALLBACK.split(",").map((u) => u.trim()).filter(Boolean)
    : [];
  const allRpcs = [primaryRpc, ...fallbackRpcs];

  if (fallbackRpcs.length > 0) {
    console.log(`[Config] RPC fallbacks configured: ${fallbackRpcs.length} backup(s)`);
  }

  return {
    port: parseInt(process.env.API_PORT || "3001"),
    wsPort: parseInt(process.env.WS_PORT || "3002"),

    chain: isTestnet ? baseSepolia : base,
    rpcUrl: primaryRpc,
    rpcUrls: allRpcs,

    contracts: {
      vault: process.env.VAULT_ADDRESS as Hex,
      engine: process.env.ENGINE_ADDRESS as Hex,
      settlement: process.env.SETTLEMENT_ADDRESS as Hex,
      liquidator: (process.env.LIQUIDATOR_ADDRESS || "0x") as Hex,
      insuranceFund: (process.env.INSURANCE_FUND_ADDRESS || "0x") as Hex,
      oracleRouter: (process.env.ORACLE_ROUTER_ADDRESS || "0x") as Hex,
    },

    operatorPrivateKey: operatorPk as Hex,

    batchIntervalMs: parseInt(process.env.BATCH_INTERVAL_MS || "2000"),
    maxBatchSize: parseInt(process.env.MAX_BATCH_SIZE || "50"),

    markets: defaultMarkets(),
  };
}

// ============================================================
//                    DEFAULT MARKETS
// ============================================================

function marketId(name: string): Hex {
  return keccak256(toHex(name)) as Hex;
}

function defaultMarkets(): MarketConfig[] {
  return [
    {
      id: marketId("BTC-USD"),
      name: "BTC-USD",
      baseAsset: "BTC",
      quoteAsset: "USD",
      tickSize: 100n,                    // $0.0001
      lotSize: 1000n,                    // 0.00001 BTC
      minSize: 10_000n,                  // 0.0001 BTC
      maxLeverage: 20,
      makerFeeBps: 2,
      takerFeeBps: 6,
    },
    {
      id: marketId("ETH-USD"),
      name: "ETH-USD",
      baseAsset: "ETH",
      quoteAsset: "USD",
      tickSize: 100n,
      lotSize: 10_000n,                  // 0.0001 ETH
      minSize: 100_000n,                 // 0.001 ETH
      maxLeverage: 15,
      makerFeeBps: 2,
      takerFeeBps: 6,
    },
  ];
}

// ============================================================
//                    CONTRACT ABIs (minimal)
// ============================================================

export const SETTLEMENT_ABI = [
  {
    name: "settleOne",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "trade",
        type: "tuple",
        components: [
          {
            name: "maker",
            type: "tuple",
            components: [
              { name: "trader", type: "address" },
              { name: "marketId", type: "bytes32" },
              { name: "isLong", type: "bool" },
              { name: "size", type: "uint256" },
              { name: "price", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "expiry", type: "uint256" },
              { name: "signature", type: "bytes" },
            ],
          },
          {
            name: "taker",
            type: "tuple",
            components: [
              { name: "trader", type: "address" },
              { name: "marketId", type: "bytes32" },
              { name: "isLong", type: "bool" },
              { name: "size", type: "uint256" },
              { name: "price", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "expiry", type: "uint256" },
              { name: "signature", type: "bytes" },
            ],
          },
          { name: "executionPrice", type: "uint256" },
          { name: "executionSize", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "settleBatch",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "trades",
        type: "tuple[]",
        components: [
          {
            name: "maker",
            type: "tuple",
            components: [
              { name: "trader", type: "address" },
              { name: "marketId", type: "bytes32" },
              { name: "isLong", type: "bool" },
              { name: "size", type: "uint256" },
              { name: "price", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "expiry", type: "uint256" },
              { name: "signature", type: "bytes" },
            ],
          },
          {
            name: "taker",
            type: "tuple",
            components: [
              { name: "trader", type: "address" },
              { name: "marketId", type: "bytes32" },
              { name: "isLong", type: "bool" },
              { name: "size", type: "uint256" },
              { name: "price", type: "uint256" },
              { name: "nonce", type: "uint256" },
              { name: "expiry", type: "uint256" },
              { name: "signature", type: "bytes" },
            ],
          },
          { name: "executionPrice", type: "uint256" },
          { name: "executionSize", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: "isNonceUsed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "trader", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "batchCounter",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const ENGINE_ABI = [
  {
    name: "getPosition",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [
      { name: "size", type: "int256" },
      { name: "entryPrice", type: "uint256" },
      { name: "margin", type: "uint256" },
      { name: "unrealizedPnl", type: "int256" },
      { name: "marginRatioBps", type: "uint256" },
    ],
  },
  {
    name: "isLiquidatable",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getUnrealizedPnl",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [{ type: "int256" }],
  },
] as const;

export const VAULT_ABI = [
  {
    name: "balances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// ============================================================
//                    RPC TRANSPORT
// ============================================================

/** Creates a viem transport with fallback support if multiple RPC URLs configured */
export function createTransport(config: Config) {
  if (config.rpcUrls.length <= 1) {
    return http(config.rpcUrl, { timeout: 30_000 });
  }

  return fallback(
    config.rpcUrls.map((url) => http(url, { timeout: 20_000 })),
    { rank: true } // auto-rank RPCs by latency
  );
}
