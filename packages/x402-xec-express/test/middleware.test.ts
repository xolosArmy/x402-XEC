import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import test from "node:test";
import {
  computeInvoiceHash,
  createInvoice,
  X402_VERSION,
  XEC_MAINNET,
  XEC_SCHEME,
  type Authorization,
  type Invoice,
} from "@x402-xec/core";
import express, { type Express } from "express";
import { createX402XecMiddleware } from "../src/index.js";

const NOW = 1_800_000_000;
const PUBLIC_ORIGIN = "https://api.example.com";
const PAY_TO = `ecash:q${"a".repeat(41)}`;
const OTHER_PAY_TO = `ecash:q${"c".repeat(41)}`;
const PAYER = `ecash:q${"b".repeat(41)}`;
const TXID = "d".repeat(64);
const ROUTE = {
  amountSats: "1000",
  asset: "XEC",
  network: "xec:mainnet",
  scheme: "xec-prepaid-utxo",
} as const;

interface StartedApp {
  readonly origin: string;
  close(): Promise<void>;
}

interface Offer {
  readonly x402Version: number;
  readonly invoiceId: string;
  readonly invoice: Invoice;
  readonly resource: {
    readonly serverOrigin: string;
    readonly method: string;
    readonly path: string;
  };
  readonly accepts: readonly Record<string, unknown>[];
}

function makeAuthorization(invoice: Invoice): Authorization {
  return {
    x402Version: X402_VERSION,
    scheme: XEC_SCHEME,
    network: XEC_MAINNET,
    invoiceHash: computeInvoiceHash(invoice),
    resourceHash: invoice.resourceHash,
    amountSats: invoice.amountSats,
    payTo: invoice.payTo,
    nonce: invoice.nonce,
    payer: PAYER,
    transaction: { txid: TXID, vout: 0 },
    signature: "mock_signature",
  };
}

function paymentHeader(invoice: Invoice, authorization = makeAuthorization(invoice)): string {
  return Buffer.from(JSON.stringify({ invoice, authorization }), "utf8").toString("base64url");
}

async function startApp(app: Express): Promise<StartedApp> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function getOffer(origin: string, path = "/weather"): Promise<Offer> {
  const response = await fetch(`${origin}${path}`, {
    headers: { host: "attacker.invalid" },
  });
  assert.equal(response.status, 402);
  return response.json() as Promise<Offer>;
}

test("unprotected routes pass without a payment", async (t) => {
  let handlerCalls = 0;
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://127.0.0.1:4020",
    payTo: PAY_TO,
    routes: { "GET /weather": ROUTE },
    now: () => NOW,
    fetch: async () => {
      throw new Error("facilitator should not be called");
    },
  }));
  app.get("/health", (_request, response) => {
    handlerCalls += 1;
    response.json({ ok: true });
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(handlerCalls, 1);
});

test("protected route without payment returns a bound 402 offer and skips the handler", async (t) => {
  let handlerCalls = 0;
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://127.0.0.1:4020",
    payTo: PAY_TO,
    routes: { "GET /weather": { ...ROUTE, description: "Forecast" } },
    now: () => NOW,
    fetch: async () => {
      throw new Error("facilitator should not be called");
    },
  }));
  app.get("/weather", (_request, response) => {
    handlerCalls += 1;
    response.json({ weather: "sunny" });
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const offer = await getOffer(server.origin, "/weather?city=merida");

  assert.equal(offer.x402Version, 1);
  assert.equal(offer.invoiceId, computeInvoiceHash(offer.invoice));
  assert.match(offer.invoice.resourceHash, /^[0-9a-f]{64}$/);
  assert.match(offer.invoice.nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(offer.invoice.expiresAt, NOW + 60);
  assert.equal(offer.invoice.amountSats, "1000");
  assert.equal(offer.invoice.payTo, PAY_TO);
  assert.equal(offer.resource.serverOrigin, PUBLIC_ORIGIN);
  assert.equal(offer.resource.method, "GET");
  assert.equal(offer.resource.path, "/weather");
  assert.deepEqual(offer.accepts[0], {
    asset: "XEC",
    network: "xec:mainnet",
    scheme: "xec-prepaid-utxo",
    amountSats: "1000",
    payTo: PAY_TO,
    description: "Forecast",
    paymentHeader: "PAYMENT-SIGNATURE",
  });
  assert.equal(handlerCalls, 0);
});

test("invalid facilitator response does not call the protected handler", async (t) => {
  let handlerCalls = 0;
  let facilitatorCalls = 0;
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://facilitator.local",
    payTo: PAY_TO,
    routes: { "GET /weather": ROUTE },
    now: () => NOW,
    fetch: async () => {
      facilitatorCalls += 1;
      return new Response(JSON.stringify({ ok: false, code: "INVALID_SIGNATURE" }), {
        status: 400,
      });
    },
  }));
  app.get("/weather", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());
  const offer = await getOffer(server.origin);

  const response = await fetch(`${server.origin}/weather`, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader(offer.invoice) },
  });

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), {
    x402Version: 1,
    error: {
      code: "INVALID_SIGNATURE",
      message: "Facilitator rejected the payment",
    },
  });
  assert.equal(facilitatorCalls, 1);
  assert.equal(handlerCalls, 0);
});

