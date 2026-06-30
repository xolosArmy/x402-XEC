import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePaymentPolicy,
  type PaymentPlan,
  type PaymentPolicy,
} from "../src/index.js";

const NOW = 1_800_000_000;
const PAY_TO = `ecash:q${"a".repeat(41)}`;

function policy(overrides: Partial<PaymentPolicy> = {}): PaymentPolicy {
  return {
    maxPaymentSats: 2_000n,
    allowedNetworks: ["xec:mainnet"],
    allowedSchemes: ["exact"],
    requireManualApproval: true,
    ...overrides,
  };
}

function plan(overrides: Partial<PaymentPlan> = {}): PaymentPlan {
  return {
    network: "xec:mainnet",
    scheme: "exact",
    amountSats: "1000",
    payTo: PAY_TO,
    expiresAt: NOW + 60,
    feeSats: "219",
    requiresManualApproval: true,
    ...overrides,
  };
}

const context = { dryRun: true, allowBroadcast: false, now: NOW } as const;

test("rejects a payment above maxPaymentSats", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy({ maxPaymentSats: 999 }),
      plan(),
      context,
    ),
    /exceeds maxPaymentSats 999/,
  );
});

test("rejects an unsupported network", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy(),
      plan({ network: "xec:testnet" }),
      context,
    ),
    /unsupported payment network: xec:testnet/,
  );
});

test("rejects an unsupported scheme", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy(),
      plan({ scheme: "upto" }),
      context,
    ),
    /unsupported payment scheme: upto/,
  );
});

test("rejects a payTo address outside the configured allowlist", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy({ allowedPayToAddresses: [`ecash:q${"b".repeat(41)}`] }),
      plan(),
      context,
    ),
    /payment destination is not allowlisted/,
  );
});

test("rejects a fee above maxFeeSats when a fee is available", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy({ maxFeeSats: 218 }),
      plan(),
      context,
    ),
    /payment fee 219 exceeds maxFeeSats 218/,
  );
});

test("accepts a missing fee because preflight runs before construction", () => {
  assert.doesNotThrow(() => evaluatePaymentPolicy(
    policy({ maxFeeSats: 218 }),
    plan({ feeSats: undefined }),
    context,
  ));
});

test("rejects an expired invoice including configured clock skew", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy({ expiresAtSkewSeconds: 30 }),
      plan({ expiresAt: NOW + 30 }),
      context,
    ),
    /invoice has expired/,
  );
});

test("dry-run mode does not require allowBroadcast", () => {
  assert.doesNotThrow(() => evaluatePaymentPolicy(policy(), plan(), context));
});

test("live mode requires allowBroadcast", () => {
  assert.throws(
    () => evaluatePaymentPolicy(
      policy(),
      plan(),
      { dryRun: false, allowBroadcast: false, now: NOW },
    ),
    /requires allowBroadcast: true/,
  );
});
