"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { useVault } from "@/hooks/useVault";
import { useTrading } from "@/providers/TradingProvider";

type Tab = "deposit" | "withdraw";

export function DepositWithdrawPanel() {
  const { isConnected } = useAccount();
  const { login: openConnectModal } = usePrivy();
  const vault = useVault();
  const { state, dispatch } = useTrading();

  const [tab, setTab] = useState<Tab>("deposit");
  const [amount, setAmount] = useState("");
  const [paperStatus, setPaperStatus] = useState<"idle" | "success">("idle");

  // Clear amount on tab switch
  useEffect(() => setAmount(""), [tab]);

  // Clear vault status after 4s
  useEffect(() => {
    if (vault.txStatus === "success" || vault.txStatus === "error") {
      const timer = setTimeout(() => {
        vault.resetStatus();
        if (vault.txStatus === "success") setAmount("");
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [vault.txStatus]);

  // Paper mode
  if (state.paperMode) {
    const walletBal = state.paperWalletBalance;
    const vaultBal = state.paperBalance;
    const maxBalance = tab === "deposit" ? walletBal : vaultBal;
    const amountNum = parseFloat(amount) || 0;
    const isValid = amountNum > 0 && amountNum <= maxBalance;

    const handlePaperPercentage = (pct: number) => {
      const val = maxBalance * pct;
      setAmount(val > 0 ? val.toFixed(2) : "");
    };

    const handlePaperSubmit = () => {
      if (!isValid) return;
      if (tab === "deposit") {
        dispatch({ type: "PAPER_DEPOSIT", amount: amountNum });
      } else {
        dispatch({ type: "PAPER_WITHDRAW", amount: amountNum });
      }
      setAmount("");
      setPaperStatus("success");
      setTimeout(() => setPaperStatus("idle"), 2000);
    };

    const buttonLabel = () => {
      if (paperStatus === "success") return "Success!";
      if (tab === "deposit") {
        if (amountNum <= 0) return "Enter Amount";
        if (amountNum > maxBalance) return "Insufficient USDC";
        return `Deposit $${amountNum.toFixed(2)}`;
      }
      if (amountNum <= 0) return "Enter Amount";
      if (amountNum > maxBalance) return "Insufficient Balance";
      return `Withdraw $${amountNum.toFixed(2)}`;
    };

    return (
      <div className="p-3">
        {/* Paper badge */}
        <div className="flex items-center justify-between mb-2">
          <span className="text-[9px] font-bold uppercase tracking-wider text-sur-yellow bg-sur-yellow/10 px-2 py-0.5 rounded">
            Paper Funds
          </span>
        </div>

        {/* Tab selector */}
        <div className="flex mb-3 bg-sur-bg rounded overflow-hidden">
          {(["deposit", "withdraw"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setPaperStatus("idle"); }}
              className={`flex-1 py-1.5 text-[11px] font-semibold transition-colors capitalize ${
                tab === t
                  ? "bg-sur-border text-white"
                  : "text-sur-muted hover:text-gray-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Balances */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className={`bg-sur-bg rounded px-2.5 py-2 ${tab === "deposit" ? "border border-sur-accent/30" : "border border-transparent"}`}>
            <div className="text-[9px] text-sur-muted uppercase tracking-wider">Wallet</div>
            <div className="text-xs font-mono font-medium mt-0.5">
              ${walletBal.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
          <div className={`bg-sur-bg rounded px-2.5 py-2 ${tab === "withdraw" ? "border border-sur-accent/30" : "border border-transparent"}`}>
            <div className="text-[9px] text-sur-muted uppercase tracking-wider">Vault</div>
            <div className="text-xs font-mono font-medium mt-0.5">
              ${vaultBal.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* Amount input */}
        <div className="mb-2">
          <label className="text-[10px] text-sur-muted mb-1 block">
            {tab === "deposit" ? "Deposit Amount" : "Withdraw Amount"} (USDC)
          </label>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setPaperStatus("idle"); }}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="w-full bg-sur-bg border border-sur-border rounded px-3 py-2 text-sm font-mono text-right
                         focus:border-sur-accent transition-colors placeholder:text-sur-muted/50"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] text-sur-muted">$</span>
          </div>
        </div>

        {/* Quick fill buttons */}
        <div className="flex gap-1.5 mb-3">
          {[0.25, 0.5, 0.75, 1].map((pct) => (
            <button
              key={pct}
              onClick={() => handlePaperPercentage(pct)}
              disabled={maxBalance <= 0}
              className="flex-1 py-1 rounded text-[10px] font-medium bg-sur-bg border border-sur-border
                         hover:border-sur-accent/50 hover:text-sur-accent transition-colors
                         disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {pct === 1 ? "MAX" : `${pct * 100}%`}
            </button>
          ))}
        </div>

        {/* Submit button */}
        <button
          onClick={handlePaperSubmit}
          disabled={!isValid && paperStatus !== "success"}
          className={`w-full py-2.5 rounded text-xs font-semibold transition-colors ${
            paperStatus === "success"
              ? "bg-sur-green/20 text-sur-green border border-sur-green/30"
              : tab === "deposit"
              ? "bg-sur-green/20 text-sur-green hover:bg-sur-green/30 disabled:opacity-30 disabled:cursor-not-allowed"
              : "bg-sur-red/20 text-sur-red hover:bg-sur-red/30 disabled:opacity-30 disabled:cursor-not-allowed"
          }`}
        >
          {buttonLabel()}
        </button>
      </div>
    );
  }

  // ---- Real wallet mode (original) ----

  const maxBalance = tab === "deposit"
    ? parseFloat(vault.usdcBalance)
    : parseFloat(vault.vaultBalance);

  const handlePercentage = (pct: number) => {
    const val = maxBalance * pct;
    setAmount(val > 0 ? val.toFixed(2) : "");
  };

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    if (tab === "deposit") {
      await vault.deposit(amount);
    } else {
      await vault.withdraw(amount);
    }
  };

  const isLoading = ["approving", "depositing", "withdrawing"].includes(vault.txStatus);
  const amountNum = parseFloat(amount) || 0;
  const isValid = amountNum > 0 && amountNum <= maxBalance;

  const buttonLabel = () => {
    if (vault.txStatus === "approving") return "Approving USDC...";
    if (vault.txStatus === "depositing") return "Depositing...";
    if (vault.txStatus === "withdrawing") return "Withdrawing...";
    if (vault.txStatus === "success") return "Success!";
    if (vault.txStatus === "error") return "Failed — Try Again";
    if (tab === "deposit") {
      if (amountNum <= 0) return "Enter Amount";
      if (amountNum > maxBalance) return "Insufficient USDC";
      return `Deposit $${parseFloat(amount).toFixed(2)}`;
    }
    if (amountNum <= 0) return "Enter Amount";
    if (amountNum > maxBalance) return "Insufficient Balance";
    return `Withdraw $${parseFloat(amount).toFixed(2)}`;
  };

  if (!isConnected) {
    return (
      <div className="p-3">
        <div className="panel-header text-[10px]">Funds</div>
        <div className="flex flex-col items-center gap-3 py-6 px-4">
          <p className="text-xs text-sur-muted text-center">
            Connect your wallet to deposit funds and start trading
          </p>
          <button
            onClick={openConnectModal}
            className="w-full py-2.5 rounded bg-sur-accent text-white text-xs font-semibold hover:bg-sur-accent/90 transition-colors"
          >
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="flex mb-3 bg-sur-bg rounded overflow-hidden">
        {(["deposit", "withdraw"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-[11px] font-semibold transition-colors capitalize ${
              tab === t ? "bg-sur-border text-white" : "text-sur-muted hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-sur-bg rounded px-2.5 py-2">
          <div className="text-[9px] text-sur-muted uppercase tracking-wider">Wallet</div>
          <div className="text-xs font-mono font-medium mt-0.5">${parseFloat(vault.usdcBalance).toFixed(2)}</div>
        </div>
        <div className="bg-sur-bg rounded px-2.5 py-2">
          <div className="text-[9px] text-sur-muted uppercase tracking-wider">Vault</div>
          <div className="text-xs font-mono font-medium mt-0.5">${parseFloat(vault.vaultBalance).toFixed(2)}</div>
        </div>
      </div>

      <div className="mb-2">
        <label className="text-[10px] text-sur-muted mb-1 block">
          {tab === "deposit" ? "Deposit Amount" : "Withdraw Amount"} (USDC)
        </label>
        <div className="relative">
          <input
            type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" min="0" step="0.01" disabled={isLoading}
            className="w-full bg-sur-bg border border-sur-border rounded px-3 py-2 text-sm font-mono text-right focus:border-sur-accent transition-colors placeholder:text-sur-muted/50 disabled:opacity-50"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] text-sur-muted">$</span>
        </div>
      </div>

      <div className="flex gap-1.5 mb-3">
        {[0.25, 0.5, 0.75, 1].map((pct) => (
          <button key={pct} onClick={() => handlePercentage(pct)} disabled={isLoading || maxBalance <= 0}
            className="flex-1 py-1 rounded text-[10px] font-medium bg-sur-bg border border-sur-border hover:border-sur-accent/50 hover:text-sur-accent transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {pct === 1 ? "MAX" : `${pct * 100}%`}
          </button>
        ))}
      </div>

      <button onClick={handleSubmit} disabled={isLoading || (!isValid && vault.txStatus !== "error")}
        className={`w-full py-2.5 rounded text-xs font-semibold transition-colors ${
          vault.txStatus === "success" ? "bg-sur-green/20 text-sur-green border border-sur-green/30"
          : vault.txStatus === "error" ? "bg-sur-red/20 text-sur-red border border-sur-red/30 hover:bg-sur-red/30"
          : tab === "deposit" ? "bg-sur-green/20 text-sur-green hover:bg-sur-green/30 disabled:opacity-30 disabled:cursor-not-allowed"
          : "bg-sur-red/20 text-sur-red hover:bg-sur-red/30 disabled:opacity-30 disabled:cursor-not-allowed"
        }`}
      >
        {isLoading && <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin mr-2 align-middle" />}
        {buttonLabel()}
      </button>
    </div>
  );
}
