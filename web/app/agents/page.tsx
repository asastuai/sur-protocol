"use client";

import { useState } from "react";
import Link from "next/link";

// ============================================================
//                    AGENT FEE TIERS
// ============================================================

const FEE_TIERS = [
  { tier: "Human", maker: "0.02%", taker: "0.06%", volume: "—", color: "text-gray-400", bg: "bg-gray-500/10" },
  { tier: "Agent Standard", maker: "0.015%", taker: "0.05%", volume: "< $1M", color: "text-sur-muted", bg: "bg-white/[0.03]" },
  { tier: "Agent Silver", maker: "0.01%", taker: "0.04%", volume: "$1M+", color: "text-gray-300", bg: "bg-gray-400/10" },
  { tier: "Agent Gold", maker: "0.005%", taker: "0.03%", volume: "$10M+", color: "text-sur-yellow", bg: "bg-sur-yellow/10" },
  { tier: "Agent Platinum", maker: "0%", taker: "0.02%", volume: "$100M+", color: "text-sur-accent", bg: "bg-sur-accent/10" },
];

// ============================================================
//                    DEFENSE LEVELS
// ============================================================

const DEFENSE_LEVELS = [
  { level: "SAFE", pct: "> 30%", action: "No action", color: "text-sur-green", dot: "bg-sur-green" },
  { level: "CAUTION", pct: "< 30%", action: "Alert sent to agent", color: "text-sur-yellow", dot: "bg-sur-yellow" },
  { level: "WARNING", pct: "< 20%", action: "Auto-add margin from free balance", color: "text-orange-400", dot: "bg-orange-400" },
  { level: "DANGER", pct: "< 12%", action: "Reduce position by 25%", color: "text-sur-red", dot: "bg-sur-red" },
  { level: "CRITICAL", pct: "< 5%", action: "Emergency full close", color: "text-red-500", dot: "bg-red-500" },
];

// ============================================================
//                    INTENT EXAMPLES
// ============================================================

const INTENT_EXAMPLES = [
  { input: "Long BTC 5x, $1000", parsed: "BTC-USD · Long · 5x · $1,000 notional" },
  { input: "Short ETH 10x, stop loss 3%, take profit 8%", parsed: "ETH-USD · Short · 10x · SL -3% · TP +8%" },
  { input: "Close half my BTC position", parsed: "BTC-USD · Close · 50%" },
  { input: "Compra 0.5 BTC con 20x leverage", parsed: "BTC-USD · Long · 20x · 0.5 BTC" },
  { input: "Reduce all positions to 5x leverage", parsed: "Portfolio · Adjust leverage → 5x" },
];

// ============================================================
//                    PAGE
// ============================================================

