"use client";

import { createConfig, http } from "wagmi";
import { baseSepolia, base } from "wagmi/chains";

const IS_TESTNET = process.env.NEXT_PUBLIC_CHAIN_ID !== "8453";

export const config = createConfig({
  chains: IS_TESTNET ? [baseSepolia] as const : [base] as const,
  transports: IS_TESTNET
    ? { [baseSepolia.id]: http() }
    : { [base.id]: http() } as any,
  ssr: true,
});
