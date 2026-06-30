import {
  authorizationSchema,
  authorizationSigningMessage,
  computeInvoiceHash,
  computeResourceHash,
  invoiceSchema,
  parseAmountSats,
  unsignedAuthorizationSchema,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
  type Authorization,
  type Invoice,
  type MaybePromise,
  type ResourceRequest,
  type SignatureProvider,
  type UnsignedAuthorization,
} from "@x402-xec/core";
import {
  buildFundingTx,
  type BuildFundingTxResult,
  type FundingUtxo,
} from "@x402-xec/transactions";
import type { Signatory } from "ecash-lib";

export * from "./chronik-utxo-provider.js";
export * from "./broadcast-provider.js";

export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE" as const;

export interface PaymentPreparationRequest {
  /** Invoice and canonical resource metadata received in the HTTP 402 response. */
  readonly invoice: Invoice;
  readonly resource: ResourceRequest;
}

export interface UtxoProviderRequest {
  readonly network: typeof XEC_MAINNET;
  readonly payer: string;
  readonly amountSats: string;
}

/**
 * Supplies an ordered UTXO snapshot. Implementations may be deterministic and
 * local, or an explicitly configured read-only discovery adapter.
 */
export interface UtxoProvider {
  getUtxos(request: UtxoProviderRequest): MaybePromise<readonly FundingUtxo[]>;
}

export interface PreparedPaymentEnvelope {
  readonly invoice: Invoice;
  readonly authorization: Authorization;
}

export interface PaymentPreparationResult {
  readonly envelope: PreparedPaymentEnvelope;
  /** Base64url JSON value for the PAYMENT-SIGNATURE header. */
  readonly paymentSignature: string;
  /** Signed raw transaction generated in memory. It has not been broadcast. */
  readonly rawTx: string;
  readonly fundingOutpoint: {
    readonly txid: string;
    readonly outIdx: number;
  };
  readonly fundingTransaction: BuildFundingTxResult;
}

export interface OfflinePaymentPreparerOptions {
  readonly utxoProvider: UtxoProvider;
  readonly signatureProvider: SignatureProvider;
  readonly payer: string;
  readonly changeAddress: string;
  /**
   * Supplies transaction-input signing behavior while keeping key material in
   * caller-controlled code.
   */
  readonly signatoryForUtxo: (utxo: FundingUtxo) => Signatory;
  readonly maxPaymentSats: bigint | number | string;
  readonly feePerKb?: string;
  readonly dustSats?: string;
  /** Test hook returning non-negative epoch seconds. */
  readonly now?: () => number;
}

/**
 * Connects validated HTTP 402 metadata to offline transaction construction and
 * message-only authorization signing. This class has no fetch or broadcast API.
 */
export class OfflinePaymentPreparer {
  readonly #options: OfflinePaymentPreparerOptions;
  readonly #maxPaymentSats: bigint;

  constructor(options: OfflinePaymentPreparerOptions) {
    this.#options = options;
    this.#maxPaymentSats = readMaximum(options.maxPaymentSats);
    unsignedAuthorizationSchema.shape.payer.parse(options.payer);
  }

