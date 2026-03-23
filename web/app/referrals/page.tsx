"use client";

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";

interface ReferralStats {
  referred_count: number;
  referral_volume: number;
  points_earned: number;
}

const API_BASE = process.env.NEXT_PUBLIC_WS_URL?.replace("wss://", "https://").replace("ws://", "http://") || "http://localhost:3002";

export default function ReferralsPage() {
  const { isConnected, address } = useAccount();
  const [copied, setCopied] = useState(false);
  const [refInput, setRefInput] = useState("");
  const [registered, setRegistered] = useState(false);
  const [regError, setRegError] = useState("");

  const referralCode = address ? address.slice(0, 10).toLowerCase() : "";
  const referralLink = address ? `https://sur.exchange/?ref=${referralCode}` : "";

  // Check URL for ref param on mount
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    if (ref) setRefInput(ref);
  }, []);

  const handleCopy = () => {
    if (referralLink) {
      navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleRegister = async () => {
    if (!address || !refInput.trim()) return;
    setRegError("");

    try {
      const res = await fetch(`${API_BASE}/api/points/referral`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          referrer: refInput.startsWith("0x") ? refInput : `0x${refInput}`,
          referee: address,
          code: refInput,
        }),
      });

      if (res.ok) {
        setRegistered(true);
      } else {
        const data = await res.json();
        setRegError(data.error || "Failed to register referral");
      }
    } catch {
      setRegError("Could not reach API. Try again later.");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center gap-2 mb-2">
          <h1 className="text-2xl font-bold">Referrals</h1>
          <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-sur-green/15 text-sur-green uppercase tracking-wider">
            Active
          </span>
        </div>
        <p className="text-sm text-sur-muted mb-8">
          Earn 10% bonus points from every trader you refer. Share your link and grow the SUR community.
        </p>

        {!isConnected ? (
          <div className="bg-sur-surface border border-sur-border rounded-xl p-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] flex items-center justify-center mx-auto mb-4">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
                <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="9" cy="7" r="4" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h3 className="text-sm font-semibold mb-2">Connect Your Wallet</h3>
            <p className="text-xs text-sur-muted max-w-sm mx-auto">
              Connect your wallet to generate a unique referral link and start earning bonus points.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Referral link */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h2 className="text-sm font-semibold mb-3">Your Referral Link</h2>
              <div className="flex items-center gap-3">
                <div className="flex-1 px-4 py-2.5 bg-sur-bg rounded-lg text-xs font-mono text-sur-muted truncate">
                  {referralLink}
                </div>
                <button
                  onClick={handleCopy}
                  className="px-4 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <p className="text-[10px] text-sur-muted mt-3">
                Anyone who registers through your link earns you 10% of their points — forever.
              </p>
            </div>

            {/* Were you referred? */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h2 className="text-sm font-semibold mb-3">Were you referred?</h2>
              {registered ? (
                <p className="text-xs text-sur-green font-medium">Referral registered! Your referrer will earn bonus points from your trading.</p>
              ) : (
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={refInput}
                    onChange={e => setRefInput(e.target.value)}
                    placeholder="Referral code or address"
                    className="flex-1 px-4 py-2.5 text-xs bg-sur-bg border border-sur-border rounded-lg focus:border-sur-accent/50 outline-none transition-colors font-mono"
                  />
                  <button
                    onClick={handleRegister}
                    disabled={!refInput.trim()}
                    className="px-4 py-2.5 bg-sur-accent text-white text-xs font-semibold rounded-lg hover:bg-sur-accent/90 transition-colors disabled:opacity-50"
                  >
                    Register
                  </button>
                </div>
              )}
              {regError && <p className="text-xs text-sur-red mt-2">{regError}</p>}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                <div className="text-[11px] text-sur-muted uppercase tracking-wider mb-1">Referred Users</div>
                <div className="text-xl font-bold tabular-nums">—</div>
                <div className="text-[10px] text-sur-muted mt-0.5">Tracked automatically</div>
              </div>
              <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                <div className="text-[11px] text-sur-muted uppercase tracking-wider mb-1">Referral Volume</div>
                <div className="text-xl font-bold tabular-nums">—</div>
                <div className="text-[10px] text-sur-muted mt-0.5">From referred traders</div>
              </div>
              <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                <div className="text-[11px] text-sur-muted uppercase tracking-wider mb-1">Points Earned</div>
                <div className="text-xl font-bold tabular-nums">—</div>
                <div className="text-[10px] text-sur-muted mt-0.5">10% of referrals&apos; points</div>
              </div>
            </div>

            {/* How it works */}
            <div className="bg-sur-surface border border-sur-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">How Referrals Work</h3>
              <div className="grid grid-cols-3 gap-6 text-[11px] text-sur-muted">
                <div>
                  <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-2">
                    <span className="text-sur-accent font-bold text-xs">1</span>
                  </div>
                  <span className="text-sur-text font-medium">Share Your Link</span>
                  <p className="mt-1 leading-relaxed">Share your unique referral link. Anyone who registers through it is permanently linked to your account.</p>
                </div>
                <div>
                  <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-2">
                    <span className="text-sur-accent font-bold text-xs">2</span>
                  </div>
                  <span className="text-sur-text font-medium">They Trade</span>
                  <p className="mt-1 leading-relaxed">When referred traders execute trades on SUR, they earn points normally. You get 10% of their earned points as a bonus.</p>
                </div>
                <div>
                  <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-2">
                    <span className="text-sur-accent font-bold text-xs">3</span>
                  </div>
                  <span className="text-sur-text font-medium">Earn Bonus Points</span>
                  <p className="mt-1 leading-relaxed">Referral points accumulate automatically and count towards your Season 1 total. No cap on referrals.</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
