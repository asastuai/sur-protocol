"use client";

import { useState, useEffect, useCallback } from "react";
import { useTrading } from "@/providers/TradingProvider";
import { useAccount, useWalletClient } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { toPrice, toSize, fmtPrice, CONTRACTS, CHAIN, EIP712_DOMAIN, ORDER_TYPES, getMaxLeverageForSize, calculateTieredMargin, MARKET_RISK_CONFIGS } from "@/lib/constants";
import { type Hex } from "viem";

type OrderType = "limit" | "market" | "stopLimit" | "stopMarket" | "oco";
type TIF = "GTC" | "IOC" | "FOK" | "PostOnly";

export function OrderPanel() {
  const { state, dispatch, send, market } = useTrading();
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { openConnectModal } = useConnectModal();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [tif, setTif] = useState<TIF>("GTC");
  const [price, setPrice] = useState("");
  const [triggerPrice, setTriggerPrice] = useState("");
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [reduceOnly, setReduceOnly] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isLong = side === "buy";

  // Auto-fill price from mark price on first load
  useEffect(() => {
    if (!price && state.markPrice > 0) {
      setPrice(state.markPrice.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }));
    }
  }, [state.markPrice, price]);

  // Calculate estimates
  const numPrice = parseFloat(price) || state.markPrice || 0;
  const numSize = parseFloat(size) || 0;
  const notional = numPrice * numSize;
  const maxLevForSize = getMaxLeverageForSize(market.name, notional);
  const tieredMarginEst = calculateTieredMargin(market.name, notional);
  const flatMarginEst = leverage > 0 ? notional / leverage : 0;
  const marginEst = Math.max(tieredMarginEst, flatMarginEst);
  const feeRate = tif === "PostOnly" ? market.makerFeeBps : market.takerFeeBps;
  const feeEst = notional * (feeRate / 10000);
  const balance = state.paperMode ? state.paperBalance : (state.vaultBalance > 0 ? state.vaultBalance : 0);

  // Determine current tier label
  const riskConfig = MARKET_RISK_CONFIGS[market.name];
  const currentTierIndex = riskConfig ? riskConfig.tiers.findIndex(
    t => t.maxNotionalUsd === 0 || notional <= t.maxNotionalUsd
  ) : -1;
  const currentTierLabel = currentTierIndex >= 0 ? `Tier ${currentTierIndex + 1}` : "";

  // Cap leverage to max allowed for this notional size
  const effectiveMaxLev = Math.min(market.maxLeverage, maxLevForSize);

  // Auto-clamp leverage if it exceeds the max for current notional
  useEffect(() => {
    if (leverage > effectiveMaxLev) {
      setLeverage(effectiveMaxLev);
    }
  }, [effectiveMaxLev, leverage]);

  // Estimated liquidation price
  const liqEst = numSize > 0 && marginEst > 0
    ? isLong
      ? numPrice - (marginEst * 0.975) / numSize
      : numPrice + (marginEst * 0.975) / numSize
    : 0;

  // Set price from orderbook click (exposed via parent)
  const setOrderPrice = (p: number) => setPrice(p.toFixed(2));

  // Submit order
  const handleSubmit = async () => {
    if (!numSize || numSize <= 0) return;

    // Paper trading mode: submit locally
    if (state.paperMode) {
      // Compute fill price from multiple sources
      const bestBid = state.bids[0]?.price || 0;
      const bestAsk = state.asks[0]?.price || 0;
      const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk);
      const fillPrice = state.markPrice > 0 ? state.markPrice : midPrice > 0 ? midPrice : numPrice;

      const tpVal = parseFloat(tp) || undefined;
      const slVal = parseFloat(sl) || undefined;

      if (orderType === "market") {
        if (fillPrice <= 0) {
          dispatch({ type: "ORDER_REJECTED", orderId: "", reason: "No price available yet — wait for orderbook data" });
          setTimeout(() => dispatch({ type: "CLEAR_ORDER_STATUS" }), 3000);
          return;
        }
        dispatch({
          type: "PAPER_MARKET_ORDER",
          market: market.name,
          marketId: market.id,
          side,
          size: numSize,
          leverage,
          fillPrice,
          feeBps: market.takerFeeBps,
          tp: tpVal,
          sl: slVal,
        });
      } else if (orderType === "stopMarket") {
        const stopPx = parseFloat(triggerPrice);
        if (!stopPx || stopPx <= 0) return;
        dispatch({
          type: "PAPER_LIMIT_ORDER",
          market: market.name, marketId: market.id, side,
          price: 0, size: numSize, leverage,
          orderType: "stopMarket", stopPrice: stopPx,
          tp: tpVal, sl: slVal,
        });
      } else if (orderType === "oco") {
        // OCO = TP limit + SL stop market, linked by group ID
        const tpPx = parseFloat(tp);
        const slPx = parseFloat(triggerPrice);
        if (!tpPx || !slPx || tpPx <= 0 || slPx <= 0 || !numSize) return;
        const groupId = `oco_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const closeSide = side === "buy" ? "sell" as const : "buy" as const;
        // TP: limit order at take profit price
        dispatch({
          type: "PAPER_LIMIT_ORDER",
          market: market.name, marketId: market.id, side: closeSide,
          price: tpPx, size: numSize, leverage,
          orderType: "limit", ocoGroupId: groupId,
        });
        // SL: stop market at stop loss trigger
        dispatch({
          type: "PAPER_LIMIT_ORDER",
          market: market.name, marketId: market.id, side: closeSide,
          price: 0, size: numSize, leverage,
          orderType: "stopMarket", stopPrice: slPx, ocoGroupId: groupId,
        });
      } else {
        // Limit or stop limit
        if (numPrice <= 0) return;
        const stopPx = orderType === "stopLimit" ? parseFloat(triggerPrice) || undefined : undefined;
        dispatch({
          type: "PAPER_LIMIT_ORDER",
          market: market.name, marketId: market.id, side,
          price: numPrice, size: numSize, leverage,
          tp: tpVal, sl: slVal,
          ...(stopPx ? { orderType: "stopLimit" as const, stopPrice: stopPx } : {}),
        });
      }
      setSize("");
      setTp("");
      setSl("");
      setTriggerPrice("");
      setTimeout(() => dispatch({ type: "CLEAR_ORDER_STATUS" }), 3000);
      return;
    }

    // If not connected, open wallet modal
    if (!isConnected || !address) {
      openConnectModal?.();
      return;
    }

    setSubmitting(true);
    try {
      const orderData = {
        trader: address,
        marketId: market.id,
        isLong,
        size: toSize(numSize),
        price: orderType === "market" ? 0n : toPrice(numPrice),
        nonce: BigInt(state.nextNonce),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      };

      let signature: Hex = "0x00";

      if (walletClient) {
        // Sign with EIP-712 via wagmi walletClient
        signature = await walletClient.signTypedData({
          domain: {
            name: EIP712_DOMAIN.name,
            version: EIP712_DOMAIN.version,
            chainId: BigInt(CHAIN.id),
            verifyingContract: CONTRACTS.settlement,
          },
          types: ORDER_TYPES,
          primaryType: "Order",
          message: {
            trader: orderData.trader,
            marketId: orderData.marketId,
            isLong: orderData.isLong,
            size: orderData.size,
            price: orderData.price,
            nonce: orderData.nonce,
            expiry: orderData.expiry,
          },
        });
      }

      send({
        type: "submitOrder",
        order: {
          trader: address,
          marketId: market.id,
          side,
          orderType: orderType === "stopLimit" ? "limit" : orderType,
          price: orderData.price.toString(),
          size: orderData.size.toString(),
          timeInForce: tif,
          nonce: orderData.nonce.toString(),
          expiry: orderData.expiry.toString(),
          signature,
          hidden,
        },
      });

      dispatch({ type: "INCREMENT_NONCE" });
      setSize(""); // Clear size after submit
    } catch (err: any) {
      console.error("Order submit error:", err);
    } finally {
      setSubmitting(false);
    }
  };

  // Set size as percentage of available balance
  const setSizePct = (pct: number) => {
    if (numPrice <= 0 || leverage <= 0) return;
    const maxNotional = balance * leverage * (pct / 100);
    const maxSize = maxNotional / numPrice;
    setSize(maxSize.toFixed(4));
  };

  // ---- Keyboard Shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable)) return;

      switch (e.key.toLowerCase()) {
        case "b": setSide("buy"); e.preventDefault(); break;
        case "s": setSide("sell"); e.preventDefault(); break;
        case "m": setOrderType("market"); e.preventDefault(); break;
        case "l": setOrderType("limit"); e.preventDefault(); break;
        case "1": setSizePct(25); e.preventDefault(); break;
        case "2": setSizePct(50); e.preventDefault(); break;
        case "3": setSizePct(75); e.preventDefault(); break;
        case "4": setSizePct(100); e.preventDefault(); break;
        case "enter":
          if (!e.ctrlKey && !e.metaKey) { handleSubmit(); e.preventDefault(); }
          break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numPrice, leverage, balance, numSize, state.paperMode, state.markPrice]);

  const leveragePresets = [1, 2, 5, 10, 20];

  const tifOptions: { key: TIF; label: string; tip: string }[] = [
    { key: "GTC", label: "GTC", tip: "Good til cancelled — stays on book until filled or cancelled" },
    { key: "IOC", label: "IOC", tip: "Immediate or cancel — fills what it can, cancels the rest" },
    { key: "FOK", label: "FOK", tip: "Fill or kill — must fill entirely or gets cancelled" },
    { key: "PostOnly", label: "Post", tip: "Post only — rejected if it would match immediately (maker only)" },
  ];

  return (
    <div className="border-t border-sur-border">
      <div className="px-3 py-2 border-b border-sur-border text-[11px] font-semibold uppercase tracking-wider text-sur-muted">
        Place Order
      </div>

      {/* Long / Short */}
      <div className="grid grid-cols-2 p-2 gap-1.5">
        <button
          onClick={() => setSide("buy")}
          aria-pressed={isLong}
          aria-label="Long (buy)"
          className={`py-2 rounded text-xs font-semibold transition-all ${
            isLong
              ? "bg-sur-green/15 text-sur-green border border-sur-green/30"
              : "bg-sur-border/30 text-sur-muted hover:text-sur-text border border-transparent"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setSide("sell")}
          aria-pressed={!isLong}
          aria-label="Short (sell)"
          className={`py-2 rounded text-xs font-semibold transition-all ${
            !isLong
              ? "bg-sur-red/15 text-sur-red border border-sur-red/30"
              : "bg-sur-border/30 text-sur-muted hover:text-sur-text border border-transparent"
          }`}
        >
          Short
        </button>
      </div>

      <div className="px-3 pb-1 flex flex-col gap-2.5">
        {/* Order Type */}
        <div className="flex gap-1 flex-wrap">
          {([
            { key: "limit" as OrderType, label: "Limit" },
            { key: "market" as OrderType, label: "Market" },
            { key: "stopMarket" as OrderType, label: "Stop" },
            { key: "stopLimit" as OrderType, label: "Stop Limit" },
            ...(state.paperMode ? [{ key: "oco" as OrderType, label: "OCO" }] : []),
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setOrderType(t.key)}
              className={`px-2.5 py-1 rounded text-[10px] transition-colors ${
                orderType === t.key
                  ? "bg-sur-border text-sur-text font-medium"
                  : "text-sur-muted hover:text-sur-text"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Time in Force */}
        <div>
          <span className="text-[9px] text-sur-muted font-medium uppercase tracking-wider" id="tif-label">Time in Force</span>
          <div role="group" aria-labelledby="tif-label" className="flex gap-1 mt-1">
            {tifOptions.map((t) => (
              <button
                key={t.key}
                onClick={() => setTif(t.key)}
                title={t.tip}
                aria-pressed={tif === t.key}
                aria-label={t.tip}
                className={`flex-1 py-1 rounded text-[9px] font-medium transition-all ${
                  tif === t.key
                    ? "bg-sur-accent/15 text-sur-accent border border-sur-accent/30"
                    : "bg-sur-border/30 text-sur-muted border border-transparent hover:text-sur-text"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Trigger Price (Stop orders) */}
        {(orderType === "stopLimit" || orderType === "stopMarket") && (
          <div>
            <label htmlFor="input-trigger-price" className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">Trigger Price</label>
            <div className="mt-1 relative">
              <input
                id="input-trigger-price"
                type="number"
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder="0.00"
                aria-label="Trigger price in USD"
                className="w-full bg-sur-bg border border-sur-border rounded px-2.5 py-1.5 text-[11px] tabular-nums focus:border-sur-accent/50 outline-none transition-colors"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-sur-muted" aria-hidden="true">USD</span>
            </div>
          </div>
        )}

        {/* OCO: TP Price + SL Trigger */}
        {orderType === "oco" && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="input-oco-tp" className="text-[9px] text-sur-green font-medium uppercase tracking-wider">TP Price</label>
              <div className="mt-1 relative">
                <input id="input-oco-tp" type="number" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="0.00"
                  aria-label="Take profit price in USD"
                  className="w-full bg-sur-bg border border-sur-border rounded px-2 py-1.5 text-[10px] tabular-nums focus:border-sur-green/40 outline-none" />
              </div>
            </div>
            <div>
              <label htmlFor="input-oco-sl" className="text-[9px] text-sur-red font-medium uppercase tracking-wider">SL Trigger</label>
              <div className="mt-1 relative">
                <input id="input-oco-sl" type="number" value={triggerPrice} onChange={(e) => setTriggerPrice(e.target.value)} placeholder="0.00"
                  aria-label="Stop loss trigger price in USD"
                  className="w-full bg-sur-bg border border-sur-border rounded px-2 py-1.5 text-[10px] tabular-nums focus:border-sur-red/40 outline-none" />
              </div>
            </div>
          </div>
        )}

        {/* Price (not for market/stopMarket/oco orders) */}
        {!["market", "stopMarket", "oco"].includes(orderType) && (
          <div>
            <label htmlFor="input-price" className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">
              {orderType === "stopLimit" ? "Limit Price" : "Price"}
            </label>
            <div className="mt-1 relative">
              <input
                id="input-price"
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
                aria-label={orderType === "stopLimit" ? "Limit price in USD" : "Price in USD"}
                className="w-full bg-sur-bg border border-sur-border rounded px-2.5 py-1.5 text-[11px] tabular-nums focus:border-sur-accent/50 outline-none transition-colors"
              />
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-sur-muted" aria-hidden="true">USD</span>
            </div>
          </div>
        )}

        {/* Size */}
        <div>
          <label htmlFor="input-size" className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">Size</label>
          <div className="mt-1 relative">
            <input
              id="input-size"
              type="number"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="0.00"
              aria-label={`Order size in ${market.baseAsset}`}
              className="w-full bg-sur-bg border border-sur-border rounded px-2.5 py-1.5 text-[11px] tabular-nums focus:border-sur-accent/50 outline-none transition-colors"
            />
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-sur-muted" aria-hidden="true">
              {market.baseAsset}
            </span>
          </div>
          <div className="flex gap-1 mt-1.5" role="group" aria-label="Set size as percentage of available balance">
            {[10, 25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => setSizePct(pct)}
                aria-label={`Set size to ${pct}% of available balance`}
                className="flex-1 text-[9px] py-0.5 rounded bg-sur-border/30 text-sur-muted hover:text-sur-text hover:bg-sur-border transition-colors"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Leverage */}
        <div>
          <div className="flex justify-between items-center">
            <label htmlFor="input-leverage" className="text-[9px] text-sur-muted font-medium uppercase tracking-wider">Leverage</label>
            <span className="text-[11px] font-semibold tabular-nums" aria-live="polite" aria-atomic="true">{leverage}x</span>
          </div>
          <input
            id="input-leverage"
            type="range"
            min={1}
            max={effectiveMaxLev}
            value={Math.min(leverage, effectiveMaxLev)}
            onChange={(e) => setLeverage(parseInt(e.target.value))}
            aria-label={`Leverage: ${leverage}x (max ${effectiveMaxLev}x)`}
            aria-valuemin={1}
            aria-valuemax={effectiveMaxLev}
            aria-valuenow={Math.min(leverage, effectiveMaxLev)}
            aria-valuetext={`${leverage}x leverage`}
            className="w-full mt-1 h-1 appearance-none bg-sur-border rounded-full cursor-pointer accent-sur-accent"
          />
          <div className="flex justify-between mt-1" role="group" aria-label="Leverage presets">
            {leveragePresets.filter(l => l <= effectiveMaxLev).map((l) => (
              <button
                key={l}
                onClick={() => setLeverage(l)}
                aria-pressed={leverage === l}
                aria-label={`Set leverage to ${l}x`}
                className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                  leverage === l
                    ? "bg-sur-accent/20 text-sur-accent"
                    : "text-sur-muted hover:text-sur-text"
                }`}
              >
                {l}x
              </button>
            ))}
          </div>
          {notional > 0 && currentTierLabel && (
            <div className="mt-1 text-[9px] text-sur-muted">
              <span className="text-sur-accent">{currentTierLabel}</span>
              {" — Max leverage for this size: "}
              <span className="text-sur-text font-medium">{maxLevForSize}x</span>
              {" — Required margin: "}
              <span className="text-sur-text font-medium">
                ${tieredMarginEst.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
        </div>

        {/* Summary (compact) */}
        <div className="border-t border-sur-border pt-2 space-y-0.5">
          {[
            ["Notional", `$${notional.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
            ["Margin", `$${marginEst.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`],
            ["Fee", `$${feeEst.toFixed(2)} (${(feeRate / 100).toFixed(2)}%)`],
            ["Available", `${fmtPrice(balance)} USDC`],
          ].map(([label, val]) => (
            <div key={label} className="flex justify-between text-[10px]">
              <span className="text-sur-muted">{label}</span>
              <span className="tabular-nums">{val}</span>
            </div>
          ))}
          {/* Funding Rate */}
          <div className="flex justify-between text-[10px]">
            <span className="text-sur-muted">Funding Rate</span>
            <span className={`tabular-nums font-medium ${
              state.fundingRate > 0 ? "text-sur-green" : state.fundingRate < 0 ? "text-sur-red" : "text-sur-muted"
            }`}>
              {state.fundingRate !== 0
                ? `${state.fundingRate > 0 ? "+" : ""}${state.fundingRate.toFixed(4)}%`
                : "—"}
            </span>
          </div>
          {state.fundingRate !== 0 && numSize > 0 && (
            <div className="flex justify-between text-[10px]">
              <span className="text-sur-muted">Est. Funding/8h</span>
              <span className={`tabular-nums ${
                (isLong ? state.fundingRate : -state.fundingRate) >= 0 ? "text-sur-red" : "text-sur-green"
              }`}>
                {(() => {
                  const cost = notional * Math.abs(state.fundingRate / 100);
                  const pays = isLong ? state.fundingRate > 0 : state.fundingRate < 0;
                  return `${pays ? "-" : "+"}$${cost.toFixed(2)}`;
                })()}
              </span>
            </div>
          )}
          {/* Est. Liq Price */}
          {liqEst > 0 && (
            <div className="flex justify-between text-[10px]">
              <span className="text-sur-muted">Est. Liq. Price</span>
              <span className="tabular-nums text-sur-red">${liqEst.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          )}
        </div>

        {/* ===== SUBMIT BUTTON ===== */}
        <button
          onClick={handleSubmit}
          disabled={!numSize || numSize <= 0 || submitting}
          className={`w-full py-3 rounded-lg font-bold text-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed ${
            isLong
              ? "bg-sur-green text-black hover:bg-sur-green/90"
              : "bg-sur-red text-white hover:bg-sur-red/90"
          }`}
        >
          {state.paperMode
            ? submitting ? "Filling..." : `${isLong ? "Long" : "Short"} ${market.name}`
            : !isConnected
            ? "Connect Wallet"
            : submitting
            ? "Signing..."
            : `${isLong ? "Long" : "Short"} ${market.name}`}
        </button>

        {/* Order status */}
        {state.lastOrderStatus && (
          <div className={`text-center text-[10px] ${
            state.orderError ? "text-sur-red" : "text-sur-green"
          }`}>
            {state.orderError
              ? `Rejected: ${state.orderError}`
              : `Order ${state.lastOrderStatus}`}
          </div>
        )}

        {/* TP / SL (below button, collapsible) */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="input-tp" className="text-[9px] text-sur-green font-medium uppercase tracking-wider">TP</label>
            <input
              id="input-tp"
              type="number"
              value={tp}
              onChange={(e) => setTp(e.target.value)}
              placeholder="—"
              aria-label="Take profit price"
              className="w-full mt-0.5 bg-sur-bg border border-sur-border rounded px-2 py-1 text-[10px] tabular-nums focus:border-sur-green/40 outline-none"
            />
          </div>
          <div>
            <label htmlFor="input-sl" className="text-[9px] text-sur-red font-medium uppercase tracking-wider">SL</label>
            <input
              id="input-sl"
              type="number"
              value={sl}
              onChange={(e) => setSl(e.target.value)}
              placeholder="—"
              aria-label="Stop loss price"
              className="w-full mt-0.5 bg-sur-bg border border-sur-border rounded px-2 py-1 text-[10px] tabular-nums focus:border-sur-red/40 outline-none"
            />
          </div>
        </div>

        {/* Reduce Only + Hidden Order */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            role="checkbox"
            aria-checked={reduceOnly}
            onClick={() => setReduceOnly(!reduceOnly)}
            className="flex items-center gap-2 cursor-pointer bg-transparent border-0 p-0"
          >
            <span
              aria-hidden="true"
              className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all ${
                reduceOnly
                  ? "border-sur-accent bg-sur-accent/20"
                  : "border-sur-border"
              }`}
            >
              {reduceOnly && <span className="text-[8px] text-sur-accent">✓</span>}
            </span>
            <span className="text-[10px] text-sur-muted">Reduce Only</span>
          </button>

          {orderType === "limit" && (
            <button
              type="button"
              role="checkbox"
              aria-checked={hidden}
              onClick={() => setHidden(!hidden)}
              title="Hidden orders don't appear on the public orderbook. They still match normally but protect your strategy from being front-run."
              className="flex items-center gap-2 cursor-pointer bg-transparent border-0 p-0 group relative"
            >
              <span
                aria-hidden="true"
                className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all ${
                  hidden
                    ? "border-purple-500 bg-purple-500/20"
                    : "border-sur-border"
                }`}
              >
                {hidden && <span className="text-[8px] text-purple-400">✓</span>}
              </span>
              <span className={`text-[10px] ${hidden ? "text-purple-400" : "text-sur-muted"}`}>Hidden</span>
              <span className="absolute bottom-full left-0 mb-1 hidden group-hover:block w-44 p-2 bg-[#28282e] border border-sur-border rounded text-[9px] text-sur-muted z-50" aria-hidden="true">
                Hidden orders don&apos;t appear on the public orderbook. They still match normally but protect your strategy from being front-run.
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Expose setPrice for orderbook click integration
OrderPanel.displayName = "OrderPanel";
