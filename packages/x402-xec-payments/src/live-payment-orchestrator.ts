import {
  type Authorization,
  type Invoice,
  type ResourceRequest,
  type SignatureProvider,
} from "@x402-xec/core";
import type { BuildFundingTxResult, FundingUtxo } from "@x402-xec/transactions";
import type { Signatory } from "ecash-lib";
import {
  DisabledBroadcastProvider,
  type BroadcastProvider,
  type BroadcastResult,
} from "./broadcast-provider.js";
import {
  OfflinePaymentPreparer,
  type FundingTransactionBuilder,
  type PreparedPaymentEnvelope,
  type UtxoProvider,
} from "./index.js";
import {
  DisabledApprovalProvider,
  PaymentApprovalError,
  evaluatePaymentPolicy,
  type ApprovalDecision,
  type ApprovalProvider,
  type PaymentPlan,
  type PaymentPolicy,
} from "./payment-policy.js";

export interface LivePaymentOrchestratorConfig {
  readonly utxoProvider: UtxoProvider;
  readonly transactionBuilder?: FundingTransactionBuilder;
  readonly signatureProvider: SignatureProvider;
  readonly broadcastProvider?: BroadcastProvider;
  /** Safe default. DisabledApprovalProvider rejects every live payment. */
  readonly approvalProvider?: ApprovalProvider;
  /** Required for live mode and evaluated before approval or broadcast. */
  readonly paymentPolicy?: PaymentPolicy;
  readonly payer: string;
  readonly changeAddress: string;
  readonly signatoryForUtxo: (utxo: FundingUtxo) => Signatory;
  /** Safe default. When true, the broadcaster is never called. */
  readonly dryRun?: boolean;
  /** Must be exactly true in live mode. It has no effect in dry-run mode. */
  readonly allowBroadcast?: boolean;
  /** @deprecated Prefer paymentPolicy.maxPaymentSats. Dry-run compatibility only. */
  readonly maxPaymentSats?: bigint | number | string;
  readonly feePerKb?: string;
  readonly dustSats?: string;
  /** Test hook returning non-negative epoch seconds. */
  readonly now?: () => number;
}

export interface LivePaymentRequest {
  readonly invoice: Invoice;
  readonly resource: ResourceRequest;
}

export interface PlannedBroadcastMetadata {
  readonly transactionTxid: string;
  readonly rawTxHex: string;
  readonly fundingOutpoint: { readonly txid: string; readonly outIdx: number };
  readonly amountSats: string;
  readonly payTo: string;
}

interface LivePaymentResultBase {
  readonly rawTxHex: string;
  readonly fundingOutpoint: { readonly txid: string; readonly outIdx: number };
  readonly authorization: Authorization;
  /** Base64url JSON value for the PAYMENT-SIGNATURE header. */
  readonly paymentSignature: string;
  readonly envelope: PreparedPaymentEnvelope;
  readonly fundingTransaction: BuildFundingTxResult;
  readonly plannedBroadcast: PlannedBroadcastMetadata;
}

export interface DryRunPaymentResult extends LivePaymentResultBase {
  readonly dryRun: true;
  readonly broadcasted: false;
  /** A live execution of this plan always crosses the approval boundary. */
  readonly requiresApproval: true;
  readonly requiresManualApproval: boolean;
}

export interface BroadcastedPaymentResult extends LivePaymentResultBase {
  readonly dryRun: false;
  readonly broadcasted: true;
  readonly broadcastResult: BroadcastResult;
  readonly approvalDecision: ApprovalDecision;
}

export type LivePaymentResult = DryRunPaymentResult | BroadcastedPaymentResult;

/**
 * Composes UTXO discovery, transaction construction, authorization signing,
 * policy evaluation, approval, and an explicitly gated broadcast boundary.
 * Dry-run mode is the default.
 */
export class LivePaymentOrchestrator {
  readonly #config: LivePaymentOrchestratorConfig;
  readonly #dryRun: boolean;
  readonly #broadcastProvider: BroadcastProvider;
  readonly #approvalProvider: ApprovalProvider;

  constructor(config: LivePaymentOrchestratorConfig) {
    this.#config = { ...config };
    this.#dryRun = config.dryRun ?? true;
    this.#broadcastProvider = config.broadcastProvider
      ?? new DisabledBroadcastProvider();
    this.#approvalProvider = config.approvalProvider
      ?? new DisabledApprovalProvider();

    if (!this.#dryRun) {
      if (config.allowBroadcast !== true) {
        throw new Error("live payment broadcast requires allowBroadcast: true");
      }
      if (
        config.broadcastProvider === undefined
        || this.#broadcastProvider instanceof DisabledBroadcastProvider
      ) {
        throw new Error(
          "live payment broadcast requires an explicit non-disabled BroadcastProvider",
        );
      }
      if (config.paymentPolicy === undefined) {
        throw new Error("live payment broadcast requires paymentPolicy");
      }
    }
  }

