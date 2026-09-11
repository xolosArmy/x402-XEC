/**
 * @file replay-cache.ts
 *
 * PROCESS-LOCAL NON-DURABLE REPLAY AND CONCURRENCY COORDINATION CACHE
 *
 * ⚠️ WARNING:
 * NOT SAFE FOR REAL-FUNDS MULTI-INSTANCE DEPLOYMENT
 *
 * This coordination store is strictly in-memory and process-local. It does not provide
 * durable or distributed synchronization across multiple instances or restarts.
 * Durable shared transactional state is a separate parallel track and MUST NOT be
 * assumed by callers of this class.
 */

import { X402AgentBridgeError } from "./errors.js";
import type { X402ReplayCache } from "./types.js";

interface CacheEntry {
  readonly invoiceHash: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export class InMemoryAuthorizationReplayCache implements X402ReplayCache {
  // In-flight reservations undergoing authorization
  private readonly inFlightInvoices = new Set<string>();
  private readonly inFlightNonces = new Set<string>();

  // Committed historical authorizations (prevent replay after completion)
  private readonly committedInvoices = new Map<string, CacheEntry>();
  private readonly committedNonces = new Map<string, CacheEntry>();

  /**
   * Reserves an invoice and nonce for in-flight authorization.
   * Fails closed if the invoice or nonce has already been seen or is concurrently in flight.
   */
  reserve(
    invoiceHash: string,
    nonce: string,
    expiresAt: number,
    now: number
  ): void {
    this.prune(now);

    // 1. Check if invoice is currently in flight (concurrent attempt)
    if (this.inFlightInvoices.has(invoiceHash)) {
      throw new X402AgentBridgeError(
        "CONCURRENT_CONFLICT",
        `Concurrent authorization attempt detected for invoiceHash ${invoiceHash}`
      );
    }

    // 2. Check if nonce is currently in flight (concurrent attempt)
    if (this.inFlightNonces.has(nonce)) {
      throw new X402AgentBridgeError(
        "CONCURRENT_CONFLICT",
        `Concurrent authorization attempt detected for nonce ${nonce}`
      );
    }

    // 3. Check if invoice was already authorized and committed
    const existingInvoice = this.committedInvoices.get(invoiceHash);
    if (existingInvoice && existingInvoice.expiresAt > now) {
      throw new X402AgentBridgeError(
        "DUPLICATE_INVOICE",
        `Invoice ${invoiceHash} has already been processed and authorized`
      );
    }

    // 4. Check if nonce was already used and committed
    const existingNonce = this.committedNonces.get(nonce);
    if (existingNonce && existingNonce.expiresAt > now) {
      throw new X402AgentBridgeError(
        "NONCE_REUSE",
        `Nonce ${nonce} has already been used in a previous authorization`
      );
    }

    // Reserve both
    this.inFlightInvoices.add(invoiceHash);
    this.inFlightNonces.add(nonce);
  }

  /**
   * Commits the reservation into the replay index upon successful authorization.
   */
  commit(invoiceHash: string, nonce: string, expiresAt: number): void {
    this.inFlightInvoices.delete(invoiceHash);
    this.inFlightNonces.delete(nonce);

    const entry: CacheEntry = { invoiceHash, nonce, expiresAt };
    this.committedInvoices.set(invoiceHash, entry);
    this.committedNonces.set(nonce, entry);
  }

  /**
   * Releases an in-flight reservation on error or rejection without marking as committed.
   */
  rollback(invoiceHash: string, nonce: string): void {
    this.inFlightInvoices.delete(invoiceHash);
    this.inFlightNonces.delete(nonce);
  }

  /**
   * Removes expired entries from the committed index.
   */
  prune(now: number): number {
    let prunedCount = 0;

    for (const [hash, entry] of this.committedInvoices.entries()) {
      if (entry.expiresAt <= now) {
        this.committedInvoices.delete(hash);
        prunedCount++;
      }
    }

    for (const [nonce, entry] of this.committedNonces.entries()) {
      if (entry.expiresAt <= now) {
        this.committedNonces.delete(nonce);
      }
    }

    return prunedCount;
  }

  hasSeenInvoice(invoiceHash: string): boolean {
    return (
      this.committedInvoices.has(invoiceHash) ||
      this.inFlightInvoices.has(invoiceHash)
    );
  }

  hasSeenNonce(nonce: string): boolean {
    return (
      this.committedNonces.has(nonce) || this.inFlightNonces.has(nonce)
    );
  }

  isInFlight(invoiceHash: string, nonce: string): boolean {
    return (
      this.inFlightInvoices.has(invoiceHash) ||
      this.inFlightNonces.has(nonce)
    );
  }
}
