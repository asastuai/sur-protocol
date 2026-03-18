/**
 * SUR Keeper - Contract ABIs
 *
 * Minimal ABIs for the keeper bot. Only includes functions/events we actually use.
 */

import { type Hex } from "viem";

// ============================================================
//                    PERP ENGINE ABI
// ============================================================

export const ENGINE_ABI = [
  // Events for position tracking
  {
    type: "event",
    name: "PositionOpened",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "size", type: "int256", indexed: false },
      { name: "entryPrice", type: "uint256", indexed: false },
      { name: "margin", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PositionModified",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "oldSize", type: "int256", indexed: false },
      { name: "newSize", type: "int256", indexed: false },
      { name: "newEntryPrice", type: "uint256", indexed: false },
      { name: "newMargin", type: "uint256", indexed: false },
      { name: "realizedPnl", type: "int256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PositionClosed",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "closedSize", type: "int256", indexed: false },
      { name: "exitPrice", type: "uint256", indexed: false },
      { name: "realizedPnl", type: "int256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PositionLiquidated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "keeper", type: "address", indexed: true },
      { name: "closedSize", type: "int256", indexed: false },
      { name: "price", type: "uint256", indexed: false },
      { name: "pnl", type: "int256", indexed: false },
      { name: "remainingMargin", type: "uint256", indexed: false },
      { name: "keeperReward", type: "uint256", indexed: false },
      { name: "insurancePayout", type: "uint256", indexed: false },
      { name: "badDebt", type: "int256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarkPriceUpdated",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "oldPrice", type: "uint256", indexed: false },
      { name: "newPrice", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  // View functions
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [
      { name: "size", type: "int256" },
      { name: "entryPrice", type: "uint256" },
      { name: "margin", type: "uint256" },
      { name: "lastCumulativeFunding", type: "int256" },
      { name: "lastUpdated", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "isLiquidatable",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "id", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "active", type: "bool" },
      { name: "initialMarginBps", type: "uint256" },
      { name: "maintenanceMarginBps", type: "uint256" },
      { name: "maxPositionSize", type: "uint256" },
      { name: "markPrice", type: "uint256" },
      { name: "indexPrice", type: "uint256" },
      { name: "lastPriceUpdate", type: "uint256" },
      { name: "cumulativeFunding", type: "int256" },
      { name: "lastFundingUpdate", type: "uint256" },
      { name: "fundingIntervalSecs", type: "uint256" },
      { name: "openInterestLong", type: "uint256" },
      { name: "openInterestShort", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "marketIds",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "marketCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "traderMarginMode",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "isAccountLiquidatable",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getAccountEquity",
    stateMutability: "view",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [
      { name: "equity", type: "int256" },
      { name: "totalMaintRequired", type: "uint256" },
    ],
  },
] as const;

// ============================================================
//                    LIQUIDATOR ABI
// ============================================================

export const LIQUIDATOR_ABI = [
  {
    type: "function",
    name: "liquidate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "liquidateBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketIds", type: "bytes32[]" },
      { name: "traders", type: "address[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "liquidateAccount",
    stateMutability: "nonpayable",
    inputs: [{ name: "trader", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "canLiquidate",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "trader", type: "address" },
    ],
    outputs: [
      { name: "can", type: "bool" },
      { name: "posSize", type: "int256" },
    ],
  },
  {
    type: "function",
    name: "totalLiquidations",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "keeperLiquidations",
    stateMutability: "view",
    inputs: [{ name: "keeper", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  // Events
  {
    type: "event",
    name: "LiquidationExecuted",
    inputs: [
      { name: "marketId", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "keeper", type: "address", indexed: true },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
] as const;

// ============================================================
//                    VAULT ABI
// ============================================================

export const VAULT_ABI = [
  {
    type: "function",
    name: "balances",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