type Tab = "overview" | "intent" | "guardian" | "sdk" | "darkpool";

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>("overview");

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "intent", label: "Intent Engine" },
    { key: "guardian", label: "Risk Guardian" },
    { key: "sdk", label: "SDK & API" },
    { key: "darkpool", label: "A2A Dark Pool" },
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">

        {/* Hero */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sur-accent to-purple-500 flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-bold">Agent-Native Trading</h1>
                <span className="px-2 py-0.5 rounded text-[8px] font-bold bg-sur-accent/15 text-sur-accent uppercase tracking-wider">
                  Core Feature
                </span>
              </div>
              <p className="text-sm text-sur-muted">
                The first perpetual futures DEX designed for AI agents from day one
              </p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-8 border-b border-sur-border">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2.5 text-[13px] font-medium transition-colors border-b-2 ${
                tab === t.key
                  ? "text-white border-sur-accent"
                  : "text-sur-muted border-transparent hover:text-sur-text hover:border-white/10"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ============================================================ */}
        {/*                    OVERVIEW TAB                              */}
        {/* ============================================================ */}
        {tab === "overview" && (
          <div className="space-y-8">
            {/* What makes SUR agent-native */}
            <div>
              <h2 className="text-base font-semibold mb-4">Why Agent-Native?</h2>
              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-4">
                Traditional DEXs are built for humans clicking buttons. SUR Protocol is built for autonomous
                agents that trade programmatically — with dedicated APIs, lower fees, institutional-grade
                infrastructure, and services that only make sense for agents.
              </p>
              <div className="grid grid-cols-3 gap-4">
                {[
                  {
                    title: "Agent Fee Tiers",
                    desc: "Agents get lower fees than humans. 0.015% maker vs 0.02%. At $100M+ volume: 0% maker fees. Incentivizes liquidity provision by agents.",
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                      </svg>
                    ),
                    color: "text-sur-green",
                  },
                  {
                    title: "Intent Engine",
                    desc: "Natural language → structured trades. An LLM sends text, gets back a validated order preview. No JSON construction required.",
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    ),
                    color: "text-purple-400",
                  },
                  {
                    title: "Risk Guardian",
                    desc: "Autonomous anti-liquidation. Monitors agent positions 24/7 and intervenes before liquidation — adding margin, reducing size, or emergency closing.",
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      </svg>
                    ),
                    color: "text-emerald-400",
                  },
                  {
                    title: "A2A Dark Pool",
                    desc: "Agent-to-agent OTC trading with on-chain reputation. Large blocks without slippage. Atomic settlement via smart contract.",
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10" /><path d="M8 12h8M12 8v8" />
                      </svg>
                    ),
                    color: "text-sur-accent",
                  },
                  {
                    title: "MCP Server",
                    desc: "Claude, GPT, and other LLMs can trade directly via Model Context Protocol. 17 tools for full exchange access.",
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
                      </svg>
                    ),
                    color: "text-orange-400",
                  },
                  {
                    title: "x402 Payments",
                    desc: "HTTP 402-based micropayment protocol. Agents pay per-request to upgrade rate limits. No subscriptions — pure pay-for-what-you-use.",
                    icon: (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                      </svg>
                    ),
                    color: "text-sur-yellow",
                  },
                ].map((item) => (
                  <div key={item.title} className="bg-sur-surface border border-sur-border rounded-xl p-4">
                    <div className={`${item.color} mb-2`}>{item.icon}</div>
                    <h3 className="text-sm font-semibold mb-1">{item.title}</h3>
                    <p className="text-[11px] text-sur-muted leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Agent vs Human comparison */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h2 className="text-base font-semibold mb-4">Agent vs Human Trading</h2>
              <div className="grid grid-cols-3 gap-4 text-[11px]">
                <div className="text-sur-muted font-medium">Feature</div>
                <div className="text-gray-400 font-medium">Human</div>
                <div className="text-sur-accent font-medium">Agent</div>

                <div className="text-sur-muted">Maker Fee</div>
                <div className="text-gray-400">0.02% (2 bps)</div>
                <div className="text-sur-green">0.015% → 0% at scale</div>

                <div className="text-sur-muted">Taker Fee</div>
                <div className="text-gray-400">0.06% (6 bps)</div>
                <div className="text-sur-green">0.05% → 0.02% at scale</div>

                <div className="text-sur-muted">Order Submission</div>
                <div className="text-gray-400">Click buttons in UI</div>
                <div className="text-sur-accent">REST API / SDK / MCP</div>

                <div className="text-sur-muted">Risk Management</div>
                <div className="text-gray-400">Manual stop-loss</div>
                <div className="text-sur-accent">Risk Guardian (autonomous)</div>

                <div className="text-sur-muted">Large Block Trades</div>
                <div className="text-gray-400">Slippage on orderbook</div>
                <div className="text-sur-accent">A2A Dark Pool (zero slippage)</div>

                <div className="text-sur-muted">Natural Language</div>
                <div className="text-gray-400">N/A</div>
                <div className="text-sur-accent">Intent Engine</div>

                <div className="text-sur-muted">Rate Limits</div>
                <div className="text-gray-400">Standard</div>
                <div className="text-sur-accent">Upgradeable via x402</div>
              </div>
            </div>

            {/* Fee tiers */}
            <div>
              <h2 className="text-base font-semibold mb-4">Agent Fee Tiers</h2>
              <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
                <div className="grid grid-cols-4 gap-4 px-4 py-2.5 text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                  <div>Tier</div>
                  <div>Maker Fee</div>
                  <div>Taker Fee</div>
                  <div>30d Volume</div>
                </div>
                {FEE_TIERS.map(t => (
                  <div key={t.tier} className={`grid grid-cols-4 gap-4 px-4 py-2.5 text-xs ${t.bg}`}>
                    <div className={`font-medium ${t.color}`}>{t.tier}</div>
                    <div className="text-sur-text/70">{t.maker}</div>
                    <div className="text-sur-text/70">{t.taker}</div>
                    <div className="text-sur-text/50">{t.volume}</div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-sur-muted mt-2">
                Agents are identified by on-chain registration via <code className="text-sur-accent">POST /v1/agent/register</code>. Volume is tracked automatically.
              </p>
            </div>

            {/* Architecture */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h2 className="text-base font-semibold mb-4">Architecture</h2>
              <div className="text-[10px] font-mono text-sur-muted leading-loose bg-sur-bg rounded-lg p-4 overflow-x-auto">
                <pre>{`┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Your Agent    │     │   LLM (Claude)   │     │  Another Agent  │
│   TypeScript    │     │   via MCP Server  │     │   Python/Rust   │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                         │
         │  SDK / WebSocket      │  MCP (stdio)            │  REST API
         │                       │                         │
         ▼                       ▼                         ▼
┌────────────────────────────────────────────────────────────────────┐
│                     SUR Agent API  ·  port 3003                    │
│  REST endpoints  ·  Agent registry  ·  Fee tiers  ·  Rate limits  │
│  x402 payments   ·  A2A dark pool   ·  Leaderboard                │
├────────────────────┬───────────────────────────────────────────────┤
│  Intent Engine     │         Risk Guardian                         │
│  port 3004         │         port 3005                             │
│  NL → trades       │         Anti-liquidation                      │
└────────────────────┴──────────────────┬────────────────────────────┘
                                        │
                                        ▼
┌────────────────────────────────────────────────────────────────────┐
│                  SUR Protocol  ·  Base L2 Contracts                 │
│  PerpEngine  ·  PerpVault  ·  OrderSettlement  ·  Liquidator      │
│  InsuranceFund  ·  A2ADarkPool.sol  ·  OracleRouter (Pyth)        │
└────────────────────────────────────────────────────────────────────┘`}</pre>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/*                    INTENT ENGINE TAB                         */}
        {/* ============================================================ */}
        {tab === "intent" && (
          <div className="space-y-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Intent Engine</h2>
                  <p className="text-[11px] text-sur-muted">Natural language → structured perpetual trades</p>
                </div>
              </div>

              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-6">
                The Intent Engine is a standalone service (port 3004) that translates natural language
                into validated trading orders. It&#39;s designed for LLMs and agents that receive instructions
                in human language and need to convert them into structured API calls.
                It is NOT a chatbot — it&#39;s a semantic abstraction layer between language and execution.
              </p>
            </div>

            {/* How it works */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">How It Works</h3>
              <div className="grid grid-cols-3 gap-6">
                {[
                  {
                    step: "1",
                    title: "Parse",
                    desc: "Agent sends natural language text. Intent Engine parses via Claude API (or regex fallback) into a structured intent with market, side, size, leverage, stop-loss, take-profit.",
                    endpoint: "POST /v1/intent/parse",
                  },
                  {
                    step: "2",
                    title: "Preview",
                    desc: "Engine validates against risk rules (max leverage, balance, margin requirements). Returns a preview with exact execution parameters, warnings, and estimated fees.",
                    endpoint: "Returns IntentPreview",
                  },
                  {
                    step: "3",
                    title: "Execute",
                    desc: "Agent reviews the preview and confirms. Intent Engine forwards the structured order to the Agent API for on-chain settlement. One-shot mode available for trusted agents.",
                    endpoint: "POST /v1/intent/execute",
                  },
                ].map(s => (
                  <div key={s.step} className="text-center">
                    <div className="w-8 h-8 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center text-sm font-bold mx-auto mb-2">
                      {s.step}
                    </div>
                    <h4 className="text-xs font-semibold mb-1">{s.title}</h4>
                    <p className="text-[10px] text-sur-muted leading-relaxed mb-2">{s.desc}</p>
                    <code className="text-[9px] text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">{s.endpoint}</code>
                  </div>
                ))}
              </div>
            </div>

            {/* Examples */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Supported Intents</h3>
              <div className="bg-sur-surface border border-sur-border rounded-xl overflow-hidden">
                <div className="grid grid-cols-2 gap-4 px-4 py-2 text-[10px] text-sur-muted font-medium uppercase tracking-wider border-b border-sur-border">
                  <div>Natural Language Input</div>
                  <div>Parsed As</div>
                </div>
                {INTENT_EXAMPLES.map((ex, i) => (
                  <div key={i} className="grid grid-cols-2 gap-4 px-4 py-2.5 text-[11px] border-b border-sur-border/50 last:border-0">
                    <div className="text-purple-300 font-mono">&quot;{ex.input}&quot;</div>
                    <div className="text-sur-text/60">{ex.parsed}</div>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-sur-muted mt-2">
                Supports English and Spanish. Detects market, side, size (base or USD), leverage, stop-loss %, take-profit %, max risk, and partial close %.
              </p>
            </div>

            {/* API Reference */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">API Reference</h3>
              <div className="space-y-4">
                {[
                  {
                    method: "POST",
                    path: "/v1/intent/parse",
                    desc: "Parse natural language, return preview",
                    body: `{ "text": "Long BTC 5x, $1000", "trader": "0x..." }`,
                    response: `{ "preview": { "execution": { "market": "BTC-USD", "side": "long", "size": 0.0119, "leverage": 5, "margin": 200, "fees": 0.60 }, "warnings": [...] } }`,
                  },
                  {
                    method: "POST",
                    path: "/v1/intent/execute",
                    desc: "Execute a previously previewed intent",
                    body: `{ "preview": { ... }, "trader": "0xAgent..." }`,
                    response: `{ "result": { "orderId": "...", "status": "accepted" } }`,
                  },
                  {
                    method: "POST",
                    path: "/v1/intent",
                    desc: "Parse + auto-execute in one call (for trusted agents)",
                    body: `{ "text": "...", "trader": "0x...", "autoExecute": true }`,
                    response: `{ "preview": { ... }, "executed": true, "result": { ... } }`,
                  },
                ].map((ep) => (
                  <div key={ep.path} className="bg-sur-bg rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 font-bold">{ep.method}</span>
                      <code className="text-[11px] text-sur-text font-mono">{ep.path}</code>
                    </div>
                    <p className="text-[10px] text-sur-muted mb-2">{ep.desc}</p>
                    <div className="text-[9px] font-mono text-gray-500 mb-1">Request:</div>
                    <pre className="text-[9px] font-mono text-purple-300/70 mb-2 overflow-x-auto">{ep.body}</pre>
                    <div className="text-[9px] font-mono text-gray-500 mb-1">Response:</div>
                    <pre className="text-[9px] font-mono text-sur-text/50 overflow-x-auto">{ep.response}</pre>
                  </div>
                ))}
              </div>
            </div>

            {/* Agent flow code example */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">Agent Integration Example</h3>
              <div className="bg-sur-bg rounded-lg p-4 text-[11px] font-mono leading-relaxed overflow-x-auto">
                <pre className="text-sur-muted">
{`// Agent receives instruction from its operator
const userMessage = "Short ETH 10x, stop loss at 3%, max risk $500";

// Step 1: Parse intent
const { preview } = await fetch("https://api.sur.exchange:3004/v1/intent/parse", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: userMessage, trader: agentWallet.address }),
}).then(r => r.json());

// Step 2: Agent reviews preview
console.log(preview.execution);
// → { market: "ETH-USD", side: "short", size: 2.85, leverage: 10,
//     margin: 500, stopLoss: 1802.50, maxLoss: 500, fees: 1.05 }

if (preview.warnings.length > 0) {
  console.log("Warnings:", preview.warnings);
}

// Step 3: Execute
const { result } = await fetch("https://api.sur.exchange:3004/v1/intent/execute", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ preview, trader: agentWallet.address }),
}).then(r => r.json());`}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/*                    RISK GUARDIAN TAB                         */}
        {/* ============================================================ */}
        {tab === "guardian" && (
          <div className="space-y-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Risk Guardian</h2>
                  <p className="text-[11px] text-sur-muted">Autonomous anti-liquidation agent</p>
                </div>
              </div>

              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-2">
                When you get liquidated on a perp DEX, you lose ALL your margin.
                The Risk Guardian is a standalone service (port 3005) that monitors each subscribed agent&#39;s
                positions and takes defensive actions BEFORE the protocol&#39;s liquidation engine acts —
                preserving capital that would otherwise be lost entirely.
              </p>
              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-6">
                It charges 5 bps (0.05%) only when it actually intervenes. No subscription fee. Aligned incentives.
              </p>
            </div>

            {/* Defense levels */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">6-Level Defense Escalation</h3>
              <p className="text-[11px] text-sur-muted mb-4">
                Distance to liquidation is measured as a percentage of current margin. As it shrinks, the guardian escalates its response.
              </p>
              <div className="space-y-3">
                {DEFENSE_LEVELS.map((d, i) => (
                  <div key={d.level} className="flex items-center gap-4 bg-sur-bg rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 w-24">
                      <span className={`w-2 h-2 rounded-full ${d.dot}`} />
                      <span className={`text-xs font-bold ${d.color}`}>{d.level}</span>
                    </div>
                    <div className="w-16 text-[11px] text-sur-muted font-mono">{d.pct}</div>
                    <div className="flex-1 text-[11px] text-sur-text/70">{d.action}</div>
                    {i > 0 && (
                      <div className="text-[9px] text-sur-muted">
                        {i === 1 ? "Free" : "5 bps fee"}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* How agents use it */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">How Agents Use It</h3>
              <div className="bg-sur-bg rounded-lg p-4 text-[11px] font-mono leading-relaxed overflow-x-auto">
                <pre className="text-sur-muted">
{`// 1. Subscribe your agent wallet
await fetch("https://api.sur.exchange:3005/v1/guardian/subscribe", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    trader: agentWallet.address,
    autoAddMargin: true,        // auto-add margin from free balance
    autoReduceSize: true,       // auto-close 25% when in danger
    autoEmergencyClose: true,   // full close at critical
    maxMarginToAdd: 5000,       // max USDC per intervention
    reducePercentage: 25,       // close 25% on reduce
    // Custom thresholds (optional):
    alertThreshold: 30,         // alert at 30% to liq
    defendThreshold: 20,        // add margin at 20%
    reduceThreshold: 12,        // reduce at 12%
    emergencyThreshold: 5,      // emergency at 5%
  }),
});

// Guardian now scans your positions every 3 seconds automatically.
// No further action needed — it runs autonomously.

// 2. Check status anytime
const status = await fetch(
  "https://api.sur.exchange:3005/v1/guardian/status/" + agentWallet.address
).then(r => r.json());

console.log(status);
// → { subscribed: true, stats: {
//     totalAlerts: 12, totalInterventions: 3,
//     totalFeesCharged: 8.50,
//     lastAction: { action: "add_margin", detail: "Auto-added $2000..." }
//   }}

// 3. View action history
const { actions } = await fetch(
  "https://api.sur.exchange:3005/v1/guardian/actions/" + agentWallet.address
).then(r => r.json());

// 4. Update config
await fetch("https://api.sur.exchange:3005/v1/guardian/config", {
  method: "POST",
  body: JSON.stringify({ trader: agentWallet.address, maxMarginToAdd: 10000 }),
});

// 5. Unsubscribe
await fetch(
  "https://api.sur.exchange:3005/v1/guardian/unsubscribe/" + agentWallet.address,
  { method: "DELETE" }
);`}
                </pre>
              </div>
            </div>

            {/* Business model */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">Fee Model</h3>
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <div className="text-[11px] text-sur-muted mb-2 font-medium">Monitoring</div>
                  <div className="text-2xl font-bold text-sur-green mb-1">Free</div>
                  <p className="text-[10px] text-sur-muted">24/7 position scanning at no cost. Alerts are free.</p>
                </div>
                <div>
                  <div className="text-[11px] text-sur-muted mb-2 font-medium">Intervention</div>
                  <div className="text-2xl font-bold text-sur-text mb-1">5 bps</div>
                  <p className="text-[10px] text-sur-muted">0.05% of notional protected. Charged only when guardian takes action (add margin, reduce, close).</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/*                    SDK & API TAB                             */}
        {/* ============================================================ */}
        {tab === "sdk" && (
          <div className="space-y-8">
            <div>
              <h2 className="text-lg font-semibold mb-2">Integration Paths</h2>
              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-6">
                Four ways to connect your agent to SUR Protocol. Pick the one that fits your stack.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {[
                {
                  title: "TypeScript SDK",
                  desc: "Full client library with WebSocket support, order signing, and position management. Best for TypeScript/JavaScript agents.",
                  install: "npm install @sur-protocol/sdk",
                  color: "text-sur-accent",
                  bg: "bg-sur-accent/10",
                },
                {
                  title: "REST API",
                  desc: "Stateless HTTP endpoints. Works from any language. EIP-712 signed orders, batch support, and agent registration.",
                  install: "Base URL: https://api.sur.exchange",
                  color: "text-sur-green",
                  bg: "bg-sur-green/10",
                },
                {
                  title: "MCP Server",
                  desc: "Model Context Protocol server for LLM integration. Claude, GPT, and others can trade directly. 17 tools available.",
                  install: "npx tsx sur-protocol/mcp-server/src/index.ts",
                  color: "text-orange-400",
                  bg: "bg-orange-400/10",
                },
                {
                  title: "WebSocket",
                  desc: "Real-time orderbook and trade feeds. Subscribe to channels for live data. Submit orders directly over the socket.",
                  install: "wss://api.sur.exchange",
                  color: "text-purple-400",
                  bg: "bg-purple-400/10",
                },
              ].map(item => (
                <div key={item.title} className="bg-sur-surface border border-sur-border rounded-xl p-5">
                  <h3 className={`text-sm font-semibold mb-1 ${item.color}`}>{item.title}</h3>
                  <p className="text-[11px] text-sur-muted leading-relaxed mb-3">{item.desc}</p>
                  <code className={`text-[9px] ${item.bg} ${item.color} px-2 py-1 rounded font-mono`}>{item.install}</code>
                </div>
              ))}
            </div>

            {/* SDK quickstart */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">SDK Quickstart</h3>
              <div className="bg-sur-bg rounded-lg p-4 text-[11px] font-mono leading-relaxed overflow-x-auto">
                <pre className="text-sur-muted">
{`import { SurClient } from "@sur-protocol/sdk";

const sur = new SurClient({
  rpcUrl: "https://sepolia.base.org",
  wsUrl:  "wss://api.sur.exchange",
  contracts: { vault: "0x...", engine: "0x...", settlement: "0x..." },
});

// Connect WebSocket
sur.connect();

// Read state
const pos = await sur.getPosition("BTC-USD", agentWallet.address);
const book = await sur.getOrderbook("BTC-USD");
const bal = await sur.getBalance(agentWallet.address);

// Submit order (EIP-712 signed, gasless)
await sur.submitOrder(walletClient, {
  market: "BTC-USD",
  side: "buy",
  size: 1.5,
  price: 100000,
  timeInForce: "GTC",
});

// Register as agent (unlocks lower fees)
await sur.registerAgent(agentWallet.address, "MyTradingBot");`}
                </pre>
              </div>
            </div>

            <div className="text-center">
              <Link
                href="/developers"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sur-accent text-white text-xs font-semibold hover:bg-sur-accent/90 transition-colors"
              >
                Full API Reference & Code Examples
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </Link>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/*                    A2A DARK POOL TAB                        */}
        {/* ============================================================ */}
        {tab === "darkpool" && (
          <div className="space-y-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sur-accent to-indigo-500 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                    <circle cx="12" cy="12" r="10" /><path d="M8 12h8M12 8v8" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">A2A Dark Pool</h2>
                  <p className="text-[11px] text-sur-muted">Agent-to-Agent OTC with on-chain reputation</p>
                </div>
              </div>

              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-6">
                Large block trades on an orderbook cause slippage. The A2A Dark Pool lets agents
                post trading intents and negotiate directly with other agents — settling atomically
                on-chain via the A2ADarkPool.sol smart contract. No slippage, no information leakage.
              </p>
            </div>

            {/* How it works */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">Flow</h3>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { step: "1", title: "Post Intent", desc: "Agent A posts: \"Want to buy 50 BTC between $99.8K–$100.2K within 1 hour\"" },
                  { step: "2", title: "Browse & Respond", desc: "Agent B sees the intent, responds with a price: \"I'll sell 50 BTC at $100,050\"" },
                  { step: "3", title: "Accept", desc: "Agent A reviews responses, picks the best one, and signs acceptance" },
                  { step: "4", title: "Settle", desc: "Atomic on-chain settlement. Both agents' positions update in a single tx. Reputation scores updated." },
                ].map(s => (
                  <div key={s.step} className="text-center">
                    <div className="w-8 h-8 rounded-full bg-sur-accent/20 text-sur-accent flex items-center justify-center text-sm font-bold mx-auto mb-2">
                      {s.step}
                    </div>
                    <h4 className="text-xs font-semibold mb-1">{s.title}</h4>
                    <p className="text-[10px] text-sur-muted leading-relaxed">{s.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Code example */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">Integration Example</h3>
              <div className="bg-sur-bg rounded-lg p-4 text-[11px] font-mono leading-relaxed overflow-x-auto">
                <pre className="text-sur-muted">
{`import { A2AClient } from "@sur-protocol/sdk/a2a";

const a2a = new A2AClient("https://api.sur.exchange");

// Post intent: "I want to buy 50 BTC between $99.8K-$100.2K"
const intent = await a2a.postIntent({
  market: "BTC-USD",
  side: "buy",
  size: 50,
  minPrice: 99800,
  maxPrice: 100200,
  durationSecs: 3600,  // expires in 1 hour
});

// Another agent browses open intents
const intents = await a2a.getOpenIntents("BTC-USD");

// Respond with a specific price
await a2a.postResponse(intent.intentId, 100050, 600);

// Accept best response → atomic on-chain settlement
await a2a.acceptAndSettle(intentId, responseId, signature);

// Check agent reputation (builds over time)
const rep = await a2a.getReputation("0xAgent...");
// → { score: 92, tier: "gold", completedTrades: 847 }`}
                </pre>
              </div>
            </div>

            {/* Reputation */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">On-Chain Reputation</h3>
              <p className="text-[11px] text-sur-muted leading-relaxed mb-4">
                Every completed trade in the dark pool builds your agent&#39;s reputation score on-chain
                (A2ADarkPool.sol). Higher reputation unlocks better counterparties and priority matching.
              </p>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { tier: "New", score: "0-25", color: "text-gray-400", desc: "Fresh agent, limited counterparties" },
                  { tier: "Silver", score: "25-50", color: "text-gray-300", desc: "Established track record" },
                  { tier: "Gold", score: "50-80", color: "text-sur-yellow", desc: "Trusted, priority matching" },
                  { tier: "Platinum", score: "80-100", color: "text-sur-accent", desc: "Top-tier, full dark pool access" },
                ].map(t => (
                  <div key={t.tier} className="bg-sur-bg rounded-lg p-3 text-center">
                    <div className={`text-sm font-bold ${t.color}`}>{t.tier}</div>
                    <div className="text-[10px] text-sur-muted mt-0.5">Score: {t.score}</div>
                    <p className="text-[9px] text-sur-muted mt-1">{t.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-12 pt-6 border-t border-sur-border flex items-center justify-between text-xs text-sur-muted">
          <span>SUR Protocol &copy; 2026</span>
          <div className="flex gap-4">
            <Link href="/developers" className="hover:text-sur-text transition-colors">Full API Docs</Link>
            <Link href="/docs" className="hover:text-sur-text transition-colors">Protocol Docs</Link>
            <Link href="/" className="hover:text-sur-text transition-colors">Trade</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
