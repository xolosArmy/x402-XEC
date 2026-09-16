/**
 * @file sqlite-invoice-store.test.ts
 *
 * ACID SQLite Durable Authoritative Store Verification (Gate C3B P1-2).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createInvoice,
  computeInvoiceHash,
  createXpubPayToAllocator,
  InMemoryAuthoritativeInvoiceStore,
  InvoiceStoreError,
} from "../src/index.js";
import {
  SqliteAuthoritativeInvoiceStore,
  InMemorySqliteAuthoritativeInvoiceStore,
} from "../src/sqlite-invoice-store.js";

// Standard mainnet test xpub (BIP32 watch-only public key)
const TEST_XPUB =
  "xpub661MyMwAqRbcEtUEgdXRTY6dJQG9fRgs7C5QomqETKMYBJVtSGpRqyHSmhWy8snovPd5oWZgQ14zUquxbxu7Z1umuXbN5VDpUL1QobD5xUY";

function createTempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-sqlite-test-"));
  return { dir, dbPath: path.join(dir, "invoices.sqlite") };
}

test("P1-2: 1. invoice survives closing and reopening the durable store", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const store1 = new SqliteAuthoritativeInvoiceStore(dbPath);
    assert.equal(store1.isDurable, true);

    const allocated = await store1.issueWithAllocation(
      {
        nonce: "test_nonce_survive_reopen_1",
        resourceHash: "11".repeat(32),
        amountSats: 2000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );
    assert.equal(allocated.record.derivationIndex, 0);

    // Close store 1
    store1.close();

    // Reopen as store 2
    const store2 = new SqliteAuthoritativeInvoiceStore(dbPath);
    const retrieved = await store2.getByInvoiceHash(allocated.record.invoiceHash);
    assert.notEqual(retrieved, null);
    assert.equal(retrieved?.invoiceHash, allocated.record.invoiceHash);
    assert.equal(retrieved?.nonce, "test_nonce_survive_reopen_1");
    assert.equal(retrieved?.amountSats, 2000n);
    assert.equal(retrieved?.payTo, allocated.record.payTo);
    assert.equal(retrieved?.state, "ISSUED");
    assert.equal(retrieved?.derivationIndex, 0);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 2. settled txid binding survives restart", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const store1 = new SqliteAuthoritativeInvoiceStore(dbPath);

    const allocated = await store1.issueWithAllocation(
      {
        nonce: "test_nonce_settled_survive_1",
        resourceHash: "22".repeat(32),
        amountSats: 1500n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );

    const txid = "ee".repeat(32);
    const commitRes = await store1.commitPaid(allocated.record.invoiceHash, txid, 1500);
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.record.state, "PAID");
    assert.equal(commitRes.record.settledTxid, txid);

    store1.close();

    // Reopen store 2
    const store2 = new SqliteAuthoritativeInvoiceStore(dbPath);
    const byTxid = await store2.getBySettledTxid(txid);
    assert.notEqual(byTxid, null);
    assert.equal(byTxid?.invoiceHash, allocated.record.invoiceHash);
    assert.equal(byTxid?.state, "PAID");
    assert.equal(byTxid?.settledTxid, txid);
    assert.equal(byTxid?.settledAt, 1500);

    // Idempotent commitPaid call on reopened store returns ok: true, idempotent: true
    const retryCommit = await store2.commitPaid(allocated.record.invoiceHash, txid, 1600);
    assert.equal(retryCommit.ok, true);
    assert.equal(retryCommit.idempotent, true);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 3. same txid cannot settle another invoice after restart", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const store1 = new SqliteAuthoritativeInvoiceStore(dbPath);

    const inv1 = await store1.issueWithAllocation(
      {
        nonce: "test_nonce_inv1_1234567890",
        resourceHash: "33".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );

    const sharedTxid = "ff".repeat(32);
    await store1.commitPaid(inv1.record.invoiceHash, sharedTxid, 1200);

    // Issue invoice 2
    const inv2 = await store1.issueWithAllocation(
      {
        nonce: "test_nonce_inv2_1234567890",
        resourceHash: "33".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );

    store1.close();

    // Reopen store 2
    const store2 = new SqliteAuthoritativeInvoiceStore(dbPath);
    const res = await store2.commitPaid(inv2.record.invoiceHash, sharedTxid, 1300);
    assert.equal(res.ok, false);
    assert.equal(res.code, "TXID_REUSED");

    const inv2After = await store2.getByInvoiceHash(inv2.record.invoiceHash);
    assert.equal(inv2After?.state, "ISSUED");
    assert.equal(inv2After?.settledTxid, undefined);
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 4. nonce uniqueness survives restart", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const store1 = new SqliteAuthoritativeInvoiceStore(dbPath);

    await store1.issueWithAllocation(
      {
        nonce: "reusable_nonce_candidate",
        resourceHash: "44".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );

    store1.close();

    const store2 = new SqliteAuthoritativeInvoiceStore(dbPath);
    await assert.rejects(
      async () => {
        await store2.issueWithAllocation(
          {
            nonce: "reusable_nonce_candidate", // Duplicate nonce
            resourceHash: "44".repeat(32),
            amountSats: 1000n,
            issuedAt: 1000,
            expiresAt: 2000,
          },
          allocator,
        );
      },
      (err: any) => err instanceof InvoiceStoreError && err.code === "NONCE_ALREADY_USED",
    );
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 5 & 6. payTo & derivationIndex uniqueness survives restart", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const store1 = new SqliteAuthoritativeInvoiceStore(dbPath);

    const inv1 = await store1.issueWithAllocation(
      {
        nonce: "test_nonce_idx_1_1234567890",
        resourceHash: "55".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );
    assert.equal(inv1.record.derivationIndex, 0);

    store1.close();

    const store2 = new SqliteAuthoritativeInvoiceStore(dbPath);
    // Next allocation must pick index 1
    const inv2 = await store2.issueWithAllocation(
      {
        nonce: "test_nonce_idx_2_1234567890",
        resourceHash: "55".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );
    assert.equal(inv2.record.derivationIndex, 1);
    assert.notEqual(inv1.record.payTo, inv2.record.payTo);

    // Manual attempt to insert row with duplicate derivation_index or pay_to throws
    await assert.rejects(
      async () => {
        await store2.issue({
          invoiceHash: "manual_hash_dup_index",
          nonce: "fresh_nonce_1234567890123",
          resourceHash: "55".repeat(32),
          amountSats: 1000n,
          payTo: allocator.deriveAddress(999),
          network: "xec:mainnet",
          scheme: "exact",
          issuedAt: 1000,
          expiresAt: 2000,
          state: "ISSUED",
          derivationIndex: 0, // Collision with inv1!
        });
      },
      (err: any) => err instanceof InvoiceStoreError && err.code === "DERIVATION_INDEX_ALREADY_USED",
    );

    await assert.rejects(
      async () => {
        await store2.issue({
          invoiceHash: "manual_hash_dup_payto",
          nonce: "fresh_nonce_4567890123456",
          resourceHash: "55".repeat(32),
          amountSats: 1000n,
          payTo: inv1.record.payTo, // Collision with inv1!
          network: "xec:mainnet",
          scheme: "exact",
          issuedAt: 1000,
          expiresAt: 2000,
          state: "ISSUED",
          derivationIndex: 999,
        });
      },
      (err: any) => err instanceof InvoiceStoreError && err.code === "PAY_TO_ALREADY_USED",
    );

    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 7. two store instances against same SQLite DB cannot allocate duplicate address/index", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const storeA = new SqliteAuthoritativeInvoiceStore(dbPath);
    const storeB = new SqliteAuthoritativeInvoiceStore(dbPath);

    // Issue concurrently across both store instances
    const [allocA, allocB] = await Promise.all([
      storeA.issueWithAllocation(
        {
          nonce: "concurrent_nonce_A_123456789",
          resourceHash: "66".repeat(32),
          amountSats: 1000n,
          issuedAt: 1000,
          expiresAt: 2000,
        },
        allocator,
      ),
      storeB.issueWithAllocation(
        {
          nonce: "concurrent_nonce_B_123456789",
          resourceHash: "66".repeat(32),
          amountSats: 1000n,
          issuedAt: 1000,
          expiresAt: 2000,
        },
        allocator,
      ),
    ]);

    assert.notEqual(allocA.record.derivationIndex, allocB.record.derivationIndex);
    assert.notEqual(allocA.record.payTo, allocB.record.payTo);
    assert.notEqual(allocA.record.invoiceHash, allocB.record.invoiceHash);

    const indices = [allocA.record.derivationIndex, allocB.record.derivationIndex].sort();
    assert.deepEqual(indices, [0, 1]);

    storeA.close();
    storeB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 8. failed transaction rolls back atomically", async () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const store = new SqliteAuthoritativeInvoiceStore(dbPath);

    await store.issueWithAllocation(
      {
        nonce: "existing_nonce_for_rollback_test",
        resourceHash: "77".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );
    assert.equal(await store.getNextDerivationIndex(), 1);

    // Attempt allocation with duplicate nonce -> fails and rolls back
    await assert.rejects(
      async () => {
        await store.issueWithAllocation(
          {
            nonce: "existing_nonce_for_rollback_test",
            resourceHash: "77".repeat(32),
            amountSats: 1000n,
            issuedAt: 1000,
            expiresAt: 2000,
          },
          allocator,
        );
      },
      (err: any) => err instanceof InvoiceStoreError && err.code === "NONCE_ALREADY_USED",
    );

    // Max derivation index must remain 1 (no index burned or orphaned)
    assert.equal(await store.getNextDerivationIndex(), 1);

    // Next successful allocation receives index 1
    const nextAlloc = await store.issueWithAllocation(
      {
        nonce: "clean_nonce_after_rollback",
        resourceHash: "77".repeat(32),
        amountSats: 1000n,
        issuedAt: 1000,
        expiresAt: 2000,
      },
      allocator,
    );
    assert.equal(nextAlloc.record.derivationIndex, 1);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-2: 9. InMemoryAuthoritativeInvoiceStore has isDurable: false", () => {
  const memStore = new InMemoryAuthoritativeInvoiceStore();
  assert.equal(memStore.isDurable, false);
});

test("Pass 2.1 Finding 1: durable SqliteAuthoritativeInvoiceStore constructor rejects missing or empty path", () => {
  assert.throws(
    () => new (SqliteAuthoritativeInvoiceStore as any)(),
    /SqliteAuthoritativeInvoiceStore requires an explicit persistent filesystem path/,
  );
  assert.throws(
    () => new SqliteAuthoritativeInvoiceStore(""),
    /SqliteAuthoritativeInvoiceStore requires a non-empty persistent filesystem path/,
  );
  assert.throws(
    () => new SqliteAuthoritativeInvoiceStore("   "),
    /SqliteAuthoritativeInvoiceStore requires a non-empty persistent filesystem path/,
  );
});

test("Pass 2.2 Finding P1-1: durable SqliteAuthoritativeInvoiceStore constructor strictly rejects :memory:, memory URIs, and any file: URI", () => {
  const rejectedPaths = [
    ":memory:",
    "file::memory:",
    "file:test.db?mode=memory",
    "file::memory:?cache=shared",
    "file:/ignored?vfs=memdb",
    "file:///tmp/database.sqlite",
    "file:relative.sqlite",
  ];

  for (const badPath of rejectedPaths) {
    assert.throws(
      () => new SqliteAuthoritativeInvoiceStore(badPath),
      (err: any) =>
        err instanceof TypeError &&
        /is prohibited for SqliteAuthoritativeInvoiceStore/.test(err.message),
      `Expected path '${badPath}' to be rejected by SqliteAuthoritativeInvoiceStore`,
    );
  }
});

test("Pass 2.2 Finding P1-1: durable SqliteAuthoritativeInvoiceStore positively verifies file-backed DB via PRAGMA database_list", () => {
  const { dir, dbPath } = createTempDbPath();
  try {
    const store = new SqliteAuthoritativeInvoiceStore(dbPath);
    assert.equal(store.isDurable, true);

    // Verify through the internal db that PRAGMA database_list has non-empty file matching dbPath
    const list = (store as any).db.prepare("PRAGMA database_list;").all();
    const mainRow = list.find((r: any) => r.name === "main");
    assert.ok(mainRow);
    assert.equal(typeof mainRow.file, "string");
    assert.ok(mainRow.file.length > 0);
    assert.equal(path.resolve(mainRow.file), path.resolve(dbPath));

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pass 2.1 Finding 1: InMemorySqliteAuthoritativeInvoiceStore is explicitly volatile with isDurable: false", async () => {
  const volatileStore = new InMemorySqliteAuthoritativeInvoiceStore();
  assert.equal(volatileStore.isDurable, false);

  const allocator = createXpubPayToAllocator(TEST_XPUB);
  const result = await volatileStore.issueWithAllocation(
    {
      nonce: "volatile_sqlite_test_nonce_12345",
      resourceHash: "88".repeat(32),
      amountSats: 500n,
      issuedAt: 1000,
      expiresAt: 2000,
    },
    allocator,
  );

  assert.equal(result.record.state, "ISSUED");
  const retrieved = await volatileStore.getByInvoiceHash(result.record.invoiceHash);
  assert.notEqual(retrieved, null);
  volatileStore.close();
});
