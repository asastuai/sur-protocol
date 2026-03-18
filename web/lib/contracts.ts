import { type Hex } from "viem";
import { CONTRACTS } from "./constants";

// Base Sepolia USDC (Circle testnet)
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;

// Minimal ABIs — only the functions we need

export const erc20Abi = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "decimals",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    name: "symbol",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const vaultAbi = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
  {
    name: "balances",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "usdc",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "depositCap",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "paused",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "maxWithdrawalPerTx",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const engineAbi = [
  {
    name: "positions",
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
      { name: "lastFundingIndex", type: "int256" },
      { name: "openTimestamp", type: "uint256" },
    ],
  },
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
      { name: "lastFundingIndex", type: "int256" },
      { name: "openTimestamp", type: "uint256" },
    ],
  },
  {
    name: "markets",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "bytes32" }],
    outputs: [
      { name: "id", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "active", type: "bool" },
      { name: "initialMarginBps", type: "uint256" },
      { name: "maintenanceMarginBps", type: "uint256" },
      { name: "maxPositionSize", type: "uint256" },
      { name: "fundingInterval", type: "uint256" },
      { name: "markPrice", type: "uint256" },
      { name: "indexPrice", type: "uint256" },
      { name: "lastFundingRate", type: "int256" },
      { name: "cumulativeFundingIndex", type: "uint256" },
      { name: "openInterestLong", type: "uint256" },
      { name: "openInterestShort", type: "uint256" },
      { name: "lastPriceUpdate", type: "uint256" },
    ],
  },
] as const;
