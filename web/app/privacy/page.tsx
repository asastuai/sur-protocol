"use client";

import Link from "next/link";

export default function PrivacyPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link href="/" className="text-sur-accent text-xs hover:underline mb-6 inline-block">&larr; Back to Trading</Link>

        <h1 className="text-2xl font-bold mb-2">Privacy Policy</h1>
        <p className="text-sm text-sur-muted mb-8">Last updated: March 15, 2026</p>

        <div className="space-y-6 text-sm text-sur-text/80 leading-relaxed">
          <Section title="1. Introduction">
            SUR Protocol (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates a decentralized perpetual futures trading platform on Base L2. This Privacy Policy explains how we collect, use, and protect information when you use our platform.
          </Section>

          <Section title="2. Information We Collect">
            <p className="font-medium text-sur-text mt-2">Blockchain Data</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>Public wallet addresses used to interact with our smart contracts</li>
              <li>On-chain transaction data (deposits, withdrawals, trades)</li>
              <li>This data is inherently public on the blockchain</li>
            </ul>
            <p className="font-medium text-sur-text mt-3">Technical Data</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>IP address and approximate geolocation</li>
              <li>Browser type, device type, and operating system</li>
              <li>WebSocket connection metadata</li>
            </ul>
            <p className="font-medium text-sur-text mt-3">We Do NOT Collect</p>
            <ul className="list-disc pl-5 mt-1 space-y-1">
              <li>Personal identification (name, email, phone)</li>
              <li>Private keys or seed phrases</li>
            </ul>
          </Section>

          <Section title="3. How We Use Information">
            <ul className="list-disc pl-5 space-y-1">
              <li>To provide and maintain the trading platform</li>
              <li>To monitor system performance and prevent abuse</li>
              <li>To improve user experience</li>
              <li>To comply with legal obligations</li>
            </ul>
          </Section>

          <Section title="4. Data Sharing">
            We do not sell your personal information. We may share data with blockchain networks (public by nature), infrastructure providers under strict agreements, and law enforcement when legally required.
          </Section>

          <Section title="5. Cookies">
            We use minimal cookies for session management and user preferences (language, theme). We do not use third-party tracking cookies.
          </Section>

          <Section title="6. Security">
            We implement industry-standard security measures including TLS encryption, smart contract audits, and regular security assessments.
          </Section>

          <Section title="7. Your Rights">
            Depending on your jurisdiction, you may have the right to access, correct, delete, or port your personal data.
          </Section>

          <Section title="8. Contact">
            For privacy-related inquiries: <span className="text-sur-accent">privacy@sur.exchange</span>
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
