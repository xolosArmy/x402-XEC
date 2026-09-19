import assert from "node:assert/strict";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  createSettlementProof,
  createSettlementProofFromReceipt,
  InMemoryAuthoritativeInvoiceStore,
  InvoiceStoreError,
  x402SettlementProofV1Schema,
  X402_VERSION,
  XEC_MAINNET,
  type AuthoritativeInvoiceRecord,
} from "../src/index.js";

test("cashAddressToOutputScriptHex converts standard P2PKH cashaddr to script", () => {
  // P2PKH address with 20 bytes of 0x11
  const p2pkhAddr = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
  const script = cashAddressToOutputScriptHex(p2pkhAddr);
  assert.equal(script, "76a914111111111111111111111111111111111111111188ac");
});

test("cashAddressToOutputScriptHex rejects invalid checksum when ignoreChecksum is false", () => {
  assert.throws(
    () => cashAddressToOutputScriptHex("ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5"),
    /Invalid CashAddr checksum/,
  );
});

test("createSettlementProof parses and validates correctly", () => {
  const proof = createSettlementProof({
    invoiceHash: "aa".repeat(32),
    txid: "bb".repeat(32),
  });
  assert.equal(proof.x402Version, 1);
  assert.equal(proof.network, "xec:mainnet");
  assert.equal(proof.invoiceHash, "aa".repeat(32));
  assert.equal(proof.txid, "bb".repeat(32));
});

test("createSettlementProofFromReceipt extracts txid safely from receipt", () => {
  const receipt = {
    status: "settled" as const,
    network: "xec:mainnet" as const,
    executionId: "exec_123",
    approvalId: "appr_456",
    txid: "cc".repeat(32),
    settledAt: 1800000050,
  };
  const proof = createSettlementProofFromReceipt(receipt, "dd".repeat(32));
  assert.equal(proof.txid, "cc".repeat(32));
  assert.equal(proof.invoiceHash, "dd".repeat(32));
  assert.equal(proof.network, "xec:mainnet");
});

test("InMemoryAuthoritativeInvoiceStore enforces nonce uniqueness", async () => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const rec1: AuthoritativeInvoiceRecord = {
    invoiceHash: "11".repeat(32),
    nonce: "duplicate_nonce_1234567890",
    resourceHash: "22".repeat(32),
    amountSats: 1000n,
    payTo: "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w",
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: 1000,
    expiresAt: 1060,
    state: "ISSUED",
  };
  await store.issue(rec1);

  const rec2: AuthoritativeInvoiceRecord = {
    ...rec1,
    invoiceHash: "33".repeat(32), // different hash
  };

  await assert.rejects(
    () => store.issue(rec2),
    (err: any) => err instanceof InvoiceStoreError && err.code === "NONCE_ALREADY_USED",
  );
});

test("InMemoryAuthoritativeInvoiceStore commitPaid handles transitions and conflicts", async () => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const invoiceHash = "aa".repeat(32);
  const txid1 = "11".repeat(32);
  const txid2 = "22".repeat(32);

  await store.issue({
    invoiceHash,
    nonce: "unique_nonce_111111111111",
    resourceHash: "ff".repeat(32),
    amountSats: 5000n,
    payTo: "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w",
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: 1000,
    expiresAt: 1060,
    state: "ISSUED",
  });

  // First commit -> success
  const res1 = await store.commitPaid(invoiceHash, txid1, 1030);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.idempotent, false);
    assert.equal(res1.record.state, "PAID");
    assert.equal(res1.record.settledTxid, txid1);
  }

  // Idempotent retry with same txid -> success with idempotent: true
  const resRetry = await store.commitPaid(invoiceHash, txid1, 1035);
  assert.equal(resRetry.ok, true);
  if (resRetry.ok) {
    assert.equal(resRetry.idempotent, true);
  }

  // Conflict with different txid -> fails
  const resConflict = await store.commitPaid(invoiceHash, txid2, 1040);
  assert.equal(resConflict.ok, false);
  if (!resConflict.ok) {
    assert.equal(resConflict.code, "CONFLICT");
  }

  // Look up by txid
  const byTxid = await store.getBySettledTxid(txid1);
  assert.equal(byTxid?.invoiceHash, invoiceHash);
});

