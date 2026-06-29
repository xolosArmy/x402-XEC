import { canonicalize } from "./canonicalize.js";
import { computeInvoiceHash } from "./invoice.js";
import type { NonceStore } from "./nonce-store.js";
import { computeResourceHash, type ResourceRequest } from "./resource.js";
import { authorizationSchema, invoiceSchema, parseAmountSats, type Authorization, type Invoice, type UnsignedAuthorization } from "./schemas.js";
import type { SignatureVerifier } from "./signatures.js";

export type VerificationFailureCode = "MALFORMED" | "NOT_YET_VALID" | "EXPIRED" | "RESOURCE_MISMATCH" | "AMOUNT_MISMATCH" | "PAY_TO_MISMATCH" | "NONCE_MISMATCH" | "INVOICE_MISMATCH" | "INVALID_SIGNATURE" | "NONCE_REUSED";
export type VerificationResult = { readonly ok: true; readonly amountSats: bigint } | { readonly ok: false; readonly code: VerificationFailureCode };
export function unsignedAuthorization(authorization: Authorization): UnsignedAuthorization {
  const { signature: _signature, ...unsigned } = authorization;
  return unsigned;
}
export const authorizationSigningMessage = (authorization: Authorization): string => canonicalize(unsignedAuthorization(authorization));

export interface VerifyAuthorizationInput {
  readonly invoice: Invoice; readonly authorization: Authorization; readonly request: ResourceRequest;
  readonly now: number; readonly signatureVerifier: SignatureVerifier; readonly nonceStore: NonceStore;
}
export async function verifyAuthorization(input: VerifyAuthorizationInput): Promise<VerificationResult> {
  const parsedInvoice = invoiceSchema.safeParse(input.invoice);
  const parsedAuthorization = authorizationSchema.safeParse(input.authorization);
  if (!parsedInvoice.success || !parsedAuthorization.success || !Number.isSafeInteger(input.now) || input.now < 0) return { ok: false, code: "MALFORMED" };
  const invoice = parsedInvoice.data;
  const authorization = parsedAuthorization.data;
  if (input.now < invoice.issuedAt) return { ok: false, code: "NOT_YET_VALID" };
  if (input.now >= invoice.expiresAt) return { ok: false, code: "EXPIRED" };
  let requestHash: string;
  try { requestHash = computeResourceHash(input.request); } catch { return { ok: false, code: "MALFORMED" }; }
  if (requestHash !== invoice.resourceHash || authorization.resourceHash !== invoice.resourceHash) return { ok: false, code: "RESOURCE_MISMATCH" };
  if (parseAmountSats(authorization.amountSats) !== parseAmountSats(invoice.amountSats)) return { ok: false, code: "AMOUNT_MISMATCH" };
  if (authorization.payTo !== invoice.payTo) return { ok: false, code: "PAY_TO_MISMATCH" };
  if (authorization.nonce !== invoice.nonce) return { ok: false, code: "NONCE_MISMATCH" };
  if (authorization.x402Version !== invoice.x402Version || authorization.scheme !== invoice.scheme || authorization.network !== invoice.network || authorization.invoiceHash !== computeInvoiceHash(invoice)) return { ok: false, code: "INVOICE_MISMATCH" };
  const signatureValid = await input.signatureVerifier.verify({ payer: authorization.payer, message: authorizationSigningMessage(authorization), signature: authorization.signature });
  if (!signatureValid) return { ok: false, code: "INVALID_SIGNATURE" };
  if (!await input.nonceStore.consume(invoice.nonce, invoice.expiresAt, input.now)) return { ok: false, code: "NONCE_REUSED" };
  return { ok: true, amountSats: parseAmountSats(invoice.amountSats) };
}
