/**
 * SUR Protocol - Risk Metrics Calculator
 *
 * Reads on-chain state and computes protocol-level risk indicators.
 * Used by the main risk engine loop to generate alerts and dashboards.
 */

import { type PublicClient, type Hex, parseAbiItem } from "viem";

// ============================================================
//                    TYPES
// ============================================================

export type RiskLevel = "GREEN" | "YELLOW" | "ORANGE" | "RED" | "CRITICAL";

export interface MarketRisk {
  name: string;
  marketId: Hex;
  active: boolean;

  // Prices
  markPrice: number;
  indexPrice: number;
  premiumPct: number;          // (mark - index) / index * 100

  // Open Interest
  oiLong: number;              // in base asset
  oiShort: number;
  oiTotal: number;
  oiImbalanceRatio: number;    // |long - short| / total (0 = balanced, 1 = fully one-sided)
  oiNotionalUsd: number;       // total OI in USD

  // Funding
  currentFundingRate: number;  // per interval, percentage
  annualizedFundingRate: number;
  cumulativeFunding: bigint;

  // Risk levels
  premiumRisk: RiskLevel;
  oiImbalanceRisk: RiskLevel;
  fundingRisk: RiskLevel;
  overallRisk: RiskLevel;
}

export interface InsuranceFundRisk {
  balance: number;             // USDC
  totalOiNotional: number;     // total protocol OI in USD
  coverageRatio: number;       // balance / totalOI (how much bad debt we can absorb)
  risk: RiskLevel;
}

export interface VaultRisk {
  totalDeposits: number;
  actualUsdc: number;
  surplus: number;             // actual - deposits (should be >= 0)
  healthy: boolean;
  risk: RiskLevel;
}

export interface LiquidationRisk {
  nearLiquidationCount: number;    // positions within 20% of maintenance margin
  totalNearLiqNotional: number;    // USD value of those positions
  cascadeRisk: RiskLevel;
}

export interface ProtocolRiskSnapshot {
  timestamp: number;
  blockNumber: bigint;
  markets: MarketRisk[];
  insuranceFund: InsuranceFundRisk;
  vault: VaultRisk;
  liquidationRisk: LiquidationRisk;
  overallRisk: RiskLevel;
  alerts: RiskAlert[];
}

export interface RiskAlert {
  severity: RiskLevel;
  category: string;
  message: string;
  market?: string;
  value?: number;
  threshold?: number;
  timestamp: number;
}

// ============================================================
//                    THRESHOLDS
// ============================================================

export const THRESHOLDS = {
  // Premium (mark vs index deviation)
  premiumYellow: 0.5,      // 0.5%
  premiumOrange: 1.0,      // 1%
  premiumRed: 2.0,         // 2%
  premiumCritical: 5.0,    // 5%

  // OI Imbalance
  oiImbalanceYellow: 0.3,  // 30% imbalanced
  oiImbalanceOrange: 0.5,  // 50%
  oiImbalanceRed: 0.7,     // 70%
  oiImbalanceCritical: 0.9,// 90%

  // Funding rate (annualized)
  fundingYellow: 50,       // 50% APR
  fundingOrange: 100,      // 100% APR
  fundingRed: 200,         // 200% APR
  fundingCritical: 500,    // 500% APR

  // Insurance fund coverage
  insuranceYellow: 0.05,   // 5% of OI
  insuranceOrange: 0.02,   // 2%
  insuranceRed: 0.01,      // 1%
  insuranceCritical: 0.005,// 0.5%

  // Vault surplus (actual - accounted, in USDC)
  vaultRed: -100,          // $100 deficit = RED
};

// ============================================================
//                    CALCULATOR
// ============================================================

const PRICE_P = 1e6;
const SIZE_P = 1e8;

const ENGINE_ABI = [
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
    type: "function", name: "isLiquidatable", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function", name: "positions", stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }, { name: "trader", type: "address" }],
    outputs: [
      { name: "size", type: "int256" }, { name: "entryPrice", type: "uint256" },
      { name: "margin", type: "uint256" }, { name: "lastCumulativeFunding", type: "int256" },
      { name: "lastUpdated", type: "uint256" },
    ],
  },
] as const;

