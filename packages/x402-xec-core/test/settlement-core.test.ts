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
