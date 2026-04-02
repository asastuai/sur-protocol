"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// Standalone orderbook demo — no providers needed, simulates live data

function fmtPrice(n: number): string {
  return n.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSize(n: number): string {
  return n.toFixed(4);
}

interface Level {
  price: number;
  size: number;
  total: number;
  percentage: number;
}

function generateLevels(midPrice: number, side: "bid" | "ask", count: number): Level[] {
  const levels: Level[] = [];
  let cumTotal = 0;
  for (let i = 0; i < count; i++) {
    const offset = (i + 1) * 0.2;
    const price = side === "ask" ? midPrice + offset : midPrice - offset;
    const size = Math.random() * 8 + 0.5;
    cumTotal += size;
    levels.push({ price: Math.round(price * 100) / 100, size, total: cumTotal, percentage: 0 });
  }
  const maxTotal = cumTotal;
  levels.forEach((l) => (l.percentage = (l.total / maxTotal) * 100));
  return levels;
}

function mutateLevels(levels: Level[], volatility: number): Level[] {
  return levels.map((l, i) => {
    const change = (Math.random() - 0.5) * volatility;
    const newSize = Math.max(0.1, l.size + change);
    return { ...l, size: newSize };
  }).reduce((acc, l) => {
    const prev = acc.length > 0 ? acc[acc.length - 1].total : 0;
    const total = prev + l.size;
    acc.push({ ...l, total });
    return acc;
  }, [] as Level[]).map((l, _, arr) => ({
    ...l,
    percentage: (l.total / (arr[arr.length - 1]?.total || 1)) * 100,
  }));
}

export default function OrderbookDemo() {
  const [midPrice, setMidPrice] = useState(1834.52);
  const [dir, setDir] = useState<"up" | "down">("up");
  const [asks, setAsks] = useState<Level[]>(() => generateLevels(1834.52, "ask", 14));
  const [bids, setBids] = useState<Level[]>(() => generateLevels(1834.52, "bid", 14));
  const [speed, setSpeed] = useState(150); // ms between updates

  const askRowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const bidRowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const prevBidsRef = useRef<Map<number, number>>(new Map());
  const prevAsksRef = useRef<Map<number, number>>(new Map());
  const flashTimers = useRef<Map<string, number>>(new Map());

  const maxTotal = useMemo(() => {
    const a = asks.length > 0 ? asks[asks.length - 1]?.total || 0 : 0;
    const b = bids.length > 0 ? bids[bids.length - 1]?.total || 0 : 0;
    return Math.max(a, b, 1);
  }, [asks, bids]);

  // Flash: instant punch → 200ms decay
  const triggerFlash = useCallback(
    (key: string, side: "bid" | "ask", el: HTMLDivElement | null) => {
      if (!el) return;
      const prev = flashTimers.current.get(key);
      if (prev) cancelAnimationFrame(prev);

      const color =
        side === "bid"
          ? "rgba(14, 203, 129, 0.4)"
          : "rgba(246, 70, 93, 0.4)";

      el.style.backgroundColor = color;
      el.style.transition = "none";
      el.offsetHeight; // force reflow

      const raf = requestAnimationFrame(() => {
        el.style.transition = "background-color 200ms ease-out";
        el.style.backgroundColor = "transparent";
      });
      flashTimers.current.set(key, raf);
    },
    []
  );

  // Simulate live updates
  useEffect(() => {
    const iv = setInterval(() => {
      const drift = (Math.random() - 0.48) * 0.3;
      setMidPrice((p) => {
        const next = Math.round((p + drift) * 100) / 100;
        setDir(next >= p ? "up" : "down");
        return next;
      });
      setAsks((prev) => mutateLevels(prev, 1.2));
      setBids((prev) => mutateLevels(prev, 1.2));
    }, speed);
    return () => clearInterval(iv);
  }, [speed]);

  // Detect changes → flash
  useEffect(() => {
    bids.forEach((level) => {
      const prev = prevBidsRef.current.get(level.price);
      if (prev !== undefined && Math.abs(level.size - prev) > 0.05) {
        const key = `bid-${level.price}`;
        triggerFlash(key, "bid", bidRowsRef.current.get(key) || null);
      }
    });
    asks.forEach((level) => {
      const prev = prevAsksRef.current.get(level.price);
      if (prev !== undefined && Math.abs(level.size - prev) > 0.05) {
        const key = `ask-${level.price}`;
        triggerFlash(key, "ask", askRowsRef.current.get(key) || null);
      }
    });
    prevBidsRef.current = new Map(bids.map((b) => [b.price, b.size]));
    prevAsksRef.current = new Map(asks.map((a) => [a.price, a.size]));
  }, [bids, asks, triggerFlash]);

  useEffect(() => {
    return () => { flashTimers.current.forEach((r) => cancelAnimationFrame(r)); };
  }, []);

  const registerRef = (map: React.MutableRefObject<Map<string, HTMLDivElement>>, key: string) =>
    (el: HTMLDivElement | null) => {
      if (el) map.current.set(key, el);
      else map.current.delete(key);
    };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "#0B0E11", fontFamily: "'Inter', system-ui, sans-serif" }}
    >
      <div className="flex flex-col gap-4 items-center">
        {/* Speed controls */}
        <div className="flex gap-2 text-xs">
          {[50, 100, 150, 300, 500].map((ms) => (
            <button
              key={ms}
              onClick={() => setSpeed(ms)}
              className={`px-3 py-1 rounded transition-colors ${
                speed === ms
                  ? "bg-[#1E80FF] text-white"
                  : "bg-[#1A1F27] text-[#848E9C] hover:text-[#EAECEF]"
              }`}
            >
              {ms}ms
            </button>
          ))}
        </div>

        {/* Orderbook */}
        <div
          className="w-[320px] rounded-md overflow-hidden select-none"
          style={{ background: "#12161C", border: "1px solid #1E2329" }}
        >
          {/* Header */}
          <div
            className="px-3 py-1.5 flex justify-between items-center"
            style={{ borderBottom: "1px solid #1E2329" }}
          >
            <span className="text-xs font-medium" style={{ color: "#848E9C" }}>
              Orderbook
            </span>
            <span
              className="text-[10px]"
              style={{
                color: "#848E9C",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              0.01
            </span>
          </div>

          {/* Column headers */}
          <div
            className="grid grid-cols-3 px-3 py-1 text-[10px] font-medium"
            style={{ color: "#5E6673" }}
          >
            <span>Price</span>
            <span className="text-right">Size</span>
            <span className="text-right">Total</span>
          </div>

          {/* Asks */}
          <div className="flex flex-col justify-end" style={{ height: "280px", overflow: "hidden" }}>
            {asks
              .slice(0, 14)
              .reverse()
              .map((level) => {
                const key = `ask-${level.price}`;
                const depthPct = Math.min((level.total / maxTotal) * 100, 100);
                return (
                  <div
                    key={key}
                    ref={registerRef(askRowsRef, key)}
                    className="relative grid grid-cols-3 px-3 cursor-pointer group"
                    style={{
                      paddingTop: "2px",
                      paddingBottom: "2px",
                      fontSize: "11px",
                    }}
                  >
                    <div
                      className="absolute inset-y-0 right-0"
                      style={{
                        width: `${depthPct}%`,
                        background: "#F6465D",
                        opacity: 0.08,
                        transition: "width 100ms ease",
                      }}
                    />
                    <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-[0.03] transition-opacity duration-75" />
                    <span
                      className="relative z-[1]"
                      style={{
                        color: "#F6465D",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtPrice(level.price)}
                    </span>
                    <span
                      className="text-right relative z-[1]"
                      style={{
                        color: "#EAECEF",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtSize(level.size)}
                    </span>
                    <span
                      className="text-right relative z-[1]"
                      style={{
                        color: "#5E6673",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {fmtSize(level.total)}
                    </span>
                  </div>
                );
              })}
          </div>

          {/* Spread / Mid price */}
          <div
            className="px-3 py-1.5 flex items-center justify-between"
            style={{ borderTop: "1px solid #1E2329", borderBottom: "1px solid #1E2329" }}
          >
            <div className="flex items-center gap-1.5">
              <span
                style={{
                  color: dir === "up" ? "#0ECB81" : "#F6465D",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: 700,
                  fontSize: "14px",
                }}
              >
                {fmtPrice(midPrice)}
              </span>
              <span
                style={{
                  color: dir === "up" ? "#0ECB81" : "#F6465D",
                  fontSize: "9px",
                }}
              >
                {dir === "up" ? "↑" : "↓"}
              </span>
            </div>
            <span
              style={{
                color: "#5E6673",
                fontSize: "10px",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {(asks[0]?.price && bids[0]?.price
                ? (asks[0].price - bids[0].price).toFixed(2)
                : "—")}
            </span>
          </div>

          {/* Bids */}
          <div style={{ height: "280px", overflow: "hidden" }}>
            {bids.slice(0, 14).map((level) => {
              const key = `bid-${level.price}`;
              const depthPct = Math.min((level.total / maxTotal) * 100, 100);
              return (
                <div
                  key={key}
                  ref={registerRef(bidRowsRef, key)}
                  className="relative grid grid-cols-3 px-3 cursor-pointer group"
                  style={{
                    paddingTop: "2px",
                    paddingBottom: "2px",
                    fontSize: "11px",
                  }}
                >
                  <div
                    className="absolute inset-y-0 right-0"
                    style={{
                      width: `${depthPct}%`,
                      background: "#0ECB81",
                      opacity: 0.08,
                      transition: "width 100ms ease",
                    }}
                  />
                  <div className="absolute inset-0 bg-white opacity-0 group-hover:opacity-[0.03] transition-opacity duration-75" />
                  <span
                    className="relative z-[1]"
                    style={{
                      color: "#0ECB81",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtPrice(level.price)}
                  </span>
                  <span
                    className="text-right relative z-[1]"
                    style={{
                      color: "#EAECEF",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtSize(level.size)}
                  </span>
                  <span
                    className="text-right relative z-[1]"
                    style={{
                      color: "#5E6673",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {fmtSize(level.total)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-[11px]" style={{ color: "#5E6673" }}>
          Click speed buttons to change update frequency. Watch the flashes.
        </p>
      </div>
    </div>
  );
}
