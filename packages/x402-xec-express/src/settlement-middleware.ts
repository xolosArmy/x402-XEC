/**
 * @file settlement-middleware.ts
 *
 * Gate C3B Express middleware for server-authoritative settlement proof verification
 * and resource unlocking.
 */

import {
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
  decodeCashAddress,
  invoiceSchema,
  normalizeMethod,
  normalizeServerOrigin,
  parseAmountSats,
  validatePath,
  verifySettlementProof,
  X402_VERSION,
  XEC_MAINNET,
  type AuthoritativeInvoiceStore,
  type CanonicalValue,
  type ChronikQueryTarget,
  type Invoice,
  type InvoicePayToAllocator,
  type ResourceRequest,
  type SettlementVerificationSuccess,
} from "@x402-xec/core";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  encodePaymentOfferHeader,
  X402_PAYMENT_OFFER_HEADER,
  type X402PaymentOffer,
} from "./payment-offer-header.js";

export const PAYMENT_PROOF_HEADER = "payment-proof";
export const SETTLEMENT_PROOF_HEADER = "settlement-proof";
const X402_SETTLEMENT_PROOF_HEADER = "x402-settlement-proof";
export const DEFAULT_EXPIRY_SECONDS = 60;

export interface SettlementRouteConfig {
  readonly amountSats: string;
  readonly description?: string | undefined;
  readonly asset?: "XEC" | undefined;
  readonly network?: "xec:mainnet" | undefined;
  readonly scheme?: "exact" | undefined;
}

export interface CreateX402SettlementMiddlewareConfig {
  readonly publicOrigin: string;
  readonly payTo?: string | undefined;
  readonly payToAllocator?: InvoicePayToAllocator | undefined;
  readonly routes: Record<string, SettlementRouteConfig>;
  readonly store: AuthoritativeInvoiceStore;
  readonly txProvider: ChronikQueryTarget;
  readonly expirySeconds?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly addressToScript?: ((address: string) => string) | undefined;
  /**
   * Explicit opt-out intended ONLY for unit tests or local development.
   * Unsafe behavior (such as non-durable stores or static payTo) may be enabled
   * ONLY when BOTH of the following conditions are met:
   * 1. allowInsecureDevelopmentMode === true
   * 2. process.env.NODE_ENV === "test" OR process.env.NODE_ENV === "development"
   *
   * In all other environments (undefined, empty, "production", "staging", etc.),
   * production-grade security is strictly enforced by default.
   */
  readonly allowInsecureDevelopmentMode?: boolean | undefined;
  /**
   * @deprecated Retained for backwards compatibility. Production-grade security
   * is now enabled by default regardless of this flag. It cannot weaken security.
   */
  readonly production?: boolean | undefined;
}

declare global {
  namespace Express {
    interface Request {
      x402Settlement?: SettlementVerificationSuccess | undefined;
    }
  }
}

interface ProtectedRoute {
  readonly method: string;
  readonly path: string;
  readonly amountSats: string;
  readonly description?: string | undefined;
}

/** Canonicalizes only the pathname used to decide whether a route is protected. */
function canonicalProtectedRoutePath(path: string): string {
  const validated = validatePath(path);
  if (validated === "/") return validated;
  return validated.replace(/\/+$/, "").toLowerCase();
}

function parseRoutes(input: Record<string, SettlementRouteConfig>): Map<string, ProtectedRoute> {
  const routes = new Map<string, ProtectedRoute>();
  for (const [configuredKey, config] of Object.entries(input)) {
    const match = /^(\S+)\s+(\S+)$/.exec(configuredKey);
    if (!match) throw new TypeError(`invalid route key: ${configuredKey}`);
    const method = normalizeMethod(match[1] ?? "");
    const path = canonicalProtectedRoutePath(match[2] ?? "");
    parseAmountSats(config.amountSats); // validates amount format
    const key = `${method} ${path}`;
    if (routes.has(key)) throw new TypeError(`duplicate route: ${key}`);
    routes.set(key, {
      method,
      path,
      amountSats: config.amountSats,
      description: config.description,
    });
  }
  return routes;
}

function canonicalBody(value: unknown): CanonicalValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("numbers must be finite for canonicalization");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const canonical = canonicalBody(item);
      return canonical === undefined ? null : canonical;
    });
  }
  if (typeof value === "object") {
    const sortedEntries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonicalBody(v) ?? null] as const);
    return Object.fromEntries(sortedEntries);
  }
  throw new TypeError(`unsupported body type: ${typeof value}`);
}

function resourceForRequest(request: Request, serverOrigin: string): ResourceRequest {
  const url = new URL(request.originalUrl || request.url, serverOrigin);
  const query = Array.from(url.searchParams, ([key, value]) => [key, value] as const);
  const body = canonicalBody(request.body);
  return {
    serverOrigin,
    method: normalizeMethod(request.method),
    path: validatePath(url.pathname),
    ...(query.length === 0 ? {} : { query }),
    ...(body === undefined ? {} : { body }),
  };
}

