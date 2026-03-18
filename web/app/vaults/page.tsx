"use client";

import { useState } from "react";
import Link from "next/link";

// ============================================================
//                    COMPONENTS
// ============================================================

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-sur-surface border border-sur-border rounded-xl px-5 py-4">
      <div className="text-[11px] text-sur-muted font-medium uppercase tracking-wider mb-1">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-sur-muted mt-0.5">{sub}</div>}
    </div>
  );
}

// ============================================================
//                    PAGE
// ============================================================

type Tab = "vaults" | "copytrade" | "create";

export default function VaultsPage() {
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notified, setNotified] = useState(false);
  const [tab, setTab] = useState<Tab>("vaults");

  const handleNotify = (e: React.FormEvent) => {
    e.preventDefault();
    if (notifyEmail.trim()) {
      setNotified(true);
      setNotifyEmail("");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Vaults & Copy Trading</h1>
          <p className="text-sm text-sur-muted max-w-2xl">
            Deposit USDC into strategy vaults managed by top traders, or follow elite traders with automated copy trading.
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-8 border-b border-sur-border">
          {([
            { key: "vaults" as Tab, label: "Protocol Vaults" },
            { key: "copytrade" as Tab, label: "Copy Trading" },
            { key: "create" as Tab, label: "Create Vault" },
          ]).map(t => (
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
        {/*                    VAULTS TAB                                */}
        {/* ============================================================ */}
        {tab === "vaults" && (
          <>
            {/* Protocol stats */}
            <div className="grid grid-cols-4 gap-4 mb-8">
              <StatCard label="Protocol TVL" value="—" sub="Vault deposits launch soon" />
              <StatCard label="Insurance Fund" value="—" sub="Protocol backstop" />
              <StatCard label="Markets" value="2" sub="BTC-USD, ETH-USD" />
              <StatCard label="Max Leverage" value="50x" sub="Tiered by position size" />
            </div>

            {/* SUR LP Vault */}
            <div className="bg-sur-surface border border-sur-accent/30 rounded-xl p-6 mb-8">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-lg font-semibold">SUR Liquidity Pool</h2>
                    <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-sur-accent/15 text-sur-accent uppercase tracking-wider">
                      Protocol Vault
                    </span>
                  </div>
                  <p className="text-[12px] text-sur-muted max-w-xl leading-relaxed">
                    The core protocol vault that acts as counterparty to all traders on SUR.
                    Depositors earn from trading fees, liquidation proceeds, and market making spread.
                    Protected by tiered leverage limits, OI caps, and the insurance fund.
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-sur-muted uppercase tracking-wider mb-1">Status</div>
                  <span className="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-sur-yellow/15 text-sur-yellow">
                    Launching Soon
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-4 gap-6 mb-5 pt-4 border-t border-sur-border">
                <div>
                  <div className="text-[10px] text-sur-muted uppercase tracking-wider">TVL</div>
                  <div className="text-sm font-semibold mt-1">—</div>
                </div>
                <div>
                  <div className="text-[10px] text-sur-muted uppercase tracking-wider">Performance Fee</div>
                  <div className="text-sm font-semibold mt-1">10%</div>
                </div>
                <div>
                  <div className="text-[10px] text-sur-muted uppercase tracking-wider">Lockup</div>
                  <div className="text-sm font-semibold mt-1">None</div>
                </div>
                <div>
                  <div className="text-[10px] text-sur-muted uppercase tracking-wider">Deposit Asset</div>
                  <div className="text-sm font-semibold mt-1">USDC</div>
                </div>
              </div>

              <button
                disabled
                className="w-full py-3 rounded-lg bg-sur-accent/20 text-sur-accent text-sm font-semibold cursor-not-allowed"
              >
                Deposits Opening Soon
              </button>
            </div>

            {/* Strategy Vaults — empty */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-base font-semibold mb-1">Strategy Vaults</h2>
                  <p className="text-[11px] text-sur-muted">
                    Community-managed vaults powered by TradingVault.sol. Top traders create vaults, depositors follow.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-center py-12 border border-dashed border-sur-border rounded-lg">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-xl bg-white/[0.04] flex items-center justify-center mx-auto mb-3">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
                      <path d="M12 2v20M2 12h20" strokeLinecap="round"/>
                    </svg>
                  </div>
                  <p className="text-xs text-sur-muted mb-1">No active strategy vaults yet</p>
                  <p className="text-[10px] text-sur-muted/60">Vault creation opens with mainnet launch</p>
                </div>
              </div>
            </div>

            {/* How it works */}
            <div className="border-t border-sur-border pt-8">
              <h2 className="text-lg font-semibold mb-5">How Vaults Work</h2>
              <div className="grid grid-cols-3 gap-6">
                <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                  <div className="w-9 h-9 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-3">
                    <span className="text-sur-accent font-bold text-sm">1</span>
                  </div>
                  <h3 className="font-semibold text-sm mb-2">Deposit USDC</h3>
                  <p className="text-[11px] text-sur-muted leading-relaxed">
                    Choose a vault and deposit USDC. You receive vault shares proportional to the pool.
                    Managed by the vault creator via TradingVault.sol smart contract.
                  </p>
                </div>
                <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                  <div className="w-9 h-9 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-3">
                    <span className="text-sur-accent font-bold text-sm">2</span>
                  </div>
                  <h3 className="font-semibold text-sm mb-2">Earn Proportionally</h3>
                  <p className="text-[11px] text-sur-muted leading-relaxed">
                    The manager trades using pooled capital. Profits are distributed by share ownership.
                    Performance fees only on profits (high water mark). Auto-pause on max drawdown.
                  </p>
                </div>
                <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                  <div className="w-9 h-9 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-3">
                    <span className="text-sur-accent font-bold text-sm">3</span>
                  </div>
                  <h3 className="font-semibold text-sm mb-2">Withdraw Anytime</h3>
                  <p className="text-[11px] text-sur-muted leading-relaxed">
                    Withdraw your USDC plus accumulated gains after any lockup period.
                    Protected by insurance fund and drawdown limits.
                  </p>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ============================================================ */}
        {/*                    COPY TRADING TAB                          */}
        {/* ============================================================ */}
        {tab === "copytrade" && (
          <div className="space-y-8">
            {/* Overview */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-sur-accent to-purple-500 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><path d="M20 8v6M23 11h-6" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold">Copy Trading</h2>
                  <p className="text-[11px] text-sur-muted">Automatically replicate top traders&apos; positions</p>
                </div>
              </div>

              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-4">
                SUR Protocol&apos;s copytrade system discovers elite traders via on-chain leaderboard data,
                scores them using Sharpe ratio, win rate, drawdown, and profit factor, then automatically
                replicates their positions on your account with configurable risk limits.
              </p>

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-sur-bg rounded-lg p-4">
                  <div className="text-sm font-bold text-sur-accent mb-1">Discovery</div>
                  <p className="text-[10px] text-sur-muted leading-relaxed">
                    Profiler scans the SUR leaderboard, fetches 90 days of trade history,
                    and calculates 6+ metrics per trader. Anti-fraud guardrails reject suspicious profiles.
                  </p>
                </div>
                <div className="bg-sur-bg rounded-lg p-4">
                  <div className="text-sm font-bold text-sur-green mb-1">Scoring</div>
                  <p className="text-[10px] text-sur-muted leading-relaxed">
                    Tier S (score &ge; 0.78), A (&ge; 0.65), B (&ge; 0.45), C (&lt; 0.45).
                    Uses recency-biased Sharpe, inverse max drawdown, profit factor, and monthly consistency.
                  </p>
                </div>
                <div className="bg-sur-bg rounded-lg p-4">
                  <div className="text-sm font-bold text-purple-400 mb-1">Execution</div>
                  <p className="text-[10px] text-sur-muted leading-relaxed">
                    Polls primary trader every 3s. Detects opens, closes, flips.
                    Sizes by YOUR capital (20% max per position, 5x max leverage). Daily loss circuit breaker at 3%.
                  </p>
                </div>
              </div>
            </div>

            {/* Tier system */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">Trader Tiers</h3>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { tier: "S", score: ">= 0.78", color: "text-sur-accent", bg: "bg-sur-accent/10", desc: "Elite — recommended for copy" },
                  { tier: "A", score: ">= 0.65", color: "text-sur-green", bg: "bg-sur-green/10", desc: "Strong — worth watching" },
                  { tier: "B", score: ">= 0.45", color: "text-sur-yellow", bg: "bg-sur-yellow/10", desc: "Decent — monitor" },
                  { tier: "C", score: "< 0.45", color: "text-gray-400", bg: "bg-gray-500/10", desc: "Weak — avoid" },
                ].map(t => (
                  <div key={t.tier} className={`${t.bg} rounded-lg p-4 text-center`}>
                    <div className={`text-2xl font-bold ${t.color}`}>Tier {t.tier}</div>
                    <div className="text-[10px] text-sur-muted mt-1">Score {t.score}</div>
                    <p className="text-[9px] text-sur-muted mt-2">{t.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Risk management */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">Risk Management</h3>
              <div className="grid grid-cols-2 gap-6">
                <div className="space-y-3">
                  {[
                    { label: "Max Position Size", value: "20% of capital" },
                    { label: "Max Leverage", value: "5x (regardless of trader)" },
                    { label: "Daily Loss Circuit Breaker", value: "3% of capital" },
                    { label: "Max Concurrent Positions", value: "5" },
                  ].map(r => (
                    <div key={r.label} className="flex items-center justify-between">
                      <span className="text-[11px] text-sur-muted">{r.label}</span>
                      <span className="text-[11px] text-sur-text font-medium">{r.value}</span>
                    </div>
                  ))}
                </div>
                <div className="space-y-3">
                  {[
                    { label: "Sizing Model", value: "Direction-only (YOUR capital)" },
                    { label: "Auto-Switch", value: "If primary has 3+ loss streak" },
                    { label: "Min Trader Account", value: "$5,000" },
                    { label: "Min Trade History", value: "5 days" },
                  ].map(r => (
                    <div key={r.label} className="flex items-center justify-between">
                      <span className="text-[11px] text-sur-muted">{r.label}</span>
                      <span className="text-[11px] text-sur-text font-medium">{r.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* How to use */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">Quick Start</h3>
              <div className="bg-sur-bg rounded-lg p-4 text-[11px] font-mono leading-relaxed overflow-x-auto">
                <pre className="text-sur-muted">
{`# 1. Discover top traders on SUR
bun run src/index.ts --mode=profile

# 2. Copy the best trader (paper mode)
bun run src/index.ts --mode=paper --primary=0xTopTrader...

# 3. Go live when confident
bun run src/index.ts --mode=copy --primary=0xTopTrader...`}
                </pre>
              </div>
              <p className="text-[10px] text-sur-muted mt-2">
                Requires SUR Agent API running. Set SUR_API_URL, SUR_AGENT_ADDRESS, and CAPITAL in .env
              </p>
            </div>
          </div>
        )}

        {/* ============================================================ */}
        {/*                    CREATE VAULT TAB                          */}
        {/* ============================================================ */}
        {tab === "create" && (
          <div className="space-y-8">
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-2">Create a Trading Vault</h2>
              <p className="text-[13px] text-sur-text/70 leading-relaxed mb-6">
                Launch a vault where depositors follow your trades. You set the fees, they provide capital.
                Powered by TradingVault.sol with on-chain share accounting, high water mark performance fees,
                and automatic drawdown protection.
              </p>

              <div className="grid grid-cols-2 gap-6 mb-6">
                <div>
                  <h3 className="text-xs font-semibold mb-3">Vault Parameters</h3>
                  <div className="space-y-3">
                    {[
                      { label: "Performance Fee", range: "0–30%", desc: "Charged on profits above high water mark" },
                      { label: "Management Fee", range: "0–5%/yr", desc: "Annual fee on AUM, accrued per-second" },
                      { label: "Deposit Cap", range: "Custom", desc: "Maximum total deposits" },
                      { label: "Lockup Period", range: "0–90 days", desc: "Minimum deposit duration" },
                      { label: "Max Drawdown", range: "5–50%", desc: "Auto-pauses vault if exceeded" },
                    ].map(p => (
                      <div key={p.label} className="flex items-start justify-between">
                        <div>
                          <span className="text-[11px] text-sur-text font-medium">{p.label}</span>
                          <p className="text-[9px] text-sur-muted">{p.desc}</p>
                        </div>
                        <span className="text-[10px] text-sur-accent font-mono">{p.range}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold mb-3">Smart Contract Features</h3>
                  <div className="space-y-2">
                    {[
                      "Share-based accounting (proportional PnL)",
                      "High water mark — fees only on new profits",
                      "Per-second management fee accrual",
                      "Auto-pause on max drawdown breach",
                      "Emergency pause by protocol owner",
                      "On-chain depositor tracking",
                      "Manager trades via PerpEngine",
                    ].map((f, i) => (
                      <div key={i} className="flex items-start gap-2 text-[10px]">
                        <span className="text-sur-green mt-0.5">+</span>
                        <span className="text-sur-muted">{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <button
                disabled
                className="w-full py-3 rounded-lg bg-sur-accent/20 text-sur-accent text-sm font-semibold cursor-not-allowed"
              >
                Vault Creation Opens With Mainnet
              </button>
            </div>

            {/* Contract reference */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-3">TradingVault.sol — Contract Interface</h3>
              <div className="bg-sur-bg rounded-lg p-4 text-[10px] font-mono leading-relaxed overflow-x-auto">
                <pre className="text-sur-muted">
{`// Create vault (manager only)
createVault(name, description, performanceFeeBps, managementFeeBps,
            depositCap, lockupPeriodSecs, maxDrawdownBps) → vaultId

// Depositors
deposit(vaultId, amount)      → shares issued
withdraw(vaultId, shares)     → USDC returned (after lockup)

// Manager trades
trade(vaultId, marketId, sizeDelta, price) → executes via PerpEngine

// View functions
getVaultInfo(vaultId) → name, manager, equity, shares, fees, depositors
getDepositorInfo(vaultId, depositor) → shares, value, pnl

// Safety
Auto-pause if equityPerShare drops below (HWM - maxDrawdown)
Emergency pause by protocol owner`}
                </pre>
              </div>
            </div>
          </div>
        )}

        {/* Notify me */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-6 mt-8">
          <h3 className="text-sm font-semibold mb-2">Get Notified</h3>
          <p className="text-[11px] text-sur-muted mb-4">
            Be the first to know when vault deposits and copy trading launch. Early depositors may receive bonus SUR points.
          </p>
          {notified ? (
            <p className="text-sur-green text-xs font-medium">You&apos;ll be notified when vaults launch.</p>
          ) : (
            <form onSubmit={handleNotify} className="flex gap-2">
              <input
                type="email"
                value={notifyEmail}
                onChange={e => setNotifyEmail(e.target.value)}
                placeholder="your@email.com"
                className="flex-1 px-4 py-2.5 text-xs bg-sur-bg border border-sur-border rounded-lg focus:border-sur-accent/50 outline-none transition-colors"
              />
              <button
                type="submit"
                className="px-5 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
              >
                Notify Me
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
