"use client";

import Link from "next/link";

export default function TermsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link href="/" className="text-sur-accent text-xs hover:underline mb-6 inline-block">&larr; Back to Trading</Link>

        <h1 className="text-2xl font-bold mb-2">Terms of Service</h1>
        <p className="text-sm text-sur-muted mb-8">Last updated: March 15, 2026</p>

        <div className="space-y-6 text-sm text-sur-text/80 leading-relaxed">
          <Section title="1. Acceptance of Terms">
            By accessing or using SUR Protocol (&ldquo;the Platform&rdquo;), you agree to be bound by these Terms of Service. If you do not agree, do not use the Platform.
          </Section>

          <Section title="2. Description of Service">
            SUR Protocol is a decentralized perpetual futures trading platform deployed on Base L2. The Platform enables users to trade BTC-USD and ETH-USD perpetual futures with leverage, deposit and withdraw USDC, and access real-time market data.
          </Section>

          <Section title="3. Eligibility">
            <ul className="list-disc pl-5 space-y-1">
              <li>You must be at least 18 years of age</li>
              <li>Not a resident of any jurisdiction where crypto trading is prohibited</li>
              <li>Not subject to any sanctions or trade restrictions</li>
            </ul>
          </Section>

          <Section title="4. Risk Disclosure">
            <div className="p-3 bg-sur-red/10 border border-sur-red/20 rounded mt-2">
              <p className="text-sur-red font-medium text-xs">Trading perpetual futures involves substantial risk of loss.</p>
              <ul className="list-disc pl-5 mt-2 space-y-1 text-sur-red/80">
                <li>Leveraged trading can result in losses exceeding your initial deposit</li>
                <li>Cryptocurrency markets are highly volatile</li>
                <li>Liquidation may occur if margin falls below maintenance</li>
                <li>Only trade with funds you can afford to lose</li>
              </ul>
            </div>
          </Section>

          <Section title="5. No Financial Advice">
            Nothing on the Platform constitutes financial, investment, legal, or tax advice. You are solely responsible for your trading decisions.
          </Section>

          <Section title="6. User Responsibilities">
            <ul className="list-disc pl-5 space-y-1">
              <li>Maintain the security of your wallet and private keys</li>
              <li>Do not attempt to manipulate markets or exploit vulnerabilities</li>
              <li>Do not use the Platform for illegal activities</li>
              <li>Comply with all applicable laws in your jurisdiction</li>
            </ul>
          </Section>

          <Section title="7. Smart Contract Risks">
            You acknowledge that smart contracts may contain bugs, blockchain transactions are irreversible, and oracle price feeds may experience temporary inaccuracies.
          </Section>

          <Section title="8. Fees">
            Trading fees are displayed before order submission. Gas fees for on-chain transactions are paid by the user. Fee schedules may change with prior notice.
          </Section>

          <Section title="9. Limitation of Liability">
            To the maximum extent permitted by law, SUR Protocol shall not be liable for any indirect, incidental, or consequential damages arising from your use of the Platform.
          </Section>

          <Section title="10. Contact">
            For questions: <span className="text-sur-accent">legal@sur.exchange</span>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-sur-text mb-2">{title}</h2>
      <div>{children}</div>
    </div>
  );
}