test("valid mock facilitator response attaches req.x402 and calls the handler", async (t) => {
  let handlerCalls = 0;
  let requestedUrl = "";
  let verifyRequest: Record<string, unknown> | undefined;
  const verification = { isValid: true, invoiceId: "verified-invoice" };
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://facilitator.local/",
    payTo: PAY_TO,
    routes: { "GET /weather": ROUTE },
    now: () => NOW,
    fetch: async (input, init) => {
      requestedUrl = String(input);
      verifyRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(verification), { status: 200 });
    },
  }));
  app.get("/weather", (request, response) => {
    handlerCalls += 1;
    response.json(request.x402);
  });
  const server = await startApp(app);
  t.after(() => server.close());
  const offer = await getOffer(server.origin);

  const response = await fetch(`${server.origin}/weather`, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader(offer.invoice) },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), verification);
  assert.equal(handlerCalls, 1);
  assert.equal(requestedUrl, "http://facilitator.local/facilitator/verify");
  assert.deepEqual(verifyRequest?.resource, offer.resource);
});

test("method/path mismatch is rejected before facilitator verification", async (t) => {
  let handlerCalls = 0;
  let facilitatorCalls = 0;
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://facilitator.local",
    payTo: PAY_TO,
    routes: {
      "GET /weather": ROUTE,
      "POST /weather": ROUTE,
    },
    now: () => NOW,
    fetch: async () => {
      facilitatorCalls += 1;
      return new Response(JSON.stringify({ isValid: true }));
    },
  }));
  app.use("/weather", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());
  const offer = await getOffer(server.origin);

  const response = await fetch(`${server.origin}/weather`, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": paymentHeader(offer.invoice) },
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "RESOURCE_MISMATCH");
  assert.equal(facilitatorCalls, 0);
  assert.equal(handlerCalls, 0);
});

test("expired invoices are rejected before facilitator verification", async (t) => {
  let currentTime = NOW;
  let facilitatorCalls = 0;
  let handlerCalls = 0;
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://facilitator.local",
    payTo: PAY_TO,
    routes: { "GET /weather": ROUTE },
    expirySeconds: 10,
    now: () => currentTime,
    fetch: async () => {
      facilitatorCalls += 1;
      return new Response(JSON.stringify({ isValid: true }));
    },
  }));
  app.get("/weather", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());
  const offer = await getOffer(server.origin);
  currentTime = NOW + 10;

  const response = await fetch(`${server.origin}/weather`, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader(offer.invoice) },
  });

  assert.equal(response.status, 402);
  assert.equal((await response.json() as { error: { code: string } }).error.code, "EXPIRED");
  assert.equal(facilitatorCalls, 0);
  assert.equal(handlerCalls, 0);
});

test("amount and payTo substitutions are rejected locally", async (t) => {
  let facilitatorCalls = 0;
  const app = express();
  app.use(createX402XecMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    facilitatorUrl: "http://facilitator.local",
    payTo: PAY_TO,
    routes: { "GET /weather": ROUTE },
    now: () => NOW,
    fetch: async () => {
      facilitatorCalls += 1;
      return new Response(JSON.stringify({ isValid: true }));
    },
  }));
  app.get("/weather", (_request, response) => response.sendStatus(204));
  const server = await startApp(app);
  t.after(() => server.close());
  const offer = await getOffer(server.origin);

  const substitutedAmount = createInvoice({
    request: offer.resource,
    amountSats: 1n,
    payTo: PAY_TO,
    nonce: offer.invoice.nonce,
    issuedAt: offer.invoice.issuedAt,
    expiresAt: offer.invoice.expiresAt,
  });
  const amountResponse = await fetch(`${server.origin}/weather`, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader(substitutedAmount) },
  });
  assert.equal(amountResponse.status, 403);
  assert.equal(
    (await amountResponse.json() as { error: { code: string } }).error.code,
    "AMOUNT_MISMATCH",
  );

  const substitutedPayTo = createInvoice({
    request: offer.resource,
    amountSats: 1_000n,
    payTo: OTHER_PAY_TO,
    nonce: offer.invoice.nonce,
    issuedAt: offer.invoice.issuedAt,
    expiresAt: offer.invoice.expiresAt,
  });
  const payToResponse = await fetch(`${server.origin}/weather`, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader(substitutedPayTo) },
  });
  assert.equal(payToResponse.status, 403);
  assert.equal(
    (await payToResponse.json() as { error: { code: string } }).error.code,
    "PAY_TO_MISMATCH",
  );
  assert.equal(facilitatorCalls, 0);
});
