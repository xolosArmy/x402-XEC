import {
  authorizationSchema,
  canonicalHash,
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
  invoiceSchema,
  normalizeMethod,
  normalizeServerOrigin,
  parseAmountSats,
  validatePath,
  X402_VERSION,
  type Authorization,
  type CanonicalValue,
  type Invoice,
  type ResourceRequest,
} from "@x402-xec/core";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const PAYMENT_HEADER = "payment-signature";
const DEFAULT_EXPIRY_SECONDS = 60;
const DEFAULT_MAX_PAYMENT_HEADER_BYTES = 16 * 1024;
const MAX_FACILITATOR_RESPONSE_BYTES = 64 * 1024;

export interface RoutePaymentConfig {
  readonly amountSats: string;
  readonly description?: string;
  readonly asset: "XEC";
  readonly network: "xec:mainnet";
  readonly scheme: "xec-prepaid-utxo";
}

export interface CreateX402XecMiddlewareConfig {
  readonly publicOrigin: string;
  readonly facilitatorUrl: string;
  readonly payTo: string;
  readonly routes: Record<string, RoutePaymentConfig>;
  readonly expirySeconds?: number;
  readonly maxPaymentHeaderBytes?: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

export type X402VerificationResult = Readonly<Record<string, unknown>>;

declare global {
  namespace Express {
    interface Request {
      x402?: X402VerificationResult;
    }
  }
}

interface ProtectedRoute {
  readonly method: string;
  readonly path: string;
  readonly payment: RoutePaymentConfig;
  readonly amountSats: bigint;
}

interface PaymentEnvelope {
  readonly invoice: Invoice;
  readonly authorization: Authorization;
  readonly idempotencyKey?: string;
}

export function createX402XecMiddleware(
  config: CreateX402XecMiddlewareConfig,
): RequestHandler {
  const publicOrigin = normalizeServerOrigin(config.publicOrigin);
  const facilitatorVerifyUrl = resolveFacilitatorVerifyUrl(config.facilitatorUrl);
  const routes = parseRoutes(config.routes);
  const payTo = invoiceSchema.shape.payTo.parse(config.payTo);
  const expirySeconds = positiveInteger(
    config.expirySeconds ?? DEFAULT_EXPIRY_SECONDS,
    "expirySeconds",
  );
  const maxPaymentHeaderBytes = positiveInteger(
    config.maxPaymentHeaderBytes ?? DEFAULT_MAX_PAYMENT_HEADER_BYTES,
    "maxPaymentHeaderBytes",
  );
  const now = config.now ?? (() => Math.floor(Date.now() / 1_000));
  const fetchImplementation = config.fetch ?? globalThis.fetch;

  if (typeof fetchImplementation !== "function") {
    throw new TypeError("a Fetch API implementation is required");
  }

  return async (request: Request, response: Response, next: NextFunction) => {
    const route = routes.get(routeKey(request.method, request.path));
    if (!route) {
      next();
      return;
    }

    let resource: ResourceRequest;
    try {
      resource = resourceForRequest(request, publicOrigin);
    } catch {
      paymentError(response, 400, "MALFORMED_RESOURCE", "Request body is not canonical JSON");
      return;
    }

    const header = request.get(PAYMENT_HEADER);
    if (header === undefined) {
      const issuedAt = checkedNow(now);
      const invoice = createInvoice({
        request: resource,
        amountSats: route.amountSats,
        payTo,
        nonce: randomBytes(24).toString("base64url"),
        issuedAt,
        expiresAt: issuedAt + expirySeconds,
      });
      response.status(402).json({
        x402Version: X402_VERSION,
        invoiceId: computeInvoiceHash(invoice),
        invoice,
        resource,
        accepts: [{
          asset: route.payment.asset,
          network: route.payment.network,
          scheme: route.payment.scheme,
          amountSats: invoice.amountSats,
          payTo: invoice.payTo,
          ...(route.payment.description === undefined
            ? {}
            : { description: route.payment.description }),
          paymentHeader: "PAYMENT-SIGNATURE",
        }],
      });
      return;
    }

    if (Buffer.byteLength(header, "utf8") > maxPaymentHeaderBytes) {
      paymentError(response, 402, "PAYMENT_HEADER_TOO_LARGE", "Payment header exceeds the configured limit");
      return;
    }

    let envelope: PaymentEnvelope;
    try {
      envelope = parsePaymentEnvelope(header);
    } catch {
      paymentError(response, 402, "MALFORMED_PAYMENT", "PAYMENT-SIGNATURE must contain base64url-encoded JSON");
      return;
    }

    const localFailure = validateEnvelope(
      envelope,
      resource,
      route,
      payTo,
      expirySeconds,
      checkedNow(now),
    );
    if (localFailure) {
      paymentError(response, localFailure.status, localFailure.code, localFailure.message);
      return;
    }

    const idempotencyKey = envelope.idempotencyKey
      ?? `x402-${canonicalHash(envelope.authorization)}`;

    let facilitatorResponse: globalThis.Response;
    try {
      facilitatorResponse = await fetchImplementation(facilitatorVerifyUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invoice: envelope.invoice,
          authorization: envelope.authorization,
          resource,
          idempotencyKey,
        }),
      });
    } catch {
      paymentError(response, 502, "FACILITATOR_UNAVAILABLE", "Facilitator verification request failed");
      return;
    }

    let result: unknown;
    try {
      const text = await facilitatorResponse.text();
      if (Buffer.byteLength(text, "utf8") > MAX_FACILITATOR_RESPONSE_BYTES) {
        throw new RangeError("facilitator response too large");
      }
      result = JSON.parse(text) as unknown;
    } catch {
      paymentError(response, 502, "FACILITATOR_ERROR", "Facilitator returned an invalid response");
      return;
    }

    if (facilitatorResponse.ok && isSuccessfulVerification(result)) {
      request.x402 = result;
      next();
      return;
    }

    const facilitatorCode = readStringProperty(result, "code") ?? "PAYMENT_INVALID";
    const status = facilitatorResponse.status === 403 ? 403 : 402;
    paymentError(response, status, facilitatorCode, "Facilitator rejected the payment");
  };
}

