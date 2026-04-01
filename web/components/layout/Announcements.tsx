"use client";

import { useState, useEffect } from "react";

interface Announcement {
  id: string;
  text: string;
  type: "info" | "warning" | "success" | "promo";
  link?: { label: string; href: string };
}

// Announcements config — add/remove here to manage announcements
const ANNOUNCEMENTS: Announcement[] = [
  {
    id: "testnet-launch-2026",
    text: "SUR Protocol is live on Base Sepolia testnet! Try paper trading with $100k virtual USDC.",
    type: "promo",
    link: { label: "Start Trading", href: "/" },
  },
  {
    id: "eth-market-live",
    text: "ETH-USD perpetual market is now available with up to 50x leverage (tiered by position size).",
    type: "success",
  },
  {
    id: "risk-warning",
    text: "Trading perpetual futures involves substantial risk. Only trade with funds you can afford to lose.",
    type: "warning",
    link: { label: "Learn More", href: "/terms" },
  },
];

const STORAGE_KEY = "sur_dismissed_announcements";

function getDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {}
}

export function Announcements() {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setDismissed(getDismissed());
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const visible = ANNOUNCEMENTS.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  // Show only the first non-dismissed announcement
  const current = visible[0];

  const dismiss = () => {
    const next = new Set(dismissed);
    next.add(current.id);
    setDismissed(next);
    saveDismissed(next);
  };

  const colors = {
    info: { bg: "bg-sur-accent/10", border: "border-sur-accent/20", text: "text-sur-accent", icon: "ℹ️" },
    warning: { bg: "bg-sur-yellow/10", border: "border-sur-yellow/20", text: "text-sur-yellow", icon: "⚠️" },
    success: { bg: "bg-sur-green/10", border: "border-sur-green/20", text: "text-sur-green", icon: "✓" },
    promo: { bg: "bg-purple-500/10", border: "border-purple-500/20", text: "text-purple-400", icon: "🚀" },
  };

  const c = colors[current.type];
  const remaining = visible.length - 1;

  return (
    <div className={`fixed bottom-4 right-4 z-50 max-w-sm animate-slide-up`}>
      <div className={`${c.bg} ${c.border} border rounded-lg shadow-2xl backdrop-blur-sm`}>
        <div className="flex items-start gap-3 px-4 py-3">
          {/* Icon */}
          <span className="text-sm flex-shrink-0 mt-0.5">{c.icon}</span>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <p className={`text-xs ${c.text} leading-relaxed`}>
              {current.text}
            </p>
            {current.link && (
              <a
                href={current.link.href}
                className={`text-[10px] ${c.text} font-semibold hover:underline mt-1 inline-block`}
              >
                {current.link.label} &rarr;
              </a>
            )}
            {remaining > 0 && (
              <span className="text-[9px] text-sur-muted ml-2">+{remaining} more</span>
            )}
          </div>

          {/* Dismiss */}
          <button
            onClick={dismiss}
            aria-label="Dismiss announcement"
            className="text-sur-muted hover:text-sur-text transition-colors flex-shrink-0 p-0.5"
            title="Dismiss"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="2" y1="2" x2="10" y2="10" /><line x1="10" y1="2" x2="2" y2="10" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
