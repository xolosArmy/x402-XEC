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

export const PAYMENT_PROOF_HEADER = "payment-proof";
export const SETTLEMENT_PROOF_HEADER = "settlement-proof";
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

function parseRoutes(input: Record<string, SettlementRouteConfig>): Map<string, ProtectedRoute> {
  const routes = new Map<string, ProtectedRoute>();
  for (const [configuredKey, config] of Object.entries(input)) {
    const match = /^(\S+)\s+(\S+)$/.exec(configuredKey);
    if (!match) throw new TypeError(`invalid route key: ${configuredKey}`);
    const method = normalizeMethod(match[1] ?? "");
    const path = validatePath(match[2] ?? "");
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
    path: validatePath(request.path),
    ...(query.length === 0 ? {} : { query }),
    ...(body === undefined ? {} : { body }),
  };
}

function parseProofHeader(rawHeader: string): unknown {
  const trimmed = rawHeader.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  try {
    const decoded = Buffer.from(trimmed, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return JSON.parse(decoded);
  }
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
  const isProduction =
    config.production === true ||
    (config.production !== false && process.env.NODE_ENV === "production");

  if (isProduction) {
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
    const path = validatePath(request.path);
    const key = `${method} ${path}`;
    const route = routes.get(key);

    if (!route) {
      next();
      return;
    }

    const resource = resourceForRequest(request, publicOrigin);

    const rawHeader =
      request.get(PAYMENT_PROOF_HEADER) ??
      request.get(SETTLEMENT_PROOF_HEADER) ??
      request.get("x402-settlement-proof");

    // 1. Missing proof: issue authoritative invoice and respond 402
    if (!rawHeader) {
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

      response.setHeader("payment-required", "true");
      response.status(402).json({
        x402Version: X402_VERSION,
        invoiceId: invoiceHash,
        invoice,
        resource,
        accepts: [
          {
            asset: "XEC",
            network: XEC_MAINNET,
            scheme: "exact",
            amountSats: invoice.amountSats,
            payTo: invoice.payTo,
            proofHeader: PAYMENT_PROOF_HEADER,
            ...(route.description ? { description: route.description } : {}),
          },
        ],
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
