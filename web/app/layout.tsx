import type { Metadata } from "next";
import "./globals.css";
import { Web3Provider } from "@/providers/Web3Provider";
import { TradingProvider } from "@/providers/TradingProvider";
import { NavBar } from "@/components/layout/NavBar";
import { Announcements } from "@/components/layout/Announcements";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";

export const metadata: Metadata = {
  title: "SUR Protocol | Trade Perpetual Futures on Base",
  description: "The first perpetual futures DEX built for Argentina and Latin America. Trade BTC and ETH perpetuals with up to 50x leverage on Base L2. Paper trading available.",
  keywords: ["perpetual futures", "DEX", "Base L2", "BTC", "ETH", "leverage trading", "DeFi", "Argentina"],
  robots: "index, follow",
  openGraph: {
    title: "SUR Protocol | Perpetual Futures DEX",
    description: "Trade BTC and ETH perpetuals with up to 50x leverage on Base L2",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem('sur-theme');if(t==='light'){document.documentElement.setAttribute('data-theme','light');document.documentElement.classList.remove('dark')}}catch(e){}` }} />
      </head>
      <body className="bg-sur-bg text-sur-text antialiased">
        {/* Skip-to-content link for keyboard users */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[9999] focus:px-4 focus:py-2 focus:bg-sur-accent focus:text-white focus:rounded focus:text-sm focus:font-semibold focus:outline-none"
        >
          Skip to main content
        </a>
        <Web3Provider>
          <TradingProvider>
            <div className="h-screen flex flex-col">
              <NavBar />
              <ErrorBoundary fallbackPage="this page">
                <main id="main-content" className="flex-1 min-h-0" role="main">
                  {children}
                </main>
              </ErrorBoundary>
              <Announcements />
            </div>
          </TradingProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
