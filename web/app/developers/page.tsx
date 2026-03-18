"use client";

import { useState } from "react";
import Link from "next/link";

// ============================================================
//                    CODE EXAMPLES
// ============================================================

const SDK_QUICKSTART = `import { SurClient } from "@sur-protocol/sdk";

const sur = new SurClient({
  rpcUrl: "https://sepolia.base.org",
  wsUrl:  "wss://api.sur.exchange",
  contracts: {
    vault:      "0x...",
    engine:     "0x...",
    settlement: "0x...",
  },
});

// Read position
const pos = await sur.getPosition("BTC-USD", "0xYourAgent...");
console.log(\`\${pos.side} \${pos.size} BTC | PnL: $\${pos.unrealizedPnl}\`);

// Submit order (EIP-712 signed)
sur.connect();
await sur.submitOrder(walletClient, {
  market: "BTC-USD",
  side: "buy",
  size: 1.5,
  price: 100000,
  timeInForce: "GTC",
});`;

const REST_API_EXAMPLE = `# Submit order
curl -X POST https://api.sur.exchange/v1/orders \\
  -H "Content-Type: application/json" \\
  -H "X-SUR-Signature: 0x..." \\
  -d '{
    "trader": "0xYourAgent...",
    "marketId": "BTC-USD",
    "side": "buy",
    "size": "150000000",
    "price": "100000000000",
    "orderType": "limit",
    "timeInForce": "GTC",
    "nonce": "1",
    "expiry": "1735689600",
    "signature": "0x..."
  }'

# Batch orders (up to 50)
curl -X POST https://api.sur.exchange/v1/orders/batch \\
  -H "Content-Type: application/json" \\
  -d '{ "orders": [...] }'

# Get orderbook
curl https://api.sur.exchange/v1/orderbook/BTC-USD

# Register as agent (reduced fees)
curl -X POST https://api.sur.exchange/v1/agent/register \\
  -d '{ "address": "0x...", "name": "MyTradingBot" }'`;

const MCP_EXAMPLE = `// claude-desktop-config.json
{
  "mcpServers": {
    "sur-protocol": {
      "command": "npx",
      "args": ["tsx", "sur-protocol/mcp-server/src/index.ts"],
      "env": {
        "AGENT_API_URL": "https://api.sur.exchange"
      }
    }
  }
}

// Now Claude can:
// "Check my BTC position on SUR"    → sur_get_position
// "Buy 2 BTC at $99,500"            → sur_submit_order
// "What's the current funding rate?" → sur_get_funding_rate
// "Post a dark pool intent to sell 50 BTC" → sur_a2a_post_intent`;

const A2A_EXAMPLE = `import { A2AClient } from "@sur-protocol/sdk/a2a";

const a2a = new A2AClient("https://api.sur.exchange");

// Post intent: "I want to buy 50 BTC between $99.8K-$100.2K"
const intent = await a2a.postIntent({
  market: "BTC-USD",
  side: "buy",
  size: 50,
  minPrice: 99800,
  maxPrice: 100200,
  durationSecs: 3600,
});

// Another agent browses intents and responds
const intents = await a2a.getOpenIntents("BTC-USD");
await a2a.postResponse(intent.intentId, 100050, 600);

// Accept best response → atomic settlement
await a2a.acceptAndSettle(intentId, responseId, signature);

// Check agent reputation
const rep = await a2a.getReputation("0xAgent...");
// → { score: 92, tier: "gold", completedTrades: 847 }`;

// ============================================================
//                    PAGE SECTIONS
// ============================================================

const FEE_TIERS = [
  { tier: "Standard", maker: "0.015%", taker: "0.05%", volume: "—", color: "text-sur-muted" },
  { tier: "Silver", maker: "0.01%", taker: "0.04%", volume: "$1M+", color: "text-gray-300" },
  { tier: "Gold", maker: "0.005%", taker: "0.03%", volume: "$10M+", color: "text-sur-yellow" },
  { tier: "Platinum", maker: "0%", taker: "0.02%", volume: "$100M+", color: "text-sur-accent" },
];

