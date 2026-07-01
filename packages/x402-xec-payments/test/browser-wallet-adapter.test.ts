import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationSigningMessage,
  computeInvoiceHash,
  createInvoice,
  type ResourceRequest,
  type UnsignedAuthorization,
} from "@x402-xec/core";
import {
  BrowserWalletApprovalSigningBoundary,
  DisabledBrowserWalletAdapter,
  TestOnlyBrowserWalletAdapter,
  type WalletApprovalRequest,
  type WalletSigningRequest,
} from "../src/browser-wallet-adapter.js";
import type { PaymentPlan } from "../src/payment-policy.js";

const NOW = 1_800_000_000;
const ADDRESS = `ecash:q${"a".repeat(41)}`;
const PAY_TO = `ecash:q${"b".repeat(41)}`;
const PUBLIC_KEY = `02${"11".repeat(32)}`;
const RESOURCE: ResourceRequest = {
  serverOrigin: "https://merchant.example",
  method: "POST",
  path: "/api/weather",
  query: [],
};
const INVOICE = createInvoice({
  request: RESOURCE,
  amountSats: 1_000n,
  payTo: PAY_TO,
  nonce: "browser_wallet_fixture_nonce_0001",
  issuedAt: NOW - 1,
  expiresAt: NOW + 60,
});
const PLAN: PaymentPlan = {
  network: INVOICE.network,
  scheme: INVOICE.scheme,
  amountSats: INVOICE.amountSats,
  payTo: INVOICE.payTo,
  expiresAt: INVOICE.expiresAt,
  feeSats: "200",
  transactionTxid: "22".repeat(32),
  requiresManualApproval: true,
};
const AUTHORIZATION: UnsignedAuthorization = {
  x402Version: INVOICE.x402Version,
  scheme: INVOICE.scheme,
  network: INVOICE.network,
  invoiceHash: computeInvoiceHash(INVOICE),
  resourceHash: INVOICE.resourceHash,
  amountSats: INVOICE.amountSats,
  payTo: INVOICE.payTo,
  nonce: INVOICE.nonce,
  payer: ADDRESS,
  transaction: { txid: "22".repeat(32), vout: 0 },
};
const APPROVAL_REQUEST: WalletApprovalRequest = {
  invoice: INVOICE,
  paymentPlan: PLAN,
};
const SIGNING_REQUEST: WalletSigningRequest = {
  authorization: AUTHORIZATION,
  message: authorizationSigningMessage({
    ...AUTHORIZATION,
    signature: "unsigned",
  }),
};

test("disabled adapter fails closed", async () => {
  const adapter = new DisabledBrowserWalletAdapter();
  assert.equal((await adapter.getActiveAccount()).status, "unavailable");
  assert.equal((await adapter.requestApproval(APPROVAL_REQUEST)).status, "rejected");
  assert.equal((await adapter.signAuthorization(SIGNING_REQUEST)).status, "rejected");
});

test("test adapter approves and signs deterministically", async () => {
  const adapter = testAdapter();
  const boundary = new BrowserWalletApprovalSigningBoundary(adapter);
  const first = await boundary.authorize({
    approval: APPROVAL_REQUEST,
    signing: SIGNING_REQUEST,
  });
  const second = await boundary.authorize({
    approval: APPROVAL_REQUEST,
    signing: SIGNING_REQUEST,
  });
  assert.equal(first.approval.status, "approved");
  assert.equal(first.signing?.status, "approved");
  assert.deepEqual(first.signing, second.signing);
  assert.deepEqual(await adapter.getActiveAccount(), {
    status: "available",
    account: { address: ADDRESS, publicKey: PUBLIC_KEY },
  });
});

test("rejected approval prevents signing and exposes no broadcast path", async () => {
  const adapter = new TestOnlyBrowserWalletAdapter({
    account: { address: ADDRESS, publicKey: PUBLIC_KEY },
    approval: { status: "rejected", reason: "user rejected payment" },
  });
  const boundary = new BrowserWalletApprovalSigningBoundary(adapter);
  const result = await boundary.authorize({
    approval: APPROVAL_REQUEST,
    signing: SIGNING_REQUEST,
  });
  assert.deepEqual(result, {
    approval: { status: "rejected", reason: "user rejected payment" },
  });
  assert.equal(adapter.signingRequests.length, 0);
  assert.equal("broadcast" in adapter, false);
  assert.equal("broadcast" in boundary, false);
});

test("requests contain invoice and plan metadata but strip secret fields", async () => {
  const adapter = testAdapter();
  const boundary = new BrowserWalletApprovalSigningBoundary(adapter);
  await boundary.authorize({
    approval: {
      ...APPROVAL_REQUEST,
      invoice: { ...INVOICE, privateKey: "not forwarded" },
      extra: {
        mnemonic: "not forwarded",
        wif: "not forwarded",
        privateKey: "not forwarded",
        seedPhrase: "not forwarded",
      },
    } as WalletApprovalRequest,
    signing: {
      ...SIGNING_REQUEST,
      authorization: { ...AUTHORIZATION, mnemonic: "not forwarded" },
      privateKey: "not forwarded",
    } as WalletSigningRequest,
  });
  const approval = adapter.approvalRequests[0];
  const signing = adapter.signingRequests[0];
  assert.equal(approval?.invoice.amountSats, "1000");
  assert.equal(approval?.paymentPlan.feeSats, "200");
  assert.equal(signing?.authorization.invoiceHash, computeInvoiceHash(INVOICE));
  const serialized = JSON.stringify({ approval, signing }).toLowerCase();
  for (const forbidden of [
    "mnemonic", "wif", "privatekey", "private_key", "seedphrase", "seed_phrase",
  ]) assert.equal(serialized.includes(forbidden), false);
});

test("test adapter signs a prepared transaction deterministically", async () => {
  const adapter = testAdapter();
  const request = {
    invoiceHash: computeInvoiceHash(INVOICE),
    paymentPlan: PLAN,
    transaction: {
      transactionHex: "0200000000",
      transactionTxid: "22".repeat(32),
      feeSats: "200",
    },
  };
  const first = await adapter.signPreparedTransaction(request);
  const second = await adapter.signPreparedTransaction(request);
  assert.deepEqual(first, second);
  assert.deepEqual(first, {
    status: "approved",
    signedTransactionHex: "0200000000",
    transactionTxid: "22".repeat(32),
  });
});

function testAdapter(): TestOnlyBrowserWalletAdapter {
  return new TestOnlyBrowserWalletAdapter({
    account: { address: ADDRESS, publicKey: PUBLIC_KEY },
  });
}
