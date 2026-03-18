"use client";

/**
 * RiskGuardianPanel — Anti-Liquidation Protection
 *
 * Subscribe to Risk Guardian to automatically defend positions
 * before the protocol's liquidation engine acts.
 *
 * Defense layers: Monitor → Alert → Add Margin → Reduce → Emergency Close
 * Fee: 5 bps (0.05%) only when guardian intervenes.
 */

import { useState, useEffect, useCallback } from "react";
import { useTrading } from "@/providers/TradingProvider";

const GUARDIAN_URL = process.env.NEXT_PUBLIC_RISK_GUARDIAN_URL || "http://localhost:3005";

type DefenseLevel = "safe" | "caution" | "warning" | "danger" | "critical";

interface GuardianStatus {
  subscribed: boolean;
  config?: {
    enabled: boolean;
    alertThreshold: number;
    defendThreshold: number;
    reduceThreshold: number;
    emergencyThreshold: number;
    autoAddMargin: boolean;
    autoReduceSize: boolean;
    autoEmergencyClose: boolean;
    maxMarginToAdd: number;
    reducePercentage: number;
  };
  stats?: {
    totalAlerts: number;
    totalInterventions: number;
    totalFeesCharged: number;
    lastAction: {
      action: string;
      detail: string;
      timestamp: number;
    } | null;
  };
}

interface GuardianAction {
  id: string;
  timestamp: number;
  market: string;
  action: string;
  detail: string;
  feeCharged: number;
  success: boolean;
}

const DEFENSE_LEVELS: { level: DefenseLevel; label: string; color: string; desc: string }[] = [
  { level: "safe", label: "SAFE", color: "text-sur-green", desc: "No action needed" },
  { level: "caution", label: "CAUTION", color: "text-sur-yellow", desc: "Alert sent" },
  { level: "warning", label: "WARNING", color: "text-orange-400", desc: "Auto-add margin" },
  { level: "danger", label: "DANGER", color: "text-sur-red", desc: "Reduce position" },
  { level: "critical", label: "CRITICAL", color: "text-red-500", desc: "Emergency close" },
];

const ACTION_ICONS: Record<string, string> = {
  alert: "!",
  add_margin: "+",
  reduce_position: "-",
  hedge: "H",
  emergency_close: "X",
};

