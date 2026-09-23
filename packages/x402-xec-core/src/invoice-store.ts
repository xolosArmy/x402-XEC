/**
 * @file invoice-store.ts
 *
 * Server-authoritative invoice storage and ACID settlement proof state machine.
 */

import { computeInvoiceHash } from "./invoice.js";
import type { InvoicePayToAllocator } from "./pay-to-allocator.js";
import {
  invoiceSchema,
  type Invoice,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
} from "./schemas.js";

export type AuthoritativeInvoiceState = "ISSUED" | "VERIFYING" | "PAID";

export interface AuthoritativeInvoiceRecord {
  readonly invoiceHash: string;
  readonly nonce: string;
  readonly resourceHash: string;
  readonly amountSats: bigint;
  readonly payTo: string;
  readonly network: "xec:mainnet";
  readonly scheme: "exact";
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly state: AuthoritativeInvoiceState;
  readonly settledTxid?: string;
  readonly settledAt?: number;
  readonly derivationIndex?: number;
}

export type CommitPaidResult =
  | {
      readonly ok: true;
      readonly idempotent: boolean;
      readonly record: AuthoritativeInvoiceRecord;
    }
  | {
      readonly ok: false;
      readonly code: "INVOICE_NOT_FOUND" | "CONFLICT" | "TXID_REUSED";
      readonly message: string;
    };

export interface IssueWithAllocationParams {
  readonly nonce: string;
  readonly resourceHash: string;
  readonly amountSats: bigint;
  readonly network?: "xec:mainnet";
  readonly scheme?: "exact";
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly state?: AuthoritativeInvoiceState;
}

export interface IssueWithAllocationResult {
  readonly record: AuthoritativeInvoiceRecord;
  readonly invoice: Invoice;
}

export interface AuthoritativeInvoiceStore {
  /**
   * Indicates whether this store guarantees durable ACID persistence across restarts.
   * Production middleware MUST fail closed if isDurable is false.
   */
  readonly isDurable: boolean;

  /**
   * Persists a freshly issued authoritative invoice record with explicit payTo.
   * Throws if nonce is already registered, invoiceHash already exists, or payTo/derivationIndex conflicts.
   */
  issue(record: AuthoritativeInvoiceRecord): Promise<void>;

  /**
   * Atomically allocates the next monotonic derivationIndex, derives a unique payTo address
   * via the provided allocator, computes the invoice, and persists the record in one authoritative operation.
   */
  issueWithAllocation(
    params: IssueWithAllocationParams,
    allocator: InvoicePayToAllocator,
  ): Promise<IssueWithAllocationResult>;

  /**
   * Retrieves an invoice record by its canonical invoiceHash.
   */
  getByInvoiceHash(invoiceHash: string): Promise<AuthoritativeInvoiceRecord | null>;

  /**
   * Retrieves an invoice record by the txid that settled it.
   */
  getBySettledTxid(txid: string): Promise<AuthoritativeInvoiceRecord | null>;

  /**
   * Retrieves an invoice record by its allocated payTo destination address.
   */
  getByPayTo(payTo: string): Promise<AuthoritativeInvoiceRecord | null>;

  /**
   * Returns the next available derivation index without allocating it.
   */
  getNextDerivationIndex(): Promise<number>;

  /**
   * Atomically transitions an invoice to PAID, binding the settling txid.
   * Enforces:
   * - (invoiceHash, txid) idempotency: repeat calls return ok: true, idempotent: true.
   * - Conflict: same invoiceHash cannot be paid with a different txid.
   * - Replay: same txid cannot pay multiple different invoices.
   */
  commitPaid(
    invoiceHash: string,
    txid: string,
    paidAt: number,
  ): Promise<CommitPaidResult>;

  /**
   * Closes the store and releases resources if applicable.
   */
  close?(): Promise<void> | void;
}

export class InvoiceStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InvoiceStoreError";
    this.code = code;
  }
}

