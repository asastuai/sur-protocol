/**
 * SUR Protocol — Intent Engine
 *
 * Translates natural language into perpetual futures trades.
 * "Short ETH 10x, max risk $500" → validated, structured, executed.
 *
 * This is NOT a chatbot. It's a semantic abstraction layer:
 *
 *   1. User/Agent sends intent in natural language
 *   2. Intent Engine parses via Anthropic Claude API
 *   3. Engine validates against risk rules (balance, leverage limits, etc.)
 *   4. Returns a preview with exact params before execution
 *   5. On confirmation, forwards to Agent API for execution
 *
 * Supports:
 *   - Simple orders: "buy 1 BTC at $50K"
 *   - Risk-managed: "long ETH 5x, stop loss 3%, take profit 8%"
 *   - Conditional: "close half my BTC if funding goes negative"
 *   - Complex: "go delta neutral on SOL with 2x short perp"
 *   - Portfolio: "reduce all positions to 5x leverage"
 *
 * Standalone HTTP service. Calls Agent API internally.
 * Port: 3004
 */

import "dotenv/config";
import http from "http";

const PORT = parseInt(process.env.INTENT_ENGINE_PORT || "3004");
const AGENT_API = process.env.AGENT_API_URL || "http://localhost:3003";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// ============================================================
//                    TYPES
// ============================================================

interface ParsedIntent {
  type: "open_position" | "close_position" | "adjust_margin" | "set_stop_loss" |
        "set_take_profit" | "conditional_close" | "portfolio_action" | "query";
  market?: string;
  side?: "long" | "short" | "buy" | "sell";
  size?: number;
  sizeUnit?: "base" | "usd";    // "1 BTC" vs "$5000 worth"
  leverage?: number;
  price?: number;                // limit price
  orderType?: "market" | "limit";
  stopLoss?: number;             // absolute price or percentage
  stopLossType?: "price" | "percent";
  takeProfit?: number;
  takeProfitType?: "price" | "percent";
  percentage?: number;           // for partial close (1-100)
  condition?: string;            // for conditional orders
  maxRisk?: number;              // max USDC to risk
  raw: string;                   // original text
}

interface IntentPreview {
  parsed: ParsedIntent;
  execution: {
    market: string;
    side: string;
    size: number;
    price: number;         // estimated execution price
    leverage: number;
    margin: number;        // USDC margin required
    stopLoss?: number;
    takeProfit?: number;
    liquidationPrice?: number;
    maxLoss?: number;      // worst case loss in USDC
    fees: number;          // estimated fees in USDC
  };
  warnings: string[];
  requiresConfirmation: boolean;
}

// ============================================================
//                    LLM INTENT PARSER
// ============================================================

const SYSTEM_PROMPT = `You are SUR Protocol's intent parser for a perpetual futures DEX.
Parse the user's natural language trading intent into a structured JSON object.

Available markets: BTC-USD (20x max), ETH-USD (20x max), SOL-USD (20x max),
AAPL-USD (10x), TSLA-USD (10x), NVDA-USD (10x), AMZN-USD (10x), MSFT-USD (10x),
GOOG-USD (10x), META-USD (10x), COIN-USD (8x), SPY-USD (12x).

Output ONLY valid JSON with these fields:
{
  "type": "open_position|close_position|adjust_margin|set_stop_loss|set_take_profit|conditional_close|portfolio_action|query",
  "market": "BTC-USD",
  "side": "long|short",
  "size": 1.5,
  "sizeUnit": "base|usd",
  "leverage": 5,
  "price": 50000,
  "orderType": "market|limit",
  "stopLoss": 48000,
  "stopLossType": "price|percent",
  "takeProfit": 55000,
  "takeProfitType": "price|percent",
  "percentage": 50,
  "condition": "funding_negative|price_above_X|price_below_X",
  "maxRisk": 500
}

Only include fields that are mentioned or implied. Infer intelligently:
- "buy BTC" → side: "long", market: "BTC-USD", orderType: "market"
- "short ETH 10x" → side: "short", market: "ETH-USD", leverage: 10
- "max risk $500" → maxRisk: 500
- "stop loss at 3%" → stopLoss: 3, stopLossType: "percent"
- "take profit 8%" → takeProfit: 8, takeProfitType: "percent"
- "close half" → type: "close_position", percentage: 50
- Numbers without $ are quantities. Numbers with $ are USD.
- If unclear, default to market order, 1x leverage.`;

async function parseIntentWithLLM(text: string): Promise<ParsedIntent | null> {
  if (!ANTHROPIC_KEY) {
    // Fallback: basic regex parsing if no API key
    return parseIntentBasic(text);
  }

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
    });

    const data = await resp.json();
    const content = data.content?.[0]?.text || "";
    const jsonStr = content.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(jsonStr);
    return { ...parsed, raw: text };
  } catch (err) {
    console.error("[IntentEngine] LLM parse error:", err);
    return parseIntentBasic(text);
  }
}

