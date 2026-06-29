import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  authorizationSchema,
  authorizationSigningMessage,
  canonicalHash,
  computeInvoiceHash,
  createInvoice,
  type Invoice,
  type ResourceRequest,
} from "@x402-xec/core";
import { OfflinePaymentPreparer, StaticUtxoProvider } from "@x402-xec/payments";
import { Address, ALL_BIP143, Ecc, P2PKHSignatory, shaRmd160 } from "ecash-lib";
import axios, { type AxiosInstance } from "axios";
import {
  createTestOnlyMockXecSigner,
  withX402XecPaymentInterceptor,
} from "../src/index.js";

const NOW = 1_800_000_000;
const SECRET_KEY = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]);
const PUBLIC_KEY = new Ecc().derivePubkey(SECRET_KEY);
const PAYER = Address.p2pkh(shaRmd160(PUBLIC_KEY)).toString();
const PAY_TO = Address.p2pkh("11".repeat(20)).toString();
const SOURCE_SCRIPT = Address.fromCashAddress(PAYER).toScriptHex();
const TXID = "c".repeat(64);
const NONCE = "local_test_invoice_nonce_000001";

interface TestServerOptions {
  readonly amountSats?: bigint;
  readonly changeOffer?: (offer: Record<string, unknown>) => void;
  readonly always402?: boolean;
}

interface StartedServer {
  readonly client: AxiosInstance;
  readonly url: string;
  readonly requests: IncomingMessage[];
  close(): Promise<void>;
}

async function startServer(options: TestServerOptions = {}): Promise<StartedServer> {
  const requests: IncomingMessage[] = [];
  let origin = "";
  const server = createServer((request, response) => {
    requests.push(request);
    const resource: ResourceRequest = {
      serverOrigin: origin,
      method: request.method ?? "GET",
      path: new URL(request.url ?? "/", origin).pathname,
    };
    const invoice = createInvoice({
      request: resource,
      amountSats: options.amountSats ?? 1_000n,
      payTo: PAY_TO,
      nonce: NONCE,
      issuedAt: NOW - 1,
      expiresAt: NOW + 60,
    });
    const offer: Record<string, unknown> = {
      x402Version: 1,
      invoiceId: computeInvoiceHash(invoice),
      invoice,
      resource,
      accepts: [{
        asset: "XEC",
        network: "xec:mainnet",
        scheme: "xec-prepaid-utxo",
        amountSats: invoice.amountSats,
        payTo: invoice.payTo,
        paymentHeader: "PAYMENT-SIGNATURE",
      }],
    };
    options.changeOffer?.(offer);

    const payment = request.headers["payment-signature"];
    if (payment === undefined || options.always402 === true) {
      sendJson(response, 402, offer);
      return;
    }
    sendJson(response, 200, { ok: true, protected: "forecast" });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    client: axios.create({ proxy: false }),
    url: `${origin}/weather`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function paymentClient(client: AxiosInstance, maxPaymentSats: bigint = 1_000n): AxiosInstance {
  return withX402XecPaymentInterceptor(client, {
    signer: createTestOnlyMockXecSigner({
      payer: PAYER,
      transaction: { txid: TXID, vout: 2 },
    }),
    maxPaymentSats,
    now: () => NOW,
  });
}

interface OfflineClientOptions {
  readonly maxPaymentSats?: bigint;
  readonly utxos?: readonly {
    readonly txid: string;
    readonly outIdx: number;
    readonly sats: string;
    readonly outputScript: string;
    readonly token?: unknown;
  }[];
}

function offlinePaymentClient(
  client: AxiosInstance,
  options: OfflineClientOptions = {},
): {
  readonly client: AxiosInstance;
  readonly preparations: string[];
  readonly attempts: { count: number };
} {
  const preparations: string[] = [];
  const attempts = { count: 0 };
  const preparer = new OfflinePaymentPreparer({
    utxoProvider: new StaticUtxoProvider(options.utxos ?? [{
      txid: "2".repeat(64),
      outIdx: 1,
      sats: "10000",
      outputScript: SOURCE_SCRIPT,
    }]),
    signatureProvider: {
      sign: (message) => canonicalHash({
        domain: "x402-xec-local-mock-signature-v1",
        message,
        payer: PAYER,
      }),
    },
    payer: PAYER,
    changeAddress: PAYER,
    signatoryForUtxo: () => P2PKHSignatory(SECRET_KEY, PUBLIC_KEY, ALL_BIP143),
    maxPaymentSats: 2_000n,
    now: () => NOW,
  });
  return {
    client: withX402XecPaymentInterceptor(client, {
      paymentPreparer: {
        async prepare(request) {
          attempts.count += 1;
          const result = await preparer.prepare(request);
          preparations.push(result.rawTx);
          return result;
        },
      },
      maxPaymentSats: options.maxPaymentSats ?? 1_000n,
      now: () => NOW,
    }),
    preparations,
    attempts,
  };
}

function replaceInvoice(offer: Record<string, unknown>, invoice: unknown): void {
  offer.invoice = invoice;
  if (typeof invoice === "object" && invoice !== null) {
    try {
      offer.invoiceId = computeInvoiceHash(invoice as Invoice);
    } catch {
      offer.invoiceId = "f".repeat(64);
    }
  }
}

test("request without interceptor receives 402", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await assert.rejects(server.client.get(server.url), (error: unknown) => {
    assert.equal(axios.isAxiosError(error) && error.response?.status, 402);
    return true;
  });
  assert.equal(server.requests.length, 1);
});

test("request with interceptor receives protected 200 response", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const response = await paymentClient(server.client).get(server.url);

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true, protected: "forecast" });
  assert.equal(server.requests.length, 2);
});