const API_ENDPOINTS = [
  { method: "POST", path: "/v1/orders", desc: "Submit signed order" },
  { method: "POST", path: "/v1/orders/batch", desc: "Submit up to 50 orders" },
  { method: "DELETE", path: "/v1/orders/:id", desc: "Cancel order" },
  { method: "GET", path: "/v1/orderbook/:market", desc: "Orderbook snapshot" },
  { method: "GET", path: "/v1/markets", desc: "List all markets" },
  { method: "GET", path: "/v1/positions/:trader", desc: "Trader positions" },
  { method: "GET", path: "/v1/account/:trader", desc: "Account details" },
  { method: "GET", path: "/v1/trades/:market", desc: "Recent trades" },
  { method: "GET", path: "/v1/funding/:market", desc: "Current funding rate" },
  { method: "POST", path: "/v1/agent/register", desc: "Register agent for fee discounts" },
  { method: "GET", path: "/v1/agent/status/:addr", desc: "Agent stats & tier" },
  { method: "GET", path: "/v1/agent/leaderboard", desc: "Top agents by volume" },
  { method: "POST", path: "/v1/intent/parse", desc: "Parse natural language into trade preview" },
  { method: "POST", path: "/v1/intent/execute", desc: "Execute a previewed intent" },
  { method: "POST", path: "/v1/intent", desc: "Parse + auto-execute in one call" },
  { method: "POST", path: "/v1/guardian/subscribe", desc: "Subscribe to anti-liquidation protection" },
  { method: "GET", path: "/v1/guardian/status/:trader", desc: "Guardian status & stats" },
  { method: "GET", path: "/v1/guardian/actions/:trader", desc: "Guardian action history" },
  { method: "POST", path: "/v1/guardian/config", desc: "Update guardian settings" },
  { method: "DELETE", path: "/v1/guardian/unsubscribe/:trader", desc: "Disable guardian" },
];

const MCP_TOOLS = [
  { name: "sur_get_markets", desc: "List available markets" },
  { name: "sur_get_orderbook", desc: "Get orderbook for a market" },
  { name: "sur_get_position", desc: "Get a trader's position" },
  { name: "sur_get_account", desc: "Cross-margin account details" },
  { name: "sur_get_balance", desc: "Vault USDC balance" },
  { name: "sur_submit_order", desc: "Submit a trading order" },
  { name: "sur_cancel_order", desc: "Cancel an open order" },
  { name: "sur_register_agent", desc: "Register as an agent" },
  { name: "sur_a2a_post_intent", desc: "Post dark pool intent" },
  { name: "sur_a2a_get_intents", desc: "Browse open intents" },
  { name: "sur_a2a_respond", desc: "Respond to an intent" },
  { name: "sur_a2a_accept", desc: "Accept & settle atomically" },
  { name: "sur_a2a_reputation", desc: "Check agent reputation" },
  { name: "sur_intent_parse", desc: "Parse natural language trade intent" },
  { name: "sur_intent_execute", desc: "Execute parsed intent" },
  { name: "sur_guardian_subscribe", desc: "Enable anti-liquidation protection" },
  { name: "sur_guardian_status", desc: "Check guardian protection status" },
];

type Tab = "sdk" | "rest" | "mcp" | "a2a";

