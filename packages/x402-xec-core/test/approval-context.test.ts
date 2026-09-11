import assert from "node:assert/strict";
import test from "node:test";
import {
  createInvoice,
  computeInvoiceHash,
  computeResourceHash,
  createX402ApprovalContext,
  validatePaymentRequired,
  validateEpochClock,
  x402ApprovalContextSchema,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
  type ResourceRequest,
} from "../src/index.js";

const FIXTURE_RESOURCE: ResourceRequest = {
  serverOrigin: "https://api.example.com",
  method: "POST",
  path: "/premium/weather",
};

const FIXTURE_RESOURCE_HASH = computeResourceHash(FIXTURE_RESOURCE);
const FIXTURE_PAY_TO = "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2";
const FIXTURE_NONCE = "b64url_nonce_sample_1234567890_val";
const SIMULATION_NOW = 1_800_000_000;
const SIMULATION_EXPIRES = 1_800_000_300;

function createTestInvoice(overrides: Record<string, unknown> = {}) {
  return createInvoice({
    request: FIXTURE_RESOURCE,
    amountSats: 50000n,
    payTo: FIXTURE_PAY_TO,
    nonce: FIXTURE_NONCE,
    issuedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES,
    ...overrides,
  });
}

test("validateEpochClock: accepts safe non-negative integer and rejects invalid numbers", () => {
  assert.equal(validateEpochClock(0), 0);
  assert.equal(validateEpochClock(123456789), 123456789);

  assert.throws(() => validateEpochClock(NaN), RangeError);
  assert.throws(() => validateEpochClock(Infinity), RangeError);
  assert.throws(() => validateEpochClock(-Infinity), RangeError);
  assert.throws(() => validateEpochClock(-1), RangeError);
  assert.throws(() => validateEpochClock(123.45), RangeError);
  assert.throws(() => validateEpochClock(Number.MAX_SAFE_INTEGER + 1), RangeError);
  assert.throws(() => validateEpochClock("123" as any), RangeError);
  assert.throws(() => validateEpochClock(null as any), RangeError);
});

test("createX402ApprovalContext: builds valid context with canonical hashes", () => {
  const invoice = createTestInvoice();
  const context = createX402ApprovalContext(invoice, FIXTURE_RESOURCE);

  assert.equal(context.x402Version, 1);
  assert.equal(context.scheme, "exact");
  assert.equal(context.network, "xec:mainnet");
  assert.equal(context.invoiceHash, computeInvoiceHash(invoice));
  assert.equal(context.resourceHash, FIXTURE_RESOURCE_HASH);
  assert.equal(context.amountSats, "50000");
  assert.equal(context.payTo, FIXTURE_PAY_TO);
  assert.equal(context.nonce, FIXTURE_NONCE);
  assert.equal(context.issuedAt, SIMULATION_NOW);
  assert.equal(context.expiresAt, SIMULATION_EXPIRES);

  // Validate with schema
  assert.doesNotThrow(() => x402ApprovalContextSchema.parse(context));
});

test("createX402ApprovalContext: rejects resource mismatch", () => {
  const invoice = createTestInvoice();
  const mismatchedResource: ResourceRequest = {
    serverOrigin: "https://api.example.com",
    method: "POST",
    path: "/different/endpoint",
  };

  assert.throws(
    () => createX402ApprovalContext(invoice, mismatchedResource),
    /Invoice resourceHash does not match calculated resourceHash/
  );
});

test("validatePaymentRequired: succeeds with canonical payment required response", () => {
  const invoice = createTestInvoice();
  const invoiceHash = computeInvoiceHash(invoice);

  const paymentRequiredResponse = {
    x402Version: 1,
    invoiceId: invoiceHash,
    invoice,
    resource: FIXTURE_RESOURCE,
    accepts: [
      {
        asset: "XEC",
        network: "xec:mainnet",
        scheme: "exact",
        amountSats: invoice.amountSats,
        payTo: invoice.payTo,
      },
    ],
  };

  const result = validatePaymentRequired(paymentRequiredResponse, {
    now: () => SIMULATION_NOW + 10,
    expectedResource: FIXTURE_RESOURCE,
  });

  assert.equal(result.invoice.amountSats, "50000");
  assert.equal(result.approvalContext.invoiceHash, invoiceHash);
  assert.equal(result.approvalContext.resourceHash, FIXTURE_RESOURCE_HASH);
});

test("validatePaymentRequired: fail-closed on temporal bounds", () => {
  const invoice = createTestInvoice();
  const invoiceHash = computeInvoiceHash(invoice);
  const response = {
    x402Version: 1,
    invoiceId: invoiceHash,
    invoice,
    resource: FIXTURE_RESOURCE,
  };

  // Not yet valid
  assert.throws(
    () => validatePaymentRequired(response, { now: () => SIMULATION_NOW - 1 }),
    /x402 invoice is not yet valid/
  );

  // Expired at exact boundary
  assert.throws(
    () => validatePaymentRequired(response, { now: () => SIMULATION_EXPIRES }),
    /x402 invoice has expired/
  );

  // Expired past boundary
  assert.throws(
    () => validatePaymentRequired(response, { now: () => SIMULATION_EXPIRES + 10 }),
    /x402 invoice has expired/
  );
});

test("validatePaymentRequired: fail-closed on tampered invoice or resource", () => {
  const invoice = createTestInvoice();
  const invoiceHash = computeInvoiceHash(invoice);

  // Tampered invoiceId
  assert.throws(
    () =>
      validatePaymentRequired(
        {
          x402Version: 1,
          invoiceId: "0".repeat(64),
          invoice,
          resource: FIXTURE_RESOURCE,
        },
        { now: () => SIMULATION_NOW + 1 }
      ),
    /Invoice hash mismatch against invoiceId/
  );

  // Tampered resource path
  assert.throws(
    () =>
      validatePaymentRequired(
        {
          x402Version: 1,
          invoiceId: invoiceHash,
          invoice,
          resource: { ...FIXTURE_RESOURCE, path: "/tampered" },
        },
        { now: () => SIMULATION_NOW + 1 }
      ),
    /Resource hash mismatch against invoice.resourceHash/
  );

  // Unsupported version
  assert.throws(
    () =>
      validatePaymentRequired(
        {
          x402Version: 2,
          invoiceId: invoiceHash,
          invoice,
          resource: FIXTURE_RESOURCE,
        },
        { now: () => SIMULATION_NOW + 1 }
      ),
    /Unsupported x402 version/
  );
});
