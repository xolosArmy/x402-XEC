import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationSigningMessage,
  computeInvoiceHash,
  createInvoice,
  type Authorization,
  type Invoice,
  type ResourceRequest,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
} from "@x402-xec/core";
import {
  Facilitator,
  FixtureChronikTxProvider,
  MockSignatureVerifier,
  createMockSignature,
  type VerifyRequest,
} from "../src/index.js";

const NOW = 1_800_000_000;
const PAY_TO = `ecash:q${"a".repeat(41)}`;
const PAYER = `ecash:q${"b".repeat(41)}`;
const TXID = "c".repeat(64);
const resource: ResourceRequest = {
  serverOrigin: "https://api.example.com",
  method: "POST",
  path: "/v1/weather",
  query: [["city", "mexico-city"]],
  body: { forecastDays: 3 },
};

function makeFacilitator(fundingValueSats = 2_000n): Facilitator {
  return new Facilitator({
    txProvider: new FixtureChronikTxProvider([{
      txid: TXID,
      block: { height: 800_000, hash: "d".repeat(64), timestamp: NOW - 100 },
      isFinal: true,
      outputs: [{ sats: fundingValueSats, outputScript: "51" }],
    }]),
    signatureVerifier: new MockSignatureVerifier(),
    now: () => NOW,
  });
}

function makeInvoice(nonce = "MDEyMzQ1Njc4OWFiY2RlZg", amountSats = 1_000n): Invoice {
  return createInvoice({
    request: resource,
    amountSats,
    payTo: PAY_TO,
    nonce,
    issuedAt: NOW - 10,
    expiresAt: NOW + 60,
  });
}

function makeAuthorization(invoice: Invoice): Authorization {
  const unsigned = {
    x402Version: X402_VERSION,
    scheme: XEC_SCHEME,
    network: XEC_MAINNET,
    invoiceHash: computeInvoiceHash(invoice),
    resourceHash: invoice.resourceHash,
    amountSats: invoice.amountSats,
    payTo: invoice.payTo,
    nonce: invoice.nonce,
    payer: PAYER,
    transaction: { txid: TXID, vout: 0 },
  } as const;
  const placeholder: Authorization = { ...unsigned, signature: "placeholder" };
  return {
    ...unsigned,
    signature: createMockSignature(PAYER, authorizationSigningMessage(placeholder)),
  };
}

function request(
  invoice = makeInvoice(),
  idempotencyKey = "verify-1",
): VerifyRequest {
  return {
    invoice,
    authorization: makeAuthorization(invoice),
    resource,
    idempotencyKey,
  };
}

test("successful debit records the complete ledger entry", async () => {
  const facilitator = makeFacilitator();
  const input = request();

  const result = await facilitator.verify(input);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.ok && {
    debitedSats: result.body.debitedSats,
    remainingBalanceSats: result.body.remainingBalanceSats,
  }, { debitedSats: "1000", remainingBalanceSats: "1000" });
  const [entry] = facilitator.ledger.entries();
  assert.equal(entry?.fundingOutpoint.txid, TXID);
  assert.equal(entry?.fundingOutpoint.outIdx, 0);
  assert.equal(entry?.payer, PAYER);
  assert.equal(entry?.payTo, PAY_TO);
  assert.equal(entry?.fundingValueSats, 2_000n);
  assert.equal(entry?.remainingBalanceSats, 1_000n);
  assert.equal(entry?.debitedSats, 1_000n);
  assert.equal(entry?.invoiceId, computeInvoiceHash(input.invoice));
  assert.equal(entry?.nonce, input.invoice.nonce);
  assert.equal(entry?.idempotencyKey, input.idempotencyKey);
  assert.match(entry?.authorizationDigest ?? "", /^[0-9a-f]{64}$/);
});

test("insufficient balance rejects without a ledger debit", async () => {
  const facilitator = makeFacilitator(999n);
  const result = await facilitator.verify(request());

  assert.deepEqual(result, {
    status: 402,
    body: { ok: false, code: "INSUFFICIENT_CREDIT" },
  });
  assert.equal(facilitator.ledger.entries().length, 0);
});

