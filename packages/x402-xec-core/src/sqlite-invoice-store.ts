/**
 * @file sqlite-invoice-store.ts
 *
 * ACID SQLite Reference Adapter for Server-Authoritative Invoice State (Gate C3B P1-2 & Pass 2.1).
 *
 * Runtime Requirement:
 * This module requires Node >=22.13.0 (or Node >=22.5.0 with native `node:sqlite` DatabaseSync).
 * Exposed via explicit subpath `@x402-xec/core/sqlite`.
 *
 * Persistence & Concurrency Guarantees:
 * - Backed by native `node:sqlite` (`DatabaseSync`).
 * - WAL mode (`PRAGMA journal_mode = WAL`) and `PRAGMA busy_timeout = 5000` for crash-resilient concurrency.
 * - Real database transactions (`BEGIN IMMEDIATE`) serialize writes and prevent allocation races.
 * - Database-enforced UNIQUE constraints:
 *   - UNIQUE(invoice_hash)
 *   - UNIQUE(nonce)
 *   - UNIQUE(settled_txid) where settled_txid IS NOT NULL
 *   - UNIQUE(pay_to)
 *   - UNIQUE(derivation_index)
 *
 * Durability Scope:
 * - Single-host / single-filesystem durability: Safely shared across multiple local processes
 *   connecting to the same SQLite database file.
 * - SqliteAuthoritativeInvoiceStore requires an explicit persistent filesystem path and sets `isDurable = true`.
 * - In-memory SQLite databases (:memory:, memory URIs) are strictly prohibited for SqliteAuthoritativeInvoiceStore.
 * - Explicit test-only in-memory SQLite store is provided via InMemorySqliteAuthoritativeInvoiceStore
 *   which sets `isDurable = false` to guarantee production middleware will reject it.
 */

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeInvoiceHash } from "./invoice.js";
import {
  InvoiceStoreError,
  type AuthoritativeInvoiceRecord,
  type AuthoritativeInvoiceStore,
  type CommitPaidResult,
  type IssueWithAllocationParams,
  type IssueWithAllocationResult,
} from "./invoice-store.js";
import type { InvoicePayToAllocator } from "./pay-to-allocator.js";
import {
  invoiceSchema,
  type Invoice,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
} from "./schemas.js";

interface InvoiceRow {
  invoice_hash: string;
  nonce: string;
  resource_hash: string;
  amount_sats: string;
  pay_to: string;
  network: string;
  scheme: string;
  issued_at: number;
  expires_at: number;
  state: string;
  settled_txid: string | null;
  settled_at: number | null;
  derivation_index: number;
}

/**
 * Shared base implementation for SQLite-backed authoritative invoice stores.
 */
