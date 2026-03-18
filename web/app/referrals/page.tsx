"use client";

import { useState } from "react";
import { useAccount } from "wagmi";

export default function ReferralsPage() {
  const { isConnected, address } = useAccount();
  const [copied, setCopied] = useState(false);

  const referralCode = address ? address.slice(0, 8).toLowerCase() : "";
  const referralLink = address ? `https://sur.exchange/?ref=${referralCode}` : "";

  const handleCopy = () => {
    if (referralLink) {
      navigator.clipboard.writeText(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center gap-2 mb-2">
          <h1 className="text-2xl font-bold">Referrals</h1>
          <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-sur-yellow/15 text-sur-yellow uppercase tracking-wider">
            Launching Soon
          </span>
        </div>
        <p className="text-sm text-sur-muted mb-8">
          Earn fee rebates by referring traders to SUR Protocol. Share your referral link and earn a percentage of their trading fees.
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
              Connect your wallet to generate a unique referral link. The referral program activates with mainnet launch.
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
                Referral tracking activates on mainnet. Share your link now — anyone who signs up through it will be linked to your account.
              </p>
            </div>

            {/* Stats — real zeros */}
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                <div className="text-[11px] text-sur-muted uppercase tracking-wider mb-1">Referred Users</div>
                <div className="text-xl font-bold tabular-nums">0</div>
                <div className="text-[10px] text-sur-muted mt-0.5">Tracked on-chain at launch</div>
              </div>
              <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                <div className="text-[11px] text-sur-muted uppercase tracking-wider mb-1">Referral Volume</div>
                <div className="text-xl font-bold tabular-nums">$0.00</div>
                <div className="text-[10px] text-sur-muted mt-0.5">From referred traders</div>
              </div>
              <div className="bg-sur-surface border border-sur-border rounded-xl p-5">
                <div className="text-[11px] text-sur-muted uppercase tracking-wider mb-1">Earned Rebates</div>
                <div className="text-xl font-bold tabular-nums">$0.00</div>
                <div className="text-[10px] text-sur-muted mt-0.5">Claimable at launch</div>
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
                  <p className="mt-1 leading-relaxed">Share your unique referral link with other traders. Anyone who signs up through your link is permanently linked to your account.</p>
                </div>
                <div>
                  <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-2">
                    <span className="text-sur-accent font-bold text-xs">2</span>
                  </div>
                  <span className="text-sur-text font-medium">They Trade</span>
                  <p className="mt-1 leading-relaxed">When referred traders execute trades on SUR, a portion of their trading fees is allocated as your referral rebate.</p>
                </div>
                <div>
                  <div className="w-8 h-8 rounded-lg bg-sur-accent/10 flex items-center justify-center mb-2">
                    <span className="text-sur-accent font-bold text-xs">3</span>
                  </div>
                  <span className="text-sur-text font-medium">Earn Rebates</span>
                  <p className="mt-1 leading-relaxed">Referral rebates accrue on-chain and are claimable anytime. Referrers earn up to 10% of trading fees from referred users.</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
