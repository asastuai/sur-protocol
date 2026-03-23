/**
 * SUR Protocol - WebSocket Load Test
 *
 * Connects N concurrent WebSocket clients, authenticates each with a
 * unique test wallet, subscribes to market data channels, and submits
 * orders at a configurable rate. Reports latency/throughput metrics.
 *
 * Usage:
 *   npx tsx test/loadtest.ts [url] [numClients] [durationSec]
 *
 * Defaults:
 *   url          = ws://localhost:3002
 *   numClients   = 100
 *   durationSec  = 30
 */

import WebSocket from "ws";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// ============================================================
//                    CONFIGURATION
// ============================================================

const WS_URL = process.argv[2] || "ws://localhost:3002";
const NUM_CLIENTS = parseInt(process.argv[3] || "100", 10);
const DURATION_SEC = parseInt(process.argv[4] || "30", 10);
const ORDERS_PER_SEC = 2; // per client

// A fake market ID (bytes32 hex). The server will reject with "Unknown market"
// but that still exercises the full message path through auth + validation.
const TEST_MARKET_ID =
  ("0x" + "ab".repeat(32)) as `0x${string}`;

// ============================================================
//                      METRICS
// ============================================================

interface Metrics {
  connectTimes: number[];
  authTimes: number[];
  orderLatencies: number[];
  ordersAccepted: number;
  ordersRejected: number;
  errors: number;
  messagesSent: number;
  messagesReceived: number;
}

const metrics: Metrics = {
  connectTimes: [],
  authTimes: [],
  orderLatencies: [],
  ordersAccepted: 0,
  ordersRejected: 0,
  errors: 0,
  messagesSent: 0,
  messagesReceived: 0,
};

// ============================================================
//                   PERCENTILE HELPERS
// ============================================================

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(values: number[]): { avg: number; p95: number; max: number; count: number } {
  if (values.length === 0) return { avg: 0, p95: 0, max: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    avg: Math.round(sum / sorted.length),
    p95: Math.round(percentile(sorted, 95)),
    max: Math.round(sorted[sorted.length - 1]),
    count: sorted.length,
  };
}

// ============================================================
//                  TEST WALLET FACTORY
// ============================================================

interface TestWallet {
  address: `0x${string}`;
  sign: (message: string) => Promise<`0x${string}`>;
}

function createTestWallet(): TestWallet {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    sign: (msg: string) => account.signMessage({ message: msg }),
  };
}

// ============================================================
//                  CLIENT RUNNER
// ============================================================

const pendingOrders = new Map<string, number>();
let nonceCounter = 0;

async function runClient(
  clientIndex: number,
  startBarrier: Promise<void>,
): Promise<void> {
  const wallet = createTestWallet();

  await startBarrier;

  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    const ws = new WebSocket(WS_URL);

    let authenticated = false;
    let authSentAt = 0;
    let orderInterval: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (orderInterval) clearInterval(orderInterval);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      resolve();
    };

    const closeTimer = setTimeout(cleanup, DURATION_SEC * 1000 + 5000);

    ws.on("open", () => {
      const connectTime = performance.now() - t0;
      metrics.connectTimes.push(connectTime);

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const authMessage = `SUR Protocol Auth\nAddress: ${wallet.address}\nTimestamp: ${timestamp}`;
      authSentAt = performance.now();

      wallet.sign(authMessage).then((signature) => {
        const msg = JSON.stringify({
          type: "authenticate",
          address: wallet.address,
          timestamp,
          signature,
        });
        ws.send(msg);
        metrics.messagesSent++;
      });
    });

    ws.on("message", (raw) => {
      metrics.messagesReceived++;
      let data: any;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        metrics.errors++;
        return;
      }

      switch (data.type) {
        case "authenticated": {
          const authTime = performance.now() - authSentAt;
          metrics.authTimes.push(authTime);
          authenticated = true;

          ws.send(
            JSON.stringify({
              type: "subscribe",
              channels: [
                `orderbook:${TEST_MARKET_ID}`,
                `trades:${TEST_MARKET_ID}`,
              ],
            }),
          );
          metrics.messagesSent++;

          const intervalMs = 1000 / ORDERS_PER_SEC;
          orderInterval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN || closed) return;
            sendOrder(ws, wallet);
          }, intervalMs);
          break;
        }

        case "orderAccepted": {
          metrics.ordersAccepted++;
          recordOrderLatency();
          break;
        }

        case "orderRejected": {
          metrics.ordersRejected++;
          recordOrderLatency();
          break;
        }

        case "error": {
          metrics.errors++;
          if (!authenticated && authSentAt > 0) {
            metrics.authTimes.push(performance.now() - authSentAt);
          }
          break;
        }
      }
    });

    ws.on("error", () => {
      metrics.errors++;
      cleanup();
      clearTimeout(closeTimer);
    });

    ws.on("close", () => {
      cleanup();
      clearTimeout(closeTimer);
    });
  });
}

