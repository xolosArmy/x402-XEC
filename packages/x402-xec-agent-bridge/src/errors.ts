/**
 * @file errors.ts
 *
 * Typed fail-closed error classes for x402-XEC Phase C1 Authorization Bridge.
 */

export type X402AgentBridgeErrorCode =
  | "MALFORMED_PAYMENT_REQUIRED"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_SCHEME"
  | "UNSUPPORTED_NETWORK"
  | "RESOURCE_MISMATCH"
  | "INVOICE_HASH_MISMATCH"
  | "INVOICE_NOT_YET_VALID"
  | "INVOICE_EXPIRED"
  | "INVOICE_EXPIRED_DURING_AUTHORIZATION"
  | "INVALID_CLOCK"
  | "INSUFFICIENT_FUNDS_LIMIT"
  | "KILL_SWITCH_ACTIVE"
  | "INVARIANT_BINDING_MISMATCH"
  | "DUPLICATE_INVOICE"
  | "NONCE_REUSE"
  | "CONCURRENT_CONFLICT"
  | "POLICY_REJECTED"
  | "POLICY_DECISION_INVALID"
  | "WALLET_TRANSPORT_ERROR"
  | "MALFORMED_HUMAN_APPROVAL"
  | "HUMAN_APPROVAL_REJECTED"
  | "HUMAN_APPROVAL_EXPIRED"
  | "PROHIBITED_ACTION_ATTEMPTED";

export class X402AgentBridgeError extends Error {
  readonly code: X402AgentBridgeErrorCode;
  readonly details?: unknown;

  constructor(
    code: X402AgentBridgeErrorCode,
    message: string,
    details?: unknown
  ) {
    super(`[X402AgentBridge] ${code}: ${message}`);
    this.name = "X402AgentBridgeError";
    this.code = code;
    this.details = details;
  }

  static [Symbol.hasInstance](instance: unknown): boolean {
    return (
      instance instanceof Error &&
      instance.name === "X402AgentBridgeError" &&
      typeof (instance as any).code === "string"
    );
  }
}
