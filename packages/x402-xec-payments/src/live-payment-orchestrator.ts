import {
  invoiceSchema,
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

export interface LivePaymentOrchestratorConfig {
  readonly utxoProvider: UtxoProvider;
  readonly transactionBuilder?: FundingTransactionBuilder;
  readonly signatureProvider: SignatureProvider;
  readonly broadcastProvider?: BroadcastProvider;
  readonly payer: string;
  readonly changeAddress: string;
  readonly signatoryForUtxo: (utxo: FundingUtxo) => Signatory;
  /** Safe default. When true, the broadcaster is never called. */
  readonly dryRun?: boolean;
  /** Must be exactly true in live mode. It has no effect in dry-run mode. */
  readonly allowBroadcast?: boolean;
  /** Required in live mode. Optional additional guard in dry-run mode. */
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
}

export interface BroadcastedPaymentResult extends LivePaymentResultBase {
  readonly dryRun: false;
  readonly broadcasted: true;
  readonly broadcastResult: BroadcastResult;
}

export type LivePaymentResult = DryRunPaymentResult | BroadcastedPaymentResult;

/**
 * Composes UTXO discovery, transaction construction, authorization signing,
 * and an explicitly gated broadcast boundary. Dry-run mode is the default.
 */
export class LivePaymentOrchestrator {
  readonly #config: LivePaymentOrchestratorConfig;
  readonly #dryRun: boolean;
  readonly #broadcastProvider: BroadcastProvider;

  constructor(config: LivePaymentOrchestratorConfig) {
    this.#config = { ...config };
    this.#dryRun = config.dryRun ?? true;
    this.#broadcastProvider = config.broadcastProvider
      ?? new DisabledBroadcastProvider();

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
      if (config.maxPaymentSats === undefined) {
        throw new Error("live payment broadcast requires maxPaymentSats");
      }
    }
  }

  async execute(request: LivePaymentRequest): Promise<LivePaymentResult> {
    const preparer = new OfflinePaymentPreparer({
      utxoProvider: this.#config.utxoProvider,
      signatureProvider: this.#config.signatureProvider,
      payer: this.#config.payer,
      changeAddress: this.#config.changeAddress,
      signatoryForUtxo: this.#config.signatoryForUtxo,
      maxPaymentSats: this.#config.maxPaymentSats
        ?? invoiceSchema.parse(request.invoice).amountSats,
      ...(this.#config.transactionBuilder === undefined
        ? {}
        : { transactionBuilder: this.#config.transactionBuilder }),
      ...(this.#config.feePerKb === undefined
        ? {}
        : { feePerKb: this.#config.feePerKb }),
      ...(this.#config.dustSats === undefined
        ? {}
        : { dustSats: this.#config.dustSats }),
      ...(this.#config.now === undefined ? {} : { now: this.#config.now }),
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

    if (this.#dryRun) {
      return { ...base, dryRun: true, broadcasted: false };
    }

    const broadcastResult = await this.#broadcastProvider.broadcastTx(
      prepared.rawTx,
    );
    return {
      ...base,
      dryRun: false,
      broadcasted: true,
      broadcastResult,
    };
  }
}