test("reused nonce with a different idempotency key is rejected", async () => {
  const facilitator = makeFacilitator();
  const first = request();

  assert.equal((await facilitator.verify(first)).status, 200);
  assert.deepEqual(
    await facilitator.verify({ ...first, idempotencyKey: "verify-2" }),
    { status: 400, body: { ok: false, code: "NONCE_REUSED" } },
  );
  assert.equal(facilitator.ledger.entries().length, 1);
});

test("valid idempotent retry returns the exact stored response", async () => {
  const facilitator = makeFacilitator();
  const input = request();

  const first = await facilitator.verify(input);
  const retry = await facilitator.verify(input);

  assert.deepEqual(retry, first);
  assert.equal(facilitator.ledger.entries().length, 1);
});

test("concurrent requests cannot double debit a funding outpoint", async () => {
  const facilitator = makeFacilitator(1_000n);
  const first = request(makeInvoice("MDEyMzQ1Njc4OWFiY2RlZg"), "concurrent-1");
  const second = request(makeInvoice("YWJjZGVmZ2hpamtsbW5vcA"), "concurrent-2");

  const results = await Promise.all([
    facilitator.verify(first),
    facilitator.verify(second),
  ]);

  assert.equal(results.filter((result) => result.body.ok).length, 1);
  assert.equal(
    results.filter((result) => !result.body.ok && result.body.code === "INSUFFICIENT_CREDIT").length,
    1,
  );
  assert.equal(facilitator.ledger.entries().length, 1);
  assert.equal(facilitator.ledger.entries()[0]?.remainingBalanceSats, 0n);
});

test("core verification rejects resource, payTo, amount, and expiry mismatches", async () => {
  const cases: Array<[string, VerifyRequest, string]> = [];
  const valid = request();
  cases.push([
    "resource",
    { ...valid, resource: { ...resource, path: "/v1/other" } },
    "RESOURCE_MISMATCH",
  ]);

  const wrongPayToInvoice = makeInvoice("cGF5dG9taXNtYXRjaG5vbmNl");
  const wrongPayToAuthorization = makeAuthorization(wrongPayToInvoice);
  const changedPayTo = `ecash:q${"d".repeat(41)}`;
  const payToUnsigned = {
    ...wrongPayToAuthorization,
    payTo: changedPayTo,
    signature: "placeholder",
  };
  cases.push([
    "payTo",
    {
      invoice: wrongPayToInvoice,
      authorization: {
        ...payToUnsigned,
        signature: createMockSignature(PAYER, authorizationSigningMessage(payToUnsigned)),
      },
      resource,
      idempotencyKey: "wrong-pay-to",
    },
    "PAY_TO_MISMATCH",
  ]);

  const amountInvoice = makeInvoice("YW1vdW50bWlzbWF0Y2hub25jZQ");
  const amountAuthorization = makeAuthorization(amountInvoice);
  const changedAmount = { ...amountAuthorization, amountSats: "1001", signature: "placeholder" };
  cases.push([
    "amount",
    {
      invoice: amountInvoice,
      authorization: {
        ...changedAmount,
        signature: createMockSignature(PAYER, authorizationSigningMessage(changedAmount)),
      },
      resource,
      idempotencyKey: "wrong-amount",
    },
    "AMOUNT_MISMATCH",
  ]);

  const expired = {
    ...makeInvoice("ZXhwaXJlZGludm9pY2Vub25jZQ"),
    expiresAt: NOW,
  };
  cases.push([
    "expiry",
    {
      invoice: expired,
      authorization: makeAuthorization(expired),
      resource,
      idempotencyKey: "expired",
    },
    "EXPIRED",
  ]);

  for (const [name, input, code] of cases) {
    const result = await makeFacilitator().verify(input);
    assert.deepEqual(result.body, { ok: false, code }, name);
  }
});

test("missing provider transaction rejects without a ledger debit", async () => {
  const facilitator = new Facilitator({
    txProvider: new FixtureChronikTxProvider(),
    signatureVerifier: new MockSignatureVerifier(),
    now: () => NOW,
  });

  const result = await facilitator.verify(request());

  assert.deepEqual(result, {
    status: 402,
    body: { ok: false, code: "FUNDING_NOT_FOUND" },
  });
  assert.equal(facilitator.ledger.entries().length, 0);
});