test("invalid invoice fails without retrying", async (t) => {
  const server = await startServer({
    changeOffer: (offer) => {
      const invoice = { ...(offer.invoice as Invoice), amountSats: "01" };
      replaceInvoice(offer, invoice);
    },
  });
  t.after(() => server.close());

  await assert.rejects(paymentClient(server.client).get(server.url), /invalid x402-XEC invoice/);
  assert.equal(server.requests.length, 1);
});

test("expired invoice fails without retrying", async (t) => {
  const server = await startServer({
    changeOffer: (offer) => {
      const invoice = { ...(offer.invoice as Invoice), issuedAt: NOW - 60, expiresAt: NOW };
      replaceInvoice(offer, invoice);
    },
  });
  t.after(() => server.close());

  await assert.rejects(paymentClient(server.client).get(server.url), /invoice has expired/);
  assert.equal(server.requests.length, 1);
});

test("amount above maxPaymentSats fails without signing", async (t) => {
  const server = await startServer({ amountSats: 1_001n });
  t.after(() => server.close());

  await assert.rejects(paymentClient(server.client).get(server.url), /exceeds maxPaymentSats 1000/);
  assert.equal(server.requests.length, 1);
});

test("unsupported network fails", async (t) => {
  const server = await startServer({
    changeOffer: (offer) => {
      replaceInvoice(offer, { ...(offer.invoice as Invoice), network: "xec:testnet" });
    },
  });
  t.after(() => server.close());

  await assert.rejects(paymentClient(server.client).get(server.url), /invalid x402-XEC invoice/);
  assert.equal(server.requests.length, 1);
});

test("retry loop is prevented after one paid retry", async (t) => {
  const server = await startServer({ always402: true });
  t.after(() => server.close());

  await assert.rejects(paymentClient(server.client).get(server.url), (error: unknown) => {
    assert.equal(axios.isAxiosError(error) && error.response?.status, 402);
    return true;
  });
  assert.equal(server.requests.length, 2);
});

test("PAYMENT-SIGNATURE envelope is attached correctly", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await paymentClient(server.client).get(server.url);

  const header = server.requests[1]?.headers["payment-signature"];
  assert.equal(typeof header, "string");
  const envelope = JSON.parse(Buffer.from(header as string, "base64url").toString("utf8")) as Record<string, unknown>;
  const invoice = envelope.invoice as Invoice;
  const authorization = authorizationSchema.parse(envelope.authorization);
  assert.deepEqual(Object.keys(envelope).sort(), ["authorization", "invoice"]);
  assert.equal(authorization.invoiceHash, computeInvoiceHash(invoice));
  assert.equal(authorization.resourceHash, invoice.resourceHash);
  assert.equal(authorization.amountSats, invoice.amountSats);
  assert.equal(authorization.payTo, invoice.payTo);
  assert.equal(authorization.nonce, invoice.nonce);
  assert.equal(authorization.payer, PAYER);
  assert.deepEqual(authorization.transaction, { txid: TXID, vout: 2 });
  assert.equal(authorization.signature, canonicalHash({
    domain: "x402-xec-local-mock-signature-v1",
    message: authorizationSigningMessage(authorization),
    payer: PAYER,
  }));
});

