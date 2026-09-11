/**
 * @file types.ts
 *
 * Contract and interface types for Phase C1 Authorization-Only Bridge.
 */

import type {
  AgentIntentV1,
  CaePolicyDecisionV1,
  HumanApprovalV1,
  WalletApprovalRequestV1,
  X402ApprovalContextV1,
} from "@xolosarmy/tonalli-core";
import type { Invoice, ResourceRequest } from "@x402-xec/core";

export type {
  AgentIntentV1,
  CaePolicyDecisionV1,
  HumanApprovalV1,
  WalletApprovalRequestV1,
  X402ApprovalContextV1,
};

export interface AgentConfigurationInput {
  readonly agentId: string;
  readonly agentRole: string;
  readonly fromAddress: string;
  readonly reason?: string;
  readonly memo?: string;
  readonly intentTtlSeconds?: number;
}

export interface X402AuthorizationRequest {
  /** Raw or parsed HTTP 402 PAYMENT-REQUIRED payload */
  readonly paymentRequired: unknown;
  /** Optional caller-expected resource to enforce strict resource matching */
  readonly expectedResource?: ResourceRequest;
  /** Agent identity and context configuration */
  readonly agentConfig: AgentConfigurationInput;
}

export interface X402AuthorizationResult {
  readonly status: "approved" | "rejected";
  readonly simulation: true;
  readonly humanApproval: HumanApprovalV1;
  readonly walletApprovalRequest: WalletApprovalRequestV1;
  readonly agentIntent: AgentIntentV1;
  readonly policyDecision: CaePolicyDecisionV1;
  readonly approvalContext: X402ApprovalContextV1;
  readonly invoice: Invoice;
  readonly resource: ResourceRequest;
}

/**
 * Port toward CAE Policy Evaluation engine.
 */
export type CaePolicyEvaluator = (
  intent: AgentIntentV1
) => Promise<CaePolicyDecisionV1>;

/**
 * Port toward Wallet approval transport layer (e.g. tonalli-agents transport).
 */
export interface WalletApprovalTransportBoundary {
  dispatchApprovalRequest(
    request: WalletApprovalRequestV1,
    port?: unknown
  ): Promise<HumanApprovalV1>;
}

export interface X402ReplayCache {
  reserve(
    invoiceHash: string,
    nonce: string,
    expiresAt: number,
    now: number
  ): void;
  commit(invoiceHash: string, nonce: string, expiresAt: number): void;
  rollback(invoiceHash: string, nonce: string): void;
  prune(now: number): number;
  hasSeenInvoice(invoiceHash: string): boolean;
  hasSeenNonce(nonce: string): boolean;
  isInFlight(invoiceHash: string, nonce: string): boolean;
}

export interface X402AgentBridgeConfig {
  /**
   * Enforce agentic kill-switch. Defaults to true (fail-closed).
   */
  readonly killSwitch?: boolean;
  /**
   * Maximum allowed monetary limit in satoshis. Defaults to 0 (all spend blocked).
   */
  readonly dailyLimitSats?: number | bigint;
  /**
   * Injectable clock provider for deterministic testing. Defaults to Date.now() / 1000.
   */
  readonly now?: () => number;
  /**
   * Injectable ID generator. Defaults to crypto.randomUUID.
   */
  readonly randomId?: () => string;
  /**
   * Injectable nonce generator for agent intent. Defaults to crypto.randomBytes(16).
   */
  readonly randomNonce?: () => string;
  /**
   * Replay cache for tracking invoice hashes and nonces. Defaults to in-memory non-durable cache.
   */
  readonly replayCache?: X402ReplayCache;
  /**
   * CAE Policy evaluation port.
   */
  readonly policyEvaluator: CaePolicyEvaluator;
  /**
   * Outbound Wallet approval transport boundary.
   */
  readonly walletTransport: WalletApprovalTransportBoundary;
  /**
   * Optional transport port passed to walletTransport.
   */
  readonly walletPort?: unknown;
}
