import assert from "node:assert/strict";
import { type AddressInfo } from "node:net";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  InMemoryAuthoritativeInvoiceStore,
  type ChronikTransaction,
  type TxProvider,
} from "@x402-xec/core";
import express, { type Express } from "express";
import { createX402SettlementMiddleware } from "../src/index.js";

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

function middleware(
  store: InMemoryAuthoritativeInvoiceStore,
  txProvider: CountingTxProvider,
  routes = { "GET /protected": { amountSats: "1000" } },
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

async function assertIssued(store: InMemoryAuthoritativeInvoiceStore, invoiceHash: string) {
  const record = await store.getByInvoiceHash(invoiceHash);
  assert.equal(record?.state, "ISSUED");
  assert.equal(record?.settledTxid, undefined);
}

test("4054156678: default-Express route equivalents are protected while unrelated paths pass", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let protectedCalls = 0;
  let unrelatedCalls = 0;
  app.use(middleware(store, txProvider));
  app.get("/protected", (_request, response) => {
    protectedCalls += 1;
    response.sendStatus(200);
  });
  app.get("/health", (_request, response) => {
    unrelatedCalls += 1;
    response.sendStatus(204);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  for (const path of ["/protected", "/Protected", "/PROTECTED", "/protected/", "/Protected/"]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 402, path);
  }
  assert.equal(protectedCalls, 0);

  const unrelated = await fetch(`${server.origin}/health`);
  assert.equal(unrelated.status, 204);
  assert.equal(unrelatedCalls, 1);
});

test("4054156678: root remains root and canonical duplicate routes fail initialization", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let rootCalls = 0;
  app.use(middleware(store, txProvider, { "GET /": { amountSats: "1000" } }));
  app.get("/", (_request, response) => {
    rootCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  assert.equal((await fetch(`${server.origin}/`)).status, 402);
  assert.equal(rootCalls, 0);

  assert.throws(
    () => middleware(new InMemoryAuthoritativeInvoiceStore(), new CountingTxProvider(), {
      "GET /protected": { amountSats: "1000" },
      "GET /Protected/": { amountSats: "1000" },
    }),
    /duplicate route: GET \/protected/,
  );
});

test("4054156680: mounted external path is in metadata/hash and cross-mount proof mismatches", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  const routes = { "GET /res": { amountSats: "1000" } };
  app.use("/v1", middleware(store, txProvider, routes));
  app.use("/v2", middleware(store, txProvider, routes));
  app.get(["/v1/res", "/v2/res"], (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const v1Response = await fetch(`${server.origin}/v1/res`);
  const v2Response = await fetch(`${server.origin}/v2/res`);
  assert.equal(v1Response.status, 402);
  assert.equal(v2Response.status, 402);
  const v1 = await v1Response.json();
  const v2 = await v2Response.json();
  assert.equal(v1.resource.path, "/v1/res");
  assert.equal(v2.resource.path, "/v2/res");
  assert.notEqual(v1.invoice.resourceHash, v2.invoice.resourceHash);

  const mismatch = await fetch(`${server.origin}/v2/res`, {
    headers: { "payment-proof": JSON.stringify(proof(v1.invoiceId)) },
  });
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json()).error, "RESOURCE_MISMATCH");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, v1.invoiceId);
});

test("4054156686: every multiple-alias combination is ambiguous and mutation-free", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const offerResponse = await fetch(`${server.origin}/protected`);
  assert.equal(offerResponse.status, 402);
  const offer = await offerResponse.json();
  const raw = JSON.stringify(proof(offer.invoiceId));
  const combinations = [
    ["payment-proof", "settlement-proof"],
    ["payment-proof", "x402-settlement-proof"],
    ["settlement-proof", "x402-settlement-proof"],
    ["payment-proof", "settlement-proof", "x402-settlement-proof"],
  ];

  for (const aliases of combinations) {
    const response = await fetch(`${server.origin}/protected`, {
      headers: Object.fromEntries(aliases.map((name) => [name, raw])),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, "MALFORMED_PROOF");
    assert.match(body.message, /multiple|ambiguous/i);
  }

  const empty = await fetch(`${server.origin}/protected`, {
    headers: { "payment-proof": "" },
  });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "MALFORMED_PROOF");
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, offer.invoiceId);

  const oneAlias = await fetch(`${server.origin}/protected`, {
    headers: { "settlement-proof": raw },
  });
  assert.equal(oneAlias.status, 200);
  assert.equal(txProvider.queryCount, 1);
  assert.equal(handlerCalls, 1);
});

