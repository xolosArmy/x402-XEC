export type SatoshiLimit = bigint | number | string;

export interface PaymentPolicy {
  readonly maxPaymentSats: SatoshiLimit;
  readonly allowedNetworks: readonly string[];
  readonly allowedSchemes: readonly string[];
  readonly allowedPayToAddresses?: readonly string[];
  readonly requireFinality?: boolean;
  readonly requireManualApproval: boolean;
  readonly expiresAtSkewSeconds?: number;
  readonly maxFeeSats?: SatoshiLimit;
}

export interface PaymentPlan {
  readonly network: string;
  readonly scheme: string;
  readonly amountSats: string;
  readonly payTo: string;
  readonly expiresAt: number;
  readonly feeSats?: string;
  readonly transactionTxid?: string;
  /** Tells an approval UX that unattended approval is not policy-compliant. */
  readonly requiresManualApproval: boolean;
  /**
   * Whether the inputs meet a caller-supplied finality guarantee. The current
   * UTXO boundary does not supply this metadata, so `requireFinality: true`
   * fails closed in LivePaymentOrchestrator.
   */
  readonly finality?: boolean;
}

export interface PaymentPolicyContext {
  readonly dryRun: boolean;
  readonly allowBroadcast: boolean;
  readonly now: number;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly reason?: string;
  readonly approvedAt?: number;
  readonly approver?: string;
}

export interface ApprovalProvider {
  approvePayment(plan: PaymentPlan): Promise<ApprovalDecision>;
}

export class PaymentPolicyError extends Error {
  readonly code = "PAYMENT_POLICY_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "PaymentPolicyError";
  }
}

export class PaymentApprovalError extends Error {
  readonly code = "PAYMENT_APPROVAL_REJECTED";

  constructor(reason = "Payment approval was rejected") {
    super(reason);
    this.name = "PaymentApprovalError";
  }
}

/** Safe default: no live payment is ever approved implicitly. */
export class DisabledApprovalProvider implements ApprovalProvider {
  async approvePayment(_plan: PaymentPlan): Promise<ApprovalDecision> {
    return {
      approved: false,
      reason: "Payment approval is disabled",
    };
  }
}

/**
 * Deterministic approval double for automated tests only. It performs no I/O
 * and returns a configured decision for every plan.
 */
export class TestOnlyApprovalProvider implements ApprovalProvider {
  readonly plans: PaymentPlan[] = [];
  readonly #decision: ApprovalDecision;

  constructor(decision: ApprovalDecision) {
    this.#decision = { ...decision };
  }

  async approvePayment(plan: PaymentPlan): Promise<ApprovalDecision> {
    this.plans.push({ ...plan });
    return { ...this.#decision };
  }
}

/**
 * Evaluates an immutable payment plan. It performs no I/O and throws before a
 * caller can cross the broadcast boundary.
 */
export function evaluatePaymentPolicy(
  policy: PaymentPolicy,
  plan: PaymentPlan,
  context: PaymentPolicyContext,
): void {
  const maximum = readLimit(policy.maxPaymentSats, "maxPaymentSats");
  const amount = readCanonicalSats(plan.amountSats, "payment amount");
  if (amount > maximum) {
    throw new PaymentPolicyError(
      `payment amount ${plan.amountSats} exceeds maxPaymentSats ${maximum}`,
    );
  }
  if (!policy.allowedNetworks.includes(plan.network)) {
    throw new PaymentPolicyError(`unsupported payment network: ${plan.network}`);
  }
  if (!policy.allowedSchemes.includes(plan.scheme)) {
    throw new PaymentPolicyError(`unsupported payment scheme: ${plan.scheme}`);
  }
  if (
    policy.allowedPayToAddresses !== undefined
    && !policy.allowedPayToAddresses.includes(plan.payTo)
  ) {
    throw new PaymentPolicyError(
      `payment destination is not allowlisted: ${plan.payTo}`,
    );
  }
  if (plan.feeSats !== undefined && policy.maxFeeSats !== undefined) {
    const fee = readCanonicalSats(plan.feeSats, "payment fee");
    const maximumFee = readLimit(policy.maxFeeSats, "maxFeeSats");
    if (fee > maximumFee) {
      throw new PaymentPolicyError(
        `payment fee ${plan.feeSats} exceeds maxFeeSats ${maximumFee}`,
      );
    }
  }
  if (policy.requireFinality === true && plan.finality !== true) {
    throw new PaymentPolicyError("payment policy requires finalized funding inputs");
  }

  const skew = readSkew(policy.expiresAtSkewSeconds ?? 0);
  if (!Number.isSafeInteger(context.now) || context.now < 0) {
    throw new RangeError("now must be a non-negative epoch second");
  }
  if (
    !Number.isSafeInteger(plan.expiresAt)
    || plan.expiresAt < 0
    || context.now + skew >= plan.expiresAt
  ) {
    throw new PaymentPolicyError("x402-XEC invoice has expired");
  }
  if (!context.dryRun && context.allowBroadcast !== true) {
    throw new PaymentPolicyError(
      "live payment broadcast requires allowBroadcast: true",
    );
  }
}

function readLimit(input: SatoshiLimit, field: string): bigint {
  let value: bigint;
  try {
    if (typeof input === "bigint") value = input;
    else if (typeof input === "number" && Number.isSafeInteger(input)) {
      value = BigInt(input);
    } else if (
      typeof input === "string"
      && /^(0|[1-9][0-9]*)$/.test(input)
    ) {
      value = BigInt(input);
    } else {
      throw new TypeError();
    }
  } catch {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  if (value < 0n) throw new RangeError(`${field} must be non-negative`);
  return value;
}

function readCanonicalSats(input: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(input)) {
    throw new TypeError(`${field} must be a canonical non-negative integer`);
  }
  return BigInt(input);
}

function readSkew(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "expiresAtSkewSeconds must be a non-negative safe integer",
    );
  }
  return value;
}
