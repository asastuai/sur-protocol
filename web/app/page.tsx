"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Header } from "@/components/layout/Header";
import { Chart } from "@/components/trading/Chart";
import { Orderbook } from "@/components/trading/Orderbook";
import { OrderPanel } from "@/components/trading/OrderPanel";
import { PositionsPanel } from "@/components/trading/PositionsPanel";
import { RecentTrades } from "@/components/trading/RecentTrades";
import AccountPanel from "@/components/trading/AccountPanel";
import CollateralPanel from "@/components/trading/CollateralPanel";
import { DepositWithdrawPanel } from "@/components/trading/DepositWithdrawPanel";
import { useTrading } from "@/providers/TradingProvider";
import { KeyboardShortcutsHelp } from "@/components/trading/KeyboardShortcutsHelp";

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [breakpoint]);
  return isMobile;
}

// ============================================================
//                 MOBILE TRADE VIEW
// ============================================================

type MobileTab = "chart" | "order" | "book" | "positions";

function MobileTradePage() {
  const { state } = useTrading();
  const [tab, setTab] = useState<MobileTab>("chart");

  const tabs: { key: MobileTab; label: string }[] = [
    { key: "chart", label: "Chart" },
    { key: "order", label: "Trade" },
    { key: "book", label: "Book" },
    { key: "positions", label: "Positions" },
  ];

  return (
    <div className="h-full flex flex-col bg-sur-bg">
      <Header />

      {/* Connection status */}
      {(state.wsStatus === "connecting" || state.wsStatus === "error") && (
        <div className={`h-6 flex items-center justify-center text-[10px] border-b flex-shrink-0 ${
          state.wsStatus === "connecting"
            ? "bg-sur-yellow/10 border-sur-yellow/20 text-sur-yellow"
            : "bg-sur-red/10 border-sur-red/20 text-sur-red"
        }`}>
          {state.wsStatus === "connecting" && "Connecting..."}
          {state.wsStatus === "error" && "Engine offline — paper trading active"}
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === "chart" && (
          <div className="h-full">
            <Chart market={state.selectedMarket} />
          </div>
        )}
        {tab === "order" && (
          <div className="p-3 space-y-3">
            <DepositWithdrawPanel />
            <OrderPanel />
            <AccountPanel />
          </div>
        )}
        {tab === "book" && (
          <div className="h-full">
            <Orderbook />
          </div>
        )}
        {tab === "positions" && (
          <div className="h-full">
            <PositionsPanel />
          </div>
        )}
      </div>

      {/* Bottom tab bar */}
      <div className="flex border-t border-sur-border bg-sur-surface flex-shrink-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-3 text-[11px] font-semibold transition-colors ${
              tab === t.key
                ? "text-sur-accent border-t-2 border-sur-accent bg-sur-accent/5"
                : "text-sur-muted hover:text-sur-text"
            }`}
          >
            {t.label}
            {t.key === "positions" && state.paperPositions.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-sur-accent/20 text-sur-accent text-[8px] font-bold">
                {state.paperPositions.length}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================
//                 RESIZE HANDLE COMPONENT
// ============================================================

function ResizeHandle({
  direction,
  onDrag,
}: {
  direction: "horizontal" | "vertical";
  onDrag: (delta: number) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      document.body.style.cursor =
        direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pos = direction === "horizontal" ? ev.clientX : ev.clientY;
        const delta = pos - lastPos.current;
        if (delta !== 0) {
          onDrag(delta);
          lastPos.current = pos;
        }
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [direction, onDrag]
  );

  const isH = direction === "horizontal";

  return (
    <div
      ref={handleRef}
      onMouseDown={onMouseDown}
      className={`${
        isH ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize"
      } bg-sur-border hover:bg-sur-accent/40 transition-colors flex-shrink-0 z-10`}
      style={{ [isH ? "minWidth" : "minHeight"]: "5px" }}
    />
  );
}

// ============================================================
//                 BOTTOM SECTION TABS
// ============================================================

function BottomSection() {
  return (
    <div className="h-full flex flex-col min-h-0 overflow-auto">
      <PositionsPanel />
    </div>
  );
}

// ============================================================
//                 MAIN TRADE PAGE
// ============================================================

// Constraints
const MIN_ORDERBOOK_W = 160;
const MAX_ORDERBOOK_W = 360;
const MIN_RIGHT_W = 220;
const MAX_RIGHT_W = 420;
const MIN_BOTTOM_H = 120;
const MAX_BOTTOM_H = 500;

const SHORTCUT_DEFS = [
  { key: "B", label: "Long / Buy", category: "Order" },
  { key: "S", label: "Short / Sell", category: "Order" },
  { key: "M", label: "Market order", category: "Order" },
  { key: "L", label: "Limit order", category: "Order" },
  { key: "Enter", label: "Submit order", category: "Order" },
  { key: "1", label: "25% size", category: "Size" },
  { key: "2", label: "50% size", category: "Size" },
  { key: "3", label: "75% size", category: "Size" },
  { key: "4", label: "100% size", category: "Size" },
  { key: "?", label: "Toggle this panel", category: "General" },
  { key: "Esc", label: "Close panel", category: "General" },
];

export default function TradePage() {
  const { state } = useTrading();
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Global ? key for shortcuts help
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.key === "?") {
        e.preventDefault();
        setShowShortcuts(v => !v);
      }
      if (e.key === "Escape" && showShortcuts) {
        e.preventDefault();
        setShowShortcuts(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showShortcuts]);

  if (isMobile) return <MobileTradePage />;

  // Resizable dimensions
  const [orderbookW, setOrderbookW] = useState(220);
  const [rightW, setRightW] = useState(280);
  const [bottomH, setBottomH] = useState(200);

  const onDragOrderbook = useCallback(
    (delta: number) => {
      setOrderbookW((prev) =>
        Math.min(MAX_ORDERBOOK_W, Math.max(MIN_ORDERBOOK_W, prev + delta))
      );
    },
    []
  );

  const onDragRight = useCallback(
    (delta: number) => {
      setRightW((prev) =>
        Math.min(MAX_RIGHT_W, Math.max(MIN_RIGHT_W, prev + delta))
      );
    },
    []
  );

  const onDragBottom = useCallback(
    (delta: number) => {
      setBottomH((prev) =>
        Math.min(MAX_BOTTOM_H, Math.max(MIN_BOTTOM_H, prev - delta))
      );
    },
    []
  );

  return (
    <div className="h-full flex flex-col bg-sur-bg">
      {/* Header */}
      <Header />

      {/* Connection status bar — only show for error/connecting, not for normal disconnected (Binance feeds are direct) */}
      {(state.wsStatus === "connecting" || state.wsStatus === "error") && (
        <div
          className={`h-6 flex items-center justify-center text-[10px] border-b flex-shrink-0 ${
            state.wsStatus === "connecting"
              ? "bg-sur-yellow/10 border-sur-yellow/20 text-sur-yellow"
              : "bg-sur-red/10 border-sur-red/20 text-sur-red"
          }`}
        >
          {state.wsStatus === "connecting" && "Connecting to trading engine..."}
          {state.wsStatus === "error" && "Engine connection error — paper trading active"}
        </div>
      )}

      {/* Order notification toast */}
      {state.lastOrderStatus && (
        <div
          className={`fixed top-14 right-4 z-50 px-4 py-2.5 rounded shadow-lg text-xs font-medium animate-fade-in ${
            state.orderError
              ? "bg-sur-red/20 text-sur-red border border-sur-red/30"
              : "bg-sur-green/20 text-sur-green border border-sur-green/30"
          }`}
        >
          {state.orderError
            ? `Rejected: ${state.orderError}`
            : `Order ${state.lastOrderStatus}`}
        </div>
      )}

      {/* Shortcuts help overlay */}
      {showShortcuts && (
        <KeyboardShortcutsHelp shortcuts={SHORTCUT_DEFS} onClose={() => setShowShortcuts(false)} />
      )}

      {/* Keyboard shortcut hint */}
      <button
        onClick={() => setShowShortcuts(v => !v)}
        className="fixed bottom-3 right-3 z-40 px-2 py-1 rounded bg-sur-surface border border-sur-border text-[9px] text-sur-muted hover:text-sur-text transition-colors opacity-60 hover:opacity-100"
        title="Keyboard shortcuts (?)"
      >
        <kbd className="font-mono">?</kbd> Shortcuts
      </button>

      {/* ====== RESIZABLE LAYOUT ====== */}
      <div ref={containerRef} className="flex-1 flex flex-col min-h-0">
        {/* TOP ROW */}
        <div className="flex-1 flex min-h-0">
          {/* Chart */}
          <div className="flex-1 min-w-0 bg-sur-surface overflow-hidden">
            <Chart market={state.selectedMarket} />
          </div>

          {/* ← Drag handle: chart | orderbook */}
          <ResizeHandle direction="horizontal" onDrag={onDragOrderbook} />

          {/* Orderbook */}
          <div
            className="bg-sur-surface overflow-hidden"
            style={{ width: orderbookW, minWidth: MIN_ORDERBOOK_W }}
          >
            <Orderbook />
          </div>

          {/* ← Drag handle: orderbook | right panel */}
          <ResizeHandle direction="horizontal" onDrag={onDragRight} />

          {/* Right panel: Order + Deposit + Account */}
          <div
            className="bg-sur-surface overflow-y-auto"
            style={{ width: rightW, minWidth: MIN_RIGHT_W }}
          >
            <DepositWithdrawPanel />
            <OrderPanel />
            <AccountPanel />
            <CollateralPanel />
          </div>
        </div>

        {/* ↑ Drag handle: top row | bottom row */}
        <ResizeHandle direction="vertical" onDrag={onDragBottom} />

        {/* BOTTOM ROW */}
        <div className="flex" style={{ height: bottomH, minHeight: MIN_BOTTOM_H }}>
          {/* Positions & Orders */}
          <div className="flex-1 min-w-0 bg-sur-surface overflow-hidden">
            <BottomSection />
          </div>

          {/* Separator */}
          <div className="w-[1px] bg-sur-border flex-shrink-0" />

          {/* Recent Trades */}
          <div
            className="bg-sur-surface overflow-hidden"
            style={{ width: rightW + orderbookW + 10 }}
          >
            <RecentTrades />
          </div>
        </div>
      </div>
    </div>
  );
}
