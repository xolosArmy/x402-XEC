import {
  canonicalHash,
  type Invoice,
  type MaybePromise,
  type UnsignedAuthorization,
} from "@x402-xec/core";
import type { PaymentPlan } from "./payment-policy.js";

export type WalletRequestStatus = "approved" | "rejected" | "cancelled";

export interface WalletActiveAccount {
  readonly address: string;
  /** Hex-encoded compressed public key. This is public identity data. */
  readonly publicKey: string;
}

export type WalletActiveAccountResponse =
  | { readonly status: "available"; readonly account: WalletActiveAccount }
  | { readonly status: "unavailable"; readonly reason?: string };

/** Display-safe payment metadata sent to the wallet approval UI. */
export interface WalletApprovalRequest {
  readonly invoice: Invoice;
  readonly paymentPlan: PaymentPlan;
}

export type WalletApprovalResponse =
  | {
    readonly status: "approved";
    readonly approvedAt?: number;
    readonly approver?: string;
  }
  | { readonly status: "rejected" | "cancelled"; readonly reason?: string };

/** Public authorization fields. The wallet returns only the signature. */
export interface WalletSigningRequest {
  readonly authorization: UnsignedAuthorization;
  readonly message: string;
}

export type WalletSigningResponse =
  | {
    readonly status: "approved";
    readonly signature: string;
    readonly publicKey?: string;
  }
  | { readonly status: "rejected" | "cancelled"; readonly reason?: string };

/** Public metadata for a transaction prepared outside the wallet. */
export interface WalletPreparedTransactionPlan {
  readonly transactionHex: string;
  readonly transactionTxid?: string;
  readonly fundingOutpoint?: { readonly txid: string; readonly outIdx: number };
  readonly feeSats?: string;
}

export interface WalletTransactionSigningRequest {
  readonly invoiceHash: string;
  readonly paymentPlan: PaymentPlan;
  readonly transaction: WalletPreparedTransactionPlan;
}

export type WalletTransactionSigningResponse =
  | {
    readonly status: "approved";
    readonly signedTransactionHex: string;
    readonly transactionTxid?: string;
  }
  | { readonly status: "rejected" | "cancelled"; readonly reason?: string };

/** Future Tonalli Wallet boundary. Implementations retain custody. */
export interface BrowserWalletAdapter {
  getActiveAccount(): MaybePromise<WalletActiveAccountResponse>;
  requestApproval(
    request: WalletApprovalRequest,
  ): MaybePromise<WalletApprovalResponse>;
  signAuthorization(
    request: WalletSigningRequest,
  ): MaybePromise<WalletSigningResponse>;
  signPreparedTransaction?(
    request: WalletTransactionSigningRequest,
  ): MaybePromise<WalletTransactionSigningResponse>;
}

const DISABLED_REASON = "Browser wallet adapter is disabled";

/** Safe default: no account, approval, or signature is available. */
export class DisabledBrowserWalletAdapter implements BrowserWalletAdapter {
  getActiveAccount(): WalletActiveAccountResponse {
    return { status: "unavailable", reason: DISABLED_REASON };
  }

  requestApproval(_request: WalletApprovalRequest): WalletApprovalResponse {
    return { status: "rejected", reason: DISABLED_REASON };
  }

  signAuthorization(_request: WalletSigningRequest): WalletSigningResponse {
    return { status: "rejected", reason: DISABLED_REASON };
  }

  signPreparedTransaction(
    _request: WalletTransactionSigningRequest,
  ): WalletTransactionSigningResponse {
    return { status: "rejected", reason: DISABLED_REASON };
  }
}

export interface TestOnlyBrowserWalletAdapterOptions {
  readonly account: WalletActiveAccount;
  readonly approval?: WalletApprovalResponse;
  readonly authorizationSigning?: Exclude<
    WalletSigningResponse,
    { readonly status: "approved" }
  >;
  readonly transactionSigning?: WalletTransactionSigningResponse;
}

/** Deterministic, I/O-free adapter for tests; hashes are not real signatures. */
export class TestOnlyBrowserWalletAdapter implements BrowserWalletAdapter {
  readonly approvalRequests: WalletApprovalRequest[] = [];
  readonly signingRequests: WalletSigningRequest[] = [];
  readonly transactionSigningRequests: WalletTransactionSigningRequest[] = [];
  readonly #options: TestOnlyBrowserWalletAdapterOptions;

