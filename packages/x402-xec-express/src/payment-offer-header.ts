import {
  canonicalize,
  computeInvoiceHash,
  invoiceSchema,
  X402_VERSION,
  XEC_MAINNET,
  type CanonicalValue,
  type Invoice,
} from "@x402-xec/core";

export const X402_PAYMENT_OFFER_HEADER = "x-x402-payment-offer";
export const MAX_X402_PAYMENT_OFFER_HEADER_LENGTH = 4096;

export interface X402PaymentOfferAccept {
  readonly asset: "XEC";
  readonly network: "xec:mainnet";
  readonly scheme: "exact";
  readonly amountSats: string;
  readonly payTo: string;
  readonly proofHeader: "payment-proof";
  readonly description?: string | undefined;
}

export interface X402PaymentOffer {
  readonly x402Version: 1;
  readonly invoiceId: string;
  readonly invoice: Invoice;
  readonly accepts: readonly [X402PaymentOfferAccept];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function parsePaymentOffer(value: unknown): X402PaymentOffer {
  if (!isRecord(value) || !hasExactKeys(value, ["x402Version", "invoiceId", "invoice", "accepts"])) {
    throw new TypeError("payment offer must contain only the required top-level fields");
  }
  if (value.x402Version !== X402_VERSION) {
    throw new TypeError(`payment offer x402Version must be ${X402_VERSION}`);
  }
  if (typeof value.invoiceId !== "string" || !/^[0-9a-f]{64}$/.test(value.invoiceId)) {
    throw new TypeError("payment offer invoiceId must be lowercase SHA-256 hex");
  }

  const parsedInvoice = invoiceSchema.safeParse(value.invoice);
  if (!parsedInvoice.success) {
    throw new TypeError(`payment offer invoice is invalid: ${parsedInvoice.error.message}`);
  }
  if (computeInvoiceHash(parsedInvoice.data) !== value.invoiceId) {
    throw new TypeError("payment offer invoiceId does not match its invoice");
  }

  if (!Array.isArray(value.accepts) || value.accepts.length !== 1) {
    throw new TypeError("payment offer accepts must contain exactly one entry");
  }
  const accept = value.accepts[0];
  if (
    !isRecord(accept) ||
    !hasExactKeys(
      accept,
      ["asset", "network", "scheme", "amountSats", "payTo", "proofHeader"],
      ["description"],
    )
  ) {
    throw new TypeError("payment offer accept entry has invalid fields");
  }
  if (
    accept.asset !== "XEC" ||
    accept.network !== XEC_MAINNET ||
    accept.scheme !== "exact" ||
    accept.proofHeader !== "payment-proof" ||
    accept.amountSats !== parsedInvoice.data.amountSats ||
    accept.payTo !== parsedInvoice.data.payTo ||
    (accept.description !== undefined && typeof accept.description !== "string")
  ) {
    throw new TypeError("payment offer accept entry is inconsistent with its invoice");
  }

  return {
    x402Version: X402_VERSION,
    invoiceId: value.invoiceId,
    invoice: parsedInvoice.data,
    accepts: [{
      asset: "XEC",
      network: XEC_MAINNET,
      scheme: "exact",
      amountSats: parsedInvoice.data.amountSats,
      payTo: parsedInvoice.data.payTo,
      proofHeader: "payment-proof",
      ...(accept.description === undefined ? {} : { description: accept.description }),
    }],
  };
}

/** Encodes a strict compact payment offer as canonical JSON and unpadded base64url. */
export function encodePaymentOfferHeader(offer: X402PaymentOffer): string {
  const parsed = parsePaymentOffer(offer);
  const canonicalJson = canonicalize(parsed as unknown as CanonicalValue);
  const encoded = Buffer.from(canonicalJson, "utf8").toString("base64url");
  if (encoded.length > MAX_X402_PAYMENT_OFFER_HEADER_LENGTH) {
    throw new RangeError(
      `encoded payment offer exceeds ${MAX_X402_PAYMENT_OFFER_HEADER_LENGTH} characters`,
    );
  }
  return encoded;
}

/** Strictly decodes canonical, unpadded base64url payment-offer transport. */
export function decodePaymentOfferHeader(encoded: string): X402PaymentOffer {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_X402_PAYMENT_OFFER_HEADER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    throw new TypeError("payment offer header is not canonical unpadded base64url");
  }

  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw new TypeError("payment offer header has non-canonical base64url encoding");
  }
  const json = bytes.toString("utf8");
  if (!Buffer.from(json, "utf8").equals(bytes)) {
    throw new TypeError("payment offer header is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TypeError("payment offer header does not contain valid JSON");
  }
  const parsed = parsePaymentOffer(value);
  if (encodePaymentOfferHeader(parsed) !== encoded) {
    throw new TypeError("payment offer header JSON is not canonical");
  }
  return parsed;
}