test("verifySettlementProof rejects unconfirmed non-final transactions", async () => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const invoiceHash = "bb".repeat(32);
  const txid = "44".repeat(32);

  await store.issue({
    invoiceHash,
    nonce: "unique_nonce_222222222222",
    resourceHash: "11".repeat(32),
    amountSats: 1000n,
    payTo: "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w",
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: 1000,
    expiresAt: 1060,
    state: "ISSUED",
  });

  const { verifySettlementProof } = await import("../src/settlement-verifier.js");

  const unconfirmedNonFinalTx = {
    txid,
    outputs: [
      {
        sats: 1000n,
        outputScript: "76a914111111111111111111111111111111111111111188ac",
      },
    ],
    isFinal: false,
    timeFirstSeen: 1_020,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid,
    },
    store,
    txProvider: {
      getTx: async () => unconfirmedNonFinalTx as any,
    },
    now: () => 1020,
  });

  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "TRANSACTION_NOT_FINAL");
    assert.equal(res.httpStatus, 402);
  }

  // Authoritative state must still be ISSUED
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
});

test("Pass 2.3 P1-1: direct verifySettlementProof fails closed on malformed checksum payTo before custom addressToScript can run", async () => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const invoiceHash = "cc".repeat(32);
  const txid = "55".repeat(32);
  const malformedPayTo = "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5"; // invalid checksum

  // Issue invoice with malformed checksum payTo
  await store.issue({
    invoiceHash,
    nonce: "test_nonce_malformed_payto",
    resourceHash: "11".repeat(32),
    amountSats: 1000n,
    payTo: malformedPayTo,
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: 1000,
    expiresAt: 2000,
    state: "ISSUED",
  });

  const { verifySettlementProof } = await import("../src/settlement-verifier.js");

  let customConverterCalled = false;
  const mockCustomConverter = (_addr: string) => {
    customConverterCalled = true;
    return "76a914111111111111111111111111111111111111111188ac";
  };

  const tx = {
    txid,
    outputs: [
      {
        sats: 1000n,
        outputScript: "76a914111111111111111111111111111111111111111188ac",
      },
    ],
    isFinal: true,
    timeFirstSeen: 1050,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid,
    },
    store,
    txProvider: {
      getTx: async () => tx as any,
    },
    addressToScript: mockCustomConverter,
    now: () => 1100,
  });

  // Must fail closed
  assert.equal(res.ok, false);
  assert.equal(res.code, "PAY_TO_MISMATCH");
  // Custom converter must NEVER have been called
  assert.equal(customConverterCalled, false);

  // Authoritative state must still be ISSUED: no commitPaid, no PAID mutation, no unlock
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid ?? null, null);
});

test("Pass 2.3 P1-2: direct verifySettlementProof executes custom converter only after canonical CashAddr validation succeeds", async () => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const invoiceHash = "dd".repeat(32);
  const txid = "66".repeat(32);
  const validPayTo = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";

  await store.issue({
    invoiceHash,
    nonce: "test_nonce_valid_payto",
    resourceHash: "22".repeat(32),
    amountSats: 1000n,
    payTo: validPayTo,
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: 1000,
    expiresAt: 2000,
    state: "ISSUED",
  });

  const { verifySettlementProof } = await import("../src/settlement-verifier.js");

  let customConverterCalled = false;
  let receivedAddress = "";
  const mockCustomConverter = (addr: string) => {
    customConverterCalled = true;
    receivedAddress = addr;
    return "76a914111111111111111111111111111111111111111188ac";
  };

  const tx = {
    txid,
    outputs: [
      {
        sats: 1000n,
        outputScript: "76a914111111111111111111111111111111111111111188ac",
      },
    ],
    isFinal: true,
    timeFirstSeen: 1050,
  };

  const res = await verifySettlementProof({
    proof: {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash,
      txid,
    },
    store,
    txProvider: {
      getTx: async () => tx as any,
    },
    addressToScript: mockCustomConverter,
    now: () => 1100,
  });

  assert.equal(customConverterCalled, true);
  assert.equal(receivedAddress, validPayTo);
  assert.equal(res.ok, true);
  assert.equal(res.status, "UNLOCKED");

  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "PAID");
  assert.equal(record?.settledTxid, txid);
});
