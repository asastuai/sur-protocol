/**
 * SUR Protocol - Live Trading Demo
 *
 * Runs a full trade cycle on Base Sepolia:
 *   1. Check USDC balance & deposit into Vault
 *   2. Connect to live WebSocket API (Railway)
 *   3. Sign & submit a BUY order
 *   4. Sign & submit a SELL order (crosses the buy → instant match)
 *   5. Settlement pipeline submits on-chain
 *   6. Verify position on-chain
 *
 * Usage:
 *   cd demo && npm install && npx tsx demo-trade.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  formatUnits,
  parseUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import WebSocket from "ws";

// ============================================================
//                    CONFIG
// ============================================================

const PRIVATE_KEY = (process.env.OPERATOR_PRIVATE_KEY ||
  "0xad1a3b9a82190a1ba383693930b6f0f9006c6f044c1a971cb038fce94c1c3bab") as Hex;
const WS_URL = process.env.WS_URL || "wss://sur-api-production.up.railway.app";
const RPC_URL = process.env.RPC_URL || "https://sepolia.base.org";

const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex;
const VAULT_ADDRESS = "0x9C54911f0f5D2D6963978ec903c118Aa09C1dC81" as Hex;
const ENGINE_ADDRESS = "0xB45E23Ace809C31bE5C6b44D052E742aF4be94e6" as Hex;
const SETTLEMENT_ADDRESS = "0x7297429477254843cB00A6e17C5B1f83B3AE2Eec" as Hex;

const MARKET_NAME = "BTC-USD";
const MARKET_ID = keccak256(toHex(MARKET_NAME)) as Hex;

const toPrice = (d: number) => BigInt(Math.round(d * 1e6));
const toSize = (a: number) => BigInt(Math.round(a * 1e8));

// ============================================================
//                    ABIs
// ============================================================

const ERC20_ABI = [
  {
    name: "balanceOf", type: "function", stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve", type: "function", stateMutability: "nonpayable" as const,
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const VAULT_ABI = [
  {
    name: "deposit", type: "function", stateMutability: "nonpayable" as const,
    inputs: [{ name: "amount", type: "uint256" }], outputs: [],
  },
  {
    name: "balances", type: "function", stateMutability: "view" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const ENGINE_ABI = [
  {
    name: "getPosition", type: "function", stateMutability: "view" as const,
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
] as const;

const EIP712_DOMAIN = {
  name: "SUR Protocol",
  version: "1",
  chainId: 84532,
  verifyingContract: SETTLEMENT_ADDRESS,
} as const;

const ORDER_TYPES = {
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

// ============================================================
//                    HELPERS
// ============================================================

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

// ============================================================
//                    MAIN
// ============================================================

async function main() {
  console.log();
  console.log("  SUR Protocol - Live Trading Demo");
  console.log("  Base Sepolia Testnet");
  console.log("  ================================");
  console.log();

  const account = privateKeyToAccount(PRIVATE_KEY);
  const trader = account.address;

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  // ---- Step 1: Check balances ----
  console.log("  [Step 1] Checking balances...");

  const ethBalance = await publicClient.getBalance({ address: trader });
  log("Wallet:", trader);
  log("ETH:", `${formatUnits(ethBalance, 18)} ETH`);

  const usdcBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [trader],
  });
  log("USDC:", `$${formatUnits(usdcBalance, 6)}`);

  const vaultBalance = await publicClient.readContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "balances",
    args: [trader],
  });
  log("Vault:", `$${formatUnits(vaultBalance, 6)}`);

  // ---- Step 2: Deposit if needed ----
  if (vaultBalance === 0n && usdcBalance > 0n) {
    console.log();
    console.log("  [Step 2] Depositing USDC into Vault...");

    const depositAmount =
      usdcBalance > parseUnits("1000", 6)
        ? parseUnits("1000", 6)
        : usdcBalance;

    const approveTx = await walletClient.writeContract({
      address: USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [VAULT_ADDRESS, depositAmount],
      chain: baseSepolia,
      account,
    });
    log("Approve tx:", `${approveTx.slice(0, 18)}...`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    const depositTx = await walletClient.writeContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [depositAmount],
      chain: baseSepolia,
      account,
    });
    log("Deposit tx:", `${depositTx.slice(0, 18)}...`);
    await publicClient.waitForTransactionReceipt({ hash: depositTx });
    log("OK", `Deposited $${formatUnits(depositAmount, 6)} into Vault`);
  } else if (vaultBalance > 0n) {
    console.log();
    console.log("  [Step 2] Vault already funded - skipping deposit");
  } else {
    console.log();
    console.log("  [Step 2] No USDC available");
    log("NOTE", "Get testnet USDC from: https://faucet.circle.com/ (select Base Sepolia)");
    console.log("  Continuing with order submission demo...");
  }

  // ---- Step 3: Connect to WebSocket ----
  console.log();
  console.log("  [Step 3] Connecting to API...");

  const ws = new WebSocket(WS_URL);
  const messages: any[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      log("Connected:", WS_URL);
      resolve();
    });
    ws.on("error", (err) => {
      log("WS error:", err.message);
      reject(err);
    });
  });

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    if (msg.type === "orderAccepted") {
      log("Order accepted:", `${msg.orderId.slice(0, 12)}... (${msg.status})`);
    }
    if (msg.type === "orderRejected") {
      log("Order rejected:", msg.reason);
    }
    if (msg.type === "trade") {
      const p = (Number(msg.trade.price) / 1e6).toFixed(2);
      const s = (Number(msg.trade.size) / 1e8).toFixed(4);
      log("TRADE MATCHED!", `$${p} x ${s} BTC`);
    }
  });

  // Subscribe to market data
  ws.send(
    JSON.stringify({
      type: "subscribe",
      channels: [`orderbook:${MARKET_ID}`, `trades:${MARKET_ID}`],
    })
  );
  await sleep(500);

  // ---- Step 4: Submit BUY order ----
  console.log();
  console.log("  [Step 4] Submitting BUY order...");

  const price = toPrice(84000); // $84,000
  const size = toSize(0.001); // 0.001 BTC (~$84)
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = now + 3600n;

  const buySignature = await walletClient.signTypedData({
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      trader,
      marketId: MARKET_ID,
      isLong: true,
      size,
      price,
      nonce: 1n,
      expiry,
    },
  });

  ws.send(
    JSON.stringify({
      type: "submitOrder",
      order: {
        trader,
        marketId: MARKET_ID,
        side: "buy",
        orderType: "limit",
        price: price.toString(),
        size: size.toString(),
        timeInForce: "GTC",
        nonce: "1",
        expiry: expiry.toString(),
        signature: buySignature,
      },
    })
  );
  log("Sent:", "BUY 0.001 BTC @ $84,000 (limit GTC)");
  await sleep(1000);

  // ---- Step 5: Submit SELL order (crosses the buy) ----
  console.log();
  console.log("  [Step 5] Submitting SELL order (instant match)...");

  const sellSignature = await walletClient.signTypedData({
    domain: EIP712_DOMAIN,
    types: ORDER_TYPES,
    primaryType: "Order",
    message: {
      trader,
      marketId: MARKET_ID,
      isLong: false,
      size,
      price,
      nonce: 2n,
      expiry,
    },
  });

  ws.send(
    JSON.stringify({
      type: "submitOrder",
      order: {
        trader,
        marketId: MARKET_ID,
        side: "sell",
        orderType: "limit",
        price: price.toString(),
        size: size.toString(),
        timeInForce: "GTC",
        nonce: "2",
        expiry: expiry.toString(),
        signature: sellSignature,
      },
    })
  );
  log("Sent:", "SELL 0.001 BTC @ $84,000 (limit GTC)");

  // Wait for match + settlement
  console.log();
  console.log("  [Step 6] Waiting for match + on-chain settlement...");
  await sleep(5000);

  // ---- Step 7: Check results ----
  console.log();
  console.log("  [Step 7] Checking on-chain position...");

  try {
    const position = await publicClient.readContract({
      address: ENGINE_ADDRESS,
      abi: ENGINE_ABI,
      functionName: "getPosition",
      args: [MARKET_ID, trader],
    });

    const [posSize, entryPrice, margin, pnl] = position;

    if (posSize !== 0n) {
      const side = posSize > 0n ? "LONG" : "SHORT";
      const sizeNum = Number(posSize > 0n ? posSize : -posSize) / 1e8;
      log("Position:", `${side} ${sizeNum.toFixed(4)} BTC`);
      log("Entry:", `$${(Number(entryPrice) / 1e6).toFixed(2)}`);
      log("Margin:", `$${(Number(margin) / 1e6).toFixed(2)}`);
      log("PnL:", `$${(Number(pnl) / 1e6).toFixed(2)}`);
    } else {
      log("Info:", "No on-chain position yet (settlement may be pending or no vault balance)");
    }
  } catch (err: any) {
    log("Info:", `Position query: ${err?.shortMessage || err?.message || "unavailable"}`);
  }

  // ---- Summary ----
  console.log();
  console.log("  ================================");
  console.log("  API messages received:");
  for (const msg of messages) {
    const detail = msg.orderId ? `: ${msg.orderId.slice(0, 12)}...` : "";
    log("<-", `${msg.type}${detail}`);
  }
  console.log("  ================================");
  console.log();
  console.log("  Demo complete!");
  console.log(`  BaseScan: https://sepolia.basescan.org/address/${trader}`);
  console.log();

  ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("  Demo failed:", err.message);
  process.exit(1);
});
