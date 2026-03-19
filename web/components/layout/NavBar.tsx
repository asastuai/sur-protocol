"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { LanguageSelector } from "./LanguageSelector";

const NAV_ITEMS = [
  { label: "Trade", href: "/" },
  { label: "Portfolio", href: "/portfolio" },
  { label: "Agents", href: "/agents" },
  { label: "Vaults", href: "/vaults" },
] as const;

const MORE_ITEMS = [
  { label: "Trading Bot", href: "/trading-bot", desc: "AI-powered auto trading" },
  { label: "Copy Trading", href: "/copytrade", desc: "Mirror top traders" },
  { label: "Backtester", href: "/backtester", desc: "Monte Carlo strategy lab" },
  { label: "Developers", href: "/developers", desc: "Agent SDK, API & MCP" },
  { label: "Leaderboard", href: "/leaderboard", desc: "Top trader rankings" },
  { label: "Referrals", href: "/referrals", desc: "Earn from referrals" },
  { label: "Points", href: "/points", desc: "SUR rewards & airdrops" },
  { label: "Support", href: "/support", desc: "FAQ & contact us" },
  { label: "Privacy", href: "/privacy", desc: "Privacy policy" },
  { label: "Terms", href: "/terms", desc: "Terms of service" },
  { label: "Docs", href: "/docs", desc: "Protocol documentation" },
] as const;

export function NavBar() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <nav className="h-12 border-b border-sur-border bg-sur-surface flex items-center justify-between px-4 flex-shrink-0">
      {/* Left: Logo + Nav links */}
      <div className="flex items-center gap-1">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 mr-6 hover:opacity-90 transition-opacity">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sur-accent to-blue-400 flex items-center justify-center">
            <span className="text-[12px] font-bold text-white">S</span>
          </div>
          <span className="font-bold text-sm tracking-wide">SUR</span>
        </Link>

        {/* Primary nav */}
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`px-3.5 py-2 text-[13px] font-medium rounded-md transition-colors ${
                isActive
                  ? "text-white bg-white/[0.06]"
                  : "text-sur-muted hover:text-sur-text hover:bg-white/[0.03]"
              }`}
            >
              {item.label}
            </Link>
          );
        })}

        {/* More dropdown */}
        <div ref={moreRef} className="relative">
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            className={`px-3.5 py-2 text-[13px] font-medium rounded-md transition-colors flex items-center gap-1.5 ${
              moreOpen
                ? "text-white bg-white/[0.06]"
                : "text-sur-muted hover:text-sur-text hover:bg-white/[0.03]"
            }`}
          >
            More
            <svg
              width="10"
              height="6"
              viewBox="0 0 10 6"
              fill="none"
              className={`transition-transform ${moreOpen ? "rotate-180" : ""}`}
            >
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>

          {moreOpen && (
            <div className="absolute top-full left-0 mt-1.5 bg-sur-surface border border-sur-border rounded-lg shadow-2xl z-50 min-w-[220px] py-1.5 animate-fade-in">
              {MORE_ITEMS.map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className="flex flex-col px-4 py-2.5 hover:bg-white/[0.04] transition-colors"
                >
                  <span className="text-[13px] font-medium text-sur-text">{item.label}</span>
                  <span className="text-[11px] text-sur-muted">{item.desc}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Language + Wallet */}
      <div className="flex items-center gap-2">
        <LanguageSelector />
        <ConnectButton.Custom>
          {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
            const ready = mounted;
            const connected = ready && account && chain;

            return (
              <div
                {...(!ready && {
                  "aria-hidden": true,
                  style: { opacity: 0, pointerEvents: "none" as const, userSelect: "none" as const },
                })}
              >
                {(() => {
                  if (!connected) {
                    return (
                      <button
                        onClick={openConnectModal}
                        className="px-4 py-1.5 rounded-lg bg-sur-accent text-white text-xs font-semibold hover:bg-sur-accent/90 transition-colors"
                      >
                        Connect Wallet
                      </button>
                    );
                  }

                  if (chain.unsupported) {
                    return (
                      <button
                        onClick={openChainModal}
                        className="px-3 py-1.5 rounded-lg bg-sur-red/20 text-sur-red text-xs font-semibold hover:bg-sur-red/30 transition-colors"
                      >
                        Wrong Network
                      </button>
                    );
                  }

                  return (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={openChainModal}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] bg-white/[0.04] text-sur-muted hover:bg-white/[0.08] transition-colors"
                      >
                        {chain.name}
                      </button>
                      <button
                        onClick={openAccountModal}
                        className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-xs font-mono hover:bg-white/[0.08] transition-colors"
                      >
                        {account.displayName}
                        {account.displayBalance ? ` (${account.displayBalance})` : ""}
                      </button>
                    </div>
                  );
                })()}
              </div>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </nav>
  );
}
