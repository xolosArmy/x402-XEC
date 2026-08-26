import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import {
  createPaymentRequired,
  encodePaymentRequired,
  type ExperimentalPaymentRequired,
} from "./payment-required.js";
import { DEFAULT_PUBLIC_ORIGIN } from "./config.js";

export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PUBLIC_ORIGIN,
} from "./config.js";

export const GATE = "H2A";
export const HEALTH_PATH = "/health";
export const RESOURCE_PATH = "/v1/resource/demo";
export const ALLOWED_ORIGIN = "https://x402.ecash.mx";
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

const ALLOWED_OPTIONS_PATHS = new Set([HEALTH_PATH, RESOURCE_PATH]);

export interface GateH2AHandler {
  readonly handler: RequestListener;
  readonly canonicalResourceUrl: string;
  readonly paymentRequired: ExperimentalPaymentRequired;
  readonly encodedPaymentRequired: string;
}

export interface GateH2AHandlerOptions {
  readonly publicOrigin?: string;
}

export function createGateH2AHandler(
  options: GateH2AHandlerOptions = {},
): GateH2AHandler {
  const publicOrigin = canonicalOrigin(options.publicOrigin ?? DEFAULT_PUBLIC_ORIGIN);
  const canonicalResourceUrl = new URL(RESOURCE_PATH, `${publicOrigin}/`).toString();
  const paymentRequired = createPaymentRequired(canonicalResourceUrl);
  const encodedPaymentRequired = encodePaymentRequired(paymentRequired);
  const handler: RequestListener = (request, response) => {
    handleRequest(request, response, encodedPaymentRequired);
  };

  return { handler, canonicalResourceUrl, paymentRequired, encodedPaymentRequired };
}

function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  encodedPaymentRequired: string,
): void {
  response.setHeader("Vary", "Origin");
  const origin = singleHeader(request.headers.origin);

  if (origin === ALLOWED_ORIGIN) {
    response.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    response.setHeader("Access-Control-Expose-Headers", PAYMENT_REQUIRED_HEADER);
  }

  const pathname = requestPathname(request.url);
  if (request.method === "OPTIONS") {
    handleOptions(request, response, pathname, origin);
    return;
  }

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET, OPTIONS");
    writeJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
    return;
  }

  if (pathname === HEALTH_PATH) {
    writeJson(response, 200, { status: "ok", gate: GATE });
    return;
  }

  if (pathname === RESOURCE_PATH) {
    response.setHeader(PAYMENT_REQUIRED_HEADER, encodedPaymentRequired);

    if (request.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()] !== undefined) {
      writeJson(response, 402, {
        error: "PAYMENT_NOT_IMPLEMENTED_IN_H2A",
        message:
          "Gate H2A advertises payment requirements but does not verify or settle payments.",
      });
      return;
    }

    writeJson(response, 402, {
      error: "PAYMENT_REQUIRED",
      message: "PAYMENT-SIGNATURE header is required",
    });
    return;
  }

  writeJson(response, 404, { error: "NOT_FOUND" });
}

function handleOptions(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  origin: string | undefined,
): void {
  if (!ALLOWED_OPTIONS_PATHS.has(pathname)) {
    writeJson(response, 404, { error: "NOT_FOUND" });
    return;
  }

  if (origin !== ALLOWED_ORIGIN) {
    writeJson(response, 403, { error: "CORS_ORIGIN_NOT_ALLOWED" });
    return;
  }

  const requestedMethod = singleHeader(
    request.headers["access-control-request-method"],
  );
  if (requestedMethod !== "GET") {
    writeJson(response, 405, { error: "CORS_METHOD_NOT_ALLOWED" });
    return;
  }

  const requestedHeaders = parseRequestedHeaders(
    singleHeader(request.headers["access-control-request-headers"]),
  );
  const allowedHeaders = pathname === RESOURCE_PATH
    ? [PAYMENT_SIGNATURE_HEADER.toLowerCase()]
    : [];
  if (requestedHeaders.some((header) => !allowedHeaders.includes(header))) {
    writeJson(response, 400, { error: "CORS_HEADER_NOT_ALLOWED" });
    return;
  }

  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (allowedHeaders.length > 0) {
    response.setHeader("Access-Control-Allow-Headers", PAYMENT_SIGNATURE_HEADER);
  }
  response.statusCode = 204;
  response.end();
}

function parseRequestedHeaders(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
}

function canonicalOrigin(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.pathname !== "/"
    || url.search
    || url.hash
    || url.username
    || url.password
  ) {
    throw new Error("Gate H2A publicOrigin must be an absolute origin without credentials or a path");
  }
  return url.origin;
}

function requestPathname(requestUrl: string | undefined): string {
  try {
    return new URL(requestUrl ?? "/", "http://gate-h2a.invalid").pathname;
  } catch {
    return "/invalid-request-target";
  }
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  const json = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(json));
  response.end(json);
}
