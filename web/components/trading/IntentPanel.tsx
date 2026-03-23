"use client";

/**
 * IntentPanel — Natural Language Trading
 *
 * Type what you want to trade in plain English (or Spanish).
 * The Intent Engine parses it into a structured order preview.
 * Confirm to execute. Powered by the Intent Engine service.
 */

import { useState, useRef, useEffect } from "react";
import { useTrading } from "@/providers/TradingProvider";

// ============================================================
//                    TYPES
// ============================================================

interface ParsedIntent {
  type: string;
  market?: string;
  side?: string;
  size?: number;
  sizeUnit?: string;
  leverage?: number;
  price?: number;
  orderType?: string;
  stopLoss?: number;
  stopLossType?: string;
  takeProfit?: number;
  takeProfitType?: string;
  percentage?: number;
  maxRisk?: number;
  raw: string;
}

interface IntentPreview {
  parsed: ParsedIntent;
  execution: {
    market: string;
    side: string;
    size: number;
    price: number;
    leverage: number;
    margin: number;
    stopLoss?: number;
    takeProfit?: number;
    liquidationPrice?: number;
    maxLoss?: number;
    fees: number;
  };
  warnings: string[];
  requiresConfirmation: boolean;
}

type IntentStatus = "idle" | "parsing" | "preview" | "executing" | "done" | "error";

const INTENT_ENGINE_URL = process.env.NEXT_PUBLIC_INTENT_ENGINE_URL || "http://localhost:3004";

const EXAMPLES = [
  "Long BTC 5x, $1000",
  "Short ETH 10x, stop loss 3%",
  "Buy 0.5 BTC at $80,000",
  "Close half my ETH position",
  "Long BTC 20x, take profit 5%, stop loss 2%",
];

// ============================================================
//                    LOCAL PARSER (fallback)
// ============================================================

function parseLocally(text: string, markPrice: number): IntentPreview | null {
  const lower = text.toLowerCase();
  const intent: ParsedIntent = { type: "query", raw: text };

  // Detect market
  const marketPatterns: Record<string, string> = {
    btc: "BTC-USD", bitcoin: "BTC-USD",
    eth: "ETH-USD", ethereum: "ETH-USD",
  };
  for (const [key, market] of Object.entries(marketPatterns)) {
    if (lower.includes(key)) { intent.market = market; break; }
  }

  // Detect side
  if (lower.includes("long") || lower.includes("buy") || lower.includes("compra")) intent.side = "long";
  if (lower.includes("short") || lower.includes("sell") || lower.includes("vend")) intent.side = "short";

  // Detect type
  if (lower.includes("close") || lower.includes("cerra") || lower.includes("exit")) {
    intent.type = "close_position";
    const halfMatch = lower.match(/(\d+)\s*%/);
    if (halfMatch) intent.percentage = parseInt(halfMatch[1]);
    else if (lower.includes("half") || lower.includes("mitad")) intent.percentage = 50;
  } else if (intent.side) {
    intent.type = "open_position";
  }

  // Detect size
  const sizeMatch = lower.match(/(\d+\.?\d*)\s*(btc|eth)/i);
  if (sizeMatch) { intent.size = parseFloat(sizeMatch[1]); intent.sizeUnit = "base"; }
  const usdMatch = lower.match(/\$(\d+[\d,]*\.?\d*)/);
  if (usdMatch && !intent.size) { intent.size = parseFloat(usdMatch[1].replace(/,/g, "")); intent.sizeUnit = "usd"; }

  // Detect leverage
  const levMatch = lower.match(/(\d+)\s*x/);
  if (levMatch) intent.leverage = parseInt(levMatch[1]);

  // Detect stop loss
  const slMatch = lower.match(/stop\s*(?:loss)?\s*(?:at|al|@)?\s*(\d+\.?\d*)\s*%/i);
  if (slMatch) { intent.stopLoss = parseFloat(slMatch[1]); intent.stopLossType = "percent"; }

  // Detect take profit
  const tpMatch = lower.match(/take\s*(?:profit)?\s*(?:at|al|@)?\s*(\d+\.?\d*)\s*%/i);
  if (tpMatch) { intent.takeProfit = parseFloat(tpMatch[1]); intent.takeProfitType = "percent"; }

  // Max risk
  const riskMatch = lower.match(/(?:max|maximo)\s*(?:risk|riesgo)\s*\$?(\d+[\d,]*)/i);
  if (riskMatch) intent.maxRisk = parseFloat(riskMatch[1].replace(/,/g, ""));

  if (intent.type === "query") return null;

  // Build preview
  const market = intent.market || "BTC-USD";
  const leverage = Math.min(intent.leverage || 1, 50);
  const price = intent.price || markPrice || 84000;
  const isLong = intent.side === "long" || intent.side === "buy";

  let sizeBase = intent.size || 0;
  if (intent.sizeUnit === "usd" && price > 0) {
    sizeBase = (intent.size || 0) / price;
  }

  const notional = sizeBase * price;
  const margin = notional / leverage;

  let stopLossPrice: number | undefined;
  let takeProfitPrice: number | undefined;
  if (intent.stopLoss && intent.stopLossType === "percent") {
    stopLossPrice = isLong ? price * (1 - intent.stopLoss / 100) : price * (1 + intent.stopLoss / 100);
  }
  if (intent.takeProfit && intent.takeProfitType === "percent") {
    takeProfitPrice = isLong ? price * (1 + intent.takeProfit / 100) : price * (1 - intent.takeProfit / 100);
  }

  let maxLoss: number | undefined;
  if (stopLossPrice) {
    const priceDiff = Math.abs(price - stopLossPrice);
    maxLoss = (priceDiff / price) * notional;
  }

  const fees = notional * 0.0006;

  const warnings: string[] = [];
  if (!intent.market) warnings.push("No market specified — defaulting to BTC-USD");
  if (!intent.size) warnings.push("No size specified");
  if (leverage > 10) warnings.push(`High leverage (${leverage}x) — liquidation risk is significant`);
  if (!intent.stopLoss) warnings.push("No stop-loss set — consider adding one");

  return {
    parsed: intent,
    execution: {
      market, side: isLong ? "long" : "short", size: sizeBase, price, leverage, margin,
      stopLoss: stopLossPrice, takeProfit: takeProfitPrice, maxLoss, fees,
    },
    warnings,
    requiresConfirmation: notional > 10000 || leverage > 5,
  };
}