function parseRoutes(input: Record<string, RoutePaymentConfig>): Map<string, ProtectedRoute> {
  const routes = new Map<string, ProtectedRoute>();
  for (const [configuredKey, payment] of Object.entries(input)) {
    const match = /^(\S+)\s+(\S+)$/.exec(configuredKey);
    if (!match) throw new TypeError(`invalid route key: ${configuredKey}`);
    const method = normalizeMethod(match[1] ?? "");
    const path = validatePath(match[2] ?? "");
    if (
      payment.asset !== "XEC"
      || payment.network !== "xec:mainnet"
      || payment.scheme !== "xec-prepaid-utxo"
    ) {
      throw new TypeError(`unsupported payment configuration for ${configuredKey}`);
    }
    const amountSats = parseAmountSats(payment.amountSats);
    const key = routeKey(method, path);
    if (routes.has(key)) throw new TypeError(`duplicate route: ${key}`);
    routes.set(key, { method, path, payment, amountSats });
  }
  return routes;
}

function routeKey(method: string, path: string): string {
  return `${normalizeMethod(method)} ${path}`;
}

function resourceForRequest(request: Request, serverOrigin: string): ResourceRequest {
  const url = new URL(request.originalUrl, serverOrigin);
  const query = Array.from(url.searchParams, ([key, value]) => [key, value] as const);
  const body = canonicalBody(request.body);
  return {
    serverOrigin,
    method: normalizeMethod(request.method),
    path: validatePath(request.path),
    ...(query.length === 0 ? {} : { query }),
    ...(body === undefined ? {} : { body }),
  };
}

function canonicalBody(value: unknown): CanonicalValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => requiredCanonicalValue(item));
  if (typeof value === "object") {
    const output: Record<string, CanonicalValue> = Object.create(null) as Record<string, CanonicalValue>;
    for (const [key, item] of Object.entries(value)) {
      output[key] = requiredCanonicalValue(item);
    }
    return output;
  }
  throw new TypeError("body is not canonical JSON");
}

