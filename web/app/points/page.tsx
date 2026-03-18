"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { useTrading } from "@/providers/TradingProvider";

export default function PointsPage() {
  const { isConnected, address } = useAccount();
  const { state } = useTrading();
  const [notified, setNotified] = useState(false);
  const [email, setEmail] = useState("");

  // Real stats from paper trading activity
  const totalVolume = state.paperTradeHistory.reduce((sum, t) => sum + t.price * t.size, 0);
  const tradeCount = state.paperTradeHistory.length;
  const isPaper = state.paperMode;

  const handleNotify = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim()) {
      setNotified(true);
      setEmail("");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-2">Points & Rewards</h1>
        <p className="text-sm text-sur-muted mb-8">
          Earn SUR points by trading, providing liquidity, and contributing to the protocol.
        </p>

        {/* Season 1 announcement */}
        <div className="bg-sur-surface border border-sur-accent/30 rounded-xl p-8 text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-sur-accent to-blue-400 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl font-bold text-white">S</span>
          </div>
          <div className="flex items-center justify-center gap-2 mb-2">
            <h2 className="text-lg font-semibold">Season 1</h2>
            <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-sur-yellow/15 text-sur-yellow uppercase tracking-wider">
              Pre-Season
            </span>
          </div>
          <p className="text-sm text-sur-muted max-w-md mx-auto mb-6">
            The points program launches with mainnet. All trading activity during testnet is being tracked.
            Early and active traders will be rewarded when Season 1 begins.
          </p>
          {notified ? (
            <p className="text-sur-green text-xs font-medium">You&apos;ll be notified when Season 1 launches.</p>
          ) : (
            <form onSubmit={handleNotify} className="flex gap-2 max-w-sm mx-auto">
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
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

        <div className="grid grid-cols-2 gap-4 mb-8">
          {/* How to earn */}
          <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
            <h3 className="font-semibold text-sm mb-3">How to Earn Points</h3>
            <ul className="space-y-2.5 text-[12px] text-sur-muted">
              <li className="flex items-start gap-2">
                <span className="text-sur-accent font-bold mt-0.5">1</span>
                <span><span className="text-sur-text font-medium">Trade</span> — Earn points proportional to your trading volume across all markets</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-sur-accent font-bold mt-0.5">2</span>
                <span><span className="text-sur-text font-medium">Deposit into Vaults</span> — Earn points based on TVL contribution and duration</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-sur-accent font-bold mt-0.5">3</span>
                <span><span className="text-sur-text font-medium">Refer Traders</span> — Earn bonus points for each referred trader&apos;s activity</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-sur-accent font-bold mt-0.5">4</span>
                <span><span className="text-sur-text font-medium">Early Participation</span> — Testnet activity counts towards your eligibility multiplier</span>
              </li>
            </ul>
          </div>

          {/* Your activity */}
          <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm">Your Activity</h3>
              {isPaper && (
                <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-sur-yellow/15 text-sur-yellow">
                  Paper
                </span>
              )}
            </div>
            {isConnected || isPaper ? (
              <div className="space-y-3">
                <div className="flex justify-between text-xs">
                  <span className="text-sur-muted">Trading Volume</span>
                  <span className="tabular-nums font-medium">
                    ${totalVolume.toLocaleString("en", { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-sur-muted">Total Trades</span>
                  <span className="tabular-nums font-medium">{tradeCount}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-sur-muted">Open Positions</span>
                  <span className="tabular-nums font-medium">{state.paperPositions.length}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-sur-muted">Status</span>
                  <span className="text-sur-accent font-medium text-[11px]">Tracking</span>
                </div>
                <div className="mt-2 pt-3 border-t border-sur-border">
                  <p className="text-[10px] text-sur-muted leading-relaxed">
                    Your testnet activity is being tracked. Points will be calculated and distributed when Season 1 launches on mainnet.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-32">
                <p className="text-xs text-sur-muted">Connect wallet or enable Paper Trading to start earning</p>
              </div>
            )}
          </div>
        </div>

        {/* Point multipliers info */}
        <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
          <h3 className="font-semibold text-sm mb-4">Point Multipliers</h3>
          <div className="grid grid-cols-3 gap-6 text-[11px] text-sur-muted">
            <div>
              <div className="text-sur-text font-medium mb-1">Early Trader Bonus</div>
              <p className="leading-relaxed">Users active during testnet receive a multiplier on Season 1 points. The earlier you start, the higher the bonus.</p>
            </div>
            <div>
              <div className="text-sur-text font-medium mb-1">Volume Tiers</div>
              <p className="leading-relaxed">Higher cumulative volume unlocks better point rates. Tiers reset each season.</p>
            </div>
            <div>
              <div className="text-sur-text font-medium mb-1">Consistency</div>
              <p className="leading-relaxed">Regular trading activity earns streak bonuses. Daily and weekly streaks compound your earning rate.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