export abstract class BaseSqliteAuthoritativeInvoiceStore
  implements AuthoritativeInvoiceStore
{
  abstract readonly isDurable: boolean;
  protected readonly db: DatabaseSync;
  readonly databasePath: string;

  constructor(db: DatabaseSync, databasePath: string) {
    this.db = db;
    this.databasePath = databasePath;
    this.initDatabase();
  }

  protected initDatabase(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS invoices (
        invoice_hash TEXT PRIMARY KEY,
        nonce TEXT NOT NULL UNIQUE,
        resource_hash TEXT NOT NULL,
        amount_sats TEXT NOT NULL,
        pay_to TEXT NOT NULL UNIQUE,
        network TEXT NOT NULL,
        scheme TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,
        settled_txid TEXT,
        settled_at INTEGER,
        derivation_index INTEGER NOT NULL UNIQUE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_settled_txid
      ON invoices(settled_txid) WHERE settled_txid IS NOT NULL;
    `);
  }

  protected rowToRecord(row: InvoiceRow): AuthoritativeInvoiceRecord {
    return {
      invoiceHash: row.invoice_hash,
      nonce: row.nonce,
      resourceHash: row.resource_hash,
      amountSats: BigInt(row.amount_sats),
      payTo: row.pay_to,
      network: row.network as "xec:mainnet",
      scheme: row.scheme as "exact",
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
      state: row.state as any,
      derivationIndex: Number(row.derivation_index),
      ...(row.settled_txid !== null ? { settledTxid: row.settled_txid } : {}),
      ...(row.settled_at !== null ? { settledAt: Number(row.settled_at) } : {}),
    };
  }

  async issue(record: AuthoritativeInvoiceRecord): Promise<void> {
    const derivationIndex =
      record.derivationIndex ?? (await this.getNextDerivationIndex());

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO invoices (
            invoice_hash, nonce, resource_hash, amount_sats, pay_to,
            network, scheme, issued_at, expires_at, state, settled_txid, settled_at, derivation_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.invoiceHash,
          record.nonce,
          record.resourceHash,
          record.amountSats.toString(10),
          record.payTo,
          record.network,
          record.scheme,
          record.issuedAt,
          record.expiresAt,
          record.state,
          record.settledTxid ?? null,
          record.settledAt ?? null,
          derivationIndex,
        );

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        if (err.message.includes("nonce")) {
          throw new InvoiceStoreError(
            "NONCE_ALREADY_USED",
            `Nonce ${record.nonce} has already been used`,
          );
        }
        if (err.message.includes("pay_to")) {
          throw new InvoiceStoreError(
            "PAY_TO_ALREADY_USED",
            `Payment address ${record.payTo} has already been allocated`,
          );
        }
        if (err.message.includes("derivation_index")) {
          throw new InvoiceStoreError(
            "DERIVATION_INDEX_ALREADY_USED",
            `Derivation index ${derivationIndex} has already been allocated`,
          );
        }
        throw new InvoiceStoreError(
          "INVOICE_ALREADY_EXISTS",
          `Invoice ${record.invoiceHash} has already been issued: ${err.message}`,
        );
      }
      throw err;
    }
  }

  async issueWithAllocation(
    params: IssueWithAllocationParams,
    allocator: InvoicePayToAllocator,
  ): Promise<IssueWithAllocationResult> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1. Atomically query next unused derivation index inside the exclusive transaction
      const indexRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(derivation_index), -1) + 1 AS next_idx FROM invoices",
        )
        .get() as { next_idx: number | bigint };
      const derivationIndex = Number(indexRow.next_idx);

      // 2. Derive unique address
      const payTo = allocator.deriveAddress(derivationIndex);

      // 3. Construct canonical invoice and compute invoiceHash
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

      // 4. Persist in database enforcing all UNIQUE constraints
      this.db
        .prepare(
          `INSERT INTO invoices (
            invoice_hash, nonce, resource_hash, amount_sats, pay_to,
            network, scheme, issued_at, expires_at, state, derivation_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          invoiceHash,
          params.nonce,
          params.resourceHash,
          params.amountSats.toString(10),
          payTo,
          params.network ?? XEC_MAINNET,
          params.scheme ?? XEC_SCHEME,
          params.issuedAt,
          params.expiresAt,
          params.state ?? "ISSUED",
          derivationIndex,
        );

      this.db.exec("COMMIT");

      const record: AuthoritativeInvoiceRecord = {
        invoiceHash,
        nonce: params.nonce,
        resourceHash: params.resourceHash,
        amountSats: params.amountSats,
        payTo,
        network: params.network ?? XEC_MAINNET,
        scheme: params.scheme ?? XEC_SCHEME,
        issuedAt: params.issuedAt,
        expiresAt: params.expiresAt,
        state: params.state ?? "ISSUED",
        derivationIndex,
      };

      return { record, invoice };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      if (
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed")
      ) {
        if (err.message.includes("nonce")) {
          throw new InvoiceStoreError(
            "NONCE_ALREADY_USED",
            `Nonce ${params.nonce} has already been used`,
          );
        }
        if (err.message.includes("pay_to")) {
          throw new InvoiceStoreError(
            "PAY_TO_ALREADY_USED",
            `Payment address has already been allocated`,
          );
        }
        if (err.message.includes("derivation_index")) {
          throw new InvoiceStoreError(
            "DERIVATION_INDEX_ALREADY_USED",
            `Derivation index has already been allocated`,
          );
        }
        throw new InvoiceStoreError(
          "INVOICE_ALREADY_EXISTS",
          `Invoice has already been issued: ${err.message}`,
        );
      }
      throw err;
    }
  }

  async getByInvoiceHash(
    invoiceHash: string,
  ): Promise<AuthoritativeInvoiceRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM invoices WHERE invoice_hash = ?")
      .get(invoiceHash) as InvoiceRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getBySettledTxid(
    txid: string,
  ): Promise<AuthoritativeInvoiceRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM invoices WHERE settled_txid = ?")
      .get(txid.toLowerCase()) as InvoiceRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getByPayTo(payTo: string): Promise<AuthoritativeInvoiceRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM invoices WHERE pay_to = ?")
      .get(payTo) as InvoiceRow | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  async getNextDerivationIndex(): Promise<number> {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(derivation_index), -1) + 1 AS next_idx FROM invoices",
      )
      .get() as { next_idx: number | bigint };
    return Number(row.next_idx);
  }

  async commitPaid(
    invoiceHash: string,
    txid: string,
    paidAt: number,
  ): Promise<CommitPaidResult> {
    const lowerTxid = txid.toLowerCase();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // 1. Check if txid has settled ANY other invoice
      const txRow = this.db
        .prepare("SELECT invoice_hash FROM invoices WHERE settled_txid = ?")
        .get(lowerTxid) as { invoice_hash: string } | undefined;

      if (txRow && txRow.invoice_hash !== invoiceHash) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: "TXID_REUSED",
          message: `Transaction ${lowerTxid} has already been used to settle invoice ${txRow.invoice_hash}`,
        };
      }

      // 2. Fetch target invoice
      const row = this.db
        .prepare("SELECT * FROM invoices WHERE invoice_hash = ?")
        .get(invoiceHash) as InvoiceRow | undefined;

      if (!row) {
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: "INVOICE_NOT_FOUND",
          message: `Invoice ${invoiceHash} was not issued by this server`,
        };
      }

      const existing = this.rowToRecord(row);

      // 3. Check if already PAID
      if (existing.state === "PAID") {
        if (existing.settledTxid === lowerTxid) {
          this.db.exec("ROLLBACK");
          return {
            ok: true,
            idempotent: true,
            record: existing,
          };
        }
        this.db.exec("ROLLBACK");
        return {
          ok: false,
          code: "CONFLICT",
          message: `Invoice ${invoiceHash} was already settled by transaction ${existing.settledTxid}`,
        };
      }

      // 4. Update to PAID
      this.db
        .prepare(
          "UPDATE invoices SET state = 'PAID', settled_txid = ?, settled_at = ? WHERE invoice_hash = ?",
        )
        .run(lowerTxid, paidAt, invoiceHash);

      this.db.exec("COMMIT");

      const updated: AuthoritativeInvoiceRecord = {
        ...existing,
        state: "PAID",
        settledTxid: lowerTxid,
        settledAt: paidAt,
      };

      return {
        ok: true,
        idempotent: false,
        record: updated,
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {}
  }
}

