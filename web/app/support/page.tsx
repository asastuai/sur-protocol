"use client";

import { useState } from "react";
import Link from "next/link";

const FAQ = [
  {
    q: "How do I start trading?",
    a: "Connect your wallet, deposit USDC into the vault, select a market (BTC-USD or ETH-USD), and place an order. You can also use Paper Trading mode to practice with $100,000 in virtual funds.",
  },
  {
    q: "What is Paper Trading?",
    a: "Paper Trading gives you $100,000 in virtual USDC to practice trading. Your positions track real market prices from Binance but no real money is at risk. Toggle it from the header.",
  },
  {
    q: "What leverage is available?",
    a: "SUR uses a tiered leverage system to protect the protocol vault. Both BTC-USD and ETH-USD support up to 50x leverage on small positions. As position size increases, maximum leverage decreases: 50x up to $100K notional, 25x up to $500K, 10x up to $2M, and 5x above $2M. The order panel automatically adjusts your max leverage based on position size.",
  },
  {
    q: "How do fees work?",
    a: "Maker orders (Post Only) pay 0.02% fee. Taker orders pay 0.06% fee. An additional dynamic spread fee (up to 0.30%) may apply when a trade increases open interest skew. Fees are deducted from your margin at execution.",
  },
  {
    q: "What is liquidation?",
    a: "When your position's margin ratio falls below the maintenance requirement, the protocol partially liquidates 25% of your position per round. This tiered approach gives traders a chance to add margin before full closure. The liquidation price is shown on each position.",
  },
  {
    q: "How does the vault work?",
    a: "The SUR Liquidity Pool is the core protocol vault that acts as counterparty to all traders. Depositors earn from trading fees, liquidation proceeds, and market making spread. The vault is protected by tiered leverage limits, open interest caps, and an insurance fund.",
  },
  {
    q: "Which wallets are supported?",
    a: "MetaMask, Coinbase Wallet, WalletConnect, Rainbow, and most EVM-compatible wallets through RainbowKit.",
  },
  {
    q: "Which network does SUR run on?",
    a: "SUR Protocol is currently on Base Sepolia testnet. Mainnet deployment on Base L2 is planned. All smart contracts are deployed and verifiable on BaseScan.",
  },
  {
    q: "What protections does the protocol have?",
    a: "Multiple layers: tiered leverage limits (lower leverage for larger positions), open interest caps per market, OI skew caps (max 70% on one side), dynamic spread fees, partial liquidation (25% per round), an insurance fund, and auto-deleveraging (ADL) as a last resort.",
  },
];

export default function SupportPage() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setName("");
    setMessage("");
    setTimeout(() => setSubmitted(false), 4000);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link href="/" className="text-sur-accent text-xs hover:underline mb-6 inline-block">&larr; Back to Trading</Link>

        <h1 className="text-2xl font-bold mb-2">Support</h1>
        <p className="text-sm text-sur-muted mb-8">Find answers or get in touch with our team.</p>

        {/* FAQ */}
        <div className="mb-12">
          <h2 className="text-base font-semibold mb-4">Frequently Asked Questions</h2>
          <div className="space-y-1">
            {FAQ.map((item, i) => (
              <div key={i} className="border border-sur-border rounded-lg overflow-hidden">
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  className="w-full text-left px-4 py-3 flex items-center justify-between text-sm font-medium hover:bg-white/[0.02] transition-colors"
                >
                  {item.q}
                  <svg
                    width="12" height="12" viewBox="0 0 12 12" fill="none"
                    className={`text-sur-muted transition-transform flex-shrink-0 ml-2 ${openFaq === i ? "rotate-180" : ""}`}
                  >
                    <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
                {openFaq === i && (
                  <div className="px-4 pb-3 text-sm text-sur-muted leading-relaxed animate-fade-in">
                    {item.a}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Contact Form */}
        <div className="mb-12">
          <h2 className="text-base font-semibold mb-4">Contact Us</h2>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs text-sur-muted block mb-1">Name or Wallet Address</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="0x... or your name"
                className="w-full bg-sur-bg border border-sur-border rounded-lg px-4 py-2.5 text-sm focus:border-sur-accent outline-none transition-colors"
              />
            </div>
            <div>
              <label className="text-xs text-sur-muted block mb-1">Message</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe your issue or question..."
                rows={5}
                className="w-full bg-sur-bg border border-sur-border rounded-lg px-4 py-2.5 text-sm focus:border-sur-accent outline-none transition-colors resize-none"
              />
            </div>
            <button
              type="submit"
              disabled={!message.trim()}
              className="px-6 py-2.5 rounded-lg bg-sur-accent text-white text-sm font-semibold hover:bg-sur-accent/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Send Message
            </button>
            {submitted && (
              <p className="text-sur-green text-xs animate-fade-in">Message sent! We&apos;ll get back to you soon.</p>
            )}
          </form>
        </div>

        {/* Links */}
        <div className="grid grid-cols-2 gap-3">
          <LinkCard title="Community" desc="Join our Discord and Telegram" icon="chat" />
          <LinkCard title="Twitter / X" desc="Follow @SURProtocol" icon="twitter" />
          <LinkCard title="GitHub" desc="Report issues and contribute" icon="code" />
          <LinkCard title="Documentation" desc="Protocol docs and guides" icon="docs" />
        </div>
      </div>
    </div>
  );
}

function LinkCard({ title, desc, icon }: { title: string; desc: string; icon: string }) {
  const icons: Record<string, React.ReactNode> = {
    chat: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    twitter: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
        <path d="M4 4l11.733 16h4.267l-11.733-16zM4 20l6.768-6.768M13.232 10.768L20 4" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    code: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
        <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    docs: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sur-muted">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  };

  return (
    <div className="p-4 bg-sur-surface border border-sur-border rounded-lg hover:border-sur-accent/30 transition-colors cursor-pointer">
      <div className="mb-2">{icons[icon]}</div>
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-sur-muted">{desc}</div>
    </div>
  );
}
