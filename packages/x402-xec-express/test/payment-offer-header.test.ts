import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import test from "node:test";
import {
  canonicalize,
  cashAddressToOutputScriptHex,
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
  InMemoryAuthoritativeInvoiceStore,
  type AuthoritativeInvoiceRecord,
  type CanonicalValue,
  type ChronikTransaction,
  type TxProvider,
} from "@x402-xec/core";
import express, { type Express } from "express";
import {
  createX402SettlementMiddleware,
  decodePaymentOfferHeader,
  encodePaymentOfferHeader,
  MAX_X402_PAYMENT_OFFER_HEADER_LENGTH,
  X402_PAYMENT_OFFER_HEADER,
  type SettlementRouteConfig,
  type X402PaymentOffer,
} from "../src/index.js";

process.env.NODE_ENV = "test";

const PUBLIC_ORIGIN = "https://api.example.com";
const PAY_TO = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const PAY_TO_SCRIPT = cashAddressToOutputScriptHex(PAY_TO);
const NOW = 1_800_000_000;
const TXID = "33".repeat(32);

class CountingTxProvider implements TxProvider {
  queryCount = 0;

  async getTx(txid: string): Promise<ChronikTransaction> {
    this.queryCount += 1;
    return {
      txid,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
      isFinal: true,
      timeFirstSeen: NOW,
    };
  }
}

class CapturingStore extends InMemoryAuthoritativeInvoiceStore {
  readonly issued: AuthoritativeInvoiceRecord[] = [];

  override async issue(record: AuthoritativeInvoiceRecord): Promise<void> {
    await super.issue(record);
    this.issued.push({ ...record });
  }
}

async function startApp(app: Express) {
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

function installErrorObserver(app: Express): void {
  app.use((_request, response, next) => {
    const json = response.json.bind(response);
    response.json = ((body: any) => {
      if (body?.error !== undefined) {
        response.setHeader("x-test-error", String(body.error));
      }
      return json(body);
    }) as typeof response.json;
    next();
  });
}

function middleware(
  store: InMemoryAuthoritativeInvoiceStore,
  txProvider: CountingTxProvider,
  routes: Record<string, SettlementRouteConfig>,
) {
  return createX402SettlementMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    payTo: PAY_TO,
    allowInsecureDevelopmentMode: true,
    routes,
    store,
    txProvider,
    now: () => NOW,
  });
}

function proof(invoiceId: string) {
  return {
    x402Version: 1,
    network: "xec:mainnet",
    invoiceHash: invoiceId,
    txid: TXID,
  };
}

function readOffer(response: Response): X402PaymentOffer {
  const encoded = response.headers.get(X402_PAYMENT_OFFER_HEADER);
  assert.ok(encoded);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(encoded.length <= MAX_X402_PAYMENT_OFFER_HEADER_LENGTH);
  return decodePaymentOfferHeader(encoded);
}

async function assertIssued(
  store: InMemoryAuthoritativeInvoiceStore,
  invoiceId: string,
) {
  const record = await store.getByInvoiceHash(invoiceId);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid, undefined);
}

