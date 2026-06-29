import assert from "node:assert/strict";
import test from "node:test";
import {
  createInvoice,
  type Invoice,
  type ResourceRequest,
} from "@x402-xec/core";
import {
  Address,
  ALL_BIP143,
  Ecc,
  P2PKHSignatory,
  Tx,
  shaRmd160,
} from "ecash-lib";
import {
  InsufficientFundsError,
  buildFundingTx,
  type BuildFundingTxRequest,
  type FundingUtxo,
} from "../src/index.js";

const SECRET_KEY = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]);
const PUBLIC_KEY = new Ecc().derivePubkey(SECRET_KEY);
const SOURCE_ADDRESS = Address.p2pkh(shaRmd160(PUBLIC_KEY)).toString();
const PAY_TO = Address.p2pkh("11".repeat(20)).toString();
const SOURCE_SCRIPT = Address.fromCashAddress(SOURCE_ADDRESS).toScriptHex();
const PAY_TO_SCRIPT = Address.fromCashAddress(PAY_TO).toScriptHex();
const REQUEST: ResourceRequest = {
  serverOrigin: "https://example.test",
  method: "GET",
  path: "/resource",
  query: [],
  body: null,
};

function invoice(amountSats = 1_000n): Invoice {
  return createInvoice({
    request: REQUEST,
    amountSats,
    payTo: PAY_TO,
    nonce: "MDEyMzQ1Njc4OWFiY2RlZg",
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_060,
  });
}

function utxo(sats: string, overrides: Partial<FundingUtxo> = {}): FundingUtxo {
  return {
    txid: "22".repeat(32),
    outIdx: 1,
    sats,
    outputScript: SOURCE_SCRIPT,
    ...overrides,
  };
}

function request(
  sats: string,
  overrides: Partial<BuildFundingTxRequest> = {},
): BuildFundingTxRequest {
  return {
    invoice: invoice(),
    utxos: [utxo(sats)],
    changeAddress: SOURCE_ADDRESS,
    signatoryForUtxo: () => P2PKHSignatory(SECRET_KEY, PUBLIC_KEY, ALL_BIP143),
    ...overrides,
  };
}

test("builds a deterministic valid funding transaction offline", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;

  try {
    const result = buildFundingTx(request("10000"));
    const tx = Tx.fromHex(result.rawTx);

    assert.equal(tx.toHex(), result.rawTx);
    assert.equal(tx.txid(), result.txid);
    assert.match(result.rawTx, /^[0-9a-f]+$/);
    assert.match(result.txid, /^[0-9a-f]{64}$/);
    assert.equal(result.selectedInputs.length, 1);
    assert.deepEqual(result.fundingOutpoint, { txid: result.txid, outIdx: 0 });
    assert.deepEqual(result.fundingOutput, {
      outIdx: 0,
      amountSats: "1000",
      outputScript: PAY_TO_SCRIPT,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pays invoice.payTo exactly invoice.amountSats", () => {
  const tx = Tx.fromHex(buildFundingTx(request("10000")).rawTx);

  assert.equal(tx.outputs[0]?.script.toHex(), PAY_TO_SCRIPT);
  assert.equal(tx.outputs[0]?.sats, 1_000n);
});

test("rejects insufficient funds", () => {
  assert.throws(
    () => buildFundingTx(request("1100")),
    (error: unknown) => error instanceof InsufficientFundsError
      && error.code === "INSUFFICIENT_FUNDS",
  );
});

test("rejects token-bearing UTXOs", () => {
  assert.throws(
    () => buildFundingTx(request("10000", {
      utxos: [utxo("10000", {
        token: {
          tokenId: "33".repeat(32),
          atoms: 1n,
          isMintBaton: false,
        },
      })],
    })),
    /Token-bearing UTXOs/,
  );
});

test("computes fee and change deterministically", () => {
  const first = buildFundingTx(request("10000"));
  const second = buildFundingTx(request("10000"));

  assert.equal(first.feeSats, "219");
  assert.equal(first.changeSats, "8781");
  assert.equal(first.rawTx, second.rawTx);
  assert.equal(BigInt(first.feeSats) + BigInt(first.changeSats) + 1_000n, 10_000n);

  const tx = Tx.fromHex(first.rawTx);
  assert.equal(tx.outputs.length, 2);
  assert.equal(tx.outputs[1]?.sats, 8_781n);
  assert.equal(tx.outputs[1]?.script.toHex(), SOURCE_SCRIPT);
});

test("omits dust change and folds it into the fee", () => {
  const result = buildFundingTx(request("1600"));
  const tx = Tx.fromHex(result.rawTx);

  assert.equal(tx.outputs.length, 1);
  assert.equal(result.changeSats, "0");
  assert.equal(result.feeSats, "600");
});

test("selects inputs in deterministic request order", () => {
  const first = utxo("1100");
  const second = utxo("1000", { txid: "44".repeat(32), outIdx: 0 });
  const result = buildFundingTx(request("1100", { utxos: [first, second] }));

  assert.deepEqual(result.selectedInputs, [first, second]);
  assert.equal(Tx.fromHex(result.rawTx).inputs.length, 2);
});

test("exports no network or broadcast operation", async () => {
  const exports = await import("../src/index.js");
  assert.equal("broadcast" in exports, false);
  assert.equal("broadcastTx" in exports, false);
  assert.equal("chronik" in exports, false);
});
