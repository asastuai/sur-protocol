/**
 * SUR Protocol - MCP Server (Model Context Protocol)
 *
 * Enables LLMs (Claude, GPT, Gemini) to interact with SUR directly.
 * An agent can say "open a long 1 BTC at $50,000" and this server
 * translates that into the correct API calls.
 *
 * MCP Tools exposed:
 *   - sur_get_markets        → List all available markets
 *   - sur_get_orderbook      → Get orderbook for a market
 *   - sur_get_position       → Get a trader's position
 *   - sur_get_account        → Get cross-margin account details
 *   - sur_get_balance        → Get vault balance
 *   - sur_get_funding_rate   → Get current funding rate
 *   - sur_submit_order       → Submit a signed trading order
 *   - sur_cancel_order       → Cancel an open order
 *   - sur_get_vaults         → List available trading vaults
 *   - sur_get_vault_info     → Get vault details
 *   - sur_get_agent_status   → Get agent registration status
 *
 * This is STANDALONE — uses the Agent REST API internally.
 * No modifications to any existing SUR code.
 *
 * Integration with Coinbase Agentic Wallets:
 *   The MCP server can be used alongside Coinbase's Agentic Wallet CLI.
 *   The LLM decides what to do, MCP calls SUR API, Agentic Wallet signs the tx.
 */

import "dotenv/config";

const AGENT_API_URL = process.env.AGENT_API_URL || "http://localhost:3003";

// ============================================================
//                    MCP TOOL DEFINITIONS
// ============================================================

interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

