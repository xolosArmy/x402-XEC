import assert from "node:assert/strict";
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
  X402_PAYMENT_OFFER_HEADER,
} from "../src/index.js";

process.env.NODE_ENV = "test";

const PUBLIC_ORIGIN = "https://api.example.com";
const PAY_TO = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const PAY_TO_SCRIPT = cashAddressToOutputScriptHex(PAY_TO);
const NOW = 1_800_000_000;
const TXID = "55".repeat(32);

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

function middleware(store: CountingStore, txProvider: CountingTxProvider, method: "GET" | "POST") {
  return createX402SettlementMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    payTo: PAY_TO,
    allowInsecureDevelopmentMode: true,
    routes: { [`${method} /protected`]: { amountSats: "1000" } },
    store,
    txProvider,
    now: () => NOW,
  });
}

function proof(invoiceHash: string) {
  return { x402Version: 1, network: "xec:mainnet", invoiceHash, txid: TXID };
}

test("4064157517: opposite duplicate query orders cannot cross-settle", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider, "GET"));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const forward = "/protected?item=basic&item=admin";
  const reverse = "/protected?item=admin&item=basic";
  const forwardResponse = await fetch(`${server.origin}${forward}`);
  const reverseResponse = await fetch(`${server.origin}${reverse}`);
  assert.equal(forwardResponse.status, 402);
  assert.equal(reverseResponse.status, 402);
  const forwardOffer = await forwardResponse.json();
  const reverseOffer = await reverseResponse.json();
  assert.notEqual(forwardOffer.invoice.resourceHash, reverseOffer.invoice.resourceHash);

  for (const [offer, target] of [[forwardOffer, reverse], [reverseOffer, forward]] as const) {
    const response = await fetch(`${server.origin}${target}`, {
      headers: { "payment-proof": JSON.stringify(proof(offer.invoiceId)) },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "RESOURCE_MISMATCH");
    assert.equal(txProvider.queryCount, 0);
    assert.equal(store.paidTransitionCount, 0);
    assert.equal(handlerCalls, 0);
    const record = await store.getByInvoiceHash(offer.invoiceId);
    assert.equal(record?.state, "ISSUED");
    assert.equal(record?.settledTxid, undefined);
  }
  assert.equal(store.issueCount, 2);
});

test("4064157528: parsed multipart files and all multipart media types fail closed before body access", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  let bodyReads = 0;
  app.use((request, _response, next) => {
    const parsedBody = { description: "same" };
    request.body = parsedBody;
    Object.assign(request, {
      file: { originalname: "upload.bin", buffer: Buffer.from("file A") },
      files: [{ originalname: "other.bin", buffer: Buffer.from("file B") }],
    });
    Object.defineProperty(request, "body", {
      configurable: true,
      get: () => {
        bodyReads += 1;
        return parsedBody;
      },
    });
    next();
  });
  app.use(middleware(store, txProvider, "POST"));
  app.post("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  for (const contentType of [
    "multipart/form-data; boundary=abc123",
    "Multipart/Form-Data; boundary=abc123",
    "multipart/mixed; boundary=abc123",
  ]) {
    for (const withProof of [false, true]) {
      const response = await fetch(`${server.origin}/protected`, {
        method: "POST",
        headers: {
          "content-type": contentType,
          ...(withProof ? { "payment-proof": JSON.stringify(proof("00".repeat(32))) } : {}),
        },
        body: "--abc123--\r\n",
      });
      assert.equal(response.status, 415, contentType);
      assert.deepEqual(await response.json(), {
        error: "UNSUPPORTED_MULTIPART_BODY",
        message: "Protected multipart requests require explicit resource binding support",
      });
      assert.equal(response.headers.get("payment-required"), null);
      assert.equal(response.headers.get(X402_PAYMENT_OFFER_HEADER), null);
    }
  }
  const bodylessResponse = await fetch(`${server.origin}/protected`, {
    method: "POST",
    headers: { "content-type": "Multipart/Mixed; boundary=abc123" },
  });
  assert.equal(bodylessResponse.status, 415);
  assert.equal((await bodylessResponse.json()).error, "UNSUPPORTED_MULTIPART_BODY");
  assert.equal(bodylessResponse.headers.get("payment-required"), null);
  assert.equal(bodylessResponse.headers.get(X402_PAYMENT_OFFER_HEADER), null);
  assert.equal(bodyReads, 0);
  assert.equal(store.issueCount, 0);
  assert.equal(txProvider.queryCount, 0);
  assert.equal(store.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);
});

test("4064157528: parsed JSON still binds body, while framed unparsed JSON still fails", async (t) => {
  const store = new CountingStore();
  const txProvider = new CountingTxProvider();
  const parsedApp = express();
  let handlerCalls = 0;
  parsedApp.use(express.json());
  parsedApp.use(middleware(store, txProvider, "POST"));
  parsedApp.post("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(204);
  });
  const parsedServer = await startApp(parsedApp);
  t.after(() => parsedServer.close());

  const response = await fetch(`${parsedServer.origin}/protected`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "same" }),
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get("payment-required"), "true");
  const offer = await response.json();
  assert.equal(offer.invoice.resourceHash, computeResourceHash({
    serverOrigin: PUBLIC_ORIGIN,
    method: "POST",
    path: "/protected",
    body: { description: "same" },
  }));
  assert.equal(store.issueCount, 1);
  assert.equal(txProvider.queryCount, 0);
  assert.equal(store.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);

  const unparsedStore = new CountingStore();
  const unparsedTxProvider = new CountingTxProvider();
  const unparsedApp = express();
  unparsedApp.use(middleware(unparsedStore, unparsedTxProvider, "POST"));
  const unparsedServer = await startApp(unparsedApp);
  t.after(() => unparsedServer.close());
  const unparsedResponse = await fetch(`${unparsedServer.origin}/protected`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "same" }),
  });
  assert.equal(unparsedResponse.status, 500);
  assert.equal((await unparsedResponse.json()).error, "UNPARSED_BODY_DETECTED");
  assert.equal(unparsedStore.issueCount, 0);
  assert.equal(unparsedTxProvider.queryCount, 0);
  assert.equal(unparsedStore.paidTransitionCount, 0);
  assert.equal(handlerCalls, 0);
});
