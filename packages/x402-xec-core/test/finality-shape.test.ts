/**
 * @file finality-shape.test.ts
 *
 * Strict Chronik finality shape validation & hostile vectors (Gate C3B P1-1).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  createInvoice,
  computeInvoiceHash,
  InMemoryAuthoritativeInvoiceStore,
  isValidChronikBlock,
  verifySettlementProof,
  type ChronikTransaction,
  type ChronikTransactionOutput,
} from "../src/index.js";

const VALID_ADDR = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const VALID_SCRIPT = cashAddressToOutputScriptHex(VALID_ADDR);
const VALID_HASH_64 = "ab".repeat(32);
const TXID_1 = "44".repeat(32);

test("P1-1: isValidChronikBlock strictly validates confirmed block metadata", () => {
  // Valid
  assert.equal(
    isValidChronikBlock({ height: 800_000, hash: VALID_HASH_64, timestamp: 1_700_000_000 }),
    true,
  );
  assert.equal(
    isValidChronikBlock({ height: 0, hash: VALID_HASH_64, timestamp: 0 }),
    true,
  );

  // Hostile / malformed
  assert.equal(isValidChronikBlock(null), false);
  assert.equal(isValidChronikBlock(undefined), false);
  assert.equal(isValidChronikBlock({}), false);
  assert.equal(isValidChronikBlock([]), false);
  assert.equal(isValidChronikBlock("string"), false);
  assert.equal(isValidChronikBlock(123), false);

  // Bad height
  assert.equal(isValidChronikBlock({ height: "800000", hash: VALID_HASH_64, timestamp: 100 }), false);
  assert.equal(isValidChronikBlock({ height: -1, hash: VALID_HASH_64, timestamp: 100 }), false);
  assert.equal(isValidChronikBlock({ height: 1.5, hash: VALID_HASH_64, timestamp: 100 }), false);
  assert.equal(isValidChronikBlock({ height: NaN, hash: VALID_HASH_64, timestamp: 100 }), false);
  assert.equal(isValidChronikBlock({ height: Infinity, hash: VALID_HASH_64, timestamp: 100 }), false);

  // Bad hash
  assert.equal(isValidChronikBlock({ height: 100, hash: "too_short", timestamp: 100 }), false);
  assert.equal(isValidChronikBlock({ height: 100, hash: VALID_HASH_64.toUpperCase(), timestamp: 100 }), false); // Non-lowercase
  assert.equal(isValidChronikBlock({ height: 100, hash: `${VALID_HASH_64}00`, timestamp: 100 }), false); // Too long
  assert.equal(isValidChronikBlock({ height: 100, hash: 12345, timestamp: 100 }), false);

  // Bad timestamp
  assert.equal(isValidChronikBlock({ height: 100, hash: VALID_HASH_64, timestamp: -1 }), false);
  assert.equal(isValidChronikBlock({ height: 100, hash: VALID_HASH_64, timestamp: 1.5 }), false);
  assert.equal(isValidChronikBlock({ height: 100, hash: VALID_HASH_64, timestamp: "2026" }), false);
});

async function runVerificationWithTx(tx: any) {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const invoice = createInvoice({
    request: { serverOrigin: "https://example.com", method: "GET", path: "/test" },
    amountSats: 500n,
    payTo: VALID_ADDR,
    nonce: "test_nonce_123456789012345",
    issuedAt: 1000,
    expiresAt: 2000,
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
    issuedAt: 1000,
    expiresAt: 2000,
    state: "ISSUED",
  });

  const txProvider = {
    getTx: async () => tx,
  };

  return verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid: TXID_1,
    },
    store,
    txProvider,
    now: () => 1500,
  });
}

const standardOutputs: readonly ChronikTransactionOutput[] = [
  { sats: 500n, outputScript: VALID_SCRIPT },
];

test("P1-1: rejects malformed confirmed block structure with MALFORMED_CHRONIK_TX", async () => {
  const malformedBlocks = [
    null,
    {},
    [],
    { height: "100", hash: VALID_HASH_64, timestamp: 100 },
    { height: -5, hash: VALID_HASH_64, timestamp: 100 },
    { height: 100, hash: "NOT_A_VALID_HASH", timestamp: 100 },
    { height: 100, hash: VALID_HASH_64, timestamp: -1 },
    { height: 100, hash: VALID_HASH_64, timestamp: "bad_ts" },
  ];

  for (const block of malformedBlocks) {
    const res = await runVerificationWithTx({
      txid: TXID_1,
      outputs: standardOutputs,
      block,
      isFinal: false,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "MALFORMED_CHRONIK_TX");
    assert.equal(res.httpStatus, 502);
  }
});

test("P1-1: rejects non-boolean isFinal with MALFORMED_CHRONIK_TX", async () => {
  const badIsFinalValues = ["true", "false", 1, 0, null, {}, []];

  for (const isFinal of badIsFinalValues) {
    const res = await runVerificationWithTx({
      txid: TXID_1,
      outputs: standardOutputs,
      isFinal,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "MALFORMED_CHRONIK_TX");
    assert.equal(res.httpStatus, 502);
  }
});

test("P1-1: unconfirmed transaction without isFinal: true returns TRANSACTION_NOT_FINAL", async () => {
  const notFinalCases = [
    { block: undefined, isFinal: false },
    { block: undefined, isFinal: undefined },
  ];

  for (const c of notFinalCases) {
    const res = await runVerificationWithTx({
      txid: TXID_1,
      outputs: standardOutputs,
      block: c.block,
      isFinal: c.isFinal,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "TRANSACTION_NOT_FINAL");
    assert.equal(res.httpStatus, 402);
  }
});

test("P1-1: accepts valid confirmed block even if isFinal is false", async () => {
  const res = await runVerificationWithTx({
    txid: TXID_1,
    outputs: standardOutputs,
    block: { height: 800_000, hash: VALID_HASH_64, timestamp: 1_700_000_000 },
    isFinal: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, "UNLOCKED");
});

test("P1-1: accepts valid Avalanche isFinal: true with timeFirstSeen even if block is undefined", async () => {
  const res = await runVerificationWithTx({
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: true,
    timeFirstSeen: 1200,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, "UNLOCKED");
});

test("P1-3: unconfirmed Avalanche isFinal: true with timeFirstSeen = 0 fails closed with TRANSACTION_TIME_UNKNOWN", async () => {
  const res = await runVerificationWithTx({
    txid: TXID_1,
    outputs: standardOutputs,
    isFinal: true,
    timeFirstSeen: 0,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "TRANSACTION_TIME_UNKNOWN");
  assert.equal(res.httpStatus, 502);
});
