"use client";

import { useState } from "react";
import { useTrading } from "@/providers/TradingProvider";
import { fmtPrice, fmtSize } from "@/lib/constants";
import { computePaperPnl } from "@/lib/trading-store";

export function PositionsPanel() {
  const { state, dispatch, send, market } = useTrading();
  const [tab, setTab] = useState<"positions" | "orders" | "history" | "funding">("positions");

  // Use paper positions if in paper mode, otherwise real positions
  const paperPositionsWithPnl = state.paperPositions.map(p => {
    const mp = state.markPrice > 0 ? state.markPrice : p.entryPrice;
    const { pnl, pnlPct, liqPrice } = computePaperPnl(p, mp);
    return {
      market: p.market,
      marketId: p.marketId,
      side: p.side,
      size: p.size,
      entryPrice: p.entryPrice,
      markPrice: mp,
      pnl,
      pnlPct,
      margin: p.margin,
      leverage: p.leverage,
      liqPrice,
      id: p.id,
    };
  });

  const positions = state.paperMode ? paperPositionsWithPnl : state.positions;
  const orders = state.paperMode ? state.paperOrders : state.openOrders;

  const cancelOrder = (id: string) => {
    if (state.paperMode) {
      dispatch({ type: "PAPER_CANCEL_ORDER", orderId: id });
    } else {
      send({ type: "cancelOrder", orderId: id });
    }
  };

  const closePosition = (posId: string) => {
    if (!state.paperMode) return;
    // Get close price from mark price, or mid price from orderbook
    const bestBid = state.bids[0]?.price || 0;
    const bestAsk = state.asks[0]?.price || 0;
    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
    const closePrice = state.markPrice > 0 ? state.markPrice : midPrice;
    if (closePrice <= 0) return;
    dispatch({
      type: "PAPER_CLOSE_POSITION",
      positionId: posId,
      closePrice,
      feeBps: market.takerFeeBps,
    });
    setTimeout(() => dispatch({ type: "CLEAR_ORDER_STATUS" }), 3000);
  };

  const tradeHistory = state.paperMode ? state.paperTradeHistory : [];

  const tabs = [
    { key: "positions" as const, label: "Positions", count: positions.length },
    { key: "orders" as const, label: "Open Orders", count: orders.length },
    { key: "history" as const, label: "Trade History", count: tradeHistory.length },
    { key: "funding" as const, label: "Funding", count: 0 },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-sur-border flex-shrink-0 px-4">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-5 py-2.5 text-[11px] font-medium transition-colors relative ${
              tab === t.key ? "text-sur-text" : "text-sur-muted hover:text-sur-text"
            }`}
          >
            {t.label}
            {t.count > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] bg-sur-accent/20 text-sur-accent">
                {t.count}
              </span>
            )}
            {tab === t.key && (
              <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-sur-accent" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Positions */}
        {tab === "positions" && (
          positions.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[11px] text-sur-muted">
              No open positions
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">
                  {["Market", "Size", "Entry", "Mark", "PnL", "Margin", "Liq", ""].map((h) => (
                    <th key={h} className={`${h === "Market" ? "text-left" : "text-right"} px-3 py-1.5 font-medium`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const isPosProfit = p.pnl >= 0;
                  return (
                    <tr key={i} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded ${
                            p.side === "long" ? "bg-sur-green/10 text-sur-green" : "bg-sur-red/10 text-sur-red"
                          }`}>
                            {p.side === "long" ? "LONG" : "SHORT"}
                          </span>
                          <span className="font-medium">{p.market}</span>
                          <span className="text-sur-muted text-[10px]">{p.leverage}x</span>
                        </div>
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">{fmtSize(p.size)}</td>
                      <td className="text-right px-3 py-2 tabular-nums">{fmtPrice(p.entryPrice)}</td>
                      <td className="text-right px-3 py-2 tabular-nums">{fmtPrice(p.markPrice)}</td>
                      <td className={`text-right px-3 py-2 tabular-nums font-medium ${isPosProfit ? "text-sur-green" : "text-sur-red"}`}>
                        <div>{isPosProfit ? "+" : ""}${Math.abs(p.pnl).toFixed(2)}</div>
                        <div className="text-[9px]">{isPosProfit ? "+" : ""}{p.pnlPct.toFixed(2)}%</div>
                      </td>
                      <td className="text-right px-3 py-2 tabular-nums">${p.margin.toFixed(2)}</td>
                      <td className="text-right px-3 py-2 tabular-nums text-sur-yellow">${fmtPrice(p.liqPrice)}</td>
                      <td className="text-right px-3 py-2">
                        <button
                          onClick={() => closePosition((p as any).id || "")}
                          className="text-[9px] px-2 py-1 rounded bg-sur-border/50 text-sur-muted hover:text-sur-red hover:bg-sur-red/10 transition-colors"
                        >
                          Close
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {/* Open Orders */}
        {tab === "orders" && (
          orders.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[11px] text-sur-muted">
              No open orders
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">
                  {["Market", "Side", "Type", "Price", "Size", "Leverage", ""].map((h) => (
                    <th key={h} className={`${["Market","Side","Type"].includes(h) ? "text-left" : "text-right"} px-3 py-1.5 font-medium`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map((o: any) => (
                  <tr key={o.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                    <td className="px-3 py-2 font-medium">{o.market}</td>
                    <td className={`px-3 py-2 ${o.side === "buy" ? "text-sur-green" : "text-sur-red"}`}>
                      {o.side.toUpperCase()}
                    </td>
                    <td className="px-3 py-2 text-sur-muted">Limit</td>
                    <td className="text-right px-3 py-2 tabular-nums">{fmtPrice(o.price)}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{fmtSize(o.size)}</td>
                    <td className="text-right px-3 py-2 tabular-nums text-sur-muted">{o.leverage}x</td>
                    <td className="text-right px-3 py-2">
                      <button
                        onClick={() => cancelOrder(o.id)}
                        className="text-[9px] px-2 py-1 rounded bg-sur-border/50 text-sur-muted hover:text-sur-red hover:bg-sur-red/10 transition-colors"
                      >
                        Cancel
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {/* History */}
        {tab === "history" && (
          tradeHistory.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[11px] text-sur-muted">
              No trade history yet
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">
                  {["Market", "Side", "Size", "Price", "PnL", "Fee", "Time"].map((h) => (
                    <th key={h} className={`${["Market","Side"].includes(h) ? "text-left" : "text-right"} px-3 py-1.5 font-medium`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tradeHistory.map((t: any) => (
                  <tr key={t.id} className="text-[11px] hover:bg-white/[0.02] border-t border-sur-border/50">
                    <td className="px-3 py-2 font-medium">{t.market}</td>
                    <td className={`px-3 py-2 ${t.side === "buy" ? "text-sur-green" : "text-sur-red"}`}>
                      {t.side.toUpperCase()}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums">{fmtSize(t.size)}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{fmtPrice(t.price)}</td>
                    <td className={`text-right px-3 py-2 tabular-nums font-medium ${t.pnl >= 0 ? "text-sur-green" : "text-sur-red"}`}>
                      {t.pnl !== 0 ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "—"}
                    </td>
                    <td className="text-right px-3 py-2 tabular-nums text-sur-muted">${t.fee.toFixed(2)}</td>
                    <td className="text-right px-3 py-2 tabular-nums text-sur-muted">
                      {new Date(t.timestamp).toLocaleTimeString("en", { hour12: false })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        {tab === "funding" && (
          <div className="flex items-center justify-center h-full text-[11px] text-sur-muted">
            No funding payments yet
          </div>
        )}
      </div>
    </div>
  );
}