function headerValues(request: Request, name: string): readonly string[] | undefined {
  const value: string | string[] | undefined = request.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Detects HTTP framing that indicates a body without consuming the request stream.
 * Only one canonical Content-Length value of exactly "0" is bodyless. Any other
 * Content-Length form is positive, malformed, or ambiguous and therefore fails
 * closed. Transfer-Encoding coding names are case-insensitive and comma-separated;
 * because every non-empty coding frames a body, and malformed/empty forms are
 * ambiguous, any present Transfer-Encoding header fails closed as body-present.
 */
function requestIndicatesBody(request: Request): boolean {
  const contentLengths = headerValues(request, "content-length");
  if (contentLengths !== undefined) {
    if (contentLengths.length !== 1) return true;
    const contentLength = contentLengths[0]!;
    if (contentLength === "0") {
      // Continue: Transfer-Encoding, if also present, still indicates a body.
    } else if (/^[1-9][0-9]*$/.test(contentLength)) {
      return BigInt(contentLength) > 0n;
    } else {
      return true;
    }
  }

  const transferEncodings = headerValues(request, "transfer-encoding");
  if (transferEncodings === undefined) return false;

  // Parse all comma-separated coding tokens with case-insensitive semantics.
  // No recognized-coding allowlist is used: unfamiliar and malformed values
  // remain body-indicating at this security boundary.
  for (const value of transferEncodings) {
    for (const coding of value.split(",")) {
      if (coding.trim().toLowerCase().length > 0) return true;
    }
  }
  return true; // Present but empty/malformed is ambiguous, so fail closed.
}

function parseProofHeader(rawHeader: string): unknown {
  const trimmed = rawHeader.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  // Canonical base64url is unpadded. Exact round-tripping prevents Node's
  // permissive decoder from ignoring punctuation or accepting aliases.
  if (/^[A-Za-z0-9_-]+$/.test(rawHeader) && rawHeader.length % 4 !== 1) {
    const decoded = Buffer.from(rawHeader, "base64url");
    if (decoded.toString("base64url") !== rawHeader) {
      throw new TypeError("non-canonical base64url proof");
    }
    return JSON.parse(decoded.toString("utf8"));
  }

  // Standard base64 compatibility is retained, with RFC-style padding and
  // exact canonical round-tripping required.
  if (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(rawHeader) &&
    rawHeader.length > 0
  ) {
    const decoded = Buffer.from(rawHeader, "base64");
    if (decoded.toString("base64") !== rawHeader) {
      throw new TypeError("non-canonical base64 proof");
    }
    return JSON.parse(decoded.toString("utf8"));
  }

  throw new TypeError("proof must be raw JSON, canonical base64url, or canonical base64");
}

/**
 * Creates Express middleware that protects configured endpoints with Gate C3B
 * settlement proof verification.
 *
 * Missing proof: Issues server-authoritative invoice into `store` and responds HTTP 402.
 * Valid proof: Verifies against server `store` + server-owned Chronik `txProvider`,
 * atomically commits state to PAID, and calls next() to unlock the resource.
 */
export function createX402SettlementMiddleware(
  config: CreateX402SettlementMiddlewareConfig,
): RequestHandler {
  const env = process.env.NODE_ENV;
  const isInsecureDevModeAllowed =
    config.allowInsecureDevelopmentMode === true &&
    (env === "test" || env === "development");

  const requireProductionGuards = !isInsecureDevModeAllowed;

  if (requireProductionGuards) {
    if (!config.store.isDurable) {
      throw new TypeError(
        "Production real-funds middleware requires a durable authoritative store (isDurable: true). Process-local stores (InMemoryAuthoritativeInvoiceStore) are strictly rejected.",
      );
    }
    if (!config.payToAllocator) {
      throw new TypeError(
        "Production real-funds middleware requires a watch-only payToAllocator for unique per-invoice on-chain binding (P0). Static payTo is strictly prohibited in production.",
      );
    }
    if (config.addressToScript !== undefined) {
      throw new TypeError(
        "Production real-funds middleware strictly prohibits custom addressToScript converters. Custom addressToScript hooks are permitted only in test or development mode with allowInsecureDevelopmentMode: true.",
      );
    }
  }

  if (!config.payToAllocator && !config.payTo) {
    throw new TypeError("Either payToAllocator or payTo must be provided");
  }

  const publicOrigin = normalizeServerOrigin(config.publicOrigin);
  const routes = parseRoutes(config.routes);
  const staticPayTo = config.payTo
    ? invoiceSchema.shape.payTo.parse(config.payTo)
    : undefined;
  if (staticPayTo) {
    decodeCashAddress(staticPayTo);
  }
  const expirySeconds = config.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const method = normalizeMethod(request.method);
    const path = canonicalProtectedRoutePath(request.path);
    const key = `${method} ${path}`;
    const route = routes.get(key) ??
      (method === "HEAD" ? routes.get(`GET ${path}`) : undefined);

    if (!route) {
      next();
      return;
    }

    if (request.body === undefined && requestIndicatesBody(request)) {
      response.status(500).json({
        error: "UNPARSED_BODY_DETECTED",
        message: "Protected request body must be parsed before x402 settlement middleware",
      });
      return;
    }

    const resource = resourceForRequest(request, publicOrigin);

    const proofHeaders = [
      PAYMENT_PROOF_HEADER,
      SETTLEMENT_PROOF_HEADER,
      X402_SETTLEMENT_PROOF_HEADER,
    ]
      .map((name) => ({ name, value: request.get(name) }))
      .filter((header): header is { name: string; value: string } => header.value !== undefined);

    if (proofHeaders.length > 1) {
      response.status(400).json({
        error: "MALFORMED_PROOF",
        message: "Multiple proof header aliases are ambiguous",
      });
      return;
    }

    const rawHeader = proofHeaders[0]?.value;

    // 1. Missing proof: issue authoritative invoice and respond 402
    if (rawHeader === undefined) {
      const issuedAt = now();
      const expiresAt = issuedAt + expirySeconds;
      const nonce = randomBytes(24).toString("base64url");
      const resourceHash = computeResourceHash(resource);
      const amountSats = parseAmountSats(route.amountSats);

      let invoice: Invoice;
      let invoiceHash: string;

      if (config.payToAllocator) {
        const allocated = await config.store.issueWithAllocation(
          {
            nonce,
            resourceHash,
            amountSats,
            issuedAt,
            expiresAt,
            state: "ISSUED",
            network: XEC_MAINNET,
            scheme: "exact",
          },
          config.payToAllocator,
        );
        invoice = allocated.invoice;
        invoiceHash = allocated.record.invoiceHash;
      } else {
        invoice = createInvoice({
          request: resource,
          amountSats,
          payTo: staticPayTo!,
          nonce,
          issuedAt,
          expiresAt,
        });

        invoiceHash = computeInvoiceHash(invoice);

        await config.store.issue({
          invoiceHash,
          nonce: invoice.nonce,
          resourceHash: invoice.resourceHash,
          amountSats: BigInt(invoice.amountSats),
          payTo: invoice.payTo,
          network: XEC_MAINNET,
          scheme: "exact",
          issuedAt: invoice.issuedAt,
          expiresAt: invoice.expiresAt,
          state: "ISSUED",
        });
      }

      const accepts: X402PaymentOffer["accepts"] = [
        {
          asset: "XEC",
          network: XEC_MAINNET,
          scheme: "exact",
          amountSats: invoice.amountSats,
          payTo: invoice.payTo,
          proofHeader: PAYMENT_PROOF_HEADER,
          ...(route.description ? { description: route.description } : {}),
        },
      ];
      const paymentOffer: X402PaymentOffer = {
        x402Version: X402_VERSION,
        invoiceId: invoiceHash,
        invoice,
        accepts,
      };

      let encodedPaymentOffer: string;
      try {
        encodedPaymentOffer = encodePaymentOfferHeader(paymentOffer);
      } catch {
        response.status(500).json({
          error: "PAYMENT_OFFER_ENCODING_FAILED",
          message: "Server could not emit a bounded canonical payment offer",
        });
        return;
      }

      response.setHeader("payment-required", "true");
      response.setHeader(X402_PAYMENT_OFFER_HEADER, encodedPaymentOffer);
      response.status(402).json({
        x402Version: paymentOffer.x402Version,
        invoiceId: paymentOffer.invoiceId,
        invoice: paymentOffer.invoice,
        resource,
        accepts: paymentOffer.accepts,
      });
      return;
    }

    // 2. Proof header is present: parse and verify
    let proofObj: unknown;
    try {
      proofObj = parseProofHeader(rawHeader);
    } catch {
      response.status(400).json({
        error: "MALFORMED_PROOF",
        message: "Failed to parse proof header JSON",
      });
      return;
    }

    const result = await verifySettlementProof({
      proof: proofObj,
      expectedResource: resource,
      store: config.store,
      txProvider: config.txProvider,
      now,
      addressToScript: config.addressToScript,
    });

    if (!result.ok) {
      response.status(result.httpStatus).json({
        error: result.code,
        message: result.message,
      });
      return;
    }

    // Attach verified settlement details and unlock resource
    request.x402 = result;
    request.x402Settlement = result;
    next();
  };
}
