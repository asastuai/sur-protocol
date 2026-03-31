/**
 * SUR Protocol - Wallet Integration
 *
 * In production, this hooks into wagmi + RainbowKit:
 *   import { useWalletClient, useAccount } from "wagmi";
 *
 * For now, provides a mock interface that matches the real API
 * so all components can be built against it.
 *
 * Production setup:
 * 1. npm install wagmi @rainbow-me/rainbowkit @tanstack/react-query
 * 2. Create wagmi config with WalletConnect project ID
 * 3. Wrap app in WagmiProvider + QueryClientProvider + RainbowKitProvider
 * 4. Replace useWallet() internals with real wagmi hooks
 */

"use client";

import { useState, useCallback } from "react";
import { type Hex } from "viem";
import { CONTRACTS, CHAIN, EIP712_DOMAIN, ORDER_TYPES } from "./constants";

// ============================================================
//                    WALLET STATE
// ============================================================

interface WalletState {
  connected: boolean;
  address: Hex | null;
  chainId: number | null;
  isCorrectChain: boolean;
}

// ============================================================
//                    WALLET HOOK
// ============================================================

export function useWallet() {
  const [wallet, setWallet] = useState<WalletState>({
    connected: false,
    address: null,
    chainId: null,
    isCorrectChain: false,
  });

  const [error, setError] = useState<string | null>(null);

  // Connect wallet (production: use RainbowKit's openConnectModal)
  const connect = useCallback(async () => {
    setError(null);
    if (typeof window === "undefined" || !window.ethereum) {
      setError("No wallet detected. Install MetaMask or Coinbase Wallet.");
      return;
    }

    try {
      // Request accounts
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      }) as string[];

      const chainIdHex = await window.ethereum.request({
        method: "eth_chainId",
      }) as string;

      const chainId = parseInt(chainIdHex, 16);
      const address = accounts[0] as Hex;

      setWallet({
        connected: true,
        address,
        chainId,
        isCorrectChain: chainId === CHAIN.id,
      });

      // Switch chain if needed
      if (chainId !== CHAIN.id) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + CHAIN.id.toString(16) }],
          });
          setWallet(prev => ({ ...prev, chainId: CHAIN.id, isCorrectChain: true }));
        } catch (switchError: any) {
          // Chain not added — try adding it
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: "0x" + CHAIN.id.toString(16),
                chainName: CHAIN.name,
                nativeCurrency: CHAIN.nativeCurrency,
                rpcUrls: [CHAIN.rpcUrls.default.http[0]],
                blockExplorerUrls: [CHAIN.blockExplorers?.default.url],
              }],
            });
          }
        }
      }

      // Listen for account/chain changes
      window.ethereum.on("accountsChanged", (accs: string[]) => {
        if (accs.length === 0) {
          setWallet({ connected: false, address: null, chainId: null, isCorrectChain: false });
        } else {
          setWallet(prev => ({ ...prev, address: accs[0] as Hex }));
        }
      });

      window.ethereum.on("chainChanged", (id: string) => {
        const newChainId = parseInt(id, 16);
        setWallet(prev => ({
          ...prev,
          chainId: newChainId,
          isCorrectChain: newChainId === CHAIN.id,
        }));
      });
    } catch (err: any) {
      const msg = err?.code === 4001 ? "Connection rejected by user" : "Wallet connection failed. Try again.";
      setError(msg);
    }
  }, []);

  // Disconnect
  const disconnect = useCallback(() => {
    setWallet({ connected: false, address: null, chainId: null, isCorrectChain: false });
  }, []);

  // Sign an order using EIP-712
  const signOrder = useCallback(async (order: {
    trader: Hex;
    marketId: Hex;
    isLong: boolean;
    size: bigint;
    price: bigint;
    nonce: bigint;
    expiry: bigint;
  }): Promise<Hex> => {
    if (!window.ethereum || !wallet.address) {
      throw new Error("Wallet not connected");
    }

    // Build EIP-712 payload
    const domain = {
      name: EIP712_DOMAIN.name,
      version: EIP712_DOMAIN.version,
      chainId: CHAIN.id,
      verifyingContract: CONTRACTS.settlement,
    };

    const message = {
      trader: order.trader,
      marketId: order.marketId,
      isLong: order.isLong,
      size: "0x" + order.size.toString(16),
      price: "0x" + order.price.toString(16),
      nonce: "0x" + order.nonce.toString(16),
      expiry: "0x" + order.expiry.toString(16),
    };

    // EIP-712 sign via eth_signTypedData_v4
    const msgParams = JSON.stringify({
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ...ORDER_TYPES,
      },
      primaryType: "Order",
      domain,
      message,
    });

    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [wallet.address, msgParams],
    }) as Hex;

    return signature;
  }, [wallet.address]);

  return {
    ...wallet,
    connect,
    disconnect,
    signOrder,
    error,
  };
}

// Window.ethereum type is provided by wagmi
