/**
 * SUR Protocol - A2A Dark Pool SDK Extension
 *
 * Import alongside the main SDK:
 *   import { SurClient } from "@sur-protocol/sdk";
 *   import { A2AClient } from "@sur-protocol/sdk/a2a";
 *
 *   const a2a = new A2AClient(agentApiUrl);
 *
 *   // Post intent: "I want to buy 50 BTC between $49.8K-$50.2K"
 *   const intent = await a2a.postIntent({
 *     market: "BTC-USD",
 *     side: "buy",
 *     size: 50,
 *     minPrice: 49800,
 *     maxPrice: 50200,
 *     durationSecs: 3600,
 *   });
 *
 *   // Browse open intents
 *   const intents = await a2a.getOpenIntents("BTC-USD");
 *
 *   // Respond to an intent
 *   const resp = await a2a.postResponse(intentId, 50050, 600);
 *
 *   // Accept best response → atomic settlement
 *   await a2a.acceptAndSettle(intentId, responseId, signature);
 *
 *   // Check agent reputation
 *   const rep = await a2a.getReputation("0xAgent...");
 */

// ============================================================
//                    TYPES
// ============================================================

export type IntentStatus = "open" | "filled" | "cancelled" | "expired";
export type ResponseStatus = "pending" | "accepted" | "cancelled" | "expired";

export interface A2AIntent {
  id: number;
  agent: string;
  market: string;
  side: "buy" | "sell";
  size: number;            // in base asset
  minPrice: number;        // USD
  maxPrice: number;        // USD
  createdAt: number;
  expiresAt: number;
  status: IntentStatus;
  responseCount: number;
}

export interface A2AResponse {
  id: number;
  intentId: number;
  agent: string;
  price: number;
  createdAt: number;
  expiresAt: number;
  status: ResponseStatus;
}

export interface AgentReputation {
  address: string;
  score: number;           // 0-100 (percentage)
  completedTrades: number;
  totalVolumeUsd: number;
  expiredIntents: number;
  cancelledResponses: number;
  firstTradeAt: number;
  lastTradeAt: number;
  tier: "new" | "bronze" | "silver" | "gold" | "diamond";
}

export interface A2ATradeResult {
  intentId: number;
  responseId: number;
  buyer: string;
  seller: string;
  market: string;
  size: number;
  price: number;
  timestamp: number;
  feePaid: number;
}

// ============================================================
//                    CLIENT
// ============================================================

export class A2AClient {
  private baseUrl: string;

  constructor(agentApiUrl: string = "http://localhost:3003") {
    this.baseUrl = agentApiUrl;
  }

  // ---- Intents ----

  async postIntent(params: {
    market: string;
    side: "buy" | "sell";
    size: number;
    minPrice: number;
    maxPrice: number;
    durationSecs: number;
    signature?: string;
  }): Promise<{ intentId: number }> {
    return this.post("/v1/a2a/intents", params);
  }

  async cancelIntent(intentId: number): Promise<void> {
    await this.del(`/v1/a2a/intents/${intentId}`);
  }

  async getOpenIntents(market: string): Promise<A2AIntent[]> {
    const res = await this.get(`/v1/a2a/intents?market=${encodeURIComponent(market)}&status=open`);
    return res.intents;
  }

  async getIntent(intentId: number): Promise<A2AIntent> {
    return this.get(`/v1/a2a/intents/${intentId}`);
  }

  // ---- Responses ----

  async postResponse(intentId: number, price: number, durationSecs: number): Promise<{ responseId: number }> {
    return this.post(`/v1/a2a/intents/${intentId}/responses`, { price, durationSecs });
  }

  async getResponses(intentId: number): Promise<A2AResponse[]> {
    const res = await this.get(`/v1/a2a/intents/${intentId}/responses`);
    return res.responses;
  }

  // ---- Accept + Settle ----

  async acceptAndSettle(intentId: number, responseId: number, signature?: string): Promise<A2ATradeResult> {
    return this.post(`/v1/a2a/settle`, { intentId, responseId, signature });
  }

  // ---- Reputation ----

  async getReputation(agentAddress: string): Promise<AgentReputation> {
    const data = await this.get(`/v1/a2a/reputation/${agentAddress}`);
    // Compute tier from score
    const tier = data.score >= 95 ? "diamond"
      : data.score >= 80 ? "gold"
      : data.score >= 60 ? "silver"
      : data.score >= 30 ? "bronze"
      : "new";
    return { ...data, tier };
  }

  async getLeaderboard(limit = 20): Promise<AgentReputation[]> {
    const res = await this.get(`/v1/a2a/leaderboard?limit=${limit}`);
    return res.agents;
  }

  // ---- Stats ----

  async getDarkPoolStats(): Promise<{
    totalIntents: number;
    totalSettled: number;
    totalVolumeUsd: number;
    activeIntents: number;
    uniqueAgents: number;
  }> {
    return this.get("/v1/a2a/stats");
  }

  // ---- HTTP helpers ----

  private async get(path: string): Promise<any> {
    const resp = await fetch(`${this.baseUrl}${path}`);
    if (!resp.ok) throw new Error(`A2A API error: ${resp.status}`);
    return resp.json();
  }

  private async post(path: string, body: any): Promise<any> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`A2A API error: ${resp.status}`);
    return resp.json();
  }

  private async del(path: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
    if (!resp.ok) throw new Error(`A2A API error: ${resp.status}`);
  }
}

export default A2AClient;