// ============================================================
//                    COMPONENT
// ============================================================

export default function IntentPanel() {
  const { state } = useTrading();
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<IntentStatus>("idle");
  const [preview, setPreview] = useState<IntentPreview | null>(null);
  const [error, setError] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const parseIntent = async () => {
    if (!input.trim()) return;
    setStatus("parsing");
    setError("");
    setPreview(null);

    // Try remote intent engine first
    try {
      const resp = await fetch(`${INTENT_ENGINE_URL}/v1/intent/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: input.trim() }),
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.preview) {
          setPreview(data.preview);
          setStatus("preview");
          return;
        }
      }
    } catch {
      // Intent engine not running — fall back to local parser
    }

    // Local fallback
    const local = parseLocally(input.trim(), state.markPrice);
    if (local) {
      setPreview(local);
      setStatus("preview");
    } else {
      setError("Could not parse intent. Try: \"Long BTC 5x, $1000\"");
      setStatus("error");
    }
  };

  const executeIntent = async () => {
    if (!preview) return;
    setStatus("executing");

    // Try remote execution
    try {
      const resp = await fetch(`${INTENT_ENGINE_URL}/v1/intent/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview, trader: "paper" }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        setStatus("done");
        setHistory(prev => [input, ...prev.slice(0, 9)]);
        setTimeout(() => { setStatus("idle"); setInput(""); setPreview(null); }, 2000);
        return;
      }
    } catch {
      // Engine not available
    }

    setError("Intent Engine not connected. Backend deployment required for execution.");
    setStatus("error");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (status === "preview") executeIntent();
      else parseIntent();
    }
    if (e.key === "Escape") {
      setStatus("idle");
      setPreview(null);
      setError("");
    }
  };

  const fmtUsd = (v: number) => v >= 1000 ? `$${(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${v.toFixed(2)}`;

  return (
    <div className="bg-[#1c1c20] border border-[#28282e] rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-gray-300">INTENT TRADING</span>
          <span className="text-[8px] px-1.5 py-0.5 bg-purple-500/15 text-purple-400 rounded font-bold uppercase tracking-wider">
            AI
          </span>
        </div>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className={`transition-transform text-gray-500 ${isExpanded ? "rotate-180" : ""}`}>
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {isExpanded && (
        <div className="border-t border-[#28282e]">
          {/* Input */}
          <div className="p-3">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder='Try: "Long BTC 5x, $1000"'
                className="flex-1 bg-[#161618] border border-[#28282e] rounded px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-purple-500/50"
                disabled={status === "executing"}
              />
              <button
                onClick={status === "preview" ? executeIntent : parseIntent}
                disabled={!input.trim() || status === "executing"}
                className={`px-3 py-2 rounded text-[10px] font-bold transition-colors ${
                  status === "preview"
                    ? "bg-sur-green/20 text-sur-green hover:bg-sur-green/30"
                    : "bg-purple-500/20 text-purple-400 hover:bg-purple-500/30"
                } disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                {status === "parsing" ? "..." : status === "preview" ? "EXECUTE" : status === "executing" ? "..." : "PARSE"}
              </button>
            </div>

            {/* Examples */}
            {status === "idle" && !input && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {EXAMPLES.slice(0, 3).map((ex) => (
                  <button
                    key={ex}
                    onClick={() => { setInput(ex); inputRef.current?.focus(); }}
                    className="text-[9px] px-2 py-1 rounded bg-[#28282e] text-gray-400 hover:text-gray-200 hover:bg-[#2e2e34] transition-colors"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Error */}
          {status === "error" && error && (
            <div className="mx-3 mb-3 px-3 py-2 rounded bg-sur-red/10 border border-sur-red/20 text-[10px] text-sur-red">
              {error}
            </div>
          )}

          {/* Done */}
          {status === "done" && (
            <div className="mx-3 mb-3 px-3 py-2 rounded bg-sur-green/10 border border-sur-green/20 text-[10px] text-sur-green">
              Intent submitted successfully
            </div>
          )}

          {/* Preview */}
          {status === "preview" && preview && (
            <div className="mx-3 mb-3 p-3 rounded bg-[#161618] border border-[#28282e]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-gray-300 uppercase tracking-wider">Order Preview</span>
                <button
                  onClick={() => { setStatus("idle"); setPreview(null); }}
                  className="text-[9px] text-gray-500 hover:text-gray-300"
                >
                  Cancel
                </button>
              </div>

              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
                <div className="flex justify-between">
                  <span className="text-gray-500">Market</span>
                  <span className="text-white font-medium">{preview.execution.market}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Side</span>
                  <span className={preview.execution.side === "long" ? "text-sur-green font-medium" : "text-sur-red font-medium"}>
                    {preview.execution.side.toUpperCase()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Size</span>
                  <span className="text-white">{preview.execution.size.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Leverage</span>
                  <span className="text-white">{preview.execution.leverage}x</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Price</span>
                  <span className="text-white">{fmtUsd(preview.execution.price)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Margin</span>
                  <span className="text-white">{fmtUsd(preview.execution.margin)}</span>
                </div>
                {preview.execution.stopLoss && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Stop Loss</span>
                    <span className="text-sur-red">{fmtUsd(preview.execution.stopLoss)}</span>
                  </div>
                )}
                {preview.execution.takeProfit && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Take Profit</span>
                    <span className="text-sur-green">{fmtUsd(preview.execution.takeProfit)}</span>
                  </div>
                )}
                {preview.execution.maxLoss != null && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Max Loss</span>
                    <span className="text-sur-red">{fmtUsd(preview.execution.maxLoss)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">Est. Fee</span>
                  <span className="text-gray-400">{fmtUsd(preview.execution.fees)}</span>
                </div>
              </div>

              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  {preview.warnings.map((w, i) => (
                    <div key={i} className="text-[9px] text-sur-yellow flex items-start gap-1">
                      <span className="mt-px">!</span>
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={executeIntent}
                className="w-full mt-3 py-2 rounded text-[11px] font-bold bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors"
              >
                Confirm & Execute
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