function sendOrder(ws: WebSocket, wallet: TestWallet): void {
  const nonce = (++nonceCounter).toString();
  const expiry = (Math.floor(Date.now() / 1000) + 300).toString();
  const side = Math.random() > 0.5 ? "buy" : "sell";
  const basePrice = 50_000_000_000n;
  const offset = BigInt(Math.floor(Math.random() * 1_000_000_000)) - 500_000_000n;
  const price = (basePrice + offset).toString();
  const size = (BigInt(Math.floor(Math.random() * 99_000_000)) + 1_000_000n).toString();

  pendingOrders.set(nonce, performance.now());

  const order = {
    type: "submitOrder",
    order: {
      trader: wallet.address,
      marketId: TEST_MARKET_ID,
      side,
      orderType: "limit" as const,
      price,
      size,
      timeInForce: "GTC" as const,
      nonce,
      expiry,
      signature: ("0x" + "aa".repeat(65)) as `0x${string}`,
      hidden: false,
    },
  };

  ws.send(JSON.stringify(order));
  metrics.messagesSent++;
}

function recordOrderLatency(): void {
  let oldest: string | undefined;
  let oldestTime = Infinity;
  for (const [nonce, time] of pendingOrders) {
    if (time < oldestTime) {
      oldestTime = time;
      oldest = nonce;
    }
  }
  if (oldest !== undefined) {
    metrics.orderLatencies.push(performance.now() - oldestTime);
    pendingOrders.delete(oldest);
  }
}

// ============================================================
//                    MAIN
// ============================================================

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  SUR Protocol - WebSocket Load Test");
  console.log("=".repeat(60));
  console.log(`  URL:             ${WS_URL}`);
  console.log(`  Clients:         ${NUM_CLIENTS}`);
  console.log(`  Duration:        ${DURATION_SEC}s`);
  console.log(`  Orders/sec/cl:   ${ORDERS_PER_SEC}`);
  console.log(`  Expected orders: ~${NUM_CLIENTS * ORDERS_PER_SEC * DURATION_SEC}`);
  console.log("=".repeat(60));
  console.log();

  let releaseBarrier!: () => void;
  const startBarrier = new Promise<void>((r) => {
    releaseBarrier = r;
  });

  const clients: Promise<void>[] = [];
  for (let i = 0; i < NUM_CLIENTS; i++) {
    clients.push(runClient(i, startBarrier));
  }

  console.log(`[+] Spawned ${NUM_CLIENTS} client tasks. Releasing barrier...`);
  releaseBarrier();

  const testStart = performance.now();

  const progressInterval = setInterval(() => {
    const elapsed = ((performance.now() - testStart) / 1000).toFixed(1);
    console.log(
      `[${elapsed}s] connections=${metrics.connectTimes.length} ` +
        `sent=${metrics.messagesSent} recv=${metrics.messagesReceived} ` +
        `accepted=${metrics.ordersAccepted} rejected=${metrics.ordersRejected} ` +
        `errors=${metrics.errors}`,
    );
  }, 5000);

  await new Promise((r) => setTimeout(r, (DURATION_SEC + 6) * 1000));
  clearInterval(progressInterval);

  await Promise.allSettled(clients);

  const totalTime = (performance.now() - testStart) / 1000;

  // ============================================================
  //                     REPORT
  // ============================================================

  const connStats = stats(metrics.connectTimes);
  const authStats = stats(metrics.authTimes);
  const orderLatStats = stats(metrics.orderLatencies);

  console.log();
  console.log("=".repeat(60));
  console.log("  LOAD TEST RESULTS");
  console.log("=".repeat(60));
  console.log();

  console.log("  Connection Time (ms):");
  console.log(`    Clients connected:  ${connStats.count} / ${NUM_CLIENTS}`);
  console.log(`    Avg:                ${connStats.avg} ms`);
  console.log(`    P95:                ${connStats.p95} ms`);
  console.log(`    Max:                ${connStats.max} ms`);
  console.log();

  console.log("  Authentication Time (ms):");
  console.log(`    Authenticated:      ${authStats.count} / ${NUM_CLIENTS}`);
  console.log(`    Avg:                ${authStats.avg} ms`);
  console.log(`    P95:                ${authStats.p95} ms`);
  console.log(`    Max:                ${authStats.max} ms`);
  console.log();

  console.log("  Order Latency (ms) [submit -> accept/reject]:");
  console.log(`    Samples:            ${orderLatStats.count}`);
  console.log(`    Avg:                ${orderLatStats.avg} ms`);
  console.log(`    P95:                ${orderLatStats.p95} ms`);
  console.log(`    Max:                ${orderLatStats.max} ms`);
  console.log();

  console.log("  Orders:");
  console.log(`    Accepted:           ${metrics.ordersAccepted}`);
  console.log(`    Rejected:           ${metrics.ordersRejected}`);
  console.log(`    Total responses:    ${metrics.ordersAccepted + metrics.ordersRejected}`);
  console.log();

  console.log("  Errors:               " + metrics.errors);
  console.log();

  console.log("  Throughput:");
  console.log(`    Messages sent:      ${metrics.messagesSent}`);
  console.log(`    Messages received:  ${metrics.messagesReceived}`);
  console.log(`    Send rate:          ${(metrics.messagesSent / totalTime).toFixed(1)} msg/s`);
  console.log(`    Recv rate:          ${(metrics.messagesReceived / totalTime).toFixed(1)} msg/s`);
  console.log(`    Test duration:      ${totalTime.toFixed(1)} s`);
  console.log();
  console.log("=".repeat(60));

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