function requiredCanonicalValue(value: unknown): CanonicalValue {
  const result = canonicalBody(value);
  if (result === undefined) throw new TypeError("body contains undefined");
  return result;
}

function parsePaymentEnvelope(encoded: string): PaymentEnvelope {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TypeError("invalid base64url");
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded) as unknown;
  if (!isRecord(parsed)) throw new TypeError("payment envelope must be an object");
  const invoice = invoiceSchema.parse(parsed.invoice);
  const authorization = authorizationSchema.parse(parsed.authorization);
  const idempotencyKey = parsed.idempotencyKey;
  if (
    idempotencyKey !== undefined
    && (typeof idempotencyKey !== "string"
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey))
  ) {
    throw new TypeError("invalid idempotency key");
  }
  return {
    invoice,
    authorization,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function validateEnvelope(
  envelope: PaymentEnvelope,
  resource: ResourceRequest,
  route: ProtectedRoute,
  payTo: string,
  expirySeconds: number,
  now: number,
): { status: 402 | 403; code: string; message: string } | undefined {
  const { invoice, authorization } = envelope;
  if (now < invoice.issuedAt) {
    return { status: 402, code: "NOT_YET_VALID", message: "Invoice is not yet valid" };
  }
  if (now >= invoice.expiresAt) {
    return { status: 402, code: "EXPIRED", message: "Invoice has expired" };
  }
  if (invoice.expiresAt - invoice.issuedAt > expirySeconds) {
    return { status: 402, code: "INVALID_EXPIRY", message: "Invoice expiry exceeds the configured limit" };
  }
  if (invoice.resourceHash !== computeResourceHash(resource)) {
    return { status: 403, code: "RESOURCE_MISMATCH", message: "Invoice does not match this method, path, origin, query, or body" };
  }
  if (invoice.amountSats !== route.payment.amountSats) {
    return { status: 403, code: "AMOUNT_MISMATCH", message: "Invoice amount does not match the protected route" };
  }
  if (invoice.payTo !== payTo) {
    return { status: 403, code: "PAY_TO_MISMATCH", message: "Invoice recipient does not match the configured recipient" };
  }
  if (authorization.invoiceHash !== computeInvoiceHash(invoice)) {
    return { status: 403, code: "INVOICE_MISMATCH", message: "Authorization does not match the invoice" };
  }
  if (authorization.resourceHash !== invoice.resourceHash) {
    return { status: 403, code: "RESOURCE_MISMATCH", message: "Authorization does not match the protected resource" };
  }
  if (authorization.amountSats !== invoice.amountSats) {
    return { status: 403, code: "AMOUNT_MISMATCH", message: "Authorization amount does not match the invoice" };
  }
  if (authorization.payTo !== invoice.payTo) {
    return { status: 403, code: "PAY_TO_MISMATCH", message: "Authorization recipient does not match the invoice" };
  }
  if (authorization.nonce !== invoice.nonce) {
    return { status: 403, code: "NONCE_MISMATCH", message: "Authorization nonce does not match the invoice" };
  }
  if (
    authorization.x402Version !== invoice.x402Version
    || authorization.scheme !== invoice.scheme
    || authorization.network !== invoice.network
  ) {
    return { status: 403, code: "INVOICE_MISMATCH", message: "Authorization protocol fields do not match the invoice" };
  }
  return undefined;
}

function resolveFacilitatorVerifyUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("facilitatorUrl must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("facilitatorUrl must not contain credentials, query, or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/verify")
    ? path
    : path.endsWith("/facilitator")
      ? path + "/verify"
      : path + "/facilitator/verify";
  return url.toString();
}

function checkedNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("now must return non-negative epoch seconds");
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function isSuccessfulVerification(input: unknown): input is X402VerificationResult {
  return isRecord(input) && (
    (input.ok === true && input.status === "VERIFIED")
    || input.isValid === true
  );
}

function readStringProperty(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function paymentError(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({ x402Version: X402_VERSION, error: { code, message } });
}
