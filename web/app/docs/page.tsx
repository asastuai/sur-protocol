"use client";

import { useState } from "react";
import Link from "next/link";

const SECTIONS = [
  {
    id: "overview",
    title: "Overview",
    content: [
      {
        heading: "What is SUR Protocol?",
        text: "SUR Protocol is a decentralized perpetual futures exchange built on Base L2. Trade BTC-USD and ETH-USD with up to 50x leverage (tiered by position size), near-instant settlement, and transparent on-chain execution.",
      },
      {
        heading: "Key Features",
        list: [
          "Perpetual futures with up to 50x leverage (tiered by position size)",
          "On-chain order matching with price-time priority",
          "Cross-margin trading with USDC collateral",
          "Yield-bearing collateral support (cbETH, wstETH, sUSDe)",
          "Paper trading mode for risk-free practice",
          "Real-time WebSocket price feeds",
          "EIP-712 signed orders for gasless submission",
        ],
      },
    ],
  },
  {
    id: "getting-started",
    title: "Getting Started",
    content: [
      {
        heading: "1. Connect Your Wallet",
        text: "Click 'Connect Wallet' in the top right. SUR supports MetaMask, Coinbase Wallet, WalletConnect, Rainbow, and most EVM-compatible wallets. Make sure you're on Base Sepolia (testnet).",
      },
      {
        heading: "2. Get Testnet USDC",
        text: "Visit the Base Sepolia faucet to get testnet ETH for gas, then use our faucet integration or bridge testnet USDC to start trading.",
      },
      {
        heading: "3. Deposit Funds",
        text: "Use the Deposit panel on the right side of the trading interface. Enter the amount of USDC you want to deposit into the vault. Your vault balance is used as margin for trades.",
      },
      {
        heading: "4. Place Your First Trade",
        text: "Select Long or Short, choose Market or Limit order, set your size and leverage, then submit. For market orders, your trade executes immediately at the best available price.",
      },
      {
        heading: "Paper Trading",
        text: "Not ready for real funds? Toggle Paper Trading mode to practice with $100,000 virtual USDC. All positions track real-time prices from Binance. Practice the full trading cycle risk-free: deposit, trade, manage positions, and track P&L.",
      },
    ],
  },
  {
    id: "trading",
    title: "Trading",
    content: [
      {
        heading: "Order Types",
        list: [
          "Market — Executes immediately at best price. Pays taker fee (0.06%).",
          "Limit — Rests on the book until filled at your price. Pays maker fee (0.02%) if Post Only.",
          "Stop Limit — Triggers a limit order when the mark price reaches your trigger price.",
        ],
      },
      {
        heading: "Time in Force",
        list: [
          "GTC (Good Til Cancelled) — Stays on book until filled or cancelled.",
          "IOC (Immediate or Cancel) — Fills what it can immediately, cancels the rest.",
          "FOK (Fill or Kill) — Must fill entirely or is cancelled.",
          "Post Only — Rejected if it would match immediately. Guarantees maker fee.",
        ],
      },
      {
        heading: "Leverage",
        text: "Both BTC-USD and ETH-USD support up to 50x leverage, tiered by position size. As notional size increases, max leverage decreases: 50x up to $100K, 25x up to $500K, 10x up to $2M, 5x above. The order panel automatically adjusts max leverage based on your position size.",
      },
      {
        heading: "Fees",
        text: "Maker fee: 0.02% (2 bps). Taker fee: 0.06% (6 bps). Fees are calculated on the notional value (price x size) and deducted from your margin at execution.",
      },
      {
        heading: "Hidden Orders",
        text: "Mark an order as 'Hidden' to keep it off the public orderbook. Hidden orders still match normally but protect your strategy from being front-run. Only available for limit orders.",
      },
    ],
  },
  {
    id: "positions",
    title: "Positions & P&L",
    content: [
      {
        heading: "Position Management",
        text: "Open positions are shown in the Positions panel at the bottom. Each position displays: market, side (Long/Short), size, entry price, mark price, unrealized P&L (in $ and %), margin, leverage, and liquidation price.",
      },
      {
        heading: "P&L Calculation",
        list: [
          "Long P&L = (Mark Price - Entry Price) x Size",
          "Short P&L = (Entry Price - Mark Price) x Size",
          "P&L % = (P&L / Margin) x 100",
        ],
      },
      {
        heading: "Closing Positions",
        text: "Click 'Close' on any position to close it at the current mark price. Realized P&L is added to your balance. A taker fee is charged on the close.",
      },
      {
        heading: "Liquidation",
        text: "When a position's margin ratio falls below the maintenance requirement, the protocol partially liquidates 25% of the position per round. This tiered approach gives traders a chance to add margin before full closure. The liquidation price is shown on each position.",
      },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    content: [
      {
        heading: "Smart Contracts (Base L2)",
        list: [
          "PerpEngine.sol — Position management, tiered margin calculation, partial liquidation, funding rate application.",
          "PerpVault.sol — USDC custody, deposits/withdrawals, margin accounting.",
          "OrderSettlement.sol — EIP-712 order verification, trade settlement, dynamic spread fees.",
          "Liquidator.sol — Permissionless liquidation engine, 25% partial close per round.",
          "InsuranceFund.sol — Protocol backstop for bad debt from liquidations.",
          "AutoDeleveraging.sol — Last-resort ADL when insurance fund is depleted.",
        ],
      },
      {
        heading: "Off-Chain Engine",
        text: "The matching engine runs off-chain for performance. It maintains an in-memory orderbook with price-time priority matching. Matched trades are batched and settled on-chain.",
      },
      {
        heading: "WebSocket API",
        text: "Real-time data flows via WebSocket on port 3002. Channels: orderbook:{marketId} for order book snapshots and deltas, trades:{marketId} for trade executions. Orders are submitted via the WebSocket with EIP-712 signatures.",
      },
      {
        heading: "Frontend Stack",
        list: [
          "Next.js 15 + React 19 + TypeScript",
          "Tailwind CSS for styling",
          "lightweight-charts for TradingView-style charting",
          "wagmi + RainbowKit for wallet connection",
          "useReducer pattern for state management",
        ],
      },
    ],
  },
  {
    id: "contracts",
    title: "Contract Addresses",
    content: [
      {
        heading: "Base Sepolia (Testnet)",
        list: [
          "PerpEngine — Position management, tiered margin, liquidation",
          "PerpVault — USDC custody, deposits/withdrawals",
          "OrderSettlement — EIP-712 trade verification, dynamic spread",
          "Liquidator — Permissionless partial liquidation (25% per round)",
          "InsuranceFund — Protocol backstop for bad debt",
          "AutoDeleveraging — Last-resort ADL when insurance fund depleted",
          "OracleRouter — Pyth Network price feeds",
        ],
      },
      {
        heading: "Audits",
        text: "Smart contracts are undergoing security review. Full audit reports will be published here before mainnet launch.",
      },
    ],
  },
];

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("overview");

  const scrollToSection = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="h-full flex">
      {/* Sidebar nav */}
      <div className="w-56 border-r border-sur-border bg-sur-surface flex-shrink-0 overflow-y-auto">
        <div className="p-4">
          <Link href="/" className="text-sur-accent text-xs hover:underline mb-4 inline-block">
            &larr; Back to Trading
          </Link>
          <h2 className="text-sm font-bold mb-4">Documentation</h2>
          <nav className="space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => scrollToSection(s.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-[12px] font-medium transition-colors ${
                  activeSection === s.id
                    ? "bg-sur-accent/10 text-sur-accent"
                    : "text-sur-muted hover:text-sur-text hover:bg-white/[0.03]"
                }`}
              >
                {s.title}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl px-8 py-8">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sur-accent to-blue-400 flex items-center justify-center">
              <span className="text-lg font-bold text-white">S</span>
            </div>
            <div>
              <h1 className="text-2xl font-bold">SUR Protocol Docs</h1>
              <p className="text-sm text-sur-muted">Perpetual Futures DEX on Base L2</p>
            </div>
          </div>

          <div className="space-y-12">
            {SECTIONS.map((section) => (
              <div key={section.id} id={section.id}>
                <h2 className="text-lg font-bold mb-4 pb-2 border-b border-sur-border">{section.title}</h2>
                <div className="space-y-6">
                  {section.content.map((block, i) => (
                    <div key={i}>
                      <h3 className="text-sm font-semibold text-sur-text mb-2">{block.heading}</h3>
                      {"text" in block && block.text && (
                        <p className="text-[13px] text-sur-text/70 leading-relaxed">{block.text}</p>
                      )}
                      {"list" in block && block.list && (
                        <ul className="space-y-1.5 mt-1">
                          {block.list.map((item, j) => (
                            <li key={j} className="text-[13px] text-sur-text/70 leading-relaxed flex items-start gap-2">
                              <span className="text-sur-accent mt-1 text-[8px]">&#9679;</span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="mt-16 pt-6 border-t border-sur-border flex items-center justify-between text-xs text-sur-muted">
            <span>SUR Protocol &copy; 2026</span>
            <div className="flex gap-4">
              <Link href="/privacy" className="hover:text-sur-text transition-colors">Privacy</Link>
              <Link href="/terms" className="hover:text-sur-text transition-colors">Terms</Link>
              <Link href="/support" className="hover:text-sur-text transition-colors">Support</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
