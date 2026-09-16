/**
 * @file settlement-unique-payto.test.ts
 *
 * Gate C3B P0 Mandatory Per-Invoice On-Chain Binding Test Suite.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cashAddressToOutputScriptHex,
  createXpubPayToAllocator,
  InMemoryAuthoritativeInvoiceStore,
  SqliteAuthoritativeInvoiceStore,
  TxNotFoundError,
  X402_VERSION,
  type ChronikTransaction,
  type ChronikTransactionOutput,
  type TxProvider,
} from "@x402-xec/core";
import express, { type Express } from "express";
import {
  createX402SettlementMiddleware,
  PAYMENT_PROOF_HEADER,
} from "../src/index.js";

const PUBLIC_ORIGIN = "https://api.example.com";
const TEST_XPUB =
  "xpub661MyMwAqRbcEtUEgdXRTY6dJQG9fRgs7C5QomqETKMYBJVtSGpRqyHSmhWy8snovPd5oWZgQ14zUquxbxu7Z1umuXbN5VDpUL1QobD5xUY";

const NOW_BASE = 1_800_000_000;

interface StartedApp {
  readonly origin: string;
  close(): Promise<void>;
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

class MockTxProvider implements TxProvider {
  public txs = new Map<string, ChronikTransaction>();

  async getTx(txid: string): Promise<ChronikTransaction> {
    const found = this.txs.get(txid.toLowerCase());
    if (!found) throw new TxNotFoundError(txid);
    return found;
  }
}

function createTempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "x402-p0-test-"));
  return { dir, dbPath: path.join(dir, "p0-invoices.sqlite") };
}

test("P0: 1. two concurrent invoices for identical route + identical amount receive different payTo addresses", async () => {
  const { dir, dbPath } = createTempDb();
  try {
    const store = new SqliteAuthoritativeInvoiceStore(dbPath);
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const txProvider = new MockTxProvider();

    const app = express();
    app.use(
      createX402SettlementMiddleware({
        publicOrigin: PUBLIC_ORIGIN,
        payToAllocator: allocator,
        store,
        txProvider,
        production: true,
        routes: {
          "GET /weather": {
            amountSats: "5000",
          },
        },
      }),
    );
    app.get("/weather", (_req, res) => res.json({ temp: 72 }));

    const server = await startApp(app);
    try {
      const [res1, res2] = await Promise.all([
        fetch(`${server.origin}/weather`),
        fetch(`${server.origin}/weather`),
      ]);

      assert.equal(res1.status, 402);
      assert.equal(res2.status, 402);

      const offer1 = await res1.json();
      const offer2 = await res2.json();

      // Distinct invoices
      assert.notEqual(offer1.invoiceId, offer2.invoiceId);
      // Distinct nonces
      assert.notEqual(offer1.invoice.nonce, offer2.invoice.nonce);
      // CRITICAL P0 REQUIREMENT: distinct payTo addresses
      assert.notEqual(offer1.invoice.payTo, offer2.invoice.payTo);
      assert.notEqual(offer1.accepts[0].payTo, offer2.accepts[0].payTo);

      // Verify addresses match allocator derivation index 0 and 1
      assert.equal(offer1.invoice.payTo, allocator.deriveAddress(0));
      assert.equal(offer2.invoice.payTo, allocator.deriveAddress(1));
    } finally {
      await server.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0: 2 & 3. tx paying invoice A cannot settle B, and tx paying B cannot settle A", async () => {
  const { dir, dbPath } = createTempDb();
  try {
    const store = new SqliteAuthoritativeInvoiceStore(dbPath);
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const txProvider = new MockTxProvider();

    const app = express();
    app.use(
      createX402SettlementMiddleware({
        publicOrigin: PUBLIC_ORIGIN,
        payToAllocator: allocator,
        store,
        txProvider,
        production: true,
        routes: {
          "GET /data": {
            amountSats: "1000",
          },
        },
      }),
    );
    let handlerCalls = 0;
    app.get("/data", (_req, res) => {
      handlerCalls++;
      res.json({ secret: "data_payload" });
    });

    const server = await startApp(app);
    try {
      // Issue invoice A
      const resA = await fetch(`${server.origin}/data`);
      const offerA = await resA.json();
      const payToA = offerA.invoice.payTo;
      const scriptA = cashAddressToOutputScriptHex(payToA);

      // Issue invoice B
      const resB = await fetch(`${server.origin}/data`);
      const offerB = await resB.json();
      const payToB = offerB.invoice.payTo;
      const scriptB = cashAddressToOutputScriptHex(payToB);

      assert.notEqual(payToA, payToB);

      const txidA = "11".repeat(32);
      const txidB = "22".repeat(32);

      // Tx A pays invoice A's address
      txProvider.txs.set(txidA, {
        txid: txidA,
        outputs: [{ sats: 1000n, outputScript: scriptA }],
        isFinal: true,
      });

      // Tx B pays invoice B's address
      txProvider.txs.set(txidB, {
        txid: txidB,
        outputs: [{ sats: 1000n, outputScript: scriptB }],
        isFinal: true,
      });

      // Cross-attack 1: Try to settle invoice B using tx A (which paid address A)
      const crossProofB = {
        x402Version: 1,
        network: "xec:mainnet",
        invoiceHash: offerB.invoiceId,
        txid: txidA,
      };
      const crossResB = await fetch(`${server.origin}/data`, {
        headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(crossProofB) },
      });
      assert.equal(crossResB.status, 402);
      const crossBodyB = await crossResB.json();
      assert.equal(crossBodyB.error, "PAY_TO_MISMATCH");
      assert.equal(handlerCalls, 0); // Resource remained locked!

      // Cross-attack 2: Try to settle invoice A using tx B (which paid address B)
      const crossProofA = {
        x402Version: 1,
        network: "xec:mainnet",
        invoiceHash: offerA.invoiceId,
        txid: txidB,
      };
      const crossResA = await fetch(`${server.origin}/data`, {
        headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(crossProofA) },
      });
      assert.equal(crossResA.status, 402);
      const crossBodyA = await crossResA.json();
      assert.equal(crossBodyA.error, "PAY_TO_MISMATCH");
      assert.equal(handlerCalls, 0); // Resource remained locked!

      // Legitimate settlements succeed for their respective invoices
      const legitResA = await fetch(`${server.origin}/data`, {
        headers: {
          [PAYMENT_PROOF_HEADER]: JSON.stringify({
            x402Version: 1,
            network: "xec:mainnet",
            invoiceHash: offerA.invoiceId,
            txid: txidA,
          }),
        },
      });
      assert.equal(legitResA.status, 200);
      assert.equal(handlerCalls, 1);

      const legitResB = await fetch(`${server.origin}/data`, {
        headers: {
          [PAYMENT_PROOF_HEADER]: JSON.stringify({
            x402Version: 1,
            network: "xec:mainnet",
            invoiceHash: offerB.invoiceId,
            txid: txidB,
          }),
        },
      });
      assert.equal(legitResB.status, 200);
      assert.equal(handlerCalls, 2);
    } finally {
      await server.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0: 4. historical transaction cannot satisfy a newly issued invoice", async () => {
  const { dir, dbPath } = createTempDb();
  try {
    const store = new SqliteAuthoritativeInvoiceStore(dbPath);
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const txProvider = new MockTxProvider();

    // A historical transaction paid to an address derived previously
    const historicalAddress = allocator.deriveAddress(999);
    const historicalScript = cashAddressToOutputScriptHex(historicalAddress);
    const historicalTxid = "99".repeat(32);

    txProvider.txs.set(historicalTxid, {
      txid: historicalTxid,
      outputs: [{ sats: 1000n, outputScript: historicalScript }],
      isFinal: true,
    });

    const app = express();
    app.use(
      createX402SettlementMiddleware({
        publicOrigin: PUBLIC_ORIGIN,
        payToAllocator: allocator,
        store,
        txProvider,
        production: true,
        routes: {
          "GET /resource": {
            amountSats: "1000",
          },
        },
      }),
    );
    app.get("/resource", (_req, res) => res.json({ ok: true }));

    const server = await startApp(app);
    try {
      // Issue a fresh invoice (allocates index 0)
      const res = await fetch(`${server.origin}/resource`);
      const offer = await res.json();

      // Attempt to present historical txid against fresh invoice
      const proof = {
        x402Version: 1,
        network: "xec:mainnet",
        invoiceHash: offer.invoiceId,
        txid: historicalTxid,
      };

      const attackRes = await fetch(`${server.origin}/resource`, {
        headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof) },
      });

      assert.equal(attackRes.status, 402);
      const attackBody = await attackRes.json();
      assert.equal(attackBody.error, "PAY_TO_MISMATCH");
    } finally {
      await server.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0: 5. invoice address allocation survives restart without address/index reuse", async () => {
  const { dir, dbPath } = createTempDb();
  try {
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    let store = new SqliteAuthoritativeInvoiceStore(dbPath);
    const txProvider = new MockTxProvider();

    const createApp = (s: SqliteAuthoritativeInvoiceStore) => {
      const app = express();
      app.use(
        createX402SettlementMiddleware({
          publicOrigin: PUBLIC_ORIGIN,
          payToAllocator: allocator,
          store: s,
          txProvider,
          production: true,
          routes: { "GET /item": { amountSats: "500" } },
        }),
      );
      app.get("/item", (_req, res) => res.json({ item: 1 }));
      return app;
    };

    // Server run 1
    let server = await startApp(createApp(store));
    let offer1: any;
    try {
      const res = await fetch(`${server.origin}/item`);
      offer1 = await res.json();
      assert.equal(offer1.invoice.payTo, allocator.deriveAddress(0));
    } finally {
      await server.close();
      store.close();
    }

    // Reopen after restart
    store = new SqliteAuthoritativeInvoiceStore(dbPath);
    server = await startApp(createApp(store));
    try {
      const res = await fetch(`${server.origin}/item`);
      const offer2 = await res.json();
      assert.notEqual(offer1.invoice.payTo, offer2.invoice.payTo);
      // Next allocated address MUST be index 1
      assert.equal(offer2.invoice.payTo, allocator.deriveAddress(1));
    } finally {
      await server.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0: 6. concurrency safety: concurrent invoice issuance requests allocate unique addresses", async () => {
  const { dir, dbPath } = createTempDb();
  try {
    const store = new SqliteAuthoritativeInvoiceStore(dbPath);
    const allocator = createXpubPayToAllocator(TEST_XPUB);
    const txProvider = new MockTxProvider();

    const app = express();
    app.use(
      createX402SettlementMiddleware({
        publicOrigin: PUBLIC_ORIGIN,
        payToAllocator: allocator,
        store,
        txProvider,
        production: true,
        routes: { "GET /concurrent": { amountSats: "100" } },
      }),
    );
    app.get("/concurrent", (_req, res) => res.json({ status: "ok" }));

    const server = await startApp(app);
    try {
      const N = 10;
      const responses = await Promise.all(
        Array.from({ length: N }, () => fetch(`${server.origin}/concurrent`)),
      );

      const offers = await Promise.all(responses.map((r) => r.json()));
      const payToAddrs = offers.map((o) => o.invoice.payTo);
      const invoiceIds = offers.map((o) => o.invoiceId);

      const uniqueAddrs = new Set(payToAddrs);
      const uniqueIds = new Set(invoiceIds);

      assert.equal(uniqueAddrs.size, N, "Every concurrent invoice must receive a unique address");
      assert.equal(uniqueIds.size, N, "Every concurrent invoice must receive a unique invoiceId");
    } finally {
      await server.close();
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P0: 7. watch-only allocator strictly rejects private keys and contains zero private material", () => {
  // Reject xprv
  const testXprv =
    "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHL";
  assert.throws(
    () => createXpubPayToAllocator(testXprv),
    /Private extended key material \(xprv\/tprv\) is strictly prohibited/,
  );

  // Reject invalid strings
  assert.throws(() => createXpubPayToAllocator(""), /Merchant xpub must be a non-empty string/);
  assert.throws(() => createXpubPayToAllocator("not_an_xpub"), /Expected standard watch-only extended public key/);

  // Valid xpub allocates strictly derived P2PKH addresses
  const allocator = createXpubPayToAllocator(TEST_XPUB);
  const addr0 = allocator.deriveAddress(0);
  const addr1 = allocator.deriveAddress(1);
  assert.match(addr0, /^ecash:q[a-z0-9]{41}$/);
  assert.match(addr1, /^ecash:q[a-z0-9]{41}$/);
  assert.notEqual(addr0, addr1);

  // Hardened indices (>= 0x80000000) are rejected
  assert.throws(() => allocator.deriveAddress(0x80000000), /Invalid non-hardened derivation index/);
  assert.throws(() => allocator.deriveAddress(-1), /Invalid non-hardened derivation index/);
});

test("P0 & P1-2: production middleware fails closed on non-durable store or static payTo", () => {
  const allocator = createXpubPayToAllocator(TEST_XPUB);
  const txProvider = new MockTxProvider();
  const memStore = new InMemoryAuthoritativeInvoiceStore();

  // Rejects in-memory store in production
  assert.throws(
    () =>
      createX402SettlementMiddleware({
        publicOrigin: PUBLIC_ORIGIN,
        payToAllocator: allocator,
        store: memStore,
        txProvider,
        production: true,
        routes: { "GET /test": { amountSats: "100" } },
      }),
    /Production real-funds middleware requires a durable authoritative store/,
  );

  // Rejects static payTo without allocator in production
  const sqliteStore = new SqliteAuthoritativeInvoiceStore(":memory:");
  assert.throws(
    () =>
      createX402SettlementMiddleware({
        publicOrigin: PUBLIC_ORIGIN,
        payTo: "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w",
        store: sqliteStore,
        txProvider,
        production: true,
        routes: { "GET /test": { amountSats: "100" } },
      }),
    /Production real-funds middleware requires a watch-only payToAllocator/,
  );
});
