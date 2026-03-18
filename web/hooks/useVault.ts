"use client";

import { useState, useCallback } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits, type Hex, maxUint256 } from "viem";
import { CONTRACTS } from "@/lib/constants";
import { erc20Abi, vaultAbi, USDC_ADDRESS } from "@/lib/contracts";

const USDC_DECIMALS = 6;

export function useVault() {
  const { address, isConnected } = useAccount();
  const [pendingTx, setPendingTx] = useState<Hex | undefined>();
  const [txStatus, setTxStatus] = useState<"idle" | "approving" | "depositing" | "withdrawing" | "success" | "error">("idle");
  const [txError, setTxError] = useState<string | null>(null);

  const { writeContractAsync } = useWriteContract();

  // --- Read: USDC wallet balance ---
  const { data: usdcBalance, refetch: refetchUsdc } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // --- Read: USDC allowance for vault ---
  const { data: usdcAllowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, CONTRACTS.vault] : undefined,
    query: { enabled: !!address },
  });

  // --- Read: Vault balance (deposited funds) ---
  const { data: vaultBalance, refetch: refetchVault } = useReadContract({
    address: CONTRACTS.vault,
    abi: vaultAbi,
    functionName: "balances",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // --- Wait for tx confirmation ---
  useWaitForTransactionReceipt({
    hash: pendingTx,
    query: {
      enabled: !!pendingTx,
    },
  });

  // --- Refetch all balances ---
  const refetchAll = useCallback(() => {
    refetchUsdc();
    refetchAllowance();
    refetchVault();
  }, [refetchUsdc, refetchAllowance, refetchVault]);

  // --- Approve USDC for vault ---
  const approve = useCallback(async () => {
    if (!address) return;
    setTxStatus("approving");
    setTxError(null);
    try {
      const hash = await writeContractAsync({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [CONTRACTS.vault, maxUint256],
      });
      setPendingTx(hash);
      setTxStatus("success");
      // Wait a bit then refetch
      setTimeout(refetchAll, 2000);
    } catch (err: any) {
      setTxStatus("error");
      setTxError(err?.shortMessage || err?.message || "Approve failed");
    }
  }, [address, writeContractAsync, refetchAll]);

  // --- Deposit USDC into vault ---
  const deposit = useCallback(async (amountUsdc: string) => {
    if (!address) return;
    setTxStatus("depositing");
    setTxError(null);
    try {
      const amount = parseUnits(amountUsdc, USDC_DECIMALS);

      // Check if we need approval first
      const currentAllowance = usdcAllowance ?? 0n;
      if (currentAllowance < amount) {
        setTxStatus("approving");
        const approveHash = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [CONTRACTS.vault, maxUint256],
        });
        setPendingTx(approveHash);
        // Wait for approval to confirm
        await new Promise(resolve => setTimeout(resolve, 3000));
        refetchAllowance();
      }

      setTxStatus("depositing");
      const hash = await writeContractAsync({
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [amount],
      });
      setPendingTx(hash);
      setTxStatus("success");
      setTimeout(refetchAll, 2000);
    } catch (err: any) {
      setTxStatus("error");
      setTxError(err?.shortMessage || err?.message || "Deposit failed");
    }
  }, [address, usdcAllowance, writeContractAsync, refetchAll, refetchAllowance]);

  // --- Withdraw USDC from vault ---
  const withdraw = useCallback(async (amountUsdc: string) => {
    if (!address) return;
    setTxStatus("withdrawing");
    setTxError(null);
    try {
      const amount = parseUnits(amountUsdc, USDC_DECIMALS);
      const hash = await writeContractAsync({
        address: CONTRACTS.vault,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [amount],
      });
      setPendingTx(hash);
      setTxStatus("success");
      setTimeout(refetchAll, 2000);
    } catch (err: any) {
      setTxStatus("error");
      setTxError(err?.shortMessage || err?.message || "Withdraw failed");
    }
  }, [address, writeContractAsync, refetchAll]);

  // --- Reset status ---
  const resetStatus = useCallback(() => {
    setTxStatus("idle");
    setTxError(null);
    setPendingTx(undefined);
  }, []);

  return {
    // Connection
    isConnected,
    address,

    // Balances (formatted)
    usdcBalance: usdcBalance ? formatUnits(usdcBalance, USDC_DECIMALS) : "0",
    usdcBalanceRaw: usdcBalance ?? 0n,
    vaultBalance: vaultBalance ? formatUnits(vaultBalance, USDC_DECIMALS) : "0",
    vaultBalanceRaw: vaultBalance ?? 0n,
    needsApproval: (usdcAllowance ?? 0n) === 0n,

    // Actions
    approve,
    deposit,
    withdraw,
    refetchAll,
    resetStatus,

    // Tx state
    txStatus,
    txError,
    pendingTx,
  };
}
