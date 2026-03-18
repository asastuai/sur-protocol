import type { Metadata } from "next";
import "./globals.css";
import { Web3Provider } from "@/providers/Web3Provider";
import { TradingProvider } from "@/providers/TradingProvider";
import { NavBar } from "@/components/layout/NavBar";
import { Announcements } from "@/components/layout/Announcements";

export const metadata: Metadata = {
  title: "SUR Protocol | Trade Perpetual Futures",
  description: "The first perpetual futures DEX built for Argentina and Latin America. Trade BTC and ETH perpetuals with up to 20x leverage on Base L2.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className="bg-sur-bg text-sur-text antialiased">
        <Web3Provider>
          <TradingProvider>
            <div className="h-screen flex flex-col">
              <NavBar />
              <div className="flex-1 min-h-0">
                {children}
              </div>
              <Announcements />
            </div>
          </TradingProvider>
        </Web3Provider>
      </body>
    </html>
  );
}