/**
 * Production-grade durable SQLite authoritative invoice store.
 * Requires an explicit persistent filesystem path and positively verifies
 * that SQLite opens a genuine filesystem-backed file via PRAGMA database_list.
 * In-memory databases and URI schemes are strictly rejected to guarantee durability.
 */
export class SqliteAuthoritativeInvoiceStore extends BaseSqliteAuthoritativeInvoiceStore {
  readonly isDurable = true;

  constructor(databasePath: string) {
    if (typeof databasePath !== "string") {
      throw new TypeError(
        "SqliteAuthoritativeInvoiceStore requires an explicit persistent filesystem path (string).",
      );
    }
    const trimmed = databasePath.trim();
    if (trimmed.length === 0) {
      throw new TypeError(
        "SqliteAuthoritativeInvoiceStore requires a non-empty persistent filesystem path.",
      );
    }

    // 2. Reject SQLite URI-style filenames for the durable production class,
    // including any input beginning with: "file:"
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith("file:") ||
      lower === ":memory:" ||
      lower.includes(":memory:") ||
      lower.includes("mode=memory") ||
      lower.includes("vfs=memdb")
    ) {
      throw new TypeError(
        `Volatile or URI database path (${trimmed}) is prohibited for SqliteAuthoritativeInvoiceStore. ` +
          `Use InMemorySqliteAuthoritativeInvoiceStore for testing or provide a standard filesystem path.`,
      );
    }

    // 3. Resolve the requested filesystem path canonically before opening.
    const resolvedPath = path.resolve(trimmed);

    // 4. Open DatabaseSync.
    const db = new DatabaseSync(resolvedPath);

    // 5. Positive engine verification: query PRAGMA database_list;
    try {
      const dbList = db.prepare("PRAGMA database_list;").all() as Array<{
        seq?: number;
        name?: string;
        file?: string;
      }>;

      // 6. Find the row where: name === "main"
      const mainRow = dbList.find((row) => row && row.name === "main");

      // 7. Require:
      // - main row exists
      // - main.file is a non-empty string
      // - main.file resolves to an actual filesystem-backed path
      // - resolved main.file corresponds to the requested durable database path
      if (
        !mainRow ||
        typeof mainRow.file !== "string" ||
        mainRow.file.trim().length === 0
      ) {
        throw new TypeError(
          `SQLite failed durability verification: 'main' database file is empty or missing. Path: ${trimmed}`,
        );
      }

      const resolvedMainFile = path.resolve(mainRow.file);
      if (resolvedMainFile !== resolvedPath) {
        throw new TypeError(
          `SQLite opened file mismatch: expected '${resolvedPath}', got '${resolvedMainFile}'`,
        );
      }
    } catch (err) {
      // 8. If any verification fails:
      // - close the opened DB
      // - throw TypeError
      // - never expose the instance as usable durable authority
      try {
        db.close();
      } catch {}
      if (err instanceof TypeError) {
        throw err;
      }
      throw new TypeError(
        `Failed positive SQLite durability verification for '${trimmed}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    super(db, resolvedPath);
  }
}

/**
 * Explicit test-only in-memory SQLite store adapter.
 * Sets `readonly isDurable = false` so production middleware will fail closed if supplied.
 */
export class InMemorySqliteAuthoritativeInvoiceStore extends BaseSqliteAuthoritativeInvoiceStore {
  readonly isDurable = false;

  constructor() {
    super(new DatabaseSync(":memory:"), ":memory:");
  }
}