export default function DevelopersPage() {
  const [activeTab, setActiveTab] = useState<Tab>("sdk");

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* Hero */}
        <div className="mb-12">
          <div className="flex items-center gap-2 mb-3">
            <h1 className="text-3xl font-bold">Build on SUR</h1>
            <span className="px-2.5 py-0.5 rounded text-[9px] font-bold bg-sur-accent/15 text-sur-accent uppercase tracking-wider">
              Agent-Native
            </span>
          </div>
          <p className="text-sm text-sur-muted max-w-2xl leading-relaxed">
            SUR Protocol is the first perpetual futures DEX designed for AI agents from day one.
            TypeScript SDK, REST API, MCP server for LLMs, and an agent-to-agent dark pool —
            everything an autonomous agent needs to trade programmatically on-chain.
          </p>
        </div>

        {/* Integration paths */}
        <div className="grid grid-cols-4 gap-4 mb-10">
          {([
            { key: "sdk" as Tab, title: "TypeScript SDK", sub: "Full client library", icon: "{ }" },
            { key: "rest" as Tab, title: "REST API", sub: "Stateless HTTP endpoints", icon: "API" },
            { key: "mcp" as Tab, title: "MCP Server", sub: "For LLMs (Claude, GPT)", icon: "AI" },
            { key: "a2a" as Tab, title: "A2A Dark Pool", sub: "Agent-to-agent trading", icon: "P2P" },
          ]).map(item => (
            <button
              key={item.key}
              onClick={() => setActiveTab(item.key)}
              className={`text-left p-4 rounded-xl border transition-colors ${
                activeTab === item.key
                  ? "bg-sur-accent/10 border-sur-accent/40"
                  : "bg-sur-surface border-sur-border hover:border-sur-accent/20"
              }`}
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-2 text-[11px] font-bold ${
                activeTab === item.key ? "bg-sur-accent/20 text-sur-accent" : "bg-white/[0.06] text-sur-muted"
              }`}>
                {item.icon}
              </div>
              <div className="text-sm font-semibold">{item.title}</div>
              <div className="text-[11px] text-sur-muted">{item.sub}</div>
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="mb-10">

          {/* SDK Tab */}
          {activeTab === "sdk" && (
            <div className="space-y-6">
              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold">@sur-protocol/sdk</h2>
                  <code className="text-[11px] px-2.5 py-1 rounded bg-sur-bg text-sur-muted font-mono">npm install @sur-protocol/sdk viem</code>
                </div>
                <pre className="bg-sur-bg rounded-lg p-4 overflow-x-auto text-[11px] leading-relaxed font-mono text-sur-text/80">
                  {SDK_QUICKSTART}
                </pre>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-3">SDK Methods</h3>
                <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[11px]">
                  {[
                    ["getPosition(market, trader)", "Read position: size, entry, PnL, liq status"],
                    ["getBalance(trader)", "Available USDC in vault"],
                    ["getMarket(market)", "Prices, open interest, status"],
                    ["getAccountDetails(trader)", "Cross-margin portfolio view"],
                    ["submitOrder(wallet, order)", "Sign EIP-712 + submit via WS"],
                    ["cancelOrder(orderId)", "Cancel an open order"],
                    ["connect() / disconnect()", "WebSocket lifecycle"],
                    ["subscribe(market)", "Subscribe to orderbook + trades"],
                    ["onTrade(market, cb)", "Real-time trade events"],
                    ["onOrderbook(market, cb)", "Real-time orderbook updates"],
                    ["onOrderStatus(cb)", "Order fill/reject notifications"],
                    ["setMarginMode(wallet, mode)", "Switch isolated/cross margin"],
                  ].map(([method, desc]) => (
                    <div key={method} className="flex items-start gap-2 py-1">
                      <code className="text-sur-accent font-mono whitespace-nowrap">{method}</code>
                      <span className="text-sur-muted">{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* REST API Tab */}
          {activeTab === "rest" && (
            <div className="space-y-6">
              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-base font-semibold">Agent REST API</h2>
                  <div className="flex items-center gap-3 text-[11px] text-sur-muted">
                    <span>Auth: <code className="text-sur-accent">X-SUR-Signature</code> (EIP-712)</span>
                    <span>Rate: 100 req/s free, 1000 req/s with x402</span>
                  </div>
                </div>

                <div className="space-y-1">
                  {API_ENDPOINTS.map(ep => (
                    <div key={ep.path + ep.method} className="flex items-center gap-3 py-1.5 text-[11px] border-b border-sur-border/30 last:border-0">
                      <span className={`font-mono font-bold w-14 ${
                        ep.method === "POST" ? "text-sur-green" : ep.method === "DELETE" ? "text-sur-red" : "text-sur-accent"
                      }`}>
                        {ep.method}
                      </span>
                      <code className="font-mono text-sur-text/80 w-56">{ep.path}</code>
                      <span className="text-sur-muted">{ep.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-3">Example: cURL</h3>
                <pre className="bg-sur-bg rounded-lg p-4 overflow-x-auto text-[11px] leading-relaxed font-mono text-sur-text/80">
                  {REST_API_EXAMPLE}
                </pre>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-2">x402 Payment Protocol</h3>
                <p className="text-[11px] text-sur-muted leading-relaxed">
                  SUR supports the <span className="text-sur-text font-medium">x402 payment protocol</span> for
                  pay-per-request API access. Agents can embed USDC micropayments in HTTP headers to unlock
                  higher rate limits (1000 req/s) and premium data feeds. Discovery endpoint
                  at <code className="text-sur-accent">/.well-known/x402</code>.
                </p>
              </div>
            </div>
          )}

          {/* MCP Tab */}
          {activeTab === "mcp" && (
            <div className="space-y-6">
              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-semibold">MCP Server</h2>
                    <p className="text-[11px] text-sur-muted mt-1">
                      Model Context Protocol — lets LLMs (Claude, GPT, Gemini) trade on SUR directly
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-purple-500/15 text-purple-400 uppercase tracking-wider">
                    LLM-Native
                  </span>
                </div>

                <pre className="bg-sur-bg rounded-lg p-4 overflow-x-auto text-[11px] leading-relaxed font-mono text-sur-text/80 mb-4">
                  {MCP_EXAMPLE}
                </pre>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-3">Available MCP Tools ({MCP_TOOLS.length})</h3>
                <div className="grid grid-cols-2 gap-1.5">
                  {MCP_TOOLS.map(tool => (
                    <div key={tool.name} className="flex items-center gap-2 py-1 text-[11px]">
                      <code className="text-purple-400 font-mono">{tool.name}</code>
                      <span className="text-sur-muted">{tool.desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-2">Coinbase Agentic Wallets</h3>
                <p className="text-[11px] text-sur-muted leading-relaxed">
                  The MCP server is designed to work alongside Coinbase&apos;s Agentic Wallet infrastructure.
                  The LLM decides what to trade, MCP translates to SUR API calls, and the Agentic Wallet signs
                  the EIP-712 transaction — fully autonomous trading with delegated signing authority.
                </p>
              </div>
            </div>
          )}

          {/* A2A Dark Pool Tab */}
          {activeTab === "a2a" && (
            <div className="space-y-6">
              <div className="bg-sur-surface border border-sur-accent/30 rounded-xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-base font-semibold">Agent-to-Agent Dark Pool</h2>
                    <p className="text-[11px] text-sur-muted mt-1">
                      Private intent-based trading between AI agents with atomic settlement
                    </p>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-sur-green/15 text-sur-green uppercase tracking-wider">
                    Unique to SUR
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-4 mb-4 pt-4 border-t border-sur-border">
                  {[
                    { label: "Post Intent", desc: "Broadcast what you want to buy/sell privately" },
                    { label: "Get Responses", desc: "Other agents propose execution prices" },
                    { label: "Accept & Settle", desc: "Atomic on-chain settlement — all or nothing" },
                    { label: "Build Reputation", desc: "Earn trust tier: bronze → silver → gold → diamond" },
                  ].map((step, i) => (
                    <div key={step.label}>
                      <div className="w-7 h-7 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-2">
                        <span className="text-sur-accent font-bold text-[11px]">{i + 1}</span>
                      </div>
                      <div className="text-[11px] font-medium text-sur-text">{step.label}</div>
                      <div className="text-[10px] text-sur-muted mt-0.5 leading-relaxed">{step.desc}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-3">A2A SDK Example</h3>
                <pre className="bg-sur-bg rounded-lg p-4 overflow-x-auto text-[11px] leading-relaxed font-mono text-sur-text/80">
                  {A2A_EXAMPLE}
                </pre>
              </div>

              <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
                <h3 className="text-sm font-semibold mb-3">Why A2A?</h3>
                <div className="grid grid-cols-3 gap-6 text-[11px] text-sur-muted">
                  <div>
                    <div className="text-sur-text font-medium mb-1">No Slippage</div>
                    <p className="leading-relaxed">Large orders execute at agreed price without moving the public orderbook. No front-running, no MEV.</p>
                  </div>
                  <div>
                    <div className="text-sur-text font-medium mb-1">Atomic Settlement</div>
                    <p className="leading-relaxed">Both sides open positions simultaneously on-chain. If either side can&apos;t fulfill, the entire transaction reverts.</p>
                  </div>
                  <div>
                    <div className="text-sur-text font-medium mb-1">Reputation System</div>
                    <p className="leading-relaxed">On-chain reputation tracks completion rates. High-reputation agents get better fill rates and priority matching.</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Agent Fee Tiers */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-6 mb-8">
          <h2 className="text-base font-semibold mb-1">Agent Fee Tiers</h2>
          <p className="text-[11px] text-sur-muted mb-4">
            Registered agents get reduced trading fees compared to regular users (0.02% / 0.06%). Tiers upgrade automatically based on cumulative volume.
          </p>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                <th className="text-left py-2 font-medium">Tier</th>
                <th className="text-right py-2 font-medium">Maker Fee</th>
                <th className="text-right py-2 font-medium">Taker Fee</th>
                <th className="text-right py-2 font-medium">Volume Required</th>
              </tr>
            </thead>
            <tbody>
              {FEE_TIERS.map(t => (
                <tr key={t.tier} className="border-b border-sur-border/30">
                  <td className={`py-2.5 font-semibold ${t.color}`}>{t.tier}</td>
                  <td className="text-right py-2.5 tabular-nums">{t.maker}</td>
                  <td className="text-right py-2.5 tabular-nums">{t.taker}</td>
                  <td className="text-right py-2.5 tabular-nums text-sur-muted">{t.volume}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-sur-muted mt-3">
            Platinum tier agents pay 0% maker fee — effectively a rebate model. Register via <code className="text-sur-accent">POST /v1/agent/register</code>.
          </p>
        </div>

        {/* Architecture overview */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-6 mb-8">
          <h2 className="text-base font-semibold mb-4">Architecture</h2>
          <div className="text-[11px] font-mono text-sur-muted leading-loose bg-sur-bg rounded-lg p-4">
            <pre>{`┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Your Agent    │     │   LLM (Claude)   │     │  Another Agent  │
│   TypeScript    │     │   via MCP Server  │     │   Python/Rust   │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                         │
         │  SDK / WebSocket      │  MCP (stdio)            │  REST API
         │                       │                         │
         ▼                       ▼                         ▼
┌────────────────────────────────────────────────────────────────────┐
│                     SUR Agent API (port 3003)                      │
│  REST endpoints  ·  Agent registry  ·  Fee tiers  ·  Rate limits  │
│  x402 payments   ·  A2A dark pool   ·  Leaderboard                │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                  SUR Protocol (Base L2 Contracts)                   │
│  PerpEngine  ·  PerpVault  ·  OrderSettlement  ·  Liquidator      │
│  InsuranceFund  ·  AutoDeleveraging  ·  OracleRouter (Pyth)       │
└────────────────────────────────────────────────────────────────────┘

  Additional Services:

┌──────────────────────┐     ┌──────────────────────┐
│   Intent Engine      │     │   Risk Guardian       │
│   (port 3004)        │     │   (port 3005)         │
│                      │     │                       │
│  Natural language →  │     │  Anti-liquidation     │
│  structured trades   │     │  6-level defense      │
│                      │     │  0.05% on action only │
│  "Long BTC 5x $1k"  │     │  Auto margin / reduce │
│   → parsed preview   │     │  Emergency close      │
│   → confirmed exec   │     │  Per-user config      │
└──────────┬───────────┘     └──────────┬────────────┘
           │                            │
           └─────────┬──────────────────┘
                     ▼
            SUR Agent API (port 3003)`}</pre>
          </div>
        </div>

        {/* Intent Engine + Risk Guardian */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                <span className="text-[10px] font-bold text-white">NL</span>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Intent Engine</h3>
                <p className="text-[10px] text-sur-muted">Natural language trading</p>
              </div>
            </div>
            <p className="text-[11px] text-sur-muted leading-relaxed mb-3">
              Translate plain English (or Spanish) into structured perpetual futures trades.
              Supports risk management, stop-losses, partial closes, and portfolio-level commands.
            </p>
            <div className="bg-sur-bg rounded-lg p-3 text-[10px] font-mono text-sur-muted">
              <div className="text-purple-400">POST /v1/intent/parse</div>
              <div className="text-gray-500 mt-1">{`{ "text": "Short ETH 10x, stop loss 3%" }`}</div>
              <div className="text-gray-500 mt-2">→ Parsed preview with margin, fees, warnings</div>
              <div className="text-purple-400 mt-2">POST /v1/intent/execute</div>
              <div className="text-gray-500 mt-1">→ Confirm and execute the previewed trade</div>
            </div>
          </div>

          <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                <span className="text-[10px] font-bold text-white">RG</span>
              </div>
              <div>
                <h3 className="text-sm font-semibold">Risk Guardian</h3>
                <p className="text-[10px] text-sur-muted">Anti-liquidation agent</p>
              </div>
            </div>
            <p className="text-[11px] text-sur-muted leading-relaxed mb-3">
              Per-user protection that intervenes before the liquidation engine acts.
              6-level defense escalation. Charges 5 bps only on actual interventions.
            </p>
            <div className="bg-sur-bg rounded-lg p-3 text-[10px] font-mono text-sur-muted">
              <div className="text-green-400">POST /v1/guardian/subscribe</div>
              <div className="text-gray-500 mt-1">{`{ "trader": "0x...", "autoAddMargin": true }`}</div>
              <div className="text-gray-500 mt-2">→ Monitors positions every 3 seconds</div>
              <div className="text-green-400 mt-2">GET /v1/guardian/status/:trader</div>
              <div className="text-gray-500 mt-1">→ Stats, intervention count, fees paid</div>
            </div>
          </div>
        </div>

        {/* Get started CTA */}
        <div className="flex items-center justify-between bg-sur-surface border border-sur-accent/30 rounded-xl p-6">
          <div>
            <h3 className="text-sm font-semibold mb-1">Ready to integrate?</h3>
            <p className="text-[11px] text-sur-muted">
              Start with the SDK, register your agent for reduced fees, and join the A2A dark pool.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="px-4 py-2 text-xs font-medium rounded-lg bg-white/[0.06] text-sur-muted hover:text-sur-text hover:bg-white/[0.1] transition-colors"
            >
              Full Docs
            </Link>
            <Link
              href="/"
              className="px-5 py-2 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
            >
              Start Trading
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
