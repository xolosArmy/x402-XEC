/**
 * @file crossrepo.test.ts
 *
 * x402-XEC Phase C1 Cross-Repo Contract Harness
 *
 * Pinned Canonical Anchors:
 * - tonalli-core:   cfe4cb1575b22ed258565717c000ac535aa98c67
 * - tonalli-agents: b95919ec0b36179b84da88ce48cb23cae30ae311
 * - RMZWallet:      860e7223cbe74476efdca81b249d2a7d3c147fbb
 * - x402-XEC:       Phase C1 branch HEAD
 *
 * Pipeline:
 * validated HTTP 402 PAYMENT-REQUIRED
 * → X402ApprovalContextV1
 * → AgentIntentV1
 * → CAE policy evaluation
 * → WalletApprovalRequestV1
 * → tonalli-agents Wallet approval transport boundary
 * → RMZWallet human review (decode handoff -> review session -> approveHandle)
 * → HumanApprovalV1
 * → STOP
 *
 * Governance & Boundary Classification:
 * ⚠️ THIS IS A SCHEMA-ONLY MAINNET-SHAPED SIMULATION WITHOUT FINANCIAL AUTHORITY.
 * Zero transaction construction, zero keys, zero signing, zero Chronik broadcast,
 * zero payment-signature production, zero resource retry/unlock.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
  type Invoice,
  type ResourceRequest,
} from "@x402-xec/core";
import {
  createX402AuthorizationBridge,
  X402AgentBridgeError,
} from "../src/index.js";

const TONALLI_AGENTS_ROOT = path.resolve(
  process.env.TONALLI_AGENTS_ROOT ?? "/home/xolosarmy/ecashschool/tonalli-agents"
);
const RMZ_WALLET_ROOT = path.resolve(
  process.env.RMZ_WALLET_ROOT ?? "/home/xolosarmy/ecashschool/RMZWallet"
);

async function loadExternalRepoModules() {
  const encoderUrl = pathToFileURL(
    path.join(RMZ_WALLET_ROOT, "src/features/agentWalletHandoff/encoder.ts")
  ).href;
  const receiverUrl = pathToFileURL(
    path.join(RMZ_WALLET_ROOT, "src/features/agentWalletApprovalReceiver/receiver.ts")
  ).href;
  const testUtilsUrl = pathToFileURL(
    path.join(RMZ_WALLET_ROOT, "src/features/agentWalletApprovalReceiver/testUtils.ts")
  ).href;
  const transportUrl = pathToFileURL(
    path.join(TONALLI_AGENTS_ROOT, "src/wallet/approvalTransport.ts")
  ).href;

  const { encodeAgentWalletHandoffV1 } = await import(encoderUrl);
  const { createAgentWalletApprovalReceiver } = await import(receiverUrl);
  const { InMemoryWalletApprovalLedger, createMockSessionVerifier } = await import(testUtilsUrl);
  const { createWalletApprovalTransport } = await import(transportUrl);

  return {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    createWalletApprovalTransport,
  };
}

const FROM_ADDRESS = "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2";
const PAY_TO_ADDRESS = "ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5";
const SIMULATION_NOW = 1_800_000_000;
const SIMULATION_EXPIRES_AT = 1_800_000_300;

const FIXTURE_RESOURCE: ResourceRequest = {
  serverOrigin: "https://api.example.com",
  method: "POST",
  path: "/premium/weather",
};

test("Cross-Repo Contract Harness [Positive]: HTTP 402 -> x402Context -> Intent -> CAE -> Request -> tonalli-agents transport -> RMZWallet review -> HumanApprovalV1 -> STOP", async () => {
  const {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    createWalletApprovalTransport,
  } = await loadExternalRepoModules();

  // 1. Initialize RMZWallet Receiver
  const ledger = new InMemoryWalletApprovalLedger();
  const sessionVerifier = createMockSessionVerifier(FROM_ADDRESS, true);
  let idCounter = 1;
  const idGenerator = () => `auto_wallet_id_${idCounter++}`;
  const receiverClock = () => SIMULATION_NOW + 10;

  const walletReceiver = createAgentWalletApprovalReceiver({
    ledger,
    sessionVerifier,
    clock: receiverClock,
    idGenerator,
    declaredOrigin: "https://app.tonalli.cash",
  });

  // 2. Connect Port using RMZWallet encoder and receiver
  let capturedHandoff: any = null;
  const walletPort = {
    async sendApprovalRequest(request: any) {
      const handoffBytes = encodeAgentWalletHandoffV1(request);
      const reviewSession = await walletReceiver.prepareHandoff(handoffBytes);
      capturedHandoff = reviewSession.presentation;
      const humanApproval = await walletReceiver.approveHandle(reviewSession.handle);
      return humanApproval;
    },
  };

  // 3. Initialize real tonalli-agents approval transport (injected simulation mode)
  const walletTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW + 5,
  });

  // 4. Create invoice & HTTP 402 challenge
  const invoice = createInvoice({
    request: FIXTURE_RESOURCE,
    amountSats: 250000n, // 2,500 XEC
    payTo: PAY_TO_ADDRESS,
    nonce: "b64url_crossrepo_test_nonce_12345",
    issuedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES_AT,
  });

  const paymentRequiredPayload = {
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
  };

  // 5. Construct X402AuthorizationBridge
  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 1_000_000n,
    now: () => SIMULATION_NOW + 5,
    policyEvaluator: async (intent) => ({
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: "cae-dec-integrated-001",
      intentId: intent.intentId,
      decision: "needs_human_approval",
      reasonCode: "POLICY_HUMAN_REVIEW_REQUIRED",
      reason: "Amount requires human custodian approval",
      policyTraceId: "cae-trace-integrated-777",
      policyVersion: "vcae-v1.0.0",
      evaluatedAt: intent.createdAt + 1,
      expiresAt: intent.expiresAt,
    }),
    walletTransport,
    walletPort,
  });

  // 6. Execute authorization
  const result = await bridge.authorizePayment({
    paymentRequired: paymentRequiredPayload,
    expectedResource: FIXTURE_RESOURCE,
    agentConfig: {
      agentId: "agent-crossrepo-01",
      agentRole: "market-data-requester",
      fromAddress: FROM_ADDRESS,
      reason: "Acquire real-time premium market data feed",
    },
  });

  // 7. Verify result
  assert.equal(result.status, "approved");
  assert.equal(result.simulation, true);
  assert.ok(result.humanApproval);
  assert.equal(result.humanApproval.status, "approved");
  assert.equal(result.humanApproval.approver, FROM_ADDRESS);
  assert.equal(result.humanApproval.requestId, result.walletApprovalRequest.requestId);

  // 8. Verify RMZWallet presentation decoded the x402 metadata
  assert.ok(capturedHandoff);
  assert.equal(capturedHandoff.amountSats, "250000");
  assert.equal(capturedHandoff.destination, PAY_TO_ADDRESS);
  assert.equal(capturedHandoff.signingStatus, "not authorized");
  assert.equal(capturedHandoff.broadcastStatus, "not attempted");

  // 9. HARD STOP BOUNDARY
  assert.equal((result as any).paymentSignature, undefined);
  assert.equal((result as any).rawTx, undefined);
  assert.equal((result as any).signedTransaction, undefined);
  assert.equal((result as any).txid, undefined);
});

test("Cross-Repo Contract Harness [Negative - Rejection]: RMZWallet custodian rejects request", async () => {
  const {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    createWalletApprovalTransport,
  } = await loadExternalRepoModules();

  const ledger = new InMemoryWalletApprovalLedger();
  const sessionVerifier = createMockSessionVerifier(FROM_ADDRESS, true);
  const walletReceiver = createAgentWalletApprovalReceiver({
    ledger,
    sessionVerifier,
    clock: () => SIMULATION_NOW + 10,
    idGenerator: () => "id_reject",
    declaredOrigin: "https://app.tonalli.cash",
  });

  const walletPort = {
    async sendApprovalRequest(request: any) {
      const handoffBytes = encodeAgentWalletHandoffV1(request);
      const reviewSession = await walletReceiver.prepareHandoff(handoffBytes);
      const humanApproval = await walletReceiver.rejectHandle(
        reviewSession.handle,
        "Custodian rejected untrusted endpoint"
      );
      return humanApproval;
    },
  };

  const walletTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW + 5,
  });

  const invoice = createInvoice({
    request: FIXTURE_RESOURCE,
    amountSats: 100000n,
    payTo: PAY_TO_ADDRESS,
    nonce: "b64url_reject_crossrepo_nonce_123",
    issuedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES_AT,
  });

  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 1_000_000n,
    now: () => SIMULATION_NOW + 5,
    policyEvaluator: async (intent) => ({
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: "cae-dec-rej-001",
      intentId: intent.intentId,
      decision: "needs_human_approval",
      reasonCode: "HUMAN_APPROVAL_REQUIRED",
      reason: "Needs approval",
      policyTraceId: "cae-trace-rej",
      policyVersion: "1.0.0",
      evaluatedAt: intent.createdAt + 1,
      expiresAt: intent.expiresAt,
    }),
    walletTransport,
    walletPort,
  });

  const result = await bridge.authorizePayment({
    paymentRequired: {
      x402Version: 1,
      invoiceId: computeInvoiceHash(invoice),
      invoice,
      resource: FIXTURE_RESOURCE,
    },
    agentConfig: {
      agentId: "agent-01",
      agentRole: "tester",
      fromAddress: FROM_ADDRESS,
    },
  });

  assert.equal(result.status, "rejected");
  assert.equal(result.humanApproval.status, "rejected");
});

test("Cross-Repo Contract Harness [Negative - Concurrency/Replay]: Replay prevented through full stack", async () => {
  const {
    encodeAgentWalletHandoffV1,
    createAgentWalletApprovalReceiver,
    InMemoryWalletApprovalLedger,
    createMockSessionVerifier,
    createWalletApprovalTransport,
  } = await loadExternalRepoModules();

  const ledger = new InMemoryWalletApprovalLedger();
  const sessionVerifier = createMockSessionVerifier(FROM_ADDRESS, true);
  let counter = 1;
  const walletReceiver = createAgentWalletApprovalReceiver({
    ledger,
    sessionVerifier,
    clock: () => SIMULATION_NOW + 10,
    idGenerator: () => `id_${counter++}`,
    declaredOrigin: "https://app.tonalli.cash",
  });

  const walletPort = {
    async sendApprovalRequest(request: any) {
      const handoffBytes = encodeAgentWalletHandoffV1(request);
      const reviewSession = await walletReceiver.prepareHandoff(handoffBytes);
      return await walletReceiver.approveHandle(reviewSession.handle);
    },
  };

  const walletTransport = createWalletApprovalTransport({
    killSwitch: false,
    monetaryLimitSats: 1_000_000,
    nowEpochSeconds: () => SIMULATION_NOW + 5,
  });

  const invoice = createInvoice({
    request: FIXTURE_RESOURCE,
    amountSats: 50000n,
    payTo: PAY_TO_ADDRESS,
    nonce: "b64url_replay_fullstack_nonce_123",
    issuedAt: SIMULATION_NOW,
    expiresAt: SIMULATION_EXPIRES_AT,
  });

  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 1_000_000n,
    now: () => SIMULATION_NOW + 5,
    policyEvaluator: async (intent) => ({
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: `dec:${intent.intentId}`,
      intentId: intent.intentId,
      decision: "needs_human_approval",
      reasonCode: "HUMAN_APPROVAL_REQUIRED",
      reason: "Needs approval",
      policyTraceId: "trace:01",
      policyVersion: "1.0.0",
      evaluatedAt: intent.createdAt + 1,
      expiresAt: intent.expiresAt,
    }),
    walletTransport,
    walletPort,
  });

  const payload = {
    x402Version: 1,
    invoiceId: computeInvoiceHash(invoice),
    invoice,
    resource: FIXTURE_RESOURCE,
  };

  // First succeeds
  const first = await bridge.authorizePayment({
    paymentRequired: payload,
    agentConfig: { agentId: "agent-01", agentRole: "tester", fromAddress: FROM_ADDRESS },
  });
  assert.equal(first.status, "approved");

  // Replay attempt fails closed
  await assert.rejects(
    async () =>
      bridge.authorizePayment({
        paymentRequired: payload,
        agentConfig: { agentId: "agent-01", agentRole: "tester", fromAddress: FROM_ADDRESS },
      }),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      (err.code === "DUPLICATE_INVOICE" || err.code === "NONCE_REUSE")
  );
});
