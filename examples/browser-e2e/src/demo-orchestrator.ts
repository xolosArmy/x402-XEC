import type {
  PaymentOrchestrator,
  PaymentPreparationRequest,
  PaymentOrchestratorResult,
} from "@x402-xec/axios";
import {
  authorizationSchema,
  authorizationSigningMessage,
  canonicalHash,
  computeInvoiceHash,
  type Authorization,
  type UnsignedAuthorization,
} from "@x402-xec/core";
import {
  BrowserWalletApprovalSigningBoundary,
  type BrowserWalletAdapter,
  type PaymentPlan,
} from "@x402-xec/payments";

export const DEMO_PAYER = `ecash:q${"b".repeat(41)}`;
export const DEMO_PUBLIC_KEY = `02${"11".repeat(32)}`;
export const DEMO_FUNDING_TXID = "c".repeat(64);

export type DemoFlowEvent =
  | "approval requested"
  | "mock approval accepted"
  | "mock approval rejected"
  | "mock signature returned";

export interface FakeTonalliWalletOptions {
  readonly approve?: boolean;
  readonly onEvent?: (event: DemoFlowEvent) => void;
  readonly onRequest?: (request: unknown) => void;
}

/**
 * Creates the test-only shape injected as window.tonalli. Its closure contains
 * configuration and public fixture identity only; the exposed object has just
 * the BrowserWalletAdapter methods needed by this demo.
 */
export function createFakeTonalliWallet(
  options: FakeTonalliWalletOptions = {},
): BrowserWalletAdapter {
  const account = { address: DEMO_PAYER, publicKey: DEMO_PUBLIC_KEY };
  const approve = options.approve ?? true;

  return {
    getActiveAccount() {
      return { status: "available", account: { ...account } };
    },
    requestApproval(request) {
      options.onEvent?.("approval requested");
      options.onRequest?.(request);
      if (!approve) {
        options.onEvent?.("mock approval rejected");
        return { status: "rejected", reason: "test user rejected payment" };
      }
      options.onEvent?.("mock approval accepted");
      return { status: "approved", approver: "fake-tonalli-wallet" };
    },
    signAuthorization(request) {
      options.onRequest?.(request);
      const signature = mockWalletSignature(account.address, request.message);
      options.onEvent?.("mock signature returned");
      return {
        status: "approved",
        signature,
        publicKey: account.publicKey,
      };
    },
  };
}

/** Demo-only orchestrator: approval + authorization signing, never broadcast. */
export class BrowserDryRunPaymentOrchestrator implements PaymentOrchestrator {
  readonly #wallet: BrowserWalletAdapter;

  constructor(wallet: BrowserWalletAdapter) {
    this.#wallet = wallet;
  }

  async execute(
    request: PaymentPreparationRequest,
  ): Promise<PaymentOrchestratorResult> {
    const active = await this.#wallet.getActiveAccount();
    if (active.status !== "available") {
      throw new Error(active.reason ?? "fake Tonalli wallet is unavailable");
    }

    const unsigned: UnsignedAuthorization = {
      x402Version: request.invoice.x402Version,
      scheme: request.invoice.scheme,
      network: request.invoice.network,
      invoiceHash: computeInvoiceHash(request.invoice),
      resourceHash: request.invoice.resourceHash,
      amountSats: request.invoice.amountSats,
      payTo: request.invoice.payTo,
      nonce: request.invoice.nonce,
      payer: active.account.address,
      transaction: { txid: DEMO_FUNDING_TXID, vout: 0 },
    };
    const plan: PaymentPlan = {
      network: request.invoice.network,
      scheme: request.invoice.scheme,
      amountSats: request.invoice.amountSats,
      payTo: request.invoice.payTo,
      expiresAt: request.invoice.expiresAt,
      transactionTxid: DEMO_FUNDING_TXID,
      requiresManualApproval: true,
    };
    const boundary = new BrowserWalletApprovalSigningBoundary(this.#wallet);
    const result = await boundary.authorize({
      approval: { invoice: request.invoice, paymentPlan: plan },
      signing: {
        authorization: unsigned,
        message: authorizationSigningMessage({
          ...unsigned,
          signature: "unsigned",
        }),
      },
    });

    if (result.approval.status !== "approved") {
      throw new Error(result.approval.reason ?? "wallet approval rejected");
    }
    if (result.signing?.status !== "approved") {
      throw new Error(result.signing?.reason ?? "wallet signing rejected");
    }

    const authorization: Authorization = authorizationSchema.parse({
      ...unsigned,
      signature: result.signing.signature,
    });
    return {
      paymentSignature: encodeBase64UrlJson({
        invoice: request.invoice,
        authorization,
      }),
      broadcasted: false,
      mode: "browser-dry-run",
    };
  }
}

function mockWalletSignature(payer: string, message: string): string {
  // Matches TestOnlyMockSignatureVerifier. This is a hash, not a wallet signature.
  return canonicalHash({
    domain: "x402-xec-local-mock-signature-v1",
    message,
    payer,
  });
}

function encodeBase64UrlJson(input: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
