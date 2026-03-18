/**
 * SUR Protocol - Order Submission Hook
 *
 * Handles the full order lifecycle:
 * 1. Build order params from UI inputs
 * 2. Sign EIP-712 typed data with wallet
 * 3. Send signed order via WebSocket
 * 4. Track order status via store dispatch
 *
 * Usage:
 *   const { submitOrder, isSubmitting } = useOrderSubmit(send, dispatch, market);
 *   await submitOrder({ side: "buy", orderType: "limit", price: "50000", ... });
 */

"use client";

import { useState, useCallback } from "react";
import { type WalletClient, type Hex } from "viem";
import {
  CONTRACTS, CHAIN, EIP712_DOMAIN, ORDER_TYPES,
  toPrice, toSize, type MarketMeta,
} from "../lib/constants";
import type { TradingDispatch } from "../lib/trading-store";

// ============================================================
//                    TYPES
// ============================================================

export interface OrderParams {
  side: "buy" | "sell";
  orderType: "limit" | "market" | "stopLimit";
  timeInForce: "GTC" | "IOC" | "FOK" | "PostOnly";
  price: string;       // human-readable price string
  size: string;        // human-readable size string
  triggerPrice?: string;
  takeProfit?: string;
  stopLoss?: string;
  reduceOnly?: boolean;
}

// ============================================================
//                    HOOK
// ============================================================

export function useOrderSubmit(
  wsSend: (data: any) => void,
  dispatch: TradingDispatch,
  market: MarketMeta,
  walletClient: WalletClient | null,
  traderAddress: Hex | null,
  nonce: number,
) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitOrder = useCallback(async (params: OrderParams) => {
    if (!walletClient || !traderAddress) {
      setError("Wallet not connected");
      return;
    }

    if (!params.size || parseFloat(params.size) <= 0) {
      setError("Invalid size");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Build order values
      const isLong = params.side === "buy";
      const sizeRaw = toSize(parseFloat(params.size));
      const priceRaw = params.orderType === "market"
        ? 0n // market orders have no price
        : toPrice(parseFloat(params.price));
      const nonceRaw = BigInt(nonce);
      const expiryRaw = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

      // Sign EIP-712 typed data with wallet
      const signature = await walletClient.signTypedData({
        account: traderAddress,
        domain: {
          ...EIP712_DOMAIN,
          chainId: CHAIN.id,
          verifyingContract: CONTRACTS.settlement,
        },
        types: ORDER_TYPES,
        primaryType: "Order",
        message: {
          trader: traderAddress,
          marketId: market.id,
          isLong,
          size: sizeRaw,
          price: priceRaw,
          nonce: nonceRaw,
          expiry: expiryRaw,
        },
      });

      // Send signed order to backend via WebSocket
      wsSend({
        type: "submitOrder",
        order: {
          trader: traderAddress,
          marketId: market.id,
          side: params.side,
          orderType: params.orderType === "stopLimit" ? "limit" : params.orderType,
          price: priceRaw.toString(),
          size: sizeRaw.toString(),
          timeInForce: params.timeInForce,
          nonce: nonceRaw.toString(),
          expiry: expiryRaw.toString(),
          signature,
        },
      });

      // Increment nonce for next order
      dispatch({ type: "INCREMENT_NONCE" });

    } catch (err: any) {
      const message = err?.shortMessage || err?.message || "Failed to submit order";
      setError(message);
      dispatch({ type: "ORDER_REJECTED", orderId: "", reason: message });
    } finally {
      setIsSubmitting(false);
    }
  }, [walletClient, traderAddress, nonce, market, wsSend, dispatch]);

  const cancelOrder = useCallback((orderId: string) => {
    wsSend({ type: "cancelOrder", orderId });
  }, [wsSend]);

  return { submitOrder, cancelOrder, isSubmitting, error };
}
