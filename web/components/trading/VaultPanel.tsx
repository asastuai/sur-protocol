"use client";

import { useState } from "react";

/**
 * VaultPanel — Vault section in trading sidebar
 * Shows real protocol vault status. No demo/fake data.
 */

export default function VaultPanel() {
  const [tab, setTab] = useState<"browse" | "my">("browse");

  return (
    <div className="h-full flex flex-col bg-[#161618]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#28282e]">
        <h2 className="text-sm font-semibold text-white tracking-wider">VAULTS</h2>
        <div className="flex bg-[#1c1c20] rounded p-0.5">
          {(["browse", "my"] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-[10px] font-medium rounded transition-colors ${
                tab === t ? "bg-[#0052FF] text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t === "browse" ? "Browse Vaults" : "My Investments"}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "my" ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-10 h-10 rounded-xl bg-white/[0.04] flex items-center justify-center mb-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-500">
                <path d="M21 12V7H5a2 2 0 010-4h14v4" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M3 5v14a2 2 0 002 2h16v-5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M18 12a2 2 0 100 4 2 2 0 000-4z" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-xs text-gray-500 mb-1">No vault investments yet</p>
            <p className="text-[10px] text-gray-600">Vault deposits open with mainnet launch</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* SUR Protocol Vault */}
            <div className="border border-[#0052FF]/30 rounded-lg bg-[#1c1c20]">
              <div className="p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-white">SUR Liquidity Pool</span>
                    <span className="text-[8px] px-1.5 py-0.5 bg-[#0052FF]/15 text-[#0052FF] rounded font-bold uppercase tracking-wider">Protocol</span>
                  </div>
                  <span className="text-[8px] px-1.5 py-0.5 bg-yellow-500/15 text-yellow-500 rounded font-bold">SOON</span>
                </div>
                <p className="text-[10px] text-gray-500 mb-3">
                  Core vault acting as counterparty to all traders. Earns from fees, liquidations, and spread.
                </p>
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div>
                    <div className="text-gray-500">TVL</div>
                    <div className="text-white font-medium">—</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Performance Fee</div>
                    <div className="text-white font-medium">10%</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Lockup</div>
                    <div className="text-white font-medium">None</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Deposit Asset</div>
                    <div className="text-white font-medium">USDC</div>
                  </div>
                </div>
              </div>
              <div className="px-3 pb-3">
                <button
                  disabled
                  className="w-full py-2 rounded bg-[#0052FF]/20 text-[#0052FF] text-[10px] font-semibold cursor-not-allowed"
                >
                  Deposits Opening Soon
                </button>
              </div>
            </div>

            {/* Empty strategy vaults */}
            <div className="flex flex-col items-center justify-center py-8 border border-dashed border-[#28282e] rounded-lg text-center">
              <div className="w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center mb-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-500">
                  <path d="M12 2v20M2 12h20" strokeLinecap="round"/>
                </svg>
              </div>
              <p className="text-[10px] text-gray-500">No strategy vaults yet</p>
              <p className="text-[9px] text-gray-600 mt-0.5">Community vaults open at mainnet</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
