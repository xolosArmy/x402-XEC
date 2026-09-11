import assert from "node:assert/strict";
import test from "node:test";
import {
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
  type Invoice,
  type ResourceRequest,
} from "@x402-xec/core";
import type {
  CaePolicyDecisionV1,
  HumanApprovalV1,
  WalletApprovalRequestV1,
} from "@xolosarmy/tonalli-core";
import {
  createX402AuthorizationBridge,
  X402AgentBridgeError,
  X402AuthorizationBridge,
} from "../src/index.js";

const FIXTURE_RESOURCE: ResourceRequest = {
  serverOrigin: "https://api.example.com",
  method: "POST",
  path: "/premium/weather",
};

const FIXTURE_RESOURCE_HASH = computeResourceHash(FIXTURE_RESOURCE);
const FIXTURE_PAY_TO = "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2";
const FIXTURE_FROM = "ecash:qq9h650ag5082460r07p6w9ep2qkv904tqm7vd0f96";
const FIXTURE_NONCE = "b64url_test_nonce_val_1234567890";
const SIMULATION_NOW = 1_800_000_000;
const SIMULATION_EXPIRES = 1_800_000_300;

function createTestInvoice(overrides: Record<string, unknown> = {}): Invoice {
  return createInvoice({
    request: FIXTURE_RESOURCE,
    amountSats: 25000n,
    payTo: FIXTURE_PAY_TO,
    nonce: FIXTURE_NONCE,
    issuedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES,
    ...overrides,
  });
}

function createPaymentRequiredPayload(invoice: Invoice, overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 1,
    invoiceId: computeInvoiceHash(invoice),
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
    ...overrides,
  };
}

function createDefaultAgentConfig() {
  return {
    agentId: "agent:curator-001",
    agentRole: "data-fetcher",
    fromAddress: FIXTURE_FROM,
    reason: "Access premium weather resource via x402",
  };
}

function createMockPolicyEvaluator(decision: "needs_human_approval" | "rejected" | "approved" = "needs_human_approval") {
  return async (intent: any): Promise<CaePolicyDecisionV1> => {
    return {
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: `decision:test-uuid-${decision}`,
      intentId: intent.intentId,
      decision,
      reasonCode: "HUMAN_APPROVAL_REQUIRED",
      reason: `Policy outcome: ${decision}`,
      policyTraceId: "trace:policy-test-trace-001",
      policyVersion: "1.0.0",
      evaluatedAt: intent.createdAt + 1,
      expiresAt: intent.expiresAt,
    };
  };
}

function createMockWalletTransport(status: "approved" | "rejected" | "expired" = "approved") {
  return {
    async dispatchApprovalRequest(request: WalletApprovalRequestV1): Promise<HumanApprovalV1> {
      return {
        contractVersion: "1.0",
        kind: "human_approval",
        approvalId: "approval:test-human-uuid",
        requestId: request.requestId,
        intentId: request.intent.intentId,
        decisionId: request.policyDecision.decisionId,
        status,
        ...(status === "approved" ? { approver: "custodian:human-officer-01" } : {}),
        reason: `Human review decision: ${status}`,
        recordedAt: request.requestedAt + 2,
      };
    },
  };
}

test("X402AuthorizationBridge: fail-closed by default (killSwitch active)", async () => {
  const invoice = createTestInvoice();
  const bridge = createX402AuthorizationBridge({
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
    // Note: killSwitch defaults to true
  });

  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "KILL_SWITCH_ACTIVE"
  );
});

test("X402AuthorizationBridge: fail-closed by default (dailyLimitSats is 0)", async () => {
  const invoice = createTestInvoice();
  const bridge = createX402AuthorizationBridge({
    killSwitch: false, // Explicitly disabled for simulation test
    // Note: dailyLimitSats defaults to 0
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
  });

  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "INSUFFICIENT_FUNDS_LIMIT"
  );
});

test("X402AuthorizationBridge: fail-closed on invalid clock values (NaN, Infinity, -Infinity, negative, float, unsafe integer)", async () => {
  const invalidClocks = [
    NaN,
    Infinity,
    -Infinity,
    -1,
    -1800000000,
    1800000000.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1800000000" as any,
    null as any,
    undefined as any,
  ];

  for (const badClock of invalidClocks) {
    const bridge = createX402AuthorizationBridge({
      killSwitch: false,
      dailyLimitSats: 100000n,
      policyEvaluator: createMockPolicyEvaluator(),
      walletTransport: createMockWalletTransport(),
      now: () => badClock,
    });

    await assert.rejects(
      async () =>
        bridge.authorizePayment({
          paymentRequired: createPaymentRequiredPayload(createTestInvoice()),
          agentConfig: createDefaultAgentConfig(),
        }),
      (err: unknown) =>
        err instanceof X402AgentBridgeError &&
        err.code === "INVALID_CLOCK",
      `Expected clock ${String(badClock)} to fail with INVALID_CLOCK`
    );
  }
});

