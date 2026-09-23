import assert from "node:assert/strict";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  computeInvoiceHash,
  createInvoice,
  InMemoryAuthoritativeInvoiceStore,
  verifySettlementProof,
  type ChronikTransactionOutput,
} from "../src/index.js";

const PAY_TO = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const OUTPUTS: readonly ChronikTransactionOutput[] = [{
  sats: 1000n,
  outputScript: cashAddressToOutputScriptHex(PAY_TO),
}];
const TXID = "11".repeat(32);
const BLOCK = {
  height: 800_000,
  hash: "ab".repeat(32),
  timestamp: 1_050,
} as const;
let nonceCounter = 0;

async function setupInvoice() {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const invoice = createInvoice({
    request: { serverOrigin: "https://api.example.com", method: "GET", path: "/resource" },
    amountSats: 1000n,
    payTo: PAY_TO,
    nonce: `pass_2_4_nonce_${String(++nonceCounter).padStart(16, "0")}`,
    issuedAt: 1_000,
    expiresAt: 2_000,
  });
  const invoiceHash = computeInvoiceHash(invoice);
  await store.issue({
    invoiceHash,
    nonce: invoice.nonce,
    resourceHash: invoice.resourceHash,
    amountSats: 1000n,
    payTo: PAY_TO,
    network: "xec:mainnet",
    scheme: "exact",
    issuedAt: 1_000,
    expiresAt: 2_000,
    state: "ISSUED",
  });
  return { store, invoiceHash };
}

function proof(invoiceHash: string) {
  return { x402Version: 1, network: "xec:mainnet", invoiceHash, txid: TXID };
}

async function assertIssued(
  store: InMemoryAuthoritativeInvoiceStore,
  invoiceHash: string,
) {
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid, undefined);
}

test("4054156682: missing or undefined timeFirstSeen is malformed and cannot mutate state", async () => {
  for (const tx of [
    { txid: TXID, outputs: OUTPUTS, isFinal: false, block: BLOCK },
    { txid: TXID, outputs: OUTPUTS, isFinal: false, block: BLOCK, timeFirstSeen: undefined },
  ]) {
    const { store, invoiceHash } = await setupInvoice();
    const result = await verifySettlementProof({
      proof: proof(invoiceHash),
      store,
      txProvider: { getTx: async () => tx as any },
      now: () => 1_100,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MALFORMED_CHRONIK_TX");
    assert.equal(result.httpStatus, 502);
    await assertIssued(store, invoiceHash);
  }
});

test("4054156682: only explicit zero permits block fallback; final-without-block stays unknown", async () => {
  const confirmed = await setupInvoice();
  const fallback = await verifySettlementProof({
    proof: proof(confirmed.invoiceHash),
    store: confirmed.store,
    txProvider: {
      getTx: async () => ({
        txid: TXID,
        outputs: OUTPUTS,
        isFinal: false,
        block: BLOCK,
        timeFirstSeen: 0,
      }),
    },
    now: () => 1_100,
  });
  assert.equal(fallback.ok, true);

  const avalanche = await setupInvoice();
  const unknown = await verifySettlementProof({
    proof: proof(avalanche.invoiceHash),
    store: avalanche.store,
    txProvider: {
      getTx: async () => ({
        txid: TXID,
        outputs: OUTPUTS,
        isFinal: true,
        timeFirstSeen: 0,
      }),
    },
    now: () => 1_100,
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "TRANSACTION_TIME_UNKNOWN");
  assert.equal(unknown.httpStatus, 502);
  await assertIssued(avalanche.store, avalanche.invoiceHash);
});

test("4054156685: invalid server clocks fail before expiry, Chronik, or mutation", async () => {
  const invalidTimes = [
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];

  for (const invalidTime of invalidTimes) {
    const { store, invoiceHash } = await setupInvoice();
    let chronikCalls = 0;
    const result = await verifySettlementProof({
      proof: proof(invoiceHash),
      store,
      txProvider: {
        getTx: async () => {
          chronikCalls += 1;
          return {
            txid: TXID,
            outputs: OUTPUTS,
            isFinal: true,
            timeFirstSeen: 1_050,
          };
        },
      },
      now: () => invalidTime,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_SERVER_TIME");
    assert.equal(result.httpStatus, 500);
    assert.equal(chronikCalls, 0);
    await assertIssued(store, invoiceHash);
  }
});