  async execute(request: LivePaymentRequest): Promise<LivePaymentResult> {
    const now = checkedNow(this.#config.now?.()
      ?? Math.floor(Date.now() / 1_000));
    const untrustedInvoice = request.invoice as unknown as Record<string, unknown>;
    const policy = this.#config.paymentPolicy ?? dryRunPolicy(
      request.invoice,
      this.#config.maxPaymentSats,
    );
    const initialPlan: PaymentPlan = {
      network: String(untrustedInvoice.network),
      scheme: String(untrustedInvoice.scheme),
      amountSats: String(untrustedInvoice.amountSats),
      payTo: String(untrustedInvoice.payTo),
      expiresAt: Number(untrustedInvoice.expiresAt),
      requiresManualApproval: policy.requireManualApproval,
    };
    evaluatePaymentPolicy(policy, initialPlan, {
      dryRun: this.#dryRun,
      allowBroadcast: this.#config.allowBroadcast === true,
      now,
    });

    const preparer = new OfflinePaymentPreparer({
      utxoProvider: this.#config.utxoProvider,
      signatureProvider: this.#config.signatureProvider,
      payer: this.#config.payer,
      changeAddress: this.#config.changeAddress,
      signatoryForUtxo: this.#config.signatoryForUtxo,
      maxPaymentSats: policy.maxPaymentSats,
      ...(this.#config.transactionBuilder === undefined
        ? {}
        : { transactionBuilder: this.#config.transactionBuilder }),
      ...(this.#config.feePerKb === undefined
        ? {}
        : { feePerKb: this.#config.feePerKb }),
      ...(this.#config.dustSats === undefined
        ? {}
        : { dustSats: this.#config.dustSats }),
      now: () => now,
    });
    const prepared = await preparer.prepare(request);
    const plannedBroadcast: PlannedBroadcastMetadata = {
      transactionTxid: prepared.fundingTransaction.txid,
      rawTxHex: prepared.rawTx,
      fundingOutpoint: prepared.fundingOutpoint,
      amountSats: prepared.envelope.invoice.amountSats,
      payTo: prepared.envelope.invoice.payTo,
    };
    const base: LivePaymentResultBase = {
      rawTxHex: prepared.rawTx,
      fundingOutpoint: prepared.fundingOutpoint,
      authorization: prepared.envelope.authorization,
      paymentSignature: prepared.paymentSignature,
      envelope: prepared.envelope,
      fundingTransaction: prepared.fundingTransaction,
      plannedBroadcast,
    };
    const approvalPlan: PaymentPlan = {
      ...initialPlan,
      feeSats: prepared.fundingTransaction.feeSats,
      transactionTxid: prepared.fundingTransaction.txid,
    };
    evaluatePaymentPolicy(policy, approvalPlan, {
      dryRun: this.#dryRun,
      allowBroadcast: this.#config.allowBroadcast === true,
      now,
    });

    if (this.#dryRun) {
      return {
        ...base,
        dryRun: true,
        broadcasted: false,
        requiresApproval: true,
        requiresManualApproval: policy.requireManualApproval,
      };
    }

    const approvalDecision = await this.#approvalProvider.approvePayment(
      approvalPlan,
    );
    if (typeof approvalDecision?.approved !== "boolean") {
      throw new TypeError("ApprovalProvider must return an ApprovalDecision");
    }
    if (!approvalDecision.approved) {
      throw new PaymentApprovalError(approvalDecision.reason);
    }

    const broadcastResult = await this.#broadcastProvider.broadcastTx(
      prepared.rawTx,
    );
    return {
      ...base,
      dryRun: false,
      broadcasted: true,
      broadcastResult,
      approvalDecision,
    };
  }
}

function dryRunPolicy(
  invoice: Invoice,
  maxPaymentSats: bigint | number | string | undefined,
): PaymentPolicy {
  return {
    maxPaymentSats: maxPaymentSats ?? invoice.amountSats,
    allowedNetworks: [invoice.network],
    allowedSchemes: [invoice.scheme],
    requireManualApproval: true,
  };
}

function checkedNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("now must return non-negative epoch seconds");
  }
  return value;
}