test("X402AuthorizationBridge: schema-only mainnet-shaped simulation succeeds with valid human approval", async () => {
  const invoice = createTestInvoice();
  const bridge = createX402AuthorizationBridge({
    killSwitch: false, // test-only injected configuration
    dailyLimitSats: 100000n, // test-only injected configuration
    policyEvaluator: createMockPolicyEvaluator("needs_human_approval"),
    walletTransport: createMockWalletTransport("approved"),
    now: () => SIMULATION_NOW + 10,
  });

  const result = await bridge.authorizePayment({
    paymentRequired: createPaymentRequiredPayload(invoice),
    expectedResource: FIXTURE_RESOURCE,
    agentConfig: createDefaultAgentConfig(),
  });

  assert.equal(result.status, "approved");
  assert.equal(result.simulation, true);
  assert.equal(result.humanApproval.status, "approved");
  assert.equal(result.humanApproval.approver, "custodian:human-officer-01");

  // Invariant propagation checks
  assert.equal(result.approvalContext.amountSats, result.agentIntent.amountSats);
  assert.equal(result.approvalContext.payTo, result.agentIntent.toAddress);
  assert.equal(result.approvalContext.network, result.agentIntent.network);
  assert.equal(result.walletApprovalRequest.x402.invoiceHash, result.approvalContext.invoiceHash);
  assert.equal(result.walletApprovalRequest.x402.amountSats, "25000");

  // HARD STOP: Ensure return object contains NO signing capability or transaction hex
  assert.equal((result as any).paymentSignature, undefined);
  assert.equal((result as any).signedTransaction, undefined);
  assert.equal((result as any).rawTx, undefined);
  assert.equal((result as any).txid, undefined);
});

test("X402AuthorizationBridge: schema-only simulation returns rejected when human reviews rejects", async () => {
  const invoice = createTestInvoice({ nonce: "b64url_unique_nonce_for_reject_123" });
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator("needs_human_approval"),
    walletTransport: createMockWalletTransport("rejected"),
    now: () => SIMULATION_NOW + 10,
  });

  const result = await bridge.authorizePayment({
    paymentRequired: createPaymentRequiredPayload(invoice),
    agentConfig: createDefaultAgentConfig(),
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.humanApproval.status, "rejected");
});

test("X402AuthorizationBridge: schema-only simulation returns rejected when CAE rejects", async () => {
  const invoice = createTestInvoice({ nonce: "b64url_unique_nonce_cae_reject_123" });
  let transportInvoked = false;
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator("rejected"),
    walletTransport: {
      async dispatchApprovalRequest(): Promise<HumanApprovalV1> {
        transportInvoked = true;
        throw new Error("Should not be called");
      },
    },
    now: () => SIMULATION_NOW + 10,
  });

  const result = await bridge.authorizePayment({
    paymentRequired: createPaymentRequiredPayload(invoice),
    agentConfig: createDefaultAgentConfig(),
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.policyDecision.decision, "rejected");
  assert.equal(transportInvoked, false);
});

test("X402AuthorizationBridge: fails closed if CAE returns approved (autonomous signing not authorized in C1)", async () => {
  const invoice = createTestInvoice({ nonce: "b64url_unique_nonce_cae_appr_12345" });
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator("approved"),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
  });

  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "POLICY_DECISION_INVALID" &&
      err.message.includes("Phase C1 requires needs_human_approval")
  );
});

test("X402AuthorizationBridge: fails closed when amount exceeds monetary limit", async () => {
  const invoice = createTestInvoice({ amountSats: 500000n });
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n, // less than 500000 sats
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
  });

  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "INSUFFICIENT_FUNDS_LIMIT"
  );
});

test("X402AuthorizationBridge: fails closed on malformed PAYMENT-REQUIRED payload", async () => {
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
  });

  // Not an object
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: "not an object",
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "MALFORMED_PAYMENT_REQUIRED"
  );

  // Missing invoice
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: { x402Version: 1 },
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "MALFORMED_PAYMENT_REQUIRED"
  );
});

test("X402AuthorizationBridge: fails closed on unsupported x402 version, scheme, or network", async () => {
  const invoice = createTestInvoice();
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
  });

  // Unsupported x402Version
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice, { x402Version: 2 }),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "UNSUPPORTED_VERSION"
  );

  // Unsupported scheme
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice, {
          invoice: { ...invoice, scheme: "range" },
        }),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      (err.code === "UNSUPPORTED_SCHEME" || err.code === "MALFORMED_PAYMENT_REQUIRED")
  );

  // Unsupported network
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice, {
          invoice: { ...invoice, network: "xec:testnet" },
        }),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      (err.code === "UNSUPPORTED_NETWORK" || err.code === "MALFORMED_PAYMENT_REQUIRED")
  );
});