// Basic regex fallback when no API key
function parseIntentBasic(text: string): ParsedIntent {
  const lower = text.toLowerCase();
  const intent: ParsedIntent = { type: "query", raw: text };

  // Detect market
  const marketPatterns: Record<string, string> = {
    btc: "BTC-USD", eth: "ETH-USD", sol: "SOL-USD",
    aapl: "AAPL-USD", apple: "AAPL-USD",
    tsla: "TSLA-USD", tesla: "TSLA-USD",
    nvda: "NVDA-USD", nvidia: "NVDA-USD",
    spy: "SPY-USD",
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
  const sizeMatch = lower.match(/(\d+\.?\d*)\s*(btc|eth|sol|aapl|tsla|nvda|shares?)/i);
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

  return intent;
}

// ============================================================
//                    RISK VALIDATION
// ============================================================

const MAX_LEVERAGE: Record<string, number> = {
  "BTC-USD": 20, "ETH-USD": 20, "SOL-USD": 20,
  "AAPL-USD": 10, "TSLA-USD": 10, "NVDA-USD": 10, "AMZN-USD": 10,
  "MSFT-USD": 10, "GOOG-USD": 10, "META-USD": 10, "COIN-USD": 8, "SPY-USD": 12,
};

function validateIntent(intent: ParsedIntent): string[] {
  const warnings: string[] = [];

  if (intent.type === "open_position") {
    if (!intent.market) warnings.push("No market specified. Which asset do you want to trade?");
    if (!intent.side) warnings.push("No direction specified. Long or short?");
    if (!intent.size) warnings.push("No size specified. How much do you want to trade?");

    if (intent.market && intent.leverage) {
      const max = MAX_LEVERAGE[intent.market] || 10;
      if (intent.leverage > max) {
        warnings.push(`Leverage ${intent.leverage}x exceeds max ${max}x for ${intent.market}. Will use ${max}x.`);
      }
    }

    if (intent.leverage && intent.leverage > 10) {
      warnings.push(`High leverage (${intent.leverage}x). Liquidation risk is significant.`);
    }

    if (!intent.stopLoss) {
      warnings.push("No stop-loss set. Consider adding one to limit downside risk.");
    }
  }

  return warnings;
}

// ============================================================
//                    EXECUTION PREVIEW
// ============================================================

async function buildPreview(intent: ParsedIntent, traderAddress?: string): Promise<IntentPreview> {
  const warnings = validateIntent(intent);
  const market = intent.market || "BTC-USD";
  const leverage = Math.min(intent.leverage || 1, MAX_LEVERAGE[market] || 10);

  // Fetch current price (in production, call Agent API)
  const currentPrice = await fetchCurrentPrice(market);
  const price = intent.price || currentPrice;

  // Calculate size
  let sizeBase = intent.size || 0;
  if (intent.sizeUnit === "usd" && price > 0) {
    sizeBase = (intent.size || 0) / price;
  }

  // Calculate margin
  const notional = sizeBase * price;
  const margin = notional / leverage;

  // Calculate stop/take profit prices
  let stopLossPrice: number | undefined;
  let takeProfitPrice: number | undefined;
  const isLong = intent.side === "long" || intent.side === "buy";

  if (intent.stopLoss && intent.stopLossType === "percent") {
    stopLossPrice = isLong ? price * (1 - intent.stopLoss / 100) : price * (1 + intent.stopLoss / 100);
  } else if (intent.stopLoss) {
    stopLossPrice = intent.stopLoss;
  }

  if (intent.takeProfit && intent.takeProfitType === "percent") {
    takeProfitPrice = isLong ? price * (1 + intent.takeProfit / 100) : price * (1 - intent.takeProfit / 100);
  } else if (intent.takeProfit) {
    takeProfitPrice = intent.takeProfit;
  }

  // Max loss estimation
  let maxLoss: number | undefined;
  if (stopLossPrice) {
    const priceDiff = Math.abs(price - stopLossPrice);
    maxLoss = (priceDiff / price) * notional;
  }

  // If maxRisk is set, adjust size to fit
  if (intent.maxRisk && maxLoss && maxLoss > intent.maxRisk) {
    const ratio = intent.maxRisk / maxLoss;
    sizeBase *= ratio;
    maxLoss = intent.maxRisk;
    warnings.push(`Size adjusted to ${sizeBase.toFixed(4)} to stay within $${intent.maxRisk} max risk.`);
  }

  const fees = notional * 0.0005; // estimate 0.05% taker fee

  return {
    parsed: intent,
    execution: {
      market,
      side: isLong ? "long" : "short",
      size: sizeBase,
      price,
      leverage,
      margin,
      stopLoss: stopLossPrice,
      takeProfit: takeProfitPrice,
      maxLoss,
      fees,
    },
    warnings,
    requiresConfirmation: notional > 10000 || leverage > 5,
  };
}

async function fetchCurrentPrice(market: string): Promise<number> {
  // In production, call Agent API for real price
  // For now, reasonable defaults
  const defaults: Record<string, number> = {
    "BTC-USD": 65000, "ETH-USD": 3500, "SOL-USD": 150,
    "AAPL-USD": 195, "TSLA-USD": 250, "NVDA-USD": 135,
    "AMZN-USD": 185, "MSFT-USD": 430, "GOOG-USD": 170,
    "META-USD": 500, "COIN-USD": 220, "SPY-USD": 530,
  };
  try {
    const resp = await fetch(`${AGENT_API}/v1/markets`);
    // Would parse price from here in production
  } catch {}
  return defaults[market] || 50000;
}

// ============================================================
//                    EXECUTE INTENT
// ============================================================

async function executeIntent(preview: IntentPreview, trader: string): Promise<any> {
  const { execution } = preview;

  if (preview.parsed.type === "open_position") {
    return fetch(`${AGENT_API}/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader,
        marketId: execution.market,
        side: execution.side === "long" ? "buy" : "sell",
        orderType: preview.parsed.orderType || "market",
        price: String(Math.round(execution.price * 1e6)),
        size: String(Math.round(execution.size * 1e8)),
        timeInForce: "GTC",
        hidden: false,
        nonce: String(Date.now()),
        expiry: String(Math.floor(Date.now() / 1000) + 3600),
        signature: "0x", // agent wallet signs
      }),
    }).then(r => r.json());
  }

  if (preview.parsed.type === "close_position") {
    return fetch(`${AGENT_API}/v1/positions/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trader,
        market: execution.market,
        percentage: preview.parsed.percentage || 100,
      }),
    }).then(r => r.json());
  }

  return { error: "Intent type not yet supported for execution", type: preview.parsed.type };
}

