/**
 * @file temporal-fencing.test.ts
 *
 * Deterministic tests for Gate C3B Server-Authoritative Temporal Fencing (P1-3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  createInvoice,
  computeInvoiceHash,
  createXpubPayToAllocator,
  InMemoryAuthoritativeInvoiceStore,
  TEMPORAL_FENCE_TOLERANCE_SECONDS,
  verifySettlementProof,
  type ChronikTransaction,
  type ChronikTransactionOutput,
} from "../src/index.js";

const VALID_ADDR = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const VALID_SCRIPT = cashAddressToOutputScriptHex(VALID_ADDR);
const VALID_HASH_64 = "ab".repeat(32);
const TXID_1 = "44".repeat(32);

const ISSUED_AT = 1_000;
const EXPIRES_AT = 2_000;
const NOW = 1_500;

const standardOutputs: readonly ChronikTransactionOutput[] = [
  { sats: 500n, outputScript: VALID_SCRIPT },
];

let nonceCounter = 1;

async function setupTestContext() {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const nonceStr = `nonce_${String(nonceCounter++).padStart(6, "0")}_12345678901234567890`;
  const invoice = createInvoice({
    request: { serverOrigin: "https://api.example.com", method: "GET", path: "/resource" },
    amountSats: 500n,
    payTo: VALID_ADDR,
    nonce: nonceStr,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  const invoiceHash = computeInvoiceHash(invoice);
  await store.issue({
    invoiceHash,
    nonce: invoice.nonce,
    resourceHash: invoice.resourceHash,
    amountSats: 500n,
    payTo: VALID_ADDR,
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    state: "ISSUED",
  });

  return { store, invoiceHash, invoice };
}

test("P1-3: 1. timeFirstSeen before issuedAt beyond tolerance returns HISTORICAL_TRANSACTION (HTTP 402) and commits no PAID", async () => {
  const { store, invoiceHash } = await setupTestContext();

  // Tolerance is 10s. ISSUED_AT - 10 = 990. 989 is beyond tolerance.
  const historicalTime = ISSUED_AT - TEMPORAL_FENCE_TOLERANCE_SECONDS - 1;

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: true,
    timeFirstSeen: historicalTime,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, "HISTORICAL_TRANSACTION");
  assert.equal(res.httpStatus, 402);

  // Authoritative state MUST remain ISSUED (no PAID mutation)
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid ?? null, null);
});

test("P1-3: 2. timeFirstSeen exactly at issuedAt (and within tolerance) is accepted", async () => {
  const { store, invoiceHash } = await setupTestContext();

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: true,
    timeFirstSeen: ISSUED_AT,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, "UNLOCKED");

  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "PAID");
  assert.equal(record?.settledTxid, TXID_1);
});

test("P1-3: 3. timeFirstSeen after issuedAt is accepted", async () => {
  const { store, invoiceHash } = await setupTestContext();

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: true,
    timeFirstSeen: ISSUED_AT + 50,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, "UNLOCKED");
});

test("P1-3: 4. confirmed tx with valid nonzero timeFirstSeen uses timeFirstSeen, not block.timestamp", async () => {
  const { store, invoiceHash } = await setupTestContext();

  // timeFirstSeen is historical (before issuance), but block timestamp is modern (after issuance)
  const historicalTime = ISSUED_AT - TEMPORAL_FENCE_TOLERANCE_SECONDS - 5;
  const modernBlockTime = ISSUED_AT + 100;

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: false,
    block: {
      height: 800_000,
      hash: VALID_HASH_64,
      timestamp: modernBlockTime,
    },
    timeFirstSeen: historicalTime,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  // Because timeFirstSeen is primary, it must be rejected even though block.timestamp was modern!
  assert.equal(res.ok, false);
  assert.equal(res.code, "HISTORICAL_TRANSACTION");
  assert.equal(res.httpStatus, 402);
});

test("P1-3: 5. timeFirstSeen = 0 with valid confirmed block after issuance falls back and succeeds", async () => {
  const { store, invoiceHash } = await setupTestContext();

  const modernBlockTime = ISSUED_AT + 20;

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: false,
    block: {
      height: 800_000,
      hash: VALID_HASH_64,
      timestamp: modernBlockTime,
    },
    timeFirstSeen: 0, // Chronik saw no mempool entry
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, "UNLOCKED");
});

test("P1-3: 6. timeFirstSeen = 0 with confirmed block before issuance beyond tolerance returns HISTORICAL_TRANSACTION", async () => {
  const { store, invoiceHash } = await setupTestContext();

  const historicalBlockTime = ISSUED_AT - TEMPORAL_FENCE_TOLERANCE_SECONDS - 1;

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: false,
    block: {
      height: 800_000,
      hash: VALID_HASH_64,
      timestamp: historicalBlockTime,
    },
    timeFirstSeen: 0,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, "HISTORICAL_TRANSACTION");
  assert.equal(res.httpStatus, 402);
});

test("P1-3: 7. timeFirstSeen = 0 with no block, even if Avalanche-final, fails closed with TRANSACTION_TIME_UNKNOWN (HTTP 502)", async () => {
  const { store, invoiceHash } = await setupTestContext();

  const tx: ChronikTransaction = {
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: true,
    timeFirstSeen: 0,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider: { getTx: async () => tx },
    now: () => NOW,
  });

  assert.equal(res.ok, false);
  assert.equal(res.code, "TRANSACTION_TIME_UNKNOWN");
  assert.equal(res.httpStatus, 502);

  // Authoritative state must NOT be committed to PAID
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid ?? null, null);
});

test("P1-3: 8. malformed timeFirstSeen returns MALFORMED_CHRONIK_TX (HTTP 502)", async () => {
  const malformedValues = [
    -1, // negative
    -500,
    1.5, // float
    100.25,
    "1234", // string
    "abc",
    null, // null
    {}, // object
    [], // array
    Number.MAX_SAFE_INTEGER + 10, // unsafe integer
    NaN,
    Infinity,
  ];

  for (const badValue of malformedValues) {
    const { store, invoiceHash } = await setupTestContext();
    const tx = {
      txid: TXID_1,
      outputs: standardOutputs,
      isFinal: true,
      timeFirstSeen: badValue,
    };

    const res = await verifySettlementProof({
      proof: {
        x402Version: 1,
        network: "xec:mainnet",
        invoiceHash,
        txid: TXID_1,
      },
      store,
      txProvider: { getTx: async () => tx as any },
      now: () => NOW,
    });

    assert.equal(
      res.ok,
      false,
      `Expected badValue ${JSON.stringify(badValue)} to fail`,
    );
    assert.equal(res.code, "MALFORMED_CHRONIK_TX");
    assert.equal(res.httpStatus, 502);

    const record = await store.getByInvoiceHash(invoiceHash);
    assert.equal(record?.state, "ISSUED");
  }
});

test("P1-3: 9. historical tx to derivation child reused after simulated DB recovery cannot settle new invoice", async () => {
  const TEST_XPUB =
    "xpub661MyMwAqRbcEtUEgdXRTY6dJQG9fRgs7C5QomqETKMYBJVtSGpRqyHSmhWy8snovPd5oWZgQ14zUquxbxu7Z1umuXbN5VDpUL1QobD5xUY";
  const allocator = createXpubPayToAllocator(TEST_XPUB);

  // Child 0 address
  const childAddress = allocator.deriveAddress(0);
  const childScript = cashAddressToOutputScriptHex(childAddress);

  // Simulated DB 1: issued and paid child 0 in the past
  const pastIssuedAt = 500;
  const pastTxid = "77".repeat(32);

  // An attacker possesses a past on-chain tx that paid child 0 at timestamp 520
  const attackerTx: ChronikTransaction = {
    txid: pastTxid,
    outputs: [{ sats: 500n, outputScript: childScript }],
    isFinal: true,
    timeFirstSeen: 520,
  };

  // Simulated DB Recovery: New store starts fresh, derivation restarts at child 0!
  const freshRecoveredStore = new InMemoryAuthoritativeInvoiceStore();

  const freshAllocation = await freshRecoveredStore.issueWithAllocation(
    {
      nonce: "fresh_recovery_nonce_12345",
      resourceHash: "99".repeat(32),
      amountSats: 500n,
      issuedAt: 2_000, // issued at t=2000
      expiresAt: 3_000,
    },
    allocator,
  );

  assert.equal(freshAllocation.record.derivationIndex, 0);
  assert.equal(freshAllocation.record.payTo, childAddress);

  // Attacker submits their past tx (from t=520) against the new invoice (issued at t=2000)
  const attackRes = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: freshAllocation.record.invoiceHash,
      txid: pastTxid,
    },
    store: freshRecoveredStore,
    txProvider: { getTx: async () => attackerTx },
    now: () => 2_100,
  });

  // Despite matching payTo and amount, it MUST be rejected by temporal fence
  assert.equal(attackRes.ok, false);
  assert.equal(attackRes.code, "HISTORICAL_TRANSACTION");
  assert.equal(attackRes.httpStatus, 402);

  // State in recovered store must still be ISSUED
  const currentRecord = await freshRecoveredStore.getByInvoiceHash(
    freshAllocation.record.invoiceHash,
  );
  assert.equal(currentRecord?.state, "ISSUED");
  assert.equal(currentRecord?.settledTxid ?? null, null);
});