const TOOLS: MCPTool[] = [
  {
    name: "sur_get_markets",
    description: "List all available markets on SUR Protocol. Returns crypto perps (BTC, ETH, SOL) and stock perps (AAPL, TSLA, NVDA, etc.) with leverage and margin info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sur_get_orderbook",
    description: "Get the current orderbook (bids and asks) for a market. Specify depth for how many price levels to return.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market name, e.g. 'BTC-USD', 'AAPL-USD'" },
        depth: { type: "number", description: "Number of price levels per side (default: 10)" },
      },
      required: ["market"],
    },
  },
  {
    name: "sur_get_position",
    description: "Get a trader's current position in a specific market. Returns size, entry price, margin, unrealized PnL, and liquidation status.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market name, e.g. 'BTC-USD'" },
        trader: { type: "string", description: "Trader's Ethereum address (0x...)" },
      },
      required: ["market", "trader"],
    },
  },
  {
    name: "sur_get_account",
    description: "Get cross-margin account details for a trader. Returns total equity, margin usage, unrealized PnL, positions count, and liquidation risk.",
    inputSchema: {
      type: "object",
      properties: {
        trader: { type: "string", description: "Trader's Ethereum address (0x...)" },
      },
      required: ["trader"],
    },
  },
  {
    name: "sur_get_balance",
    description: "Get a trader's USDC balance available in the vault for trading.",
    inputSchema: {
      type: "object",
      properties: {
        trader: { type: "string", description: "Trader's Ethereum address (0x...)" },
      },
      required: ["trader"],
    },
  },
  {
    name: "sur_submit_order",
    description: "Submit a trading order on SUR Protocol. Supports limit and market orders for all crypto and stock perp markets. Returns order ID and status.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market name, e.g. 'BTC-USD', 'TSLA-USD'" },
        side: { type: "string", enum: ["buy", "sell"], description: "Order side: 'buy' for long, 'sell' for short" },
        size: { type: "number", description: "Position size in base asset (e.g. 1.5 for 1.5 BTC, 100 for 100 AAPL shares)" },
        price: { type: "number", description: "Limit price in USD. Use 0 for market order." },
        orderType: { type: "string", enum: ["limit", "market"], description: "Order type (default: limit)" },
        timeInForce: { type: "string", enum: ["GTC", "IOC", "FOK", "PostOnly"], description: "Time in force (default: GTC)" },
        hidden: { type: "boolean", description: "If true, order is hidden from orderbook (default: false)" },
        trader: { type: "string", description: "Trader's Ethereum address" },
        signature: { type: "string", description: "EIP-712 signature from Agentic Wallet" },
      },
      required: ["market", "side", "size", "trader"],
    },
  },
  {
    name: "sur_cancel_order",
    description: "Cancel an open order by its order ID.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The order ID to cancel" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "sur_get_vaults",
    description: "List available trading vaults where you can deposit USDC and have a professional trader (or AI agent) manage your funds.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sur_get_agent_status",
    description: "Check if an address is registered as an agent on SUR and view their trading stats and fee tier.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Agent's Ethereum address (0x...)" },
      },
      required: ["address"],
    },
  },
  {
    name: "sur_register_agent",
    description: "Register an address as an AI agent on SUR Protocol to get reduced trading fees. Agents start at 0.015%/0.05% maker/taker fees vs 0.02%/0.06% for regular users.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Agent's Ethereum address (0x...)" },
        name: { type: "string", description: "Agent name for the leaderboard" },
      },
      required: ["address", "name"],
    },
  },
  {
    name: "sur_get_agent_leaderboard",
    description: "Get the top-performing AI agents on SUR Protocol ranked by trading volume.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── A2A DARK POOL ──
  {
    name: "sur_a2a_post_intent",
    description: "Post an intent to the A2A Dark Pool. Your intent is private and won't appear on the public orderbook. Other agents can respond with price proposals. Example: 'I want to buy 50 BTC between $49,800-$50,200 in the next hour'.",
    inputSchema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Market name (e.g. 'BTC-USD')" },
        side: { type: "string", enum: ["buy", "sell"], description: "Buy or sell" },
        size: { type: "number", description: "Amount in base asset (e.g. 50 for 50 BTC)" },
        minPrice: { type: "number", description: "Minimum acceptable price in USD" },
        maxPrice: { type: "number", description: "Maximum acceptable price in USD" },
        durationSecs: { type: "number", description: "How long the intent is valid (seconds, default: 3600)" },
      },
      required: ["market", "side", "size", "minPrice", "maxPrice"],
    },
  },
  {
    name: "sur_a2a_get_intents",
    description: "Browse open intents in the A2A Dark Pool for a specific market. Shows what other agents want to buy/sell privately.",
    inputSchema: {
      type: "object",
      properties: { market: { type: "string", description: "Market name (e.g. 'BTC-USD')" } },
      required: ["market"],
    },
  },
  {
    name: "sur_a2a_respond",
    description: "Respond to an intent with your proposed price. If the intent creator accepts, the trade settles atomically.",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "number", description: "The intent ID to respond to" },
        price: { type: "number", description: "Your proposed execution price in USD" },
        durationSecs: { type: "number", description: "How long your response is valid (default: 600)" },
      },
      required: ["intentId", "price"],
    },
  },
  {
    name: "sur_a2a_accept",
    description: "Accept a response to your intent and settle the trade atomically. Both positions open simultaneously — if either side can't fulfill, the whole transaction reverts.",
    inputSchema: {
      type: "object",
      properties: {
        intentId: { type: "number", description: "Your intent ID" },
        responseId: { type: "number", description: "The response ID to accept" },
      },
      required: ["intentId", "responseId"],
    },
  },
  {
    name: "sur_a2a_reputation",
    description: "Check an agent's A2A Dark Pool reputation. Shows completion rate, volume, and trust tier (new/bronze/silver/gold/diamond).",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Agent address (0x...)" } },
      required: ["address"],
    },
  },
];

// ============================================================
//                    TOOL EXECUTION
// ============================================================

