/**
 * @file bridge.ts
 *
 * x402-XEC Phase C1 Pure Authorization Bridge
 *
 * Permitted Flow:
 * validated HTTP 402 PAYMENT-REQUIRED
 * → X402ApprovalContextV1
 * → AgentIntentV1
 * → CAE policy evaluation
 * → WalletApprovalRequestV1
 * → existing tonalli-agents Wallet approval transport boundary
 * → RMZWallet human review
 * → HumanApprovalV1
 * → STOP
 *
 * Hard Security Boundary:
 * Zero transaction construction, zero signing, zero keys, zero broadcast,
 * zero payment-signature production, zero resource retry/unlock.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  humanApprovalV1Schema,
  parseAgentIntentV1,
  parseCaePolicyDecisionV1,
  parseWalletApprovalRequestV1,
} from "@xolosarmy/tonalli-core";
import {
  computeResourceHash,
  validatePaymentRequired,
  type Invoice,
  type ResourceRequest,
} from "@x402-xec/core";
import { X402AgentBridgeError } from "./errors.js";
import { InMemoryAuthorizationReplayCache } from "./replay-cache.js";
import type {
  AgentConfigurationInput,
  AgentIntentV1,
  CaePolicyDecisionV1,
  HumanApprovalV1,
  WalletApprovalRequestV1,
  X402AgentBridgeConfig,
  X402ApprovalContextV1,
  X402AuthorizationRequest,
  X402AuthorizationResult,
  X402ReplayCache,
} from "./types.js";

function validateClockValue(now: number): number {
  if (
    typeof now !== "number" ||
    !Number.isFinite(now) ||
    !Number.isInteger(now) ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new X402AgentBridgeError(
      "INVALID_CLOCK",
      `Clock provider returned invalid timestamp: ${String(now)}. Safe non-negative integer required.`
    );
  }
  return now;
}

export class X402AuthorizationBridge {
  private readonly killSwitch: boolean;
  private readonly dailyLimitSats: bigint;
  private readonly getNow: () => number;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly replayCache: X402ReplayCache;
  private readonly policyEvaluator: X402AgentBridgeConfig["policyEvaluator"];
  private readonly walletTransport: X402AgentBridgeConfig["walletTransport"];
  private readonly walletPort: unknown;

  constructor(config: X402AgentBridgeConfig) {
    this.killSwitch = config.killSwitch ?? true;
    this.dailyLimitSats = BigInt(config.dailyLimitSats ?? 0);
    this.getNow = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomId = config.randomId ?? randomUUID;
    this.randomNonce =
      config.randomNonce ??
      (() => randomBytes(16).toString("base64url"));
    this.replayCache =
      config.replayCache ?? new InMemoryAuthorizationReplayCache();
    this.policyEvaluator = config.policyEvaluator;
    this.walletTransport = config.walletTransport;
    this.walletPort = config.walletPort;

    if (!this.policyEvaluator) {
      throw new X402AgentBridgeError(
        "POLICY_DECISION_INVALID",
        "A valid policyEvaluator is required to construct X402AuthorizationBridge"
      );
    }
    if (!this.walletTransport) {
      throw new X402AgentBridgeError(
        "WALLET_TRANSPORT_ERROR",
        "A valid walletTransport is required to construct X402AuthorizationBridge"
      );
    }
  }

  /**
   * Executes the Phase C1 authorization pipeline:
   * HTTP 402 → X402ApprovalContextV1 → AgentIntentV1 → CAE → WalletApprovalRequestV1 →
   * Transport → RMZWallet review → HumanApprovalV1 → STOP.
   */
  async authorizePayment(
    request: X402AuthorizationRequest
  ): Promise<X402AuthorizationResult> {
    // 1. Clock validation
    const nowSec = validateClockValue(this.getNow());

    // 2. Kill switch check (fail-closed default)
    if (this.killSwitch) {
      throw new X402AgentBridgeError(
        "KILL_SWITCH_ACTIVE",
        "Agentic kill switch is active (default). Outbound x402 payment authorization is blocked."
      );
    }

    // 3. Monetary limit check (fail-closed default 0)
    if (this.dailyLimitSats <= 0n) {
      throw new X402AgentBridgeError(
        "INSUFFICIENT_FUNDS_LIMIT",
        `Configured daily monetary limit is ${this.dailyLimitSats} sats (default 0). All spend blocked.`
      );
    }

    // 4. Ingest and validate HTTP 402 PAYMENT-REQUIRED payload
    let validated402: {
      invoice: Invoice;
      resource: ResourceRequest;
      approvalContext: X402ApprovalContextV1;
    };
    try {
      validated402 = validatePaymentRequired(request.paymentRequired, {
        now: () => nowSec,
        ...(request.expectedResource === undefined ? {} : { expectedResource: request.expectedResource }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Invalid x402 payment required") || message.includes("Invalid x402 resource metadata")) {
        throw new X402AgentBridgeError("MALFORMED_PAYMENT_REQUIRED", message, err);
      }
      if (message.includes("Unsupported x402 version")) {
        throw new X402AgentBridgeError("UNSUPPORTED_VERSION", message, err);
      }
      if (message.includes("Unsupported x402 network")) {
        throw new X402AgentBridgeError("UNSUPPORTED_NETWORK", message, err);
      }
      if (message.includes("Unsupported x402 invoice scheme")) {
        throw new X402AgentBridgeError("UNSUPPORTED_SCHEME", message, err);
      }
      if (message.includes("Resource hash mismatch") || message.includes("Resource does not match expected resource")) {
        throw new X402AgentBridgeError("RESOURCE_MISMATCH", message, err);
      }
      if (message.includes("Invoice hash mismatch")) {
        throw new X402AgentBridgeError("INVOICE_HASH_MISMATCH", message, err);
      }
      if (message.includes("x402 invoice is not yet valid")) {
        throw new X402AgentBridgeError("INVOICE_NOT_YET_VALID", message, err);
      }
      if (message.includes("x402 invoice has expired")) {
        throw new X402AgentBridgeError("INVOICE_EXPIRED", message, err);
      }
      throw new X402AgentBridgeError("MALFORMED_PAYMENT_REQUIRED", message, err);
    }

    const { invoice, resource, approvalContext } = validated402;

    // 5. Reserve in process-local non-durable Replay Cache
    this.replayCache.reserve(
      approvalContext.invoiceHash,
      approvalContext.nonce,
      approvalContext.expiresAt,
      nowSec
    );

    try {
      // 6. Construct and bind AgentIntentV1
      const intentCreatedAt = nowSec;
      const intentTtl = request.agentConfig.intentTtlSeconds ?? 300;
      const intentExpiresAt = Math.min(
        approvalContext.expiresAt,
        intentCreatedAt + intentTtl
      );

      if (intentExpiresAt <= intentCreatedAt) {
        throw new X402AgentBridgeError(
          "INVOICE_EXPIRED",
          "Invoice expires at or before intent creation timestamp"
        );
      }

      let agentIntent: AgentIntentV1;
      try {
        agentIntent = parseAgentIntentV1({
          contractVersion: "1.0",
          kind: "agent_intent",
          intentId: `intent:${this.randomId()}`,
          nonce: this.randomNonce(),
          agentId: request.agentConfig.agentId,
          agentRole: request.agentConfig.agentRole,
          network: approvalContext.network,
          fromAddress: request.agentConfig.fromAddress,
          toAddress: approvalContext.payTo,
          amountSats: approvalContext.amountSats,
          reason:
            request.agentConfig.reason ??
            `x402 payment authorization for invoice ${approvalContext.invoiceHash}`,
          ...(request.agentConfig.memo === undefined
            ? {}
            : { memo: request.agentConfig.memo }),
          createdAt: intentCreatedAt,
          expiresAt: intentExpiresAt,
        });
      } catch (err) {
        throw new X402AgentBridgeError(
          "MALFORMED_PAYMENT_REQUIRED",
          `Failed to construct bound AgentIntentV1: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      // Exact Invariant Binding Verification
      if (approvalContext.amountSats !== agentIntent.amountSats) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `amountSats mismatch: context (${approvalContext.amountSats}) !== intent (${agentIntent.amountSats})`
        );
      }
      if (approvalContext.payTo !== agentIntent.toAddress) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `payTo mismatch: context (${approvalContext.payTo}) !== intent (${agentIntent.toAddress})`
        );
      }
      if (approvalContext.network !== agentIntent.network) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `network mismatch: context (${approvalContext.network}) !== intent (${agentIntent.network})`
        );
      }

      // Check agent limit against intent amount
      if (BigInt(agentIntent.amountSats) > this.dailyLimitSats) {
        throw new X402AgentBridgeError(
          "INSUFFICIENT_FUNDS_LIMIT",
          `Requested amount (${agentIntent.amountSats} sats) exceeds agent monetary limit (${this.dailyLimitSats} sats)`
        );
      }

      // 7. Invoke CAE Policy Evaluation
      let rawPolicyDecision: unknown;
      try {
        rawPolicyDecision = await this.policyEvaluator(agentIntent);
      } catch (err) {
        throw new X402AgentBridgeError(
          "POLICY_DECISION_INVALID",
          `CAE policy evaluator invocation failed: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      let policyDecision: CaePolicyDecisionV1;
      try {
        policyDecision = parseCaePolicyDecisionV1(rawPolicyDecision);
      } catch (err) {
        throw new X402AgentBridgeError(
          "POLICY_DECISION_INVALID",
          `Policy decision failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      if (policyDecision.intentId !== agentIntent.intentId) {
        throw new X402AgentBridgeError(
          "POLICY_DECISION_INVALID",
          `Policy decision intentId (${policyDecision.intentId}) does not match intent (${agentIntent.intentId})`
        );
      }

      // If CAE rejected, stop the pipeline early
      if (policyDecision.decision === "rejected") {
        this.replayCache.rollback(
          approvalContext.invoiceHash,
          approvalContext.nonce
        );
        return {
          status: "rejected",
          simulation: true,
          humanApproval: undefined as any,
          walletApprovalRequest: undefined as any,
          agentIntent,
          policyDecision,
          approvalContext,
          invoice,
          resource,
        };
      }

      // In Phase C1, autonomous signing is strictly prohibited
      if (policyDecision.decision !== "needs_human_approval") {
        throw new X402AgentBridgeError(
          "POLICY_DECISION_INVALID",
          `Unsupported policy decision: ${policyDecision.decision}. Phase C1 requires needs_human_approval.`
        );
      }

      // 8. Construct WalletApprovalRequestV1
      const currentRequestedAt = validateClockValue(this.getNow());
      if (
        currentRequestedAt >= approvalContext.expiresAt ||
        currentRequestedAt >= agentIntent.expiresAt ||
        currentRequestedAt >= policyDecision.expiresAt
      ) {
        throw new X402AgentBridgeError(
          "INVOICE_EXPIRED_DURING_AUTHORIZATION",
          "Invoice, intent, or policy decision expired before wallet request dispatch"
        );
      }

      const walletExpiresAt = Math.min(
        agentIntent.expiresAt,
        policyDecision.expiresAt,
        approvalContext.expiresAt
      );

      let walletApprovalRequest: WalletApprovalRequestV1;
      try {
        walletApprovalRequest = parseWalletApprovalRequestV1({
          contractVersion: "1.0",
          kind: "wallet_approval_request",
          purpose: "xec_payment",
          requestId: `wallet-request:${this.randomId()}`,
          intent: agentIntent,
          policyDecision,
          x402: approvalContext,
          requestedAt: currentRequestedAt,
          expiresAt: walletExpiresAt,
        });
      } catch (err) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `Failed to construct valid WalletApprovalRequestV1: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      // 9. Dispatch through existing tonalli-agents Wallet approval transport boundary
      let rawHumanApproval: unknown;
      try {
        rawHumanApproval = await this.walletTransport.dispatchApprovalRequest(
          walletApprovalRequest,
          this.walletPort
        );
      } catch (err) {
        throw new X402AgentBridgeError(
          "WALLET_TRANSPORT_ERROR",
          `Wallet approval transport dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      // 10. Receive and validate HumanApprovalV1 response
      let humanApproval: HumanApprovalV1;
      try {
        humanApproval = humanApprovalV1Schema.parse(rawHumanApproval);
      } catch (err) {
        throw new X402AgentBridgeError(
          "MALFORMED_HUMAN_APPROVAL",
          `Wallet response failed HumanApprovalV1 schema validation: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
      }

      // Bindings and invariant checks on returned HumanApprovalV1
      if (humanApproval.contractVersion !== "1.0") {
        throw new X402AgentBridgeError(
          "MALFORMED_HUMAN_APPROVAL",
          `Invalid contractVersion on HumanApprovalV1: ${humanApproval.contractVersion}`
        );
      }
      if (humanApproval.requestId !== walletApprovalRequest.requestId) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `Human approval requestId (${humanApproval.requestId}) does not match outbound request (${walletApprovalRequest.requestId})`
        );
      }
      if (humanApproval.intentId !== agentIntent.intentId) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `Human approval intentId (${humanApproval.intentId}) does not match outbound intent (${agentIntent.intentId})`
        );
      }
      if (humanApproval.decisionId !== policyDecision.decisionId) {
        throw new X402AgentBridgeError(
          "INVARIANT_BINDING_MISMATCH",
          `Human approval decisionId (${humanApproval.decisionId}) does not match policy decision (${policyDecision.decisionId})`
        );
      }
      if (
        humanApproval.recordedAt >= agentIntent.expiresAt ||
        humanApproval.recordedAt >= policyDecision.expiresAt
      ) {
        throw new X402AgentBridgeError(
          "HUMAN_APPROVAL_EXPIRED",
          `Human approval recordedAt (${humanApproval.recordedAt}) is outside validity window`
        );
      }

      if (humanApproval.status === "approved") {
        if (!humanApproval.approver) {
          throw new X402AgentBridgeError(
            "MALFORMED_HUMAN_APPROVAL",
            "Approved HumanApprovalV1 requires an approver identifier"
          );
        }
        // Commit reservation in replay cache
        this.replayCache.commit(
          approvalContext.invoiceHash,
          approvalContext.nonce,
          approvalContext.expiresAt
        );

        // 11. HARD STOP BOUNDARY
        // Return authorization receipt only. No signing capability, no payment signature,
        // no transaction construction, no Chronik broadcast.
        return {
          status: "approved",
          simulation: true,
          humanApproval,
          walletApprovalRequest,
          agentIntent,
          policyDecision,
          approvalContext,
          invoice,
          resource,
        };
      }

      if (humanApproval.status === "rejected") {
        this.replayCache.rollback(
          approvalContext.invoiceHash,
          approvalContext.nonce
        );
        return {
          status: "rejected",
          simulation: true,
          humanApproval,
          walletApprovalRequest,
          agentIntent,
          policyDecision,
          approvalContext,
          invoice,
          resource,
        };
      }

      if (humanApproval.status === "expired") {
        this.replayCache.rollback(
          approvalContext.invoiceHash,
          approvalContext.nonce
        );
        throw new X402AgentBridgeError(
          "HUMAN_APPROVAL_EXPIRED",
          "Wallet human approval status is expired"
        );
      }

      const _exhaustive: never = humanApproval.status;
      throw new X402AgentBridgeError(
        "MALFORMED_HUMAN_APPROVAL",
        `Unknown human approval status: ${String(_exhaustive)}`
      );
    } catch (err) {
      this.replayCache.rollback(
        approvalContext.invoiceHash,
        approvalContext.nonce
      );
      throw err;
    }
  }
}

export function createX402AuthorizationBridge(
  config: X402AgentBridgeConfig
): X402AuthorizationBridge {
  return new X402AuthorizationBridge(config);
}