test("4055341610: HEAD receives an observable authoritative compact offer", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider, {
    "GET /protected": { amountSats: "1000", description: "Protected HEAD" },
  }));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/protected`, { method: "HEAD" });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), "true");
  assert.equal(await response.text(), "");
  assert.equal(handlerCalls, 0);

  const offer = readOffer(response);
  assert.match(offer.invoiceId, /^[0-9a-f]{64}$/);
  assert.equal(offer.invoice.amountSats, "1000");
  assert.equal(offer.invoice.payTo, PAY_TO);
  assert.match(offer.invoice.nonce, /^[A-Za-z0-9_-]+$/);
  assert.equal(offer.invoice.issuedAt, NOW);
  assert.equal(offer.invoice.expiresAt, NOW + 60);
  assert.equal(offer.accepts[0].proofHeader, "payment-proof");
  assert.equal(computeInvoiceHash(offer.invoice), offer.invoiceId);
  assert.equal(Object.hasOwn(offer, "resource"), false);

  const persisted = await store.getByInvoiceHash(offer.invoiceId);
  assert.ok(persisted);
  assert.equal(offer.invoice.resourceHash, persisted.resourceHash);
  assert.equal(offer.invoice.amountSats, persisted.amountSats.toString());
  assert.equal(offer.invoice.payTo, persisted.payTo);
  assert.equal(offer.invoice.nonce, persisted.nonce);
  assert.equal(offer.invoice.issuedAt, persisted.issuedAt);
  assert.equal(offer.invoice.expiresAt, persisted.expiresAt);

  const headResourceHash = computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "HEAD",
    path: "/protected",
  });
  const getResourceHash = computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "GET",
    path: "/protected",
  });
  assert.equal(offer.invoice.resourceHash, headResourceHash);
  assert.notEqual(offer.invoice.resourceHash, getResourceHash);
});

test("4055341610: decoded HEAD offer supports end-to-end settlement", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider, {
    "GET /protected": { amountSats: "1000" },
  }));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const offerResponse = await fetch(`${server.origin}/protected`, { method: "HEAD" });
  const offer = readOffer(offerResponse);
  assert.equal(handlerCalls, 0);

  const paidResponse = await fetch(`${server.origin}/protected`, {
    method: "HEAD",
    headers: { "payment-proof": JSON.stringify(proof(offer.invoiceId)) },
  });
  assert.equal(paidResponse.status, 204);
  assert.equal(await paidResponse.text(), "");
  assert.equal(txProvider.queryCount, 1);
  assert.equal(handlerCalls, 1);
  const record = await store.getByInvoiceHash(offer.invoiceId);
  assert.equal(record?.state, "PAID");
  assert.equal(record?.settledTxid, TXID);
});

test("4055341610: explicit and implicit HEAD policies both emit usable offers", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  app.use(middleware(store, txProvider, {
    "GET /fallback": { amountSats: "1000", description: "GET fallback" },
    "GET /explicit": { amountSats: "1000", description: "GET policy" },
    "HEAD /explicit": { amountSats: "2000", description: "HEAD policy" },
  }));
  const server = await startApp(app);
  t.after(() => server.close());

  const fallback = readOffer(await fetch(`${server.origin}/fallback`, { method: "HEAD" }));
  assert.equal(fallback.invoice.amountSats, "1000");
  assert.equal(fallback.accepts[0].description, "GET fallback");

  const explicit = readOffer(await fetch(`${server.origin}/explicit`, { method: "HEAD" }));
  assert.equal(explicit.invoice.amountSats, "2000");
  assert.equal(explicit.accepts[0].description, "HEAD policy");
});

test("4055341610: GET body remains compatible and matches the global offer header", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  app.use(middleware(store, txProvider, {
    "GET /protected": { amountSats: "1000", description: "GET body" },
  }));
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/protected?private=query-value`, {
    headers: { cookie: "secret=cookie-value", authorization: "Bearer secret" },
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), "true");
  const headerOffer = readOffer(response);
  const body = await response.json();
  assert.deepEqual({
    x402Version: body.x402Version,
    invoiceId: body.invoiceId,
    invoice: body.invoice,
    accepts: body.accepts,
  }, headerOffer);
  assert.deepEqual(body.resource.query, [["private", "query-value"]]);
  const encoded = response.headers.get(X402_PAYMENT_OFFER_HEADER)!;
  const decodedJson = Buffer.from(encoded, "base64url").toString("utf8");
  assert.doesNotMatch(decodedJson, /query-value|cookie-value|Bearer|"resource":/);
});