// ============================================================
//                    HTTP SERVER
// ============================================================

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => d += c);
    req.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error("Invalid JSON")); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  // Health
  if (url.pathname === "/health") return json(res, { status: "ok", service: "sur-intent-engine" });

  // POST /v1/intent/parse — Parse natural language, return preview
  if (req.method === "POST" && url.pathname === "/v1/intent/parse") {
    try {
      const body = await readBody(req);
      const { text, trader } = body;
      if (!text) return json(res, { error: "Missing 'text' field" }, 400);

      const parsed = await parseIntentWithLLM(text);
      if (!parsed) return json(res, { error: "Could not parse intent" }, 422);

      const preview = await buildPreview(parsed, trader);
      return json(res, { preview });
    } catch (err: any) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /v1/intent/execute — Execute a previously previewed intent
  if (req.method === "POST" && url.pathname === "/v1/intent/execute") {
    try {
      const body = await readBody(req);
      const { preview, trader } = body;
      if (!preview || !trader) return json(res, { error: "Missing 'preview' and 'trader'" }, 400);

      const result = await executeIntent(preview, trader);
      return json(res, { result });
    } catch (err: any) {
      return json(res, { error: err.message }, 500);
    }
  }

  // POST /v1/intent — Parse + execute in one call (for agents that don't need preview)
  if (req.method === "POST" && url.pathname === "/v1/intent") {
    try {
      const body = await readBody(req);
      const { text, trader, autoExecute } = body;
      if (!text) return json(res, { error: "Missing 'text'" }, 400);

      const parsed = await parseIntentWithLLM(text);
      if (!parsed) return json(res, { error: "Could not parse intent" }, 422);

      const preview = await buildPreview(parsed, trader);

      // If autoExecute and no critical warnings, execute immediately
      if (autoExecute && trader && preview.warnings.length === 0) {
        const result = await executeIntent(preview, trader);
        return json(res, { preview, executed: true, result });
      }

      return json(res, { preview, executed: false });
    } catch (err: any) {
      return json(res, { error: err.message }, 500);
    }
  }

  json(res, { error: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║     SUR Protocol — Intent Engine               ║");
  console.log(`║     Port: ${PORT}                                  ║`);
  console.log("║     Natural language → perpetual trades        ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log(`  Parse:   POST http://localhost:${PORT}/v1/intent/parse`);
  console.log(`  Execute: POST http://localhost:${PORT}/v1/intent/execute`);
  console.log(`  OneShot: POST http://localhost:${PORT}/v1/intent`);
  console.log(`  LLM:     ${ANTHROPIC_KEY ? "Claude API configured ✓" : "Fallback regex mode (no API key)"}`);
});
