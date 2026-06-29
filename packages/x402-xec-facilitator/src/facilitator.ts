import {
  authorizationSchema,
  canonicalHash,
  computeInvoiceHash,
  computeResourceHash,
  inspectFundingTransaction,
  parseAmountSats,
  verifyAuthorization,
  type SignatureVerifier,
  type TxProvider,
  type VerificationFailureCode,
} from "@x402-xec/core";
import {
  InMemoryTransactionalLedger,
  type FundingAccount,
  type StoredResponse,
} from "./ledger.js";
import {
  toResourceRequest,
  verifyRequestSchema,
  type VerifyRequest,
} from "./schemas.js";

export type FacilitatorFailureCode =
  | VerificationFailureCode
  | "FUNDING_NOT_FOUND"
  | "FUNDING_CHANGED"
  | "PAYER_MISMATCH"
  | "INSUFFICIENT_CREDIT"
  | "IDEMPOTENCY_CONFLICT";

export type VerifyResponse =
  | {
    readonly ok: true;
    readonly status: "VERIFIED";
    readonly invoiceId: string;
    readonly authorizationDigest: string;
    readonly debitedSats: string;
    readonly remainingBalanceSats: string;
    readonly fundingOutpoint: { readonly txid: string; readonly outIdx: number };
  }
  | { readonly ok: false; readonly code: FacilitatorFailureCode | "MALFORMED" };

export interface FacilitatorResult {
  readonly status: number;
  readonly body: VerifyResponse;
}

export interface FacilitatorOptions {
  readonly txProvider: TxProvider;
  readonly signatureVerifier: SignatureVerifier;
  readonly ledger?: InMemoryTransactionalLedger;
  readonly now?: () => number;
}

export class Facilitator {
  readonly ledger: InMemoryTransactionalLedger;
  readonly #txProvider: TxProvider;
  readonly #signatureVerifier: SignatureVerifier;
  readonly #now: () => number;

  constructor(options: FacilitatorOptions) {
    this.#txProvider = options.txProvider;
    this.#signatureVerifier = options.signatureVerifier;
    this.ledger = options.ledger ?? new InMemoryTransactionalLedger();
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1_000));
  }

  async verify(untrustedInput: unknown): Promise<FacilitatorResult> {
    const parsed = verifyRequestSchema.safeParse(untrustedInput);
    if (!parsed.success) return failure("MALFORMED", 400);
    const input = parsed.data;
    const resource = toResourceRequest(input.resource);

    let resourceHash: string;
    try {
      resourceHash = computeResourceHash(resource);
    } catch {
      return failure("MALFORMED", 400);
    }

    const authorizationDigest = canonicalHash(authorizationSchema.parse(input.authorization));
    const invoiceId = computeInvoiceHash(input.invoice);
    const requestDigest = canonicalHash({ authorizationDigest, invoiceId, resourceHash });

    return this.ledger.transact(async (transaction) => {
      const previous = transaction.findIdempotent(input.idempotencyKey);
      if (previous) {
        if (previous.requestDigest !== requestDigest) return failure("IDEMPOTENCY_CONFLICT", 409);
        return { status: 200, body: previous.response as VerifyResponse };
      }

      const verification = await verifyAuthorization({
        invoice: input.invoice,
        authorization: input.authorization,
        request: resource,
        now: this.#now(),
        signatureVerifier: this.#signatureVerifier,
        nonceStore: transaction.nonceStore,
      });
      if (!verification.ok) return failure(verification.code, 400);

      return this.debit(input, invoiceId, authorizationDigest, requestDigest, transaction);
    });
  }

  private async debit(
    input: VerifyRequest,
    invoiceId: string,
    authorizationDigest: string,
    requestDigest: string,
    transaction: Parameters<Parameters<InMemoryTransactionalLedger["transact"]>[0]>[0],
  ): Promise<FacilitatorResult> {
    const { txid, vout } = input.authorization.transaction;
    const amount = parseAmountSats(input.invoice.amountSats);
    const inspection = await inspectFundingTransaction({
      txProvider: this.#txProvider,
      fundingOutpoint: { txid, outIdx: vout },
      amountSats: amount,
    });
    if (!inspection.ok) {
      return inspection.code === "INSUFFICIENT_SATS"
        ? failure("INSUFFICIENT_CREDIT", 402)
        : failure("FUNDING_NOT_FOUND", 402);
    }
    const { output } = inspection;

    const existing = transaction.getFundingAccount(txid, vout);
    if (existing && existing.fundingValueSats !== output.sats) {
      return failure("FUNDING_CHANGED", 409);
    }
    if (existing && existing.payer !== input.authorization.payer) {
      return failure("PAYER_MISMATCH", 403);
    }

    const account: FundingAccount = existing
      ? { ...existing, fundingOutpoint: { ...existing.fundingOutpoint } }
      : {
        fundingOutpoint: { txid, outIdx: vout },
        payer: input.authorization.payer,
        fundingValueSats: output.sats,
        remainingBalanceSats: output.sats,
      };
    if (account.remainingBalanceSats < amount) return failure("INSUFFICIENT_CREDIT", 402);

    account.remainingBalanceSats -= amount;
    const body: Extract<VerifyResponse, { ok: true }> = {
      ok: true,
      status: "VERIFIED",
      invoiceId,
      authorizationDigest,
      debitedSats: amount.toString(10),
      remainingBalanceSats: account.remainingBalanceSats.toString(10),
      fundingOutpoint: { txid, outIdx: vout },
    };
    transaction.commit({
      account,
      entry: {
        fundingOutpoint: { txid, outIdx: vout },
        payer: input.authorization.payer,
        payTo: input.invoice.payTo,
        fundingValueSats: account.fundingValueSats,
        remainingBalanceSats: account.remainingBalanceSats,
        debitedSats: amount,
        invoiceId,
        nonce: input.invoice.nonce,
        authorizationDigest,
        idempotencyKey: input.idempotencyKey,
      },
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      response: body as StoredResponse,
    });
    return { status: 200, body };
  }
}

function failure(code: FacilitatorFailureCode | "MALFORMED", status: number): FacilitatorResult {
  return { status, body: { ok: false, code } };
}
