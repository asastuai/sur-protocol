"use client";

import { type ReactNode } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { config } from "@/lib/wagmi-config";
import { baseSepolia, base } from "wagmi/chains";

const queryClient = new QueryClient();

const IS_TESTNET = process.env.NEXT_PUBLIC_CHAIN_ID !== "8453";
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cmngp5w7900cb0clfxqy2wdej";

export function Web3Provider({ children }: { children: ReactNode }) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#0052FF",
          logo: "/logo.svg",
          showWalletLoginFirst: false,
        },
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        defaultChain: IS_TESTNET ? baseSepolia : base,
        supportedChains: IS_TESTNET ? [baseSepolia] : [base],
      }}
    >
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </WagmiProvider>
    </PrivyProvider>
  );
}
