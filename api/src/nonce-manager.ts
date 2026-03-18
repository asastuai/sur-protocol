/**
 * SUR Protocol - Sequential Nonce Manager
 *
 * Prevents nonce collisions when multiple keeper transactions
 * are submitted concurrently from the same operator wallet.
 * Tracks pending nonces locally and falls back to on-chain
 * nonce on error.
 */

import { type PublicClient, type Hex } from "viem";

export class NonceManager {
  private currentNonce: number | null = null;
  private pendingCount = 0;
  private client: PublicClient;
  private address: Hex;

  constructor(client: PublicClient, address: Hex) {
    this.client = client;
    this.address = address;
  }

  async getNonce(): Promise<number> {
    if (this.currentNonce === null) {
      await this.sync();
    }
    const nonce = this.currentNonce! + this.pendingCount;
    this.pendingCount++;
    return nonce;
  }

  confirmNonce(): void {
    if (this.currentNonce !== null && this.pendingCount > 0) {
      this.currentNonce++;
      this.pendingCount--;
    }
  }

  rejectNonce(): void {
    if (this.pendingCount > 0) {
      this.pendingCount--;
    }
  }

  async sync(): Promise<void> {
    const count = await this.client.getTransactionCount({
      address: this.address,
    });
    this.currentNonce = count;
    this.pendingCount = 0;
  }

  async reset(): Promise<void> {
    this.currentNonce = null;
    this.pendingCount = 0;
    await this.sync();
  }
}