  constructor(options: TestOnlyBrowserWalletAdapterOptions) {
    this.#options = {
      ...options,
      account: { ...options.account },
      ...(options.approval === undefined
        ? {}
        : { approval: { ...options.approval } }),
      ...(options.authorizationSigning === undefined
        ? {}
        : { authorizationSigning: { ...options.authorizationSigning } }),
      ...(options.transactionSigning === undefined
        ? {}
        : { transactionSigning: { ...options.transactionSigning } }),
    };
  }

  getActiveAccount(): WalletActiveAccountResponse {
    return { status: "available", account: { ...this.#options.account } };
  }

  requestApproval(request: WalletApprovalRequest): WalletApprovalResponse {
    this.approvalRequests.push(copyApprovalRequest(request));
    return { ...(this.#options.approval ?? { status: "approved" }) };
  }

  signAuthorization(request: WalletSigningRequest): WalletSigningResponse {
    const safeRequest = copySigningRequest(request);
    this.signingRequests.push(safeRequest);
    if (this.#options.authorizationSigning !== undefined) {
      return { ...this.#options.authorizationSigning };
    }
    return {
      status: "approved",
      signature: canonicalHash({
        domain: "x402-xec-test-browser-wallet-authorization-v1",
        address: this.#options.account.address,
        message: safeRequest.message,
      }),
      publicKey: this.#options.account.publicKey,
    };
  }

  signPreparedTransaction(
    request: WalletTransactionSigningRequest,
  ): WalletTransactionSigningResponse {
    const safeRequest = copyTransactionSigningRequest(request);
    this.transactionSigningRequests.push(safeRequest);
    if (this.#options.transactionSigning !== undefined) {
      return { ...this.#options.transactionSigning };
    }
    return {
      status: "approved",
      signedTransactionHex: safeRequest.transaction.transactionHex,
      ...(safeRequest.transaction.transactionTxid === undefined
        ? {}
        : { transactionTxid: safeRequest.transaction.transactionTxid }),
    };
  }
}

export interface BrowserWalletAuthorizationRequest {
  readonly approval: WalletApprovalRequest;
  readonly signing: WalletSigningRequest;
}

export interface BrowserWalletAuthorizationResult {
  readonly approval: WalletApprovalResponse;
  /** Omitted unless the approval state is exactly `approved`. */
  readonly signing?: WalletSigningResponse;
}

/** Enforces approval-before-signing and has no broadcast capability. */
export class BrowserWalletApprovalSigningBoundary {
  readonly #adapter: BrowserWalletAdapter;

  constructor(adapter: BrowserWalletAdapter = new DisabledBrowserWalletAdapter()) {
    this.#adapter = adapter;
  }

  async authorize(
    request: BrowserWalletAuthorizationRequest,
  ): Promise<BrowserWalletAuthorizationResult> {
    const approval = await this.#adapter.requestApproval(
      copyApprovalRequest(request.approval),
    );
    if (approval.status !== "approved") return { approval: { ...approval } };
    const signing = await this.#adapter.signAuthorization(
      copySigningRequest(request.signing),
    );
    return { approval: { ...approval }, signing: { ...signing } };
  }
}

function copyApprovalRequest(
  request: WalletApprovalRequest,
): WalletApprovalRequest {
  return {
    invoice: copyInvoice(request.invoice),
    paymentPlan: copyPaymentPlan(request.paymentPlan),
  };
}

function copySigningRequest(request: WalletSigningRequest): WalletSigningRequest {
  return {
    authorization: {
      x402Version: request.authorization.x402Version,
      scheme: request.authorization.scheme,
      network: request.authorization.network,
      invoiceHash: request.authorization.invoiceHash,
      resourceHash: request.authorization.resourceHash,
      amountSats: request.authorization.amountSats,
      payTo: request.authorization.payTo,
      nonce: request.authorization.nonce,
      payer: request.authorization.payer,
      transaction: {
        txid: request.authorization.transaction.txid,
        vout: request.authorization.transaction.vout,
      },
    },
    message: request.message,
  };
}

function copyTransactionSigningRequest(
  request: WalletTransactionSigningRequest,
): WalletTransactionSigningRequest {
  return {
    invoiceHash: request.invoiceHash,
    paymentPlan: copyPaymentPlan(request.paymentPlan),
    transaction: {
      transactionHex: request.transaction.transactionHex,
      ...(request.transaction.transactionTxid === undefined
        ? {}
        : { transactionTxid: request.transaction.transactionTxid }),
      ...(request.transaction.fundingOutpoint === undefined
        ? {}
        : { fundingOutpoint: { ...request.transaction.fundingOutpoint } }),
      ...(request.transaction.feeSats === undefined
        ? {}
        : { feeSats: request.transaction.feeSats }),
    },
  };
}

function copyInvoice(invoice: Invoice): Invoice {
  return {
    x402Version: invoice.x402Version,
    scheme: invoice.scheme,
    network: invoice.network,
    resourceHash: invoice.resourceHash,
    amountSats: invoice.amountSats,
    payTo: invoice.payTo,
    nonce: invoice.nonce,
    issuedAt: invoice.issuedAt,
    expiresAt: invoice.expiresAt,
  };
}

function copyPaymentPlan(plan: PaymentPlan): PaymentPlan {
  return {
    network: plan.network,
    scheme: plan.scheme,
    amountSats: plan.amountSats,
    payTo: plan.payTo,
    expiresAt: plan.expiresAt,
    requiresManualApproval: plan.requiresManualApproval,
    ...(plan.feeSats === undefined ? {} : { feeSats: plan.feeSats }),
    ...(plan.transactionTxid === undefined
      ? {}
      : { transactionTxid: plan.transactionTxid }),
    ...(plan.finality === undefined ? {} : { finality: plan.finality }),
  };
}