/**
 * In-memory reference implementation of AuthoritativeInvoiceStore.
 *
 * WARNING: PROCESS-LOCAL ONLY.
 * MUST NOT be used as ACID durable authority for production real-funds middleware.
 * Keep ONLY for test and development reference.
 */
export class InMemoryAuthoritativeInvoiceStore implements AuthoritativeInvoiceStore {
  readonly isDurable = false;

  private readonly records = new Map<string, AuthoritativeInvoiceRecord>();
  private readonly nonceToInvoice = new Map<string, string>();
  private readonly txidToInvoice = new Map<string, string>();
  private readonly payToToInvoice = new Map<string, string>();
  private readonly indexToInvoice = new Map<number, string>();
  private nextDerivationIndex = 0;

  // Async lock / queue to serialize concurrent operations
  private lockPromise: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const nextLock = this.lockPromise.then(async () => {
      return fn();
    });
    this.lockPromise = nextLock.then(() => {}, () => {});
    return nextLock;
  }

  async issue(record: AuthoritativeInvoiceRecord): Promise<void> {
    return this.withLock(() => {
      if (this.records.has(record.invoiceHash)) {
        throw new InvoiceStoreError(
          "INVOICE_ALREADY_EXISTS",
          `Invoice ${record.invoiceHash} has already been issued`,
        );
      }
      if (this.nonceToInvoice.has(record.nonce)) {
        throw new InvoiceStoreError(
          "NONCE_ALREADY_USED",
          `Nonce ${record.nonce} has already been used by invoice ${this.nonceToInvoice.get(record.nonce)}`,
        );
      }
      if (record.derivationIndex !== undefined) {
        if (this.payToToInvoice.has(record.payTo)) {
          throw new InvoiceStoreError(
            "PAY_TO_ALREADY_USED",
            `Payment address ${record.payTo} has already been allocated to invoice ${this.payToToInvoice.get(record.payTo)}`,
          );
        }
        if (this.indexToInvoice.has(record.derivationIndex)) {
          throw new InvoiceStoreError(
            "DERIVATION_INDEX_ALREADY_USED",
            `Derivation index ${record.derivationIndex} has already been allocated`,
          );
        }
        this.payToToInvoice.set(record.payTo, record.invoiceHash);
        this.indexToInvoice.set(record.derivationIndex, record.invoiceHash);
        this.nextDerivationIndex = Math.max(this.nextDerivationIndex, record.derivationIndex + 1);
      } else {
        this.payToToInvoice.set(record.payTo, record.invoiceHash);
      }

      this.records.set(record.invoiceHash, { ...record });
      this.nonceToInvoice.set(record.nonce, record.invoiceHash);
    });
  }

  async issueWithAllocation(
    params: IssueWithAllocationParams,
    allocator: InvoicePayToAllocator,
  ): Promise<IssueWithAllocationResult> {
    return this.withLock(() => {
      if (this.nonceToInvoice.has(params.nonce)) {
        throw new InvoiceStoreError(
          "NONCE_ALREADY_USED",
          `Nonce ${params.nonce} has already been used by invoice ${this.nonceToInvoice.get(params.nonce)}`,
        );
      }

      const derivationIndex = this.nextDerivationIndex++;
      const payTo = allocator.deriveAddress(derivationIndex);

      if (this.payToToInvoice.has(payTo)) {
        throw new InvoiceStoreError(
          "PAY_TO_ALREADY_USED",
          `Payment address ${payTo} has already been allocated to invoice ${this.payToToInvoice.get(payTo)}`,
        );
      }

      const invoice: Invoice = invoiceSchema.parse({
        x402Version: X402_VERSION,
        scheme: params.scheme ?? XEC_SCHEME,
        network: params.network ?? XEC_MAINNET,
        resourceHash: params.resourceHash,
        amountSats: params.amountSats.toString(10),
        payTo,
        nonce: params.nonce,
        issuedAt: params.issuedAt,
        expiresAt: params.expiresAt,
      });

      const invoiceHash = computeInvoiceHash(invoice);

      if (this.records.has(invoiceHash)) {
        throw new InvoiceStoreError(
          "INVOICE_ALREADY_EXISTS",
          `Invoice ${invoiceHash} has already been issued`,
        );
      }

      const record: AuthoritativeInvoiceRecord = {
        invoiceHash,
        nonce: invoice.nonce,
        resourceHash: invoice.resourceHash,
        amountSats: params.amountSats,
        payTo,
        network: params.network ?? XEC_MAINNET,
        scheme: params.scheme ?? XEC_SCHEME,
        issuedAt: invoice.issuedAt,
        expiresAt: invoice.expiresAt,
        state: params.state ?? "ISSUED",
        derivationIndex,
      };

      this.records.set(invoiceHash, record);
      this.nonceToInvoice.set(record.nonce, invoiceHash);
      this.payToToInvoice.set(payTo, invoiceHash);
      this.indexToInvoice.set(derivationIndex, invoiceHash);

      return { record, invoice };
    });
  }

  async getByInvoiceHash(invoiceHash: string): Promise<AuthoritativeInvoiceRecord | null> {
    return this.withLock(() => {
      const existing = this.records.get(invoiceHash);
      return existing ? { ...existing } : null;
    });
  }

  async getBySettledTxid(txid: string): Promise<AuthoritativeInvoiceRecord | null> {
    return this.withLock(() => {
      const invoiceHash = this.txidToInvoice.get(txid.toLowerCase());
      if (!invoiceHash) return null;
      const existing = this.records.get(invoiceHash);
      return existing ? { ...existing } : null;
    });
  }

  async getByPayTo(payTo: string): Promise<AuthoritativeInvoiceRecord | null> {
    return this.withLock(() => {
      const invoiceHash = this.payToToInvoice.get(payTo);
      if (!invoiceHash) return null;
      const existing = this.records.get(invoiceHash);
      return existing ? { ...existing } : null;
    });
  }

  async getNextDerivationIndex(): Promise<number> {
    return this.withLock(() => {
      return this.nextDerivationIndex;
    });
  }

  async commitPaid(
    invoiceHash: string,
    txid: string,
    paidAt: number,
  ): Promise<CommitPaidResult> {
    return this.withLock(() => {
      const lowerTxid = txid.toLowerCase();
      const existing = this.records.get(invoiceHash);

      if (!existing) {
        return {
          ok: false,
          code: "INVOICE_NOT_FOUND",
          message: `Invoice ${invoiceHash} was not issued by this server`,
        };
      }

      // Check if txid was already bound to ANY OTHER invoice
      const boundTo = this.txidToInvoice.get(lowerTxid);
      if (boundTo !== undefined && boundTo !== invoiceHash) {
        return {
          ok: false,
          code: "TXID_REUSED",
          message: `Transaction ${lowerTxid} has already been used to settle invoice ${boundTo}`,
        };
      }

      // Check if this invoice is already PAID
      if (existing.state === "PAID") {
        if (existing.settledTxid === lowerTxid) {
          // Idempotent retry with the exact same (invoiceHash, txid)
          return {
            ok: true,
            idempotent: true,
            record: { ...existing },
          };
        }
        // Conflict: invoice was already paid with a DIFFERENT txid
        return {
          ok: false,
          code: "CONFLICT",
          message: `Invoice ${invoiceHash} was already settled by transaction ${existing.settledTxid}`,
        };
      }

      // Transition to PAID
      const updated: AuthoritativeInvoiceRecord = {
        ...existing,
        state: "PAID",
        settledTxid: lowerTxid,
        settledAt: paidAt,
      };

      this.records.set(invoiceHash, updated);
      this.txidToInvoice.set(lowerTxid, invoiceHash);

      return {
        ok: true,
        idempotent: false,
        record: { ...updated },
      };
    });
  }
}