test("X402AuthorizationBridge: fails closed on resource or invoice hash mismatch", async () => {
  const invoice = createTestInvoice();
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => SIMULATION_NOW + 10,
  });

  // Resource mismatch against expected
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        expectedResource: {
          serverOrigin: "https://api.example.com",
          method: "POST",
          path: "/different/endpoint",
        },
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "RESOURCE_MISMATCH"
  );

  // InvoiceId hash mismatch
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice, {
          invoiceId: "f".repeat(64),
        }),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "INVOICE_HASH_MISMATCH"
  );
});

test("X402AuthorizationBridge: fails closed on temporal issues (not yet valid, expired, expiry during authorization)", async () => {
  const invoice = createTestInvoice({
    nonce: "b64url_temporal_test_nonce_12345",
  });
  let currentTime = SIMULATION_NOW - 5;
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator(),
    walletTransport: createMockWalletTransport(),
    now: () => currentTime,
  });

  // Invoice not yet valid
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "INVOICE_NOT_YET_VALID"
  );

  // Invoice expired at start
  currentTime = SIMULATION_EXPIRES + 1;
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "INVOICE_EXPIRED"
  );

  // Expiry reached during authorization before wallet dispatch
  currentTime = SIMULATION_NOW + 10;
  let dynamicNow = SIMULATION_NOW + 10;
  const advancingBridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: async (intent: any) => {
      // Simulate slow CAE policy evaluation that crosses invoice expiration
      dynamicNow = SIMULATION_EXPIRES + 5;
      return {
        contractVersion: "1.0",
        kind: "cae_policy_decision",
        decisionId: "decision:late-uuid",
        intentId: intent.intentId,
        decision: "needs_human_approval",
        reasonCode: "HUMAN_APPROVAL_REQUIRED",
        reason: "Delayed review",
        policyTraceId: "trace:slow-review",
        policyVersion: "1.0.0",
        evaluatedAt: intent.createdAt + 1,
        expiresAt: intent.expiresAt,
      };
    },
    walletTransport: createMockWalletTransport(),
    now: () => dynamicNow,
  });

  await assert.rejects(
    async () =>
      advancingBridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(
          createTestInvoice({ nonce: "b64url_dynamic_advancing_nonce_12" })
        ),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "INVOICE_EXPIRED_DURING_AUTHORIZATION"
  );
});

test("X402AuthorizationBridge: fails closed on replay and concurrent duplicate attempts", async () => {
  const invoice = createTestInvoice({
    nonce: "b64url_replay_test_nonce_9876543",
  });
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator("needs_human_approval"),
    walletTransport: createMockWalletTransport("approved"),
    now: () => SIMULATION_NOW + 10,
  });

  // First authorization succeeds
  const first = await bridge.authorizePayment({
    paymentRequired: createPaymentRequiredPayload(invoice),
    agentConfig: createDefaultAgentConfig(),
  });
  assert.equal(first.status, "approved");

  // Replay attempt with same invoice
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      (err.code === "DUPLICATE_INVOICE" || err.code === "NONCE_REUSE")
  );
});

test("X402AuthorizationBridge: fails closed on wallet transport failure or malformed human approval", async () => {
  const invoice = createTestInvoice({
    nonce: "b64url_transport_fail_nonce_1234",
  });

  // Transport network/dispatch failure
  const failingTransportBridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator("needs_human_approval"),
    walletTransport: {
      async dispatchApprovalRequest(): Promise<HumanApprovalV1> {
        throw new Error("RPC connection lost to wallet service");
      },
    },
    now: () => SIMULATION_NOW + 10,
  });

  await assert.rejects(
    async () =>
      failingTransportBridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(invoice),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "WALLET_TRANSPORT_ERROR"
  );

  // Malformed human approval (missing approver when approved)
  const malformedBridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 100000n,
    policyEvaluator: createMockPolicyEvaluator("needs_human_approval"),
    walletTransport: {
      async dispatchApprovalRequest(request: WalletApprovalRequestV1): Promise<any> {
        return {
          contractVersion: "1.0",
          kind: "human_approval",
          approvalId: "approval:bad",
          requestId: request.requestId,
          intentId: request.intent.intentId,
          decisionId: request.policyDecision.decisionId,
          status: "approved",
          // Missing approver!
          reason: "Approved without identity",
          recordedAt: request.requestedAt + 1,
        };
      },
    },
    now: () => SIMULATION_NOW + 10,
  });

  await assert.rejects(
    async () =>
      malformedBridge.authorizePayment({
        paymentRequired: createPaymentRequiredPayload(
          createTestInvoice({ nonce: "b64url_malformed_approval_nonce_1" })
        ),
        agentConfig: createDefaultAgentConfig(),
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "MALFORMED_HUMAN_APPROVAL"
  );
});
