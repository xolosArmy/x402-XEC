import assert from "node:assert/strict";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  assertDisplayAmountMatchesAtomic,
  FIXTURE_PAY_TO,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_DISPLAY_AMOUNT,
  type ExperimentalPaymentRequired,
} from "../src/payment-required.js";
import {
  ALLOWED_ORIGIN,
  createGateH2AHandler,
  PAYMENT_REQUIRED_HEADER,
} from "../src/server.js";

const TEST_PUBLIC_ORIGIN = "https://h2a.test";
const EXPECTED_RESOURCE_URL = `${TEST_PUBLIC_ORIGIN}/v1/resource/demo`;

interface HttpResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

test("health endpoint returns the Gate H2A status", async (t) => {
  const server = await startTestServer();
  t.after(() => close(server));

  const response = await request(server, "/health");

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ok", gate: "H2A" });
});

test("demo resource returns deterministic PaymentRequired transport data", async (t) => {
  const server = await startTestServer();
  t.after(() => close(server));

  const response = await request(server, "/v1/resource/demo", {
    headers: { Origin: ALLOWED_ORIGIN },
  });
  const header = requiredHeader(response.headers, PAYMENT_REQUIRED_HEADER);
  const decoded = decodePaymentRequired(header);

  assert.equal(response.status, 402);
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.error, "PAYMENT-SIGNATURE header is required");
  assert.deepEqual(decoded.resource, {
    url: EXPECTED_RESOURCE_URL,
    description: "x402eCash WebMCP Challenge demo resource",
    mimeType: "application/json",
    serviceName: "x402eCash",
  });
  assert.equal(decoded.accepts.length, 1);
  assert.deepEqual(decoded.accepts[0], {
    scheme: "xec-prepaid-utxo",
    network: "xec:mainnet",
    amount: "10000",
    asset: "XEC",
    payTo: FIXTURE_PAY_TO,
    maxTimeoutSeconds: 60,
    extra: {
      displayAmount: "100 XEC",
      experimental: true,
      gate: "H2A",
    },
  });
  assert.deepEqual(decoded.extensions, {});
  assert.deepEqual(JSON.parse(response.body), {
    error: "PAYMENT_REQUIRED",
    message: "PAYMENT-SIGNATURE header is required",
  });
  assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(
    response.headers["access-control-expose-headers"],
    PAYMENT_REQUIRED_HEADER,
  );
  assert.equal(response.headers.vary, "Origin");
  assert.notEqual(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["access-control-allow-credentials"], undefined);
});

test("display and atomic XEC amounts cannot silently diverge", () => {
  assert.doesNotThrow(() => {
    assertDisplayAmountMatchesAtomic(PAYMENT_DISPLAY_AMOUNT, PAYMENT_AMOUNT_ATOMIC);
  });
  assert.throws(
    () => assertDisplayAmountMatchesAtomic("100 XEC", "9999"),
    /does not match/,
  );
});

test("PAYMENT-SIGNATURE cannot unlock the protected resource", async (t) => {
  const server = await startTestServer();
  t.after(() => close(server));

  const response = await request(server, "/v1/resource/demo", {
    headers: {
      Origin: ALLOWED_ORIGIN,
      "PAYMENT-SIGNATURE": "deterministic-nonpayment-fixture",
    },
  });

  assert.equal(response.status, 402);
  assert.ok(requiredHeader(response.headers, PAYMENT_REQUIRED_HEADER));
  assert.deepEqual(JSON.parse(response.body), {
    error: "PAYMENT_NOT_IMPLEMENTED_IN_H2A",
    message:
      "Gate H2A advertises payment requirements but does not verify or settle payments.",
  });
  assert.doesNotMatch(response.body, /protected resource|unlocked|success/i);
});

test("permitted CORS preflight allows only Gate H2A requirements", async (t) => {
  const server = await startTestServer();
  t.after(() => close(server));

  const response = await request(server, "/v1/resource/demo", {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "PAYMENT-SIGNATURE",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(response.headers["access-control-allow-methods"], "GET, OPTIONS");
  assert.equal(response.headers["access-control-allow-headers"], "PAYMENT-SIGNATURE");
  assert.equal(
    response.headers["access-control-expose-headers"],
    PAYMENT_REQUIRED_HEADER,
  );
  assert.equal(response.headers.vary, "Origin");
  assert.equal(response.headers["access-control-allow-credentials"], undefined);

  const healthWithPaymentHeader = await request(server, "/health", {
    method: "OPTIONS",
    headers: {
      Origin: ALLOWED_ORIGIN,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "PAYMENT-SIGNATURE",
    },
  });
  assert.equal(healthWithPaymentHeader.status, 400);
});

test("demo requests perform no outbound fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  let outboundFetches = 0;
  globalThis.fetch = (async () => {
    outboundFetches += 1;
    throw new Error("unexpected outbound fetch");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const server = await startTestServer();
  t.after(() => close(server));

  const unsigned = await request(server, "/v1/resource/demo");
  const signed = await request(server, "/v1/resource/demo", {
    headers: { "PAYMENT-SIGNATURE": "ignored" },
  });

  assert.equal(unsigned.status, 402);
  assert.equal(signed.status, 402);
  assert.equal(outboundFetches, 0);
});

function decodePaymentRequired(value: string): ExperimentalPaymentRequired {
  return JSON.parse(
    Buffer.from(value, "base64").toString("utf8"),
  ) as ExperimentalPaymentRequired;
}

async function startTestServer(): Promise<Server> {
  const { handler } = createGateH2AHandler({ publicOrigin: TEST_PUBLIC_ORIGIN });
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function request(
  server: Server,
  path: string,
  options: { readonly method?: string; readonly headers?: OutgoingHttpHeaders } = {},
): Promise<HttpResult> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server has no TCP address");
  }
  const { port } = address as AddressInfo;

  return new Promise((resolve, reject) => {
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: options.method ?? "GET",
      ...(options.headers ? { headers: options.headers } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    clientRequest.once("error", reject);
    clientRequest.end();
  });
}

function requiredHeader(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  assert.equal(typeof value, "string", `${name} header must exist exactly once`);
  return value;
}
