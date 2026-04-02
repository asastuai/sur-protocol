"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { LanguageSelector } from "./LanguageSelector";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { useTradingZustand } from "@/lib/trading-zustand";

function PrivyConnectButton() {
  const { login, logout, authenticated, user, ready } = usePrivy();

  if (!ready) return <div className="w-24 h-8 rounded-lg bg-white/[0.04] animate-pulse" />;

  if (!authenticated) {
    return (
      <button
        onClick={login}
        className="px-4 py-1.5 rounded-lg bg-sur-accent text-white text-xs font-semibold hover:bg-sur-accent/90 transition-colors"
      >
        Sign In
      </button>
    );
  }

  const displayName = user?.email?.address
    || user?.google?.email
    || user?.wallet?.address?.slice(0, 6) + "..." + user?.wallet?.address?.slice(-4)
    || "Connected";

  return (
    <div className="flex items-center gap-2">
      <span className="px-3 py-1.5 rounded-lg bg-white/[0.04] text-xs font-mono text-sur-text">
        {displayName}
      </span>
      <button
        onClick={logout}
        className="px-2.5 py-1.5 rounded-lg text-[11px] text-sur-muted hover:text-sur-text hover:bg-white/[0.04] transition-colors"
      >
        Sign Out
      </button>
    </div>
  );
}

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
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const paperMode = useTradingZustand(s => s.paperMode);
  const togglePaperMode = useTradingZustand(s => s.actions.togglePaperMode);

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
    <nav aria-label="Main navigation" className="h-12 border-b border-sur-border bg-sur-surface flex items-center justify-between px-4 flex-shrink-0 relative">
      {/* Left: Logo + Nav links */}
      <div className="flex items-center gap-1">
        {/* Hamburger (mobile only) */}
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileMenuOpen}
          aria-controls="mobile-menu"
          className="md:hidden p-2 -ml-2 mr-1 text-sur-muted hover:text-sur-text"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {mobileMenuOpen ? (
              <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
            ) : (
              <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>
            )}
          </svg>
        </button>

        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 md:mr-6 mr-2 hover:opacity-90 transition-opacity">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-sur-accent to-blue-400 flex items-center justify-center">
            <span className="text-[12px] font-bold text-white">S</span>
          </div>
          <span className="font-bold text-sm tracking-wide hidden sm:block">SUR</span>
        </Link>

        {/* Primary nav (hidden on mobile) */}
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`hidden md:block px-3.5 py-2 text-[13px] font-medium rounded-md transition-colors ${
                isActive
                  ? "text-sur-text bg-sur-border/40"
                  : "text-sur-muted hover:text-sur-text hover:bg-sur-border/30"
              }`}
            >
              {item.label}
            </Link>
          );
        })}

        {/* More dropdown (hidden on mobile — use hamburger instead) */}
        <div ref={moreRef} className="relative hidden md:block">
          <button
            onClick={() => setMoreOpen(!moreOpen)}
            aria-expanded={moreOpen}
            aria-haspopup="true"
            aria-controls="more-dropdown"
            className={`px-3.5 py-2 text-[13px] font-medium rounded-md transition-colors flex items-center gap-1.5 ${
              moreOpen
                ? "text-white bg-white/[0.06]"
                : "text-sur-muted hover:text-sur-text hover:bg-sur-border/30"
            }`}
          >
            More
            <svg
              width="10"
              height="6"
              viewBox="0 0 10 6"
              fill="none"
              aria-hidden="true"
              className={`transition-transform ${moreOpen ? "rotate-180" : ""}`}
            >
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>

          {moreOpen && (
            <div id="more-dropdown" className="absolute top-full left-0 mt-1.5 bg-sur-surface border border-sur-border rounded-lg shadow-2xl z-50 min-w-[220px] py-1.5 animate-fade-in">
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

      {/* Mobile menu overlay */}
      {mobileMenuOpen && (
        <div id="mobile-menu" className="absolute top-full left-0 right-0 bg-sur-surface border-b border-sur-border z-50 md:hidden animate-fade-in max-h-[70vh] overflow-y-auto">
          <div className="py-2">
            {NAV_ITEMS.map((item) => {
              const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`block px-5 py-3 text-[13px] font-medium transition-colors ${
                    isActive ? "text-sur-accent bg-sur-accent/5" : "text-sur-text hover:bg-white/[0.04]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
            <div className="border-t border-sur-border my-1" />
            {MORE_ITEMS.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className="block px-5 py-2.5 hover:bg-white/[0.04] transition-colors"
              >
                <span className="text-[13px] font-medium text-sur-text">{item.label}</span>
                <span className="text-[11px] text-sur-muted ml-2">{item.desc}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Right: Paper Toggle + Theme + Language + Wallet */}
      <div className="flex items-center gap-2">
        <button
          onClick={togglePaperMode}
          title={paperMode ? "Paper Trading (simulated)" : "Live Trading (real orders)"}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all border ${
            paperMode
              ? "bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25"
              : "bg-sur-green/15 text-sur-green border-sur-green/30 hover:bg-sur-green/25"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${paperMode ? "bg-amber-400 animate-pulse" : "bg-sur-green"}`} />
          {paperMode ? "Paper" : "Live"}
        </button>
        <ThemeToggle />
        <LanguageSelector />
        <PrivyConnectButton />
      </div>
    </nav>
  );
}