  async prepare(
    request: PaymentPreparationRequest,
  ): Promise<PaymentPreparationResult> {
    const now = checkedNow(this.#options.now?.()
      ?? Math.floor(Date.now() / 1_000));
    const invoice = validateInvoice(request.invoice, request.resource, now);
    const amountSats = parseAmountSats(invoice.amountSats);
    if (amountSats > this.#maxPaymentSats) {
      throw new RangeError(
        `payment amount ${invoice.amountSats} exceeds maxPaymentSats ${this.#maxPaymentSats}`,
      );
    }

    const utxos = await this.#options.utxoProvider.getUtxos({
      network: XEC_MAINNET,
      payer: this.#options.payer,
      amountSats: invoice.amountSats,
    });
    if (!Array.isArray(utxos)) {
      throw new TypeError("UtxoProvider must return an array");
    }

    const fundingTransaction = buildFundingTx({
      invoice,
      utxos,
      changeAddress: this.#options.changeAddress,
      signatoryForUtxo: this.#options.signatoryForUtxo,
      ...(this.#options.feePerKb === undefined
        ? {}
        : { feePerKb: this.#options.feePerKb }),
      ...(this.#options.dustSats === undefined
        ? {}
        : { dustSats: this.#options.dustSats }),
    });
    const unsigned: UnsignedAuthorization = {
      x402Version: X402_VERSION,
      scheme: XEC_SCHEME,
      network: XEC_MAINNET,
      invoiceHash: computeInvoiceHash(invoice),
      resourceHash: invoice.resourceHash,
      amountSats: invoice.amountSats,
      payTo: invoice.payTo,
      nonce: invoice.nonce,
      payer: this.#options.payer,
      transaction: {
        txid: fundingTransaction.fundingOutpoint.txid,
        vout: fundingTransaction.fundingOutpoint.outIdx,
      },
    };
    const signingShape: Authorization = {
      ...unsigned,
      signature: "unsigned",
    };
    const signature = await this.#options.signatureProvider.sign(
      authorizationSigningMessage(signingShape),
    );
    const authorization = authorizationSchema.parse({
      ...unsigned,
      signature,
    });
    const envelope: PreparedPaymentEnvelope = { invoice, authorization };

    return {
      envelope,
      paymentSignature: encodeBase64UrlJson(envelope),
      rawTx: fundingTransaction.rawTx,
      fundingOutpoint: fundingTransaction.fundingOutpoint,
      fundingTransaction,
    };
  }
}

/** Deterministic local provider for fixtures and explicit caller snapshots. */
export class StaticUtxoProvider implements UtxoProvider {
  readonly #utxos: readonly FundingUtxo[];

  constructor(utxos: readonly FundingUtxo[]) {
    this.#utxos = utxos.map((utxo) => ({ ...utxo }));
  }

  getUtxos(): readonly FundingUtxo[] {
    return this.#utxos.map((utxo) => ({ ...utxo }));
  }
}

function validateInvoice(
  input: Invoice,
  resource: ResourceRequest,
  now: number,
): Invoice {
  const untrusted = input as unknown;
  if (!isRecord(untrusted)) throw new TypeError("invalid x402-XEC invoice");
  if (untrusted.network !== XEC_MAINNET) {
    throw new Error(`unsupported x402-XEC network: ${String(untrusted.network)}`);
  }
  if (untrusted.scheme !== XEC_SCHEME) {
    throw new Error(`unsupported x402-XEC invoice scheme: ${String(untrusted.scheme)}`);
  }

  const parsed = invoiceSchema.safeParse(untrusted);
  if (!parsed.success) {
    throw new TypeError(
      `invalid x402-XEC invoice: ${parsed.error.issues[0]?.message ?? "malformed"}`,
    );
  }
  const invoice = parsed.data;
  if (now < invoice.issuedAt) throw new Error("x402-XEC invoice is not yet valid");
  if (now >= invoice.expiresAt) throw new Error("x402-XEC invoice has expired");

  let resourceHash: string;
  try {
    resourceHash = computeResourceHash(resource);
  } catch {
    throw new TypeError("invalid x402-XEC resource metadata");
  }
  if (resourceHash !== invoice.resourceHash) {
    throw new Error("x402-XEC invoice does not match resource metadata");
  }
  return invoice;
}

function checkedNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("now must return non-negative epoch seconds");
  }
  return value;
}

function readMaximum(input: bigint | number | string): bigint {
  let maximum: bigint;
  try {
    if (typeof input === "bigint") maximum = input;
    else if (typeof input === "number" && Number.isSafeInteger(input)) {
      maximum = BigInt(input);
    } else if (
      typeof input === "string"
      && /^(0|[1-9][0-9]*)$/.test(input)
    ) {
      maximum = BigInt(input);
    } else {
      throw new TypeError();
    }
  } catch {
    throw new TypeError("maxPaymentSats must be a non-negative integer");
  }
  if (maximum < 0n) {
    throw new RangeError("maxPaymentSats must be non-negative");
  }
  return maximum;
}

function encodeBase64UrlJson(input: unknown): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
