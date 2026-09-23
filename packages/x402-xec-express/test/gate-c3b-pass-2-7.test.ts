import assert from "node:assert/strict";
import http from "node:http";
import { type AddressInfo } from "node:net";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  computeResourceHash,
  InMemoryAuthoritativeInvoiceStore,
  type AuthoritativeInvoiceRecord,
  type ChronikTransaction,
  type CommitPaidResult,
  type TxProvider,
} from "@x402-xec/core";
import express, { type Express } from "express";
import {
  createX402SettlementMiddleware,
  decodePaymentOfferHeader,
  X402_PAYMENT_OFFER_HEADER,
  type SettlementRouteConfig,
} from "../src/index.js";

process.env.NODE_ENV = "test";

const PUBLIC_ORIGIN = "https://api.example.com";
const PAY_TO = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const PAY_TO_SCRIPT = cashAddressToOutputScriptHex(PAY_TO);
const NOW = 1_800_000_000;
const TXID = "44".repeat(32);

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

class CountingStore extends InMemoryAuthoritativeInvoiceStore {
  issueCount = 0;
  paidTransitionCount = 0;

  override async issue(record: AuthoritativeInvoiceRecord): Promise<void> {
    this.issueCount += 1;
    await super.issue(record);
  }

  override async commitPaid(
    invoiceHash: string,
    txid: string,
    paidAt: number,
  ): Promise<CommitPaidResult> {
    this.paidTransitionCount += 1;
    return super.commitPaid(invoiceHash, txid, paidAt);
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

function middleware(
  store: CountingStore,
  txProvider: CountingTxProvider,
  routes: Record<string, SettlementRouteConfig> = {
    "POST /protected": { amountSats: "1000" },
  },
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

function proof(invoiceHash: string) {
  return {
    x402Version: 1,
    network: "xec:mainnet",
    invoiceHash,
    txid: TXID,
  };
}

async function assertIssued(store: CountingStore, invoiceHash: string): Promise<void> {
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid, undefined);
}

async function sendChunkedJson(origin: string, body: unknown) {
  const url = new URL("/protected", origin);
  const encoded = JSON.stringify(body);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "ChUnKeD",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    request.on("error", reject);
    request.write(encoded.slice(0, 5));
    request.end(encoded.slice(5));
  });
}

test("4063748203: positive Content-Length with an undefined body fails before settlement", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider));
  app.use(express.json());
  app.post("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/protected`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "A" }),
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "UNPARSED_BODY_DETECTED");
  assert.equal(store.issueCount, 0);
  assert.equal(txProvider.queryCount, 0);
  assert.equal(store.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);
});

test("4063748203: Transfer-Encoding with an undefined body fails before settlement", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider));
  app.use(express.json());
  app.post("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await sendChunkedJson(server.origin, { action: "A" });
  assert.equal(response.status, 500);
  assert.equal(response.body.error, "UNPARSED_BODY_DETECTED");
  assert.equal(store.issueCount, 0);
  assert.equal(txProvider.queryCount, 0);
  assert.equal(store.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);
});

test("4063748203: parsed POST bodies are bound to distinct resource identities", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(express.json());
  app.use(middleware(store, txProvider));
  app.post("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const issue = async (action: string) => {
    const response = await fetch(`${server.origin}/protected`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 402);
    return response.json();
  };

  const offerA = await issue("A");
  const offerB = await issue("B");
  assert.equal(offerA.invoice.resourceHash, computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "POST",
    path: "/protected",
    body: { action: "A" },
  }));
  assert.notEqual(offerA.invoice.resourceHash, offerB.invoice.resourceHash);

  const aAgainstB = await fetch(`${server.origin}/protected`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-proof": JSON.stringify(proof(offerA.invoiceId)),
    },
    body: JSON.stringify({ action: "B" }),
  });
  assert.equal(aAgainstB.status, 400);
  assert.equal((await aAgainstB.json()).error, "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(store.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, offerA.invoiceId);

  const bAgainstA = await fetch(`${server.origin}/protected`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-proof": JSON.stringify(proof(offerB.invoiceId)),
    },
    body: JSON.stringify({ action: "A" }),
  });
  assert.equal(bAgainstA.status, 400);
  assert.equal((await bAgainstA.json()).error, "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(store.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, offerB.invoiceId);
});

test("4063748203: Content-Length zero remains bodyless", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  app.use(middleware(store, txProvider));
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/protected`, {
    method: "POST",
    headers: { "content-length": "0" },
  });
  assert.equal(response.status, 402);
  assert.notEqual((await response.json()).error, "UNPARSED_BODY_DETECTED");
  assert.equal(store.issueCount, 1);
  assert.equal(txProvider.queryCount, 0);
});

test("4063748203: bodyless GET and HEAD retain fallback, offer, liveness, and isolation", async (t) => {
  const store = new CountingStore();
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

  const getResponse = await fetch(`${server.origin}/protected`);
  assert.equal(getResponse.status, 402);
  assert.ok(getResponse.headers.get(X402_PAYMENT_OFFER_HEADER));
  const getOffer = await getResponse.json();

  const headResponse = await fetch(`${server.origin}/protected`, { method: "HEAD" });
  assert.equal(headResponse.status, 402);
  const encodedHeadOffer = headResponse.headers.get(X402_PAYMENT_OFFER_HEADER);
  assert.ok(encodedHeadOffer);
  const headOffer = decodePaymentOfferHeader(encodedHeadOffer);
  assert.equal(await headResponse.text(), "");
  assert.equal(handlerCalls, 0);
  assert.equal(headOffer.invoice.resourceHash, computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "HEAD",
    path: "/protected",
  }));
  assert.notEqual(getOffer.invoice.resourceHash, headOffer.invoice.resourceHash);
});
