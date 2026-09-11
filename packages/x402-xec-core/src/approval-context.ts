import { z } from "zod";
import { computeInvoiceHash } from "./invoice.js";
import {
  computeResourceHash,
  type ResourceRequest,
} from "./resource.js";
import {
  invoiceSchema,
  type Invoice,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
} from "./schemas.js";

const hash = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase SHA-256 hex");
const amount = z.string().regex(/^[1-9][0-9]*$/, "amountSats must be a canonical positive integer string");
const address = z.string().regex(/^ecash:[qp][a-z0-9]{41,}$/, "expected a lowercase prefixed eCash address");
const nonce = z.string().min(22).max(128).regex(/^[A-Za-z0-9_-]+$/, "nonce must be unpadded base64url");
const timestamp = z.number().int().nonnegative().safe();

export const x402ApprovalContextSchema = z.object({
  x402Version: z.literal(X402_VERSION),
  scheme: z.literal(XEC_SCHEME),
  network: z.literal(XEC_MAINNET),
  invoiceHash: hash,
  resourceHash: hash,
  amountSats: amount,
  payTo: address,
  nonce,
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine((value) => value.expiresAt > value.issuedAt, {
  message: "expiresAt must exceed issuedAt",
  path: ["expiresAt"],
});

export type X402ApprovalContext = z.infer<typeof x402ApprovalContextSchema>;

export function validateEpochClock(now: number): number {
  if (
    typeof now !== "number" ||
    !Number.isFinite(now) ||
    !Number.isInteger(now) ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new RangeError(
      "Clock must return a non-negative safe integer timestamp"
    );
  }
  return now;
}

export function createX402ApprovalContext(
  invoice: Invoice,
  resourceOrHash: ResourceRequest | string,
): X402ApprovalContext {
  const resourceHash = typeof resourceOrHash === "string"
    ? resourceOrHash
    : computeResourceHash(resourceOrHash);

  if (resourceHash !== invoice.resourceHash) {
    throw new Error(
      "Invoice resourceHash does not match calculated resourceHash"
    );
  }

  const invoiceHash = computeInvoiceHash(invoice);

  return x402ApprovalContextSchema.parse({
    x402Version: invoice.x402Version,
    scheme: invoice.scheme,
    network: invoice.network,
    invoiceHash,
    resourceHash,
    amountSats: invoice.amountSats,
    payTo: invoice.payTo,
    nonce: invoice.nonce,
    issuedAt: invoice.issuedAt,
    expiresAt: invoice.expiresAt,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResourceMetadata(input: unknown): ResourceRequest {
  if (!isRecord(input)) throw new Error("Invalid x402 resource metadata");
  const { serverOrigin, method, path, query, body } = input;
  if (
    typeof serverOrigin !== "string" ||
    typeof method !== "string" ||
    typeof path !== "string"
  ) {
    throw new Error("Invalid x402 resource metadata: required fields missing");
  }
  return {
    serverOrigin,
    method,
    path,
    ...(query === undefined ? {} : { query: query as any }),
    ...(body === undefined ? {} : { body: body as any }),
  };
}

export interface ValidatePaymentRequiredOptions {
  readonly now?: () => number;
  readonly expectedResource?: ResourceRequest;
}

export interface ValidatedPaymentRequiredResult {
  readonly invoice: Invoice;
  readonly resource: ResourceRequest;
  readonly approvalContext: X402ApprovalContext;
}

export function validatePaymentRequired(
  input: unknown,
  options: ValidatePaymentRequiredOptions = {},
): ValidatedPaymentRequiredResult {
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const now = validateEpochClock(clock());

  if (!isRecord(input)) {
    throw new Error("Invalid x402 payment required response: expected an object");
  }

  if (input.x402Version !== X402_VERSION) {
    throw new Error(
      `Unsupported x402 version: expected ${X402_VERSION}, got ${String(input.x402Version)}`
    );
  }

  const parsedInvoice = invoiceSchema.safeParse(input.invoice);
  if (!parsedInvoice.success) {
    throw new Error(
      `Invalid x402 invoice: ${parsedInvoice.error.issues[0]?.message ?? "malformed"}`
    );
  }
  const invoice = parsedInvoice.data;

  if (invoice.network !== XEC_MAINNET) {
    throw new Error(`Unsupported x402 network: ${invoice.network}`);
  }
  if (invoice.scheme !== XEC_SCHEME) {
    throw new Error(`Unsupported x402 invoice scheme: ${invoice.scheme}`);
  }

  if (now < invoice.issuedAt) {
    throw new Error("x402 invoice is not yet valid");
  }
  if (now >= invoice.expiresAt) {
    throw new Error("x402 invoice has expired");
  }

  const calculatedInvoiceHash = computeInvoiceHash(invoice);
  if (
    typeof input.invoiceId === "string" &&
    input.invoiceId !== calculatedInvoiceHash
  ) {
    throw new Error("Invoice hash mismatch against invoiceId");
  }

  const resource = parseResourceMetadata(input.resource);
  const calculatedResourceHash = computeResourceHash(resource);
  if (calculatedResourceHash !== invoice.resourceHash) {
    throw new Error("Resource hash mismatch against invoice.resourceHash");
  }

  if (options.expectedResource !== undefined) {
    const expectedHash = computeResourceHash(options.expectedResource);
    if (calculatedResourceHash !== expectedHash) {
      throw new Error("Resource does not match expected resource");
    }
  }

  const approvalContext = createX402ApprovalContext(invoice, calculatedResourceHash);

  return {
    invoice,
    resource,
    approvalContext,
  };
}