export default function RiskGuardianPanel() {
  const { state } = useTrading();
  const [isExpanded, setIsExpanded] = useState(false);
  const [tab, setTab] = useState<"status" | "config" | "history">("status");
  const [guardianStatus, setGuardianStatus] = useState<GuardianStatus | null>(null);
  const [actions, setActions] = useState<GuardianAction[]>([]);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  // Use a placeholder address for paper trading
  const traderAddress = "0x_paper_trader";

  // Check guardian status
  const checkStatus = useCallback(async () => {
    try {
      const resp = await fetch(`${GUARDIAN_URL}/v1/guardian/status/${traderAddress}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json();
        setGuardianStatus(data);
        setConnected(true);
      } else if (resp.status === 404) {
        setGuardianStatus({ subscribed: false });
        setConnected(true);
      }
    } catch {
      setConnected(false);
      setGuardianStatus(null);
    }
  }, [traderAddress]);

  // Check connection on expand
  useEffect(() => {
    if (isExpanded) checkStatus();
  }, [isExpanded, checkStatus]);

  // Subscribe
  const subscribe = async () => {
    setSubscribing(true);
    try {
      const resp = await fetch(`${GUARDIAN_URL}/v1/guardian/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trader: traderAddress }),
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        await checkStatus();
      }
    } catch {
      // Not connected
    }
    setSubscribing(false);
  };

  // Unsubscribe
  const unsubscribe = async () => {
    try {
      await fetch(`${GUARDIAN_URL}/v1/guardian/unsubscribe/${traderAddress}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(2000),
      });
      setGuardianStatus({ subscribed: false });
    } catch {}
  };

  // Fetch action history
  const fetchHistory = async () => {
    try {
      const resp = await fetch(`${GUARDIAN_URL}/v1/guardian/actions/${traderAddress}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json();
        setActions(data.actions || []);
      }
    } catch {}
  };

  useEffect(() => {
    if (tab === "history" && isExpanded) fetchHistory();
  }, [tab, isExpanded]);

  // Compute position risk for local display
  const positionsAtRisk = state.paperPositions.filter(p => {
    if (!p.size || p.size === 0) return false;
    const mp = state.markPrice > 0 ? state.markPrice : p.entryPrice;
    // Simple distance estimate
    const isLong = p.side === "long";
    const liqPrice = isLong
      ? p.entryPrice * (1 - 1 / p.leverage * 0.9)
      : p.entryPrice * (1 + 1 / p.leverage * 0.9);
    const distance = Math.abs(mp - liqPrice) / mp * 100;
    return distance < 30;
  });

  return (
    <div className="bg-[#1b1d28] border border-[#252836] rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </div>
          <span className="text-xs font-semibold text-gray-300">RISK GUARDIAN</span>
          {guardianStatus?.subscribed && (
            <span className="text-[8px] px-1.5 py-0.5 bg-sur-green/15 text-sur-green rounded font-bold uppercase tracking-wider">
              Active
            </span>
          )}
          {!guardianStatus?.subscribed && (
            <span className="text-[8px] px-1.5 py-0.5 bg-gray-500/15 text-gray-500 rounded font-bold uppercase tracking-wider">
              Off
            </span>
          )}
          {positionsAtRisk.length > 0 && (
            <span className="text-[8px] px-1.5 py-0.5 bg-sur-yellow/15 text-sur-yellow rounded font-bold">
              {positionsAtRisk.length} at risk
            </span>
          )}
        </div>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none" className={`transition-transform text-gray-500 ${isExpanded ? "rotate-180" : ""}`}>
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {isExpanded && (
        <div className="border-t border-[#252836]">
          {/* Tabs */}
          <div className="flex border-b border-[#252836]">
            {(["status", "config", "history"] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2 text-[10px] font-medium transition-colors ${
                  tab === t ? "text-white border-b border-sur-green" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {t === "status" ? "Status" : t === "config" ? "Settings" : "History"}
              </button>
            ))}
          </div>

          {/* Not connected */}
          {!connected && tab === "status" && (
            <div className="p-4">
              <div className="text-center">
                <div className="w-10 h-10 rounded-full bg-[#252836] flex items-center justify-center mx-auto mb-3">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <p className="text-[11px] text-gray-400 mb-1 font-medium">Risk Guardian Service</p>
                <p className="text-[10px] text-gray-500 mb-3 leading-relaxed">
                  Anti-liquidation protection that monitors your positions and intervenes before liquidation.
                  Charges 0.05% only when it takes action.
                </p>
                <div className="space-y-2 text-left mb-4">
                  {DEFENSE_LEVELS.map(d => (
                    <div key={d.level} className="flex items-center gap-2 text-[9px]">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        d.level === "safe" ? "bg-sur-green" :
                        d.level === "caution" ? "bg-sur-yellow" :
                        d.level === "warning" ? "bg-orange-400" :
                        d.level === "danger" ? "bg-sur-red" : "bg-red-500"
                      }`} />
                      <span className={d.color}>{d.label}</span>
                      <span className="text-gray-600">—</span>
                      <span className="text-gray-500">{d.desc}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-gray-600">
                  Requires backend deployment to activate
                </p>
              </div>
            </div>
          )}

          {/* Connected — not subscribed */}
          {connected && !guardianStatus?.subscribed && tab === "status" && (
            <div className="p-4 text-center">
              <p className="text-[11px] text-gray-400 mb-3">
                Guardian is available. Subscribe to protect your positions.
              </p>
              <button
                onClick={subscribe}
                disabled={subscribing}
                className="px-4 py-2 rounded text-[11px] font-bold bg-sur-green/20 text-sur-green hover:bg-sur-green/30 transition-colors disabled:opacity-50"
              >
                {subscribing ? "Subscribing..." : "Enable Protection"}
              </button>
            </div>
          )}

          {/* Connected — subscribed — status tab */}
          {connected && guardianStatus?.subscribed && tab === "status" && (
            <div className="p-3 space-y-3">
              {/* Stats */}
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-[#141518] rounded p-2 text-center">
                  <div className="text-[10px] text-gray-500">Alerts</div>
                  <div className="text-sm font-bold text-sur-yellow">{guardianStatus.stats?.totalAlerts || 0}</div>
                </div>
                <div className="bg-[#141518] rounded p-2 text-center">
                  <div className="text-[10px] text-gray-500">Interventions</div>
                  <div className="text-sm font-bold text-sur-green">{guardianStatus.stats?.totalInterventions || 0}</div>
                </div>
                <div className="bg-[#141518] rounded p-2 text-center">
                  <div className="text-[10px] text-gray-500">Fees Paid</div>
                  <div className="text-sm font-bold text-gray-300">${(guardianStatus.stats?.totalFeesCharged || 0).toFixed(2)}</div>
                </div>
              </div>

              {/* Last action */}
              {guardianStatus.stats?.lastAction && (
                <div className="bg-[#141518] rounded p-2">
                  <div className="text-[9px] text-gray-500 mb-1">Last Action</div>
                  <p className="text-[10px] text-gray-300">{guardianStatus.stats.lastAction.detail}</p>
                  <p className="text-[8px] text-gray-600 mt-1">
                    {new Date(guardianStatus.stats.lastAction.timestamp).toLocaleString()}
                  </p>
                </div>
              )}

              {/* Unsubscribe */}
              <button
                onClick={unsubscribe}
                className="w-full py-1.5 rounded text-[9px] text-gray-500 hover:text-sur-red hover:bg-sur-red/10 transition-colors"
              >
                Disable Protection
              </button>
            </div>
          )}

          {/* Config tab */}
          {tab === "config" && (
            <div className="p-3">
              {!connected ? (
                <p className="text-[10px] text-gray-500 text-center py-4">
                  Connect to Risk Guardian to configure settings
                </p>
              ) : !guardianStatus?.subscribed ? (
                <p className="text-[10px] text-gray-500 text-center py-4">
                  Subscribe first to access settings
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="text-[10px] text-gray-400 mb-2 font-medium">Defense Thresholds</div>
                  {[
                    { label: "Alert", key: "alertThreshold", color: "text-sur-yellow" },
                    { label: "Add Margin", key: "defendThreshold", color: "text-orange-400" },
                    { label: "Reduce Size", key: "reduceThreshold", color: "text-sur-red" },
                    { label: "Emergency Close", key: "emergencyThreshold", color: "text-red-500" },
                  ].map(item => (
                    <div key={item.key} className="flex items-center justify-between">
                      <span className={`text-[10px] ${item.color}`}>{item.label}</span>
                      <span className="text-[10px] text-gray-400">
                        {(guardianStatus.config as any)?.[item.key] || "—"}% to liquidation
                      </span>
                    </div>
                  ))}

                  <div className="border-t border-[#252836] pt-2 mt-2">
                    <div className="text-[10px] text-gray-400 mb-2 font-medium">Permissions</div>
                    {[
                      { label: "Auto Add Margin", key: "autoAddMargin" },
                      { label: "Auto Reduce Size", key: "autoReduceSize" },
                      { label: "Emergency Close", key: "autoEmergencyClose" },
                    ].map(item => (
                      <div key={item.key} className="flex items-center justify-between py-1">
                        <span className="text-[10px] text-gray-400">{item.label}</span>
                        <span className={`text-[9px] font-bold ${
                          (guardianStatus.config as any)?.[item.key] ? "text-sur-green" : "text-gray-600"
                        }`}>
                          {(guardianStatus.config as any)?.[item.key] ? "ON" : "OFF"}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="border-t border-[#252836] pt-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-gray-400">Max Margin to Add</span>
                      <span className="text-[10px] text-gray-300">${guardianStatus.config?.maxMarginToAdd || 5000}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-gray-400">Reduce Percentage</span>
                      <span className="text-[10px] text-gray-300">{guardianStatus.config?.reducePercentage || 25}%</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-gray-400">Guardian Fee</span>
                      <span className="text-[10px] text-gray-300">5 bps (0.05%)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* History tab */}
          {tab === "history" && (
            <div className="p-3">
              {actions.length === 0 ? (
                <p className="text-[10px] text-gray-500 text-center py-4">
                  No guardian actions yet
                </p>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {actions.slice().reverse().map(a => (
                    <div key={a.id} className="bg-[#141518] rounded p-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${
                          a.action === "alert" ? "bg-sur-yellow/20 text-sur-yellow" :
                          a.action === "add_margin" ? "bg-orange-400/20 text-orange-400" :
                          a.action === "reduce_position" ? "bg-sur-red/20 text-sur-red" :
                          "bg-red-500/20 text-red-500"
                        }`}>
                          {ACTION_ICONS[a.action] || "?"}
                        </span>
                        <span className="text-[10px] text-gray-300 font-medium">{a.market}</span>
                        <span className={`text-[8px] px-1 rounded ${a.success ? "bg-sur-green/15 text-sur-green" : "bg-sur-red/15 text-sur-red"}`}>
                          {a.success ? "OK" : "FAILED"}
                        </span>
                      </div>
                      <p className="text-[9px] text-gray-400">{a.detail}</p>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[8px] text-gray-600">
                          {new Date(a.timestamp).toLocaleString()}
                        </span>
                        {a.feeCharged > 0 && (
                          <span className="text-[8px] text-gray-500">Fee: ${a.feeCharged.toFixed(2)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
