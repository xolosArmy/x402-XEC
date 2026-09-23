import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  computeResourceHash,
  InMemoryAuthoritativeInvoiceStore,
  type ChronikTransaction,
  type TxProvider,
} from "@x402-xec/core";
import express, { type Express } from "express";
import {
  createX402SettlementMiddleware,
  type SettlementRouteConfig,
} from "../src/index.js";

process.env.NODE_ENV = "test";

const PUBLIC_ORIGIN = "https://api.example.com";
const PAY_TO = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const PAY_TO_SCRIPT = cashAddressToOutputScriptHex(PAY_TO);
const NOW = 1_800_000_000;
const TXID = "11".repeat(32);

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

function installHeadResponseObserver(app: Express): void {
  app.use((_request, response, next) => {
    const json = response.json.bind(response);
    response.json = ((body: any) => {
      if (body?.invoiceId !== undefined) {
        response.setHeader("x-test-invoice-id", String(body.invoiceId));
      }
      if (body?.invoice?.amountSats !== undefined) {
        response.setHeader("x-test-amount-sats", String(body.invoice.amountSats));
      }
      if (body?.resource?.method !== undefined) {
        response.setHeader("x-test-resource-method", String(body.resource.method));
      }
      if (body?.accepts?.[0]?.description !== undefined) {
        response.setHeader("x-test-description", String(body.accepts[0].description));
      }
      if (body?.error !== undefined) {
        response.setHeader("x-test-error", String(body.error));
      }
      return json(body);
    }) as typeof response.json;
    next();
  });
}

function settlementMiddleware(
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

function proof(invoiceHash: string) {
  return {
    x402Version: 1,
    network: "xec:mainnet",
    invoiceHash,
    txid: TXID,
  };
}

async function assertIssued(
  store: InMemoryAuthoritativeInvoiceStore,
  invoiceHash: string,
) {
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid, undefined);
}

test("4054835203: GET policy protects implicit HEAD across canonical path equivalents", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  installHeadResponseObserver(app);
  let protectedHandlerCalls = 0;
  let unrelatedHandlerCalls = 0;
  app.use(settlementMiddleware(store, txProvider, {
    "GET /protected": { amountSats: "1000" },
  }));
  app.get("/protected", (_request, response) => {
    protectedHandlerCalls += 1;
    response.sendStatus(200);
  });
  app.get("/unrelated", (_request, response) => {
    unrelatedHandlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  for (const path of [
    "/protected",
    "/Protected",
    "/PROTECTED",
    "/protected/",
    "/Protected/",
  ]) {
    const response = await fetch(`${server.origin}${path}`, { method: "HEAD" });
    assert.equal(response.status, 402, path);
    assert.equal(response.headers.get("x-test-amount-sats"), "1000", path);
    assert.equal(response.headers.get("x-test-resource-method"), "HEAD", path);
  }
  assert.equal(protectedHandlerCalls, 0);

  const unrelated = await fetch(`${server.origin}/unrelated`, { method: "HEAD" });
  assert.equal(unrelated.status, 204);
  assert.equal(unrelatedHandlerCalls, 1);
});

test("4054835203: explicit HEAD policy wins before GET fallback", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  installHeadResponseObserver(app);
  let handlerCalls = 0;
  app.use(settlementMiddleware(store, txProvider, {
    "GET /explicit": { amountSats: "1000", description: "GET policy" },
    "HEAD /explicit": { amountSats: "2000", description: "HEAD policy" },
  }));
  app.get("/explicit", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/explicit`, { method: "HEAD" });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("x-test-amount-sats"), "2000");
  assert.equal(response.headers.get("x-test-description"), "HEAD policy");
  assert.equal(response.headers.get("x-test-resource-method"), "HEAD");
  assert.equal(handlerCalls, 0);
});

test("4054835203: implicit HEAD inherits GET policy but retains HEAD resource identity", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  installHeadResponseObserver(app);
  let handlerCalls = 0;
  app.use(settlementMiddleware(store, txProvider, {
    "GET /fallback": { amountSats: "1750", description: "Inherited GET policy" },
  }));
  app.get("/fallback", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${server.origin}/fallback`, { method: "HEAD" });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("x-test-amount-sats"), "1750");
  assert.equal(response.headers.get("x-test-description"), "Inherited GET policy");
  assert.equal(response.headers.get("x-test-resource-method"), "HEAD");
  const invoiceId = response.headers.get("x-test-invoice-id");
  assert.ok(invoiceId);
  const record = await store.getByInvoiceHash(invoiceId);
  assert.equal(record?.resourceHash, computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "HEAD",
    path: "/fallback",
  }));
  assert.notEqual(record?.resourceHash, computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "GET",
    path: "/fallback",
  }));
  assert.equal(handlerCalls, 0);
});

test("4054835203: GET and fallback-HEAD invoices cannot cross-settle", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  installHeadResponseObserver(app);
  let handlerCalls = 0;
  app.use(settlementMiddleware(store, txProvider, {
    "GET /protected": { amountSats: "1000" },
  }));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const getOfferResponse = await fetch(`${server.origin}/protected`);
  assert.equal(getOfferResponse.status, 402);
  const getOffer = await getOfferResponse.json();

  const getAgainstHead = await fetch(`${server.origin}/protected`, {
    method: "HEAD",
    headers: { "payment-proof": JSON.stringify(proof(getOffer.invoiceId)) },
  });
  assert.equal(getAgainstHead.status, 400);
  assert.equal(getAgainstHead.headers.get("x-test-error"), "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, getOffer.invoiceId);

  const headOfferResponse = await fetch(`${server.origin}/protected`, { method: "HEAD" });
  assert.equal(headOfferResponse.status, 402);
  assert.equal(headOfferResponse.headers.get("x-test-resource-method"), "HEAD");
  const headInvoiceId = headOfferResponse.headers.get("x-test-invoice-id");
  assert.ok(headInvoiceId);

  const headAgainstGet = await fetch(`${server.origin}/protected`, {
    headers: { "payment-proof": JSON.stringify(proof(headInvoiceId)) },
  });
  assert.equal(headAgainstGet.status, 400);
  assert.equal((await headAgainstGet.json()).error, "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, headInvoiceId);

  const unchangedGet = await fetch(`${server.origin}/protected`);
  assert.equal(unchangedGet.status, 402);
  assert.equal((await unchangedGet.json()).resource.method, "GET");
  assert.equal(handlerCalls, 0);
});
