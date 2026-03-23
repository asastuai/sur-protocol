"use client";

import { useTradingContext } from "../../providers/TradingProvider";
import { computePaperPnl } from "../../lib/trading-store";

export default function AccountPanel() {
  const { state, dispatch } = useTradingContext();

  const fmt = (n: number) => n >= 0
    ? `$${n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `-$${Math.abs(n).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Paper mode account
  if (state.paperMode) {
    const markPrice = state.markPrice;
    const totalUnrealizedPnl = state.paperPositions.reduce((sum, p) => {
      const { pnl } = computePaperPnl(p, markPrice > 0 ? markPrice : p.entryPrice);
      return sum + pnl;
    }, 0);
    const totalMarginUsed = state.paperPositions.reduce((sum, p) => sum + p.margin, 0);
    const equity = state.paperBalance + totalMarginUsed + totalUnrealizedPnl;
    const freeBalance = state.paperBalance;
    const totalNotional = state.paperPositions.reduce((sum, p) => {
      const mp = markPrice > 0 ? markPrice : p.entryPrice;
      return sum + mp * p.size;
    }, 0);

    const handleReset = () => {
      if (confirm("Reset paper trading account to $100,000?")) {
        dispatch({ type: "PAPER_RESET" });
      }
    };

    return (
      <div className="border-t border-sur-border">
        <div className="px-3 py-2 border-b border-sur-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sur-muted">Account</span>
            <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sur-yellow/15 text-sur-yellow">Paper</span>
          </div>
          <button
            onClick={handleReset}
            className="text-[9px] px-2 py-0.5 rounded bg-sur-border/50 text-sur-muted hover:text-sur-yellow hover:bg-sur-yellow/10 transition-colors"
          >
            Reset
          </button>
        </div>

        <div className="px-3 py-2 space-y-1.5">
          <Row label="Equity" value={fmt(equity)} highlight />
          <Row label="Balance" value={fmt(freeBalance)} />
          <Row
            label="Unrealized PnL"
            value={fmt(totalUnrealizedPnl)}
            color={totalUnrealizedPnl >= 0 ? "#3fb950" : "#f85149"}
          />
          <Row label="Margin Used" value={fmt(totalMarginUsed)} />
          <Row
            label="Realized PnL"
            value={fmt(state.paperTotalRealizedPnl)}
            color={state.paperTotalRealizedPnl >= 0 ? "#3fb950" : "#f85149"}
          />
          {state.paperPositions.length > 0 && (
            <Row label="Positions" value={String(state.paperPositions.length)} />
          )}
          {totalNotional > 0 && (
            <Row label="Notional" value={fmt(totalNotional)} />
          )}
        </div>
      </div>
    );
  }

  // Testnet mode account
  const vaultBal = state.vaultBalance;

  return (
    <div className="border-t border-sur-border">
      <div className="px-3 py-2 border-b border-sur-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-sur-muted">Account</span>
          <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sur-accent/15 text-sur-accent">Testnet</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-1.5">
        <Row label="Vault Balance" value={vaultBal > 0 ? fmt(vaultBal) : "—"} highlight />
        <Row label="Positions" value={String(state.positions.length)} />
        <Row label="Open Orders" value={String(state.openOrders.length)} />
        {state.positions.length === 0 && vaultBal <= 0 && (
          <p className="text-[10px] text-sur-muted text-center pt-2">
            Connect wallet & deposit USDC to start trading on Base Sepolia
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, color, highlight }: {
  label: string; value: string; color?: string; highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-gray-500">{label}</span>
      <span
        className={`text-xs font-mono ${highlight ? "font-semibold" : ""}`}
        style={{ color: color || (highlight ? "#E4E5EB" : "#9CA3AF") }}
      >
        {value}
      </span>
    </div>
  );
}