function nonCanonicalPadBits(encoded: string, alphabet: string): string {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const index = encoded.length - padding - 1;
  const value = alphabet.indexOf(encoded[index]!);
  assert.notEqual(value, -1);
  return `${encoded.slice(0, index)}${alphabet[value + 1]}${encoded.slice(index + 1)}`;
}

test("4054156689: proof encodings require strict canonical syntax", async (t) => {
  const store = new InMemoryAuthoritativeInvoiceStore();
  const txProvider = new CountingTxProvider();
  const app = express();
  let handlerCalls = 0;
  app.use(middleware(store, txProvider));
  app.get("/protected", (_request, response) => {
    handlerCalls += 1;
    response.sendStatus(200);
  });
  const server = await startApp(app);
  t.after(() => server.close());

  const offer = await (await fetch(`${server.origin}/protected`)).json();
  let json = JSON.stringify(proof(offer.invoiceId));
  while (Buffer.from(json).toString("base64url").length % 4 === 0) json += " ";
  const canonicalUrl = Buffer.from(json).toString("base64url");
  const nonCanonicalUrl = nonCanonicalPadBits(canonicalUrl, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");

  const compatibleStandardJson = json.replace(
    "{",
    '{"network":"???",',
  );
  const compatibleStandard = Buffer.from(compatibleStandardJson).toString("base64");
  assert.match(compatibleStandard, /\//);
  assert.match(compatibleStandard, /=+$/);
  const nonCanonicalStandard = nonCanonicalPadBits(
    compatibleStandard,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
  );

  const malformed = [
    `${canonicalUrl}!!!`,
    `${canonicalUrl.slice(0, 5)} ${canonicalUrl.slice(5)}`,
    `${canonicalUrl.slice(0, 5)}*${canonicalUrl.slice(6)}`,
    `${canonicalUrl}=x`,
    `${canonicalUrl}=`,
    "A",
    nonCanonicalUrl,
    `${compatibleStandard}!!!`,
    `${compatibleStandard.slice(0, 5)} ${compatibleStandard.slice(5)}`,
    `${compatibleStandard.slice(0, 5)}*${compatibleStandard.slice(6)}`,
    `=${compatibleStandard}`,
    compatibleStandard.slice(0, -1),
    nonCanonicalStandard,
  ];

  for (const encoded of malformed) {
    const response = await fetch(`${server.origin}/protected`, {
      headers: { "payment-proof": encoded },
    });
    assert.equal(response.status, 400, encoded);
    assert.equal((await response.json()).error, "MALFORMED_PROOF");
  }
  assert.equal(txProvider.queryCount, 0);
  assert.equal(handlerCalls, 0);
  await assertIssued(store, offer.invoiceId);

  const urlSuccess = await fetch(`${server.origin}/protected`, {
    headers: { "payment-proof": canonicalUrl },
  });
  assert.equal(urlSuccess.status, 200);

  // JSON.parse keeps the last duplicate key, so the first value only supplies
  // a standard-only '/' alphabet byte while the parsed strict proof is unchanged.
  const standardCompatibleResponse = await fetch(`${server.origin}/protected`, {
    headers: { "payment-proof": compatibleStandard },
  });
  assert.equal(standardCompatibleResponse.status, 200);
  assert.equal(handlerCalls, 2);
});