test("4055341610: GET and HEAD offers retain cross-method isolation", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  installErrorObserver(app);
  let handlerCalls = 0;
  app.use(middleware(store, txProvider, {
    "GET /protected": { amountSats: "1000" },
  }));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const getResponse = await fetch(`${server.origin}/protected`);
  const getOffer = readOffer(getResponse);
  const getAgainstHead = await fetch(`${server.origin}/protected`, {
    method: "HEAD",
    headers: { "payment-proof": JSON.stringify(proof(getOffer.invoiceId)) },
  });
  assert.equal(getAgainstHead.status, 400);
  assert.equal(getAgainstHead.headers.get("x-test-error"), "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, getOffer.invoiceId);

  const headResponse = await fetch(`${server.origin}/protected`, { method: "HEAD" });
  const headOffer = readOffer(headResponse);
  const headAgainstGet = await fetch(`${server.origin}/protected`, {
    headers: { "payment-proof": JSON.stringify(proof(headOffer.invoiceId)) },
  });
  assert.equal(headAgainstGet.status, 400);
  assert.equal((await headAgainstGet.json()).error, "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, headOffer.invoiceId);
});

test("4055341610: oversized offers fail closed after issuance", async (t) => {
  const store = new CapturingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider, {
    "GET /protected": {
      amountSats: "1000",
      description: "x".repeat(MAX_X402_PAYMENT_OFFER_HEADER_LENGTH),
    },
  }));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/protected`);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("payment-required"), null);
  assert.equal(response.headers.get(X402_PAYMENT_OFFER_HEADER), null);
  assert.equal((await response.json()).error, "PAYMENT_OFFER_ENCODING_FAILED");
  assert.equal(store.issued.length, 1);
  assert.equal(store.issued[0]?.state, "ISSUED");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
});

function deterministicOffer(description?: string): X402PaymentOffer {
  const invoice = createInvoice({
    request: { serverOrigin: PUBLIC_ORIGIN, method: "HEAD", path: "/protected" },
    amountSats: 1000n,
    payTo: PAY_TO,
    nonce: "deterministic_nonce_1234567890",
    issuedAt: NOW,
    expiresAt: NOW + 60,
  });
  return {
    x402Version: 1,
    invoiceId: computeInvoiceHash(invoice),
    invoice,
    accepts: [{
      asset: "XEC",
      network: "xec:mainnet",
      scheme: "exact",
      amountSats: invoice.amountSats,
      payTo: invoice.payTo,
      proofHeader: "payment-proof",
      ...(description === undefined ? {} : { description }),
    }],
  };
}

function nonCanonicalPadBits(encoded: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const index = encoded.length - 1;
  const value = alphabet.indexOf(encoded[index]!);
  assert.notEqual(value, -1);
  return `${encoded.slice(0, index)}${alphabet[value + 1]}`;
}

test("4055341610: codec is deterministic and rejects malformed or non-canonical input", () => {
  let offer = deterministicOffer();
  let encoded = encodePaymentOfferHeader(offer);
  for (let length = 1; encoded.length % 4 === 0; length++) {
    offer = deterministicOffer("x".repeat(length));
    encoded = encodePaymentOfferHeader(offer);
  }

  assert.equal(encodePaymentOfferHeader({
    accepts: offer.accepts,
    invoice: offer.invoice,
    invoiceId: offer.invoiceId,
    x402Version: offer.x402Version,
  }), encoded);
  assert.deepEqual(decodePaymentOfferHeader(encoded), offer);

  const nonCanonicalJson = Buffer.from(JSON.stringify(offer), "utf8").toString("base64url");
  const extraField = Buffer.from(canonicalize({
    ...(offer as unknown as Record<string, CanonicalValue>),
    extra: true,
  }), "utf8").toString("base64url");
  const invalidInputs = [
    `${encoded}*`,
    `${encoded}=`,
    `${encoded}!!!`,
    `${encoded.slice(0, 4)} ${encoded.slice(4)}`,
    "A",
    nonCanonicalPadBits(encoded),
    Buffer.from("{", "utf8").toString("base64url"),
    Buffer.from(canonicalize({ x402Version: 1 }), "utf8").toString("base64url"),
    nonCanonicalJson,
    extraField,
    "A".repeat(MAX_X402_PAYMENT_OFFER_HEADER_LENGTH + 1),
  ];

  for (const invalid of invalidInputs) {
    assert.throws(() => decodePaymentOfferHeader(invalid), invalid);
  }
});