test("unsupported payment scheme or asset fails", async (t) => {
  const server = await startServer({
    changeOffer: (offer) => {
      offer.accepts = [{
        ...(offer.accepts as Record<string, unknown>[])[0],
        asset: "RMZ",
        scheme: "other",
      }];
    },
  });
  t.after(() => server.close());

  await assert.rejects(paymentClient(server.client).get(server.url), /unsupported or inconsistent/);
  assert.equal(server.requests.length, 1);
});

test("request with OfflinePaymentPreparer receives protected 200 response", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const payment = offlinePaymentClient(server.client);

  const response = await payment.client.get(server.url);

  assert.equal(response.status, 200);
  assert.equal(payment.preparations.length, 1);
  assert.match(payment.preparations[0] ?? "", /^[0-9a-f]+$/);
  const header = server.requests[1]?.headers["payment-signature"];
  assert.equal(typeof header, "string");
  const envelope = JSON.parse(
    Buffer.from(header as string, "base64url").toString("utf8"),
  ) as { authorization: { transaction: { txid: string; vout: number } } };
  assert.equal(envelope.authorization.transaction.vout, 0);
  assert.equal(envelope.authorization.transaction.txid.length, 64);
});

test("OfflinePaymentPreparer mode rejects an expired invoice before preparation", async (t) => {
  const server = await startServer({
    changeOffer: (offer) => {
      const invoice = { ...(offer.invoice as Invoice), expiresAt: NOW };
      replaceInvoice(offer, invoice);
    },
  });
  t.after(() => server.close());
  const payment = offlinePaymentClient(server.client);

  await assert.rejects(payment.client.get(server.url), /invoice has expired/);
  assert.equal(payment.attempts.count, 0);
  assert.equal(server.requests.length, 1);
});

test("OfflinePaymentPreparer mode enforces interceptor max before preparation", async (t) => {
  const server = await startServer({ amountSats: 1_001n });
  t.after(() => server.close());
  const payment = offlinePaymentClient(server.client);

  await assert.rejects(payment.client.get(server.url), /exceeds maxPaymentSats 1000/);
  assert.equal(payment.preparations.length, 0);
  assert.equal(payment.attempts.count, 0);
  assert.equal(server.requests.length, 1);
});

test("OfflinePaymentPreparer mode rejects insufficient UTXOs without retry", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const payment = offlinePaymentClient(server.client, {
    utxos: [{ txid: "2".repeat(64), outIdx: 1, sats: "1000", outputScript: SOURCE_SCRIPT }],
  });

  await assert.rejects(payment.client.get(server.url), /Insufficient funds/);
  assert.equal(server.requests.length, 1);
});

test("OfflinePaymentPreparer mode rejects token UTXOs without retry", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const payment = offlinePaymentClient(server.client, {
    utxos: [{
      txid: "2".repeat(64),
      outIdx: 1,
      sats: "10000",
      outputScript: SOURCE_SCRIPT,
      token: { tokenId: "3".repeat(64), atoms: 1n, isMintBaton: false },
    }],
  });

  await assert.rejects(payment.client.get(server.url), /Token-bearing UTXOs/);
  assert.equal(server.requests.length, 1);
});

test("OfflinePaymentPreparer mode still prevents a retry loop", async (t) => {
  const server = await startServer({ always402: true });
  t.after(() => server.close());
  const payment = offlinePaymentClient(server.client);

  await assert.rejects(payment.client.get(server.url), (error: unknown) => {
    assert.equal(axios.isAxiosError(error) && error.response?.status, 402);
    return true;
  });
  assert.equal(payment.preparations.length, 1);
  assert.equal(server.requests.length, 2);
});
