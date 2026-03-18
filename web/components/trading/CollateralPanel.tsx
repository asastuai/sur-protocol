"use client";

/**
 * CollateralPanel — Yield-Bearing Collateral Dashboard
 *
 * Shows supported yield-bearing tokens for future margin collateral.
 * Not yet active — launches with mainnet.
 */

const SUPPORTED_COLLATERALS = [
  { symbol: "cbETH", name: "Coinbase Staked ETH", icon: "cb" },
  { symbol: "wstETH", name: "Lido Staked ETH", icon: "st" },
  { symbol: "sUSDe", name: "Ethena Staked USDe", icon: "su" },
];

export default function CollateralPanel() {
  return (
    <div className="bg-[#1b1d28] border border-[#252836] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-300 tracking-wider">YIELD COLLATERAL</h3>
        <span className="text-[8px] px-1.5 py-0.5 bg-yellow-500/15 text-yellow-500 rounded font-bold uppercase tracking-wider">
          Soon
        </span>
      </div>

      <div className="p-3 bg-[#141518] rounded border border-[#252836]">
        <p className="text-[11px] text-gray-400 mb-3">
          Deposit yield-bearing tokens as margin collateral. Your tokens continue earning yield while locked as trading margin.
        </p>
        <div className="space-y-2">
          {SUPPORTED_COLLATERALS.map(c => (
            <div key={c.symbol} className="flex items-center justify-between text-[10px] py-1">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-[#252836] flex items-center justify-center text-[8px] text-gray-400 font-bold">
                  {c.icon.charAt(0).toUpperCase()}
                </div>
                <div>
                  <span className="text-gray-300 font-medium">{c.symbol}</span>
                  <span className="text-gray-500 ml-1.5">{c.name}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[9px] text-gray-600 mt-3 text-center">
          Collateral support activates with mainnet launch
        </p>
      </div>
    </div>
  );
}
