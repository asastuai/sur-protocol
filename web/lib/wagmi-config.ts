"use client";

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { baseSepolia, base } from "wagmi/chains";
import { http } from "wagmi";

const IS_TESTNET = process.env.NEXT_PUBLIC_CHAIN_ID !== "8453";

export const config = getDefaultConfig({
  appName: "SUR Protocol",
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "sur-protocol-dev",
  chains: IS_TESTNET ? [baseSepolia] : [base],
  transports: IS_TESTNET
    ? { [baseSepolia.id]: http() }
    : { [base.id]: http() },
  ssr: true,
});