const VAULT_ABI = [
  {
    type: "function", name: "totalDeposits", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "balances", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "healthCheck", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "healthy", type: "bool" },
      { name: "actualUsdc", type: "uint256" },
      { name: "accountedUsdc", type: "uint256" },
    ],
  },
] as const;

export class RiskCalculator {
  private client: PublicClient;
  private engineAddress: Hex;
  private vaultAddress: Hex;
  private insuranceFundAddress: Hex;
  private marketConfigs: { name: string; id: Hex }[];

  constructor(
    client: PublicClient,
    engineAddress: Hex,
    vaultAddress: Hex,
    insuranceFundAddress: Hex,
    marketConfigs: { name: string; id: Hex }[],
  ) {
    this.client = client;
    this.engineAddress = engineAddress;
    this.vaultAddress = vaultAddress;
    this.insuranceFundAddress = insuranceFundAddress;
    this.marketConfigs = marketConfigs;
  }

  async computeSnapshot(): Promise<ProtocolRiskSnapshot> {
    const blockNumber = await this.client.getBlockNumber();
    const alerts: RiskAlert[] = [];
    const now = Date.now();

    // ---- Market risks ----
    const markets: MarketRisk[] = [];
    let totalOiNotional = 0;

    for (const mc of this.marketConfigs) {
      const data = await this.client.readContract({
        address: this.engineAddress, abi: ENGINE_ABI,
        functionName: "markets", args: [mc.id],
      });

      const [, , active, , , , markRaw, indexRaw, , cumFunding, lastFundUp, fundInterval, oiLRaw, oiSRaw] = data;

      const mark = Number(markRaw) / PRICE_P;
      const index = Number(indexRaw) / PRICE_P;
      const oiL = Number(oiLRaw) / SIZE_P;
      const oiS = Number(oiSRaw) / SIZE_P;
      const oiTotal = oiL + oiS;
      const oiNotional = mark * oiTotal;
      totalOiNotional += oiNotional;

      const premium = index > 0 ? ((mark - index) / index) * 100 : 0;
      const imbalance = oiTotal > 0 ? Math.abs(oiL - oiS) / oiTotal : 0;

      const fundRate = index > 0 ? ((mark - index) / index) * 100 : 0;
      const intervalsPerYear = (365.25 * 24 * 3600) / Number(fundInterval || 28800);
      const annualized = fundRate * intervalsPerYear;

      // Risk assessments
      const premiumRisk = classify(Math.abs(premium), THRESHOLDS.premiumYellow, THRESHOLDS.premiumOrange, THRESHOLDS.premiumRed, THRESHOLDS.premiumCritical);
      const oiImbalanceRisk = classify(imbalance, THRESHOLDS.oiImbalanceYellow, THRESHOLDS.oiImbalanceOrange, THRESHOLDS.oiImbalanceRed, THRESHOLDS.oiImbalanceCritical);
      const fundingRisk = classify(Math.abs(annualized), THRESHOLDS.fundingYellow, THRESHOLDS.fundingOrange, THRESHOLDS.fundingRed, THRESHOLDS.fundingCritical);
      const overallRisk = worstOf(premiumRisk, oiImbalanceRisk, fundingRisk);

      const mr: MarketRisk = {
        name: mc.name, marketId: mc.id, active, markPrice: mark, indexPrice: index,
        premiumPct: premium, oiLong: oiL, oiShort: oiS, oiTotal, oiImbalanceRatio: imbalance,
        oiNotionalUsd: oiNotional, currentFundingRate: fundRate, annualizedFundingRate: annualized,
        cumulativeFunding: cumFunding, premiumRisk, oiImbalanceRisk, fundingRisk, overallRisk,
      };

      markets.push(mr);

      // Generate alerts
      if (premiumRisk !== "GREEN") {
        alerts.push({ severity: premiumRisk, category: "PREMIUM", market: mc.name, message: `Price premium at ${premium.toFixed(3)}%`, value: Math.abs(premium), timestamp: now });
      }
      if (oiImbalanceRisk !== "GREEN") {
        const heavy = oiL > oiS ? "long" : "short";
        alerts.push({ severity: oiImbalanceRisk, category: "OI_IMBALANCE", market: mc.name, message: `OI ${(imbalance * 100).toFixed(1)}% ${heavy}-heavy (${oiL.toFixed(2)}L / ${oiS.toFixed(2)}S)`, value: imbalance, timestamp: now });
      }
      if (fundingRisk !== "GREEN") {
        alerts.push({ severity: fundingRisk, category: "FUNDING_RATE", market: mc.name, message: `Annualized funding ${annualized >= 0 ? "+" : ""}${annualized.toFixed(1)}%`, value: Math.abs(annualized), timestamp: now });
      }
    }

    // ---- Insurance Fund ----
    const insBal = Number(await this.client.readContract({
      address: this.vaultAddress, abi: VAULT_ABI,
      functionName: "balances", args: [this.insuranceFundAddress],
    })) / PRICE_P;

    const coverageRatio = totalOiNotional > 0 ? insBal / totalOiNotional : 1;
    const insRisk = classifyInverse(coverageRatio, THRESHOLDS.insuranceYellow, THRESHOLDS.insuranceOrange, THRESHOLDS.insuranceRed, THRESHOLDS.insuranceCritical);

    const insuranceFund: InsuranceFundRisk = {
      balance: insBal, totalOiNotional, coverageRatio, risk: insRisk,
    };

    if (insRisk !== "GREEN") {
      alerts.push({ severity: insRisk, category: "INSURANCE_FUND", message: `Coverage ratio ${(coverageRatio * 100).toFixed(2)}% (balance: $${insBal.toFixed(2)} / OI: $${totalOiNotional.toFixed(2)})`, value: coverageRatio, timestamp: now });
    }

    // ---- Vault Health ----
    const [healthy, actualRaw, accountedRaw] = await this.client.readContract({
      address: this.vaultAddress, abi: VAULT_ABI, functionName: "healthCheck", args: [],
    });

    const actual = Number(actualRaw) / PRICE_P;
    const accounted = Number(accountedRaw) / PRICE_P;
    const surplus = actual - accounted;
    const vaultRisk: RiskLevel = !healthy ? "CRITICAL" : surplus < THRESHOLDS.vaultRed ? "RED" : "GREEN";

    const vault: VaultRisk = { totalDeposits: accounted, actualUsdc: actual, surplus, healthy, risk: vaultRisk };

    if (vaultRisk !== "GREEN") {
      alerts.push({ severity: vaultRisk, category: "VAULT_SOLVENCY", message: `Vault ${healthy ? "surplus" : "DEFICIT"}: $${surplus.toFixed(2)} (actual: $${actual.toFixed(2)}, accounted: $${accounted.toFixed(2)})`, value: surplus, timestamp: now });
    }

    // ---- Liquidation cascade risk (simplified) ----
    // In production, this would scan all tracked positions
    const liquidationRisk: LiquidationRisk = {
      nearLiquidationCount: 0, totalNearLiqNotional: 0,
      cascadeRisk: "GREEN",
    };

    // ---- Overall protocol risk ----
    const allRisks = [...markets.map(m => m.overallRisk), insRisk, vaultRisk];
    const overallRisk = allRisks.reduce((worst, r) => worstOf(worst, r), "GREEN" as RiskLevel);

    return {
      timestamp: now, blockNumber, markets, insuranceFund, vault,
      liquidationRisk, overallRisk, alerts,
    };
  }
}

// ============================================================
//                    HELPERS
// ============================================================

function classify(value: number, yellow: number, orange: number, red: number, critical: number): RiskLevel {
  if (value >= critical) return "CRITICAL";
  if (value >= red) return "RED";
  if (value >= orange) return "ORANGE";
  if (value >= yellow) return "YELLOW";
  return "GREEN";
}

function classifyInverse(value: number, yellow: number, orange: number, red: number, critical: number): RiskLevel {
  if (value <= critical) return "CRITICAL";
  if (value <= red) return "RED";
  if (value <= orange) return "ORANGE";
  if (value <= yellow) return "YELLOW";
  return "GREEN";
}

function worstOf(...levels: RiskLevel[]): RiskLevel {
  const order: RiskLevel[] = ["GREEN", "YELLOW", "ORANGE", "RED", "CRITICAL"];
  let worst = 0;
  for (const l of levels) {
    const idx = order.indexOf(l);
    if (idx > worst) worst = idx;
  }
  return order[worst];
}