async function callAgentAPI(path: string, method = "GET", body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${AGENT_API_URL}${path}`, opts);
  return resp.json();
}

async function executeTool(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "sur_get_markets":
      return callAgentAPI("/v1/markets");

    case "sur_get_orderbook":
      return callAgentAPI(`/v1/orderbook/${encodeURIComponent(args.market)}?depth=${args.depth || 10}`);

    case "sur_get_position":
      return callAgentAPI(`/v1/positions/${args.trader}?market=${encodeURIComponent(args.market)}`);

    case "sur_get_account":
      return callAgentAPI(`/v1/account/${args.trader}`);

    case "sur_get_balance":
      return callAgentAPI(`/v1/balance/${args.trader}`);

    case "sur_submit_order":
      return callAgentAPI("/v1/orders", "POST", {
        trader: args.trader,
        marketId: args.market, // Agent API resolves name → marketId internally
        side: args.side,
        orderType: args.orderType || "limit",
        price: String(Math.round((args.price || 0) * 1e6)),
        size: String(Math.round(args.size * 1e8)),
        timeInForce: args.timeInForce || "GTC",
        hidden: args.hidden || false,
        nonce: String(Date.now()),
        expiry: String(Math.floor(Date.now() / 1000) + 3600),
        signature: args.signature || "0x",
      });

    case "sur_cancel_order":
      return callAgentAPI(`/v1/orders/${args.orderId}`, "DELETE");

    case "sur_get_vaults":
      return callAgentAPI("/v1/vaults");

    case "sur_get_agent_status":
      return callAgentAPI(`/v1/agent/status/${args.address}`);

    case "sur_register_agent":
      return callAgentAPI("/v1/agent/register", "POST", {
        address: args.address,
        name: args.name,
      });

    case "sur_get_agent_leaderboard":
      return callAgentAPI("/v1/agent/leaderboard");

    // ── A2A DARK POOL ──
    case "sur_a2a_post_intent":
      return callAgentAPI("/v1/a2a/intents", "POST", {
        market: args.market,
        side: args.side,
        size: args.size,
        minPrice: args.minPrice,
        maxPrice: args.maxPrice,
        durationSecs: args.durationSecs || 3600,
      });

    case "sur_a2a_get_intents":
      return callAgentAPI(`/v1/a2a/intents?market=${encodeURIComponent(args.market)}&status=open`);

    case "sur_a2a_respond":
      return callAgentAPI(`/v1/a2a/intents/${args.intentId}/responses`, "POST", {
        price: args.price,
        durationSecs: args.durationSecs || 600,
      });

    case "sur_a2a_accept":
      return callAgentAPI("/v1/a2a/settle", "POST", {
        intentId: args.intentId,
        responseId: args.responseId,
      });

    case "sur_a2a_reputation":
      return callAgentAPI(`/v1/a2a/reputation/${args.address}`);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ============================================================
//                    MCP STDIO SERVER
// ============================================================

/**
 * MCP uses JSON-RPC over stdin/stdout.
 * The LLM sends requests, we respond with tool results.
 */

async function handleMessage(message: any): Promise<any> {
  const { method, params, id } = message;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "sur-protocol-mcp",
            version: "0.1.0",
            description: "SUR Protocol - Agent-Native Perpetual Futures DEX on Base L2. Trade crypto and stock perps with AI agent fee discounts.",
          },
        },
      };

    case "tools/list":
      return {
        jsonrpc: "2.0", id,
        result: { tools: TOOLS },
      };

    case "tools/call": {
      const { name, arguments: args } = params;
      try {
        const result = await executeTool(name, args || {});
        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err: any) {
        return {
          jsonrpc: "2.0", id,
          result: {
            content: [{ type: "text", text: `Error: ${err.message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
  }
}

// Read from stdin, write to stdout
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", async (chunk: string) => {
  buffer += chunk;

  // Process complete messages (newline-delimited JSON)
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      const response = await handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err: any) {
      process.stderr.write(`MCP Error: ${err.message}\n`);
    }
  }
});

process.stderr.write("SUR Protocol MCP Server started. Waiting for LLM connections...\n");
