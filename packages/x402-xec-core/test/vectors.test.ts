import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { authorizationSigningMessage, computeInvoiceHash, createInvoice, InMemoryNonceStore, type Authorization, type AuthorizationSignatureVerifier, type Invoice, type ResourceRequest, verifyAuthorization, X402_VERSION, XEC_MAINNET, XEC_SCHEME } from "../src/index.js";

const NOW = 1_800_000_000;
const PAY_TO = `ecash:q${"a".repeat(41)}`;
const PAYER = `ecash:q${"b".repeat(41)}`;
const request: ResourceRequest = {
  serverOrigin: "https://api.example.com", method: "POST", path: "/v1/weather",
  query: [["units", "metric"], ["city", "mexico-city"]], body: { forecastDays: 3, alerts: true },
};
const sign = (message: string): string => createHash("sha256").update(`local-test-key\0${message}`).digest("base64url");
const signatureVerifier: AuthorizationSignatureVerifier = { verify: ({ message, signature }) => signature === sign(message) };
function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return { ...createInvoice({ request, amountSats: 1_000n, payTo: PAY_TO, nonce: "MDEyMzQ1Njc4OWFiY2RlZg", issuedAt: NOW - 10, expiresAt: NOW + 50 }), ...overrides };
}
function makeAuthorization(invoice: Invoice): Authorization {
  const unsigned = {
    x402Version: X402_VERSION, scheme: XEC_SCHEME, network: XEC_MAINNET,
    invoiceHash: computeInvoiceHash(invoice), resourceHash: invoice.resourceHash, amountSats: invoice.amountSats,
    payTo: invoice.payTo, nonce: invoice.nonce, payer: PAYER, transaction: { txid: "c".repeat(64), vout: 0 },
  } as const;
  const placeholder: Authorization = { ...unsigned, signature: "placeholder" };
  return { ...unsigned, signature: sign(authorizationSigningMessage(placeholder)) };
}
async function verify(invoice: Invoice, authorization: Authorization, candidate: ResourceRequest = request, store = new InMemoryNonceStore(), now = NOW) {
  return verifyAuthorization({ invoice, authorization, request: candidate, nonceStore: store, now, signatureVerifier });
}

test("valid vector verifies with bigint amount", async () => {
  const invoice = makeInvoice();
  assert.deepEqual(await verify(invoice, makeAuthorization(invoice)), { ok: true, amountSats: 1_000n });
});
for (const vector of [
  { name: "method change fails", candidate: { ...request, method: "GET" } },
  { name: "path change fails", candidate: { ...request, path: "/v1/climate" } },
  { name: "domain change fails", candidate: { ...request, serverOrigin: "https://evil.example.com" } },
]) test(vector.name, async () => {
  const invoice = makeInvoice();
  assert.deepEqual(await verify(invoice, makeAuthorization(invoice), vector.candidate), { ok: false, code: "RESOURCE_MISMATCH" });
});
test("amount change fails", async () => {
  const invoice = makeInvoice();
  assert.deepEqual(await verify(invoice, { ...makeAuthorization(invoice), amountSats: "1001" }), { ok: false, code: "AMOUNT_MISMATCH" });
});
test("payTo change fails", async () => {
  const invoice = makeInvoice();
  assert.deepEqual(await verify(invoice, { ...makeAuthorization(invoice), payTo: `ecash:q${"d".repeat(41)}` }), { ok: false, code: "PAY_TO_MISMATCH" });
});
test("nonce change fails", async () => {
  const invoice = makeInvoice();
  assert.deepEqual(await verify(invoice, { ...makeAuthorization(invoice), nonce: "YWJjZGVmZ2hpamtsbW5vcA" }), { ok: false, code: "NONCE_MISMATCH" });
});
test("expired invoice fails", async () => {
  const invoice = makeInvoice();
  assert.deepEqual(await verify(invoice, makeAuthorization(invoice), request, new InMemoryNonceStore(), invoice.expiresAt), { ok: false, code: "EXPIRED" });
});
test("reused nonce fails", async () => {
  const invoice = makeInvoice(); const authorization = makeAuthorization(invoice); const store = new InMemoryNonceStore();
  assert.deepEqual(await verify(invoice, authorization, request, store), { ok: true, amountSats: 1_000n });
  assert.deepEqual(await verify(invoice, authorization, request, store), { ok: false, code: "NONCE_REUSED" });
});
test("invalid signature does not consume nonce", async () => {
  const invoice = makeInvoice();
  const authorization = makeAuthorization(invoice);
  const store = new InMemoryNonceStore();
  assert.deepEqual(await verify(invoice, { ...authorization, signature: "invalid" }, request, store), { ok: false, code: "INVALID_SIGNATURE" });
  assert.deepEqual(await verify(invoice, authorization, request, store), { ok: true, amountSats: 1_000n });
});
