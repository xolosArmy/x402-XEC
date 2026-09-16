/**
 * @file invoice-store.ts
 *
 * Server-authoritative invoice storage and ACID settlement proof state machine.
 */

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

export interface AuthoritativeInvoiceStore {
  /**
   * Persists a freshly issued authoritative invoice record.
   * Throws if nonce is already registered or invoiceHash already exists.
   */
  issue(record: AuthoritativeInvoiceRecord): Promise<void>;

  /**
   * Retrieves an invoice record by its canonical invoiceHash.
   */
  getByInvoiceHash(invoiceHash: string): Promise<AuthoritativeInvoiceRecord | null>;

  /**
   * Retrieves an invoice record by the txid that settled it.
   */
  getBySettledTxid(txid: string): Promise<AuthoritativeInvoiceRecord | null>;

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
 * In-memory reference implementation of AuthoritativeInvoiceStore with
 * serialized atomic mutations to guarantee multi-attempt and concurrency safety.
 */
export class InMemoryAuthoritativeInvoiceStore implements AuthoritativeInvoiceStore {
  private readonly records = new Map<string, AuthoritativeInvoiceRecord>();
  private readonly nonceToInvoice = new Map<string, string>();
  private readonly txidToInvoice = new Map<string, string>();

  // Async lock / queue to serialize concurrent state transitions
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

      this.records.set(record.invoiceHash, { ...record });
      this.nonceToInvoice.set(record.nonce, record.invoiceHash);
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
