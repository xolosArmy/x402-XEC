import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  cashAddressToOutputScriptHex,
  computeInvoiceHash,
  createInvoice,
  InMemoryAuthoritativeInvoiceStore,
  TxNotFoundError,
  x402SettlementProofV1Schema,
  X402_VERSION,
  XEC_MAINNET,
  type ChronikTransaction,
  type ChronikTransactionOutput,
  type TxProvider,
} from "@x402-xec/core";
import express, { type Express } from "express";
import {
  createX402SettlementMiddleware,
  PAYMENT_PROOF_HEADER,
  type SettlementRouteConfig,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_ORIGIN = "https://api.example.com";
// Valid cashaddr for testing
const PAY_TO = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const PAY_TO_SCRIPT = cashAddressToOutputScriptHex(PAY_TO);
const OTHER_PAY_TO = "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2";
const OTHER_PAY_TO_SCRIPT = cashAddressToOutputScriptHex(OTHER_PAY_TO);

const TXID_1 = "11".repeat(32);
const TXID_2 = "22".repeat(32);
const TXID_3 = "33".repeat(32);

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
  public failWithUnavailable = false;
  public returnMalformed = false;
  public returnWrongTxid = false;
  public queryCount = 0;

  async getTx(txid: string): Promise<ChronikTransaction> {
    this.queryCount++;
    if (this.failWithUnavailable) {
      throw new Error("Chronik 503 Service Unavailable: connection refused");
    }
    if (this.returnMalformed) {
      return null as any;
    }
    if (this.returnWrongTxid) {
      return {
        txid: "99".repeat(32),
        outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
      };
    }
    const found = this.txs.get(txid.toLowerCase());
    if (!found) {
      throw new TxNotFoundError(txid);
    }
    return found;
  }
}

function setupTestServer(options?: {
  readonly now?: () => number;
  readonly txProvider?: MockTxProvider;
  readonly store?: InMemoryAuthoritativeInvoiceStore;
}) {
  const store = options?.store ?? new InMemoryAuthoritativeInvoiceStore();
  const txProvider = options?.txProvider ?? new MockTxProvider();
  let currentTime = options?.now ? options.now() : NOW_BASE;
  const now = () => currentTime;

  const app = express();
  let protectedHandlerCalls = 0;

  const middleware = createX402SettlementMiddleware({
    publicOrigin: PUBLIC_ORIGIN,
    payTo: PAY_TO,
    routes: {
      "GET /protected": {
        amountSats: "1000",
        description: "Protected resource",
      },
      "POST /action": {
        amountSats: "2500",
        description: "Protected action",
      },
    },
    store,
    txProvider,
    expirySeconds: 60,
    now,
  });

  app.use(middleware);

  app.get("/protected", (req, res) => {
    protectedHandlerCalls++;
    res.json({ secret: "UNLOCKED_DATA", calls: protectedHandlerCalls });
  });

  app.post("/action", (req, res) => {
    protectedHandlerCalls++;
    res.json({ secret: "ACTION_COMPLETED", calls: protectedHandlerCalls });
  });

  return {
    app,
    store,
    txProvider,
    setTime: (t: number) => {
      currentTime = t;
    },
    getHandlerCalls: () => protectedHandlerCalls,
  };
}

// ---------------------------------------------------------------------------
// 20 REQUIRED TESTS FOR GATE C3B
// ---------------------------------------------------------------------------

test("1. valid server-issued invoice + observed tx + exact output -> unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    // 1a. Request without proof returns 402 with authoritative invoice
    const res402 = await fetch(`${server.origin}/protected`);
    assert.equal(res402.status, 402);
    const offer = await res402.json();
    assert.equal(offer.x402Version, 1);
    assert.ok(offer.invoiceId);
    assert.equal(offer.accepts[0].proofHeader, "payment-proof");

    // 1b. Mock Chronik has exact payment tx
    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    // 1c. Submit valid settlement proof
    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const resUnlock = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(resUnlock.status, 200);
    const data = await resUnlock.json();
    assert.equal(data.secret, "UNLOCKED_DATA");
    assert.equal(fixture.getHandlerCalls(), 1);

    // Verify invoice state in authoritative store transitioned to PAID
    const record = await fixture.store.getByInvoiceHash(offer.invoiceId);
    assert.equal(record?.state, "PAID");
    assert.equal(record?.settledTxid, TXID_1);
  } finally {
    await server.close();
  }
});

test("2. txid not found -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // TXID_1 not registered in txProvider -> throws TxNotFoundError
    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "TX_NOT_FOUND");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("3. wrong destination -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // Outputs pay OTHER_PAY_TO, not PAY_TO
    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: OTHER_PAY_TO_SCRIPT }],
    });

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "PAY_TO_MISMATCH");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("4. underpayment -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // Required: 1000 sats, provided: 999 sats
    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 999n, outputScript: PAY_TO_SCRIPT }],
    });

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "AMOUNT_MISMATCH");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("5. wrong amount under exact semantics -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // Required: 1000 sats exact, provided: 2000 sats
    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 2000n, outputScript: PAY_TO_SCRIPT }],
    });

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "AMOUNT_MISMATCH");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("6. correct tx but wrong invoiceHash -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    await fetch(`${server.origin}/protected`); // creates an invoice

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    // Valid tx, but wrong invoiceHash
    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: "ee".repeat(32),
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "INVOICE_NOT_FOUND");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("7. fabricated client invoice never issued by server -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    // Client manufactures an invoice locally without server issuance
    const fakeInvoice = createInvoice({
      request: {
        serverOrigin: PUBLIC_ORIGIN,
        method: "GET",
        path: "/protected",
      },
      amountSats: 1000n,
      payTo: PAY_TO,
      nonce: "client_crafted_nonce_12345",
      issuedAt: NOW_BASE,
      expiresAt: NOW_BASE + 60,
    });
    const fakeHash = computeInvoiceHash(fakeInvoice);

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: fakeHash,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "INVOICE_NOT_FOUND");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("8. expired invoice -> no unlock", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    // Exactly at expiry boundary (now === expiresAt) -> exclusive boundary rejected
    fixture.setTime(offer.invoice.expiresAt);

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, "INVOICE_EXPIRED");
    assert.equal(fixture.getHandlerCalls(), 0);
  } finally {
    await server.close();
  }
});

test("9. same invoiceHash + same txid retry -> idempotent success", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    // First attempt -> unlocks
    const res1 = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof) },
    });
    assert.equal(res1.status, 200);
    assert.equal(fixture.getHandlerCalls(), 1);

    // Second attempt with same (invoiceHash, txid) even after expiry -> idempotent success
    fixture.setTime(NOW_BASE + 500);
    const res2 = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof) },
    });
    assert.equal(res2.status, 200);
    assert.equal(fixture.getHandlerCalls(), 2);
  } finally {
    await server.close();
  }
});

test("10. same invoiceHash + second different txid -> conflict", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });
    fixture.txProvider.txs.set(TXID_2, {
      txid: TXID_2,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    // 1st tx settles the invoice
    const proof1 = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };
    const res1 = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof1) },
    });
    assert.equal(res1.status, 200);

    // 2nd different tx for already-paid invoice -> 409 Conflict
    const proof2 = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_2,
    };
    const res2 = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof2) },
    });
    assert.equal(res2.status, 409);
    const body = await res2.json();
    assert.equal(body.error, "TXID_CONFLICT");
    assert.equal(fixture.getHandlerCalls(), 1); // Not called second time
  } finally {
    await server.close();
  }
});

test("11. same txid reused for different invoiceHash -> reject", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    // Generate invoice 1
    const res1 = await fetch(`${server.origin}/protected`);
    const offer1 = await res1.json();

    // Generate invoice 2
    const res2 = await fetch(`${server.origin}/protected`);
    const offer2 = await res2.json();
    assert.notEqual(offer1.invoiceId, offer2.invoiceId);

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    // Settle invoice 1 with TXID_1
    const proof1 = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer1.invoiceId,
      txid: TXID_1,
    };
    const unlock1 = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof1) },
    });
    assert.equal(unlock1.status, 200);

    // Attempt to reuse same TXID_1 to settle invoice 2 -> reject replay!
    const proof2 = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer2.invoiceId,
      txid: TXID_1,
    };
    const unlock2 = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof2) },
    });
    assert.equal(unlock2.status, 409);
    const body = await unlock2.json();
    assert.equal(body.error, "TXID_REUSED");
  } finally {
    await server.close();
  }
});

test("12. concurrent competing proofs -> exactly one binding wins", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });
    fixture.txProvider.txs.set(TXID_2, {
      txid: TXID_2,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    const proofA = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };
    const proofB = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_2,
    };

    // Dispatch concurrently
    const [resA, resB] = await Promise.all([
      fetch(`${server.origin}/protected`, {
        headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proofA) },
      }),
      fetch(`${server.origin}/protected`, {
        headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proofB) },
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 409], "Exactly one proof must win 200, one must fail 409");
    assert.equal(fixture.getHandlerCalls(), 1);
  } finally {
    await server.close();
  }
});

test("13. Chronik unavailable -> fail closed, no unlock, no PAID mutation", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // Chronik network error / 503
    fixture.txProvider.failWithUnavailable = true;

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof) },
    });

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "CHRONIK_UNAVAILABLE");
    assert.equal(fixture.getHandlerCalls(), 0);

    // Crucial: invoice MUST NOT be mutated to PAID
    const record = await fixture.store.getByInvoiceHash(offer.invoiceId);
    assert.equal(record?.state, "ISSUED");
    assert.equal(record?.settledTxid, undefined);
  } finally {
    await server.close();
  }
});

test("14. malformed Chronik tx -> fail closed", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // Chronik returns malformed / null
    fixture.txProvider.returnMalformed = true;

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof) },
    });

    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, "MALFORMED_CHRONIK_TX");
    assert.equal(fixture.getHandlerCalls(), 0);

    const record = await fixture.store.getByInvoiceHash(offer.invoiceId);
    assert.equal(record?.state, "ISSUED");
  } finally {
    await server.close();
  }
});

test("15. no private key/raw tx/signatory fields in proof schema", () => {
  const validProof = {
    x402Version: 1,
    network: "xec:mainnet",
    invoiceHash: "aa".repeat(32),
    txid: "bb".repeat(32),
  };

  assert.ok(x402SettlementProofV1Schema.safeParse(validProof).success);

  // Schema MUST reject extra fields
  const forbiddenFields = [
    { privateKey: "x".repeat(64) },
    { rawTx: "0100000000..." },
    { signatory: {} },
    { signature: "some_sig" },
    { vout: 0 },
    { payer: "ecash:..." },
    { mnemonic: "seed words..." },
    { wif: "5K..." },
  ];

  for (const forbidden of forbiddenFields) {
    const candidate = { ...validProof, ...forbidden };
    const res = x402SettlementProofV1Schema.safeParse(candidate);
    assert.equal(
      res.success,
      false,
      `Proof schema must reject forbidden property: ${Object.keys(forbidden)[0]}`,
    );
  }
});

test("16. C3B code contains no PAYMENT-SIGNATURE requirement", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    // Requests using PAYMENT_PROOF_HEADER without PAYMENT-SIGNATURE succeed
    const res = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify(proof),
      },
    });
    assert.equal(res.status, 200);

    // Verify codebase files for C3B do not require PAYMENT-SIGNATURE
    const settlementMiddlewareContent = readFileSync(
      path.resolve(__dirname, "../src/settlement-middleware.ts"),
      "utf8",
    );
    assert.equal(
      settlementMiddlewareContent.includes("payment-signature"),
      false,
      "settlement-middleware.ts must not contain payment-signature",
    );
  } finally {
    await server.close();
  }
});

test("17. C3B performs zero broadcast calls", () => {
  const coreDir = path.resolve(__dirname, "../../x402-xec-core/src");
  const verifierCode = readFileSync(path.join(coreDir, "settlement-verifier.ts"), "utf8");
  const storeCode = readFileSync(path.join(coreDir, "invoice-store.ts"), "utf8");
  const middlewareCode = readFileSync(
    path.resolve(__dirname, "../src/settlement-middleware.ts"),
    "utf8",
  );

  const combined = verifierCode + storeCode + middlewareCode;
  assert.equal(
    combined.includes("broadcastTx"),
    false,
    "C3B components must not reference or call broadcastTx",
  );
  assert.equal(
    combined.includes("broadcast"),
    false,
    "C3B components must not reference or call broadcast",
  );
});

test("18. C3B performs zero transaction construction/signing", () => {
  const coreDir = path.resolve(__dirname, "../../x402-xec-core/src");
  const verifierCode = readFileSync(path.join(coreDir, "settlement-verifier.ts"), "utf8");
  const storeCode = readFileSync(path.join(coreDir, "invoice-store.ts"), "utf8");
  const middlewareCode = readFileSync(
    path.resolve(__dirname, "../src/settlement-middleware.ts"),
    "utf8",
  );

  const combined = verifierCode + storeCode + middlewareCode;
  const signingKeywords = [
    "signatoryForUtxo",
    "P2PKHSignatory",
    "TxBuilder",
    "signPreparedTransaction",
    "privateKey",
  ];
  for (const kw of signingKeywords) {
    assert.equal(combined.includes(kw), false, `C3B components must not contain ${kw}`);
  }
});

test("19. server selects matching output itself; client cannot nominate vout", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    const res402 = await fetch(`${server.origin}/protected`);
    const offer = await res402.json();

    // Transaction has 3 outputs:
    // output 0: change (different script)
    // output 1: token output paying destination (must be rejected)
    // output 2: qualifying payment output
    const outputs: ChronikTransactionOutput[] = [
      { sats: 5000n, outputScript: OTHER_PAY_TO_SCRIPT },
      { sats: 1000n, outputScript: PAY_TO_SCRIPT, token: { tokenId: "token123" } },
      { sats: 1000n, outputScript: PAY_TO_SCRIPT },
    ];

    fixture.txProvider.txs.set(TXID_1, { txid: TXID_1, outputs });

    // Client provides NO vout in proof
    const proof = {
      x402Version: 1,
      network: "xec:mainnet",
      invoiceHash: offer.invoiceId,
      txid: TXID_1,
    };

    const res = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(proof) },
    });

    assert.equal(res.status, 200);
    assert.equal(fixture.getHandlerCalls(), 1);

    // If client tries to inject vout, proof parsing fails schema validation
    const badProof = { ...proof, vout: 0 };
    const resBad = await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: JSON.stringify(badProof) },
    });
    assert.equal(resBad.status, 400);
    const badBody = await resBad.json();
    assert.equal(badBody.error, "MALFORMED_PROOF");
  } finally {
    await server.close();
  }
});

test("20. protected resource handler is unreachable before proof commit", async () => {
  const fixture = setupTestServer();
  const server = await startApp(fixture.app);
  try {
    assert.equal(fixture.getHandlerCalls(), 0);

    // Attempt 1: no header -> 402, handler not reached
    await fetch(`${server.origin}/protected`);
    assert.equal(fixture.getHandlerCalls(), 0);

    // Attempt 2: junk header -> 400, handler not reached
    await fetch(`${server.origin}/protected`, {
      headers: { [PAYMENT_PROOF_HEADER]: "not-valid-json" },
    });
    assert.equal(fixture.getHandlerCalls(), 0);

    // Attempt 3: unconfirmed tx -> 402, handler not reached
    await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify({
          x402Version: 1,
          network: "xec:mainnet",
          invoiceHash: "aa".repeat(32),
          txid: "bb".repeat(32),
        }),
      },
    });
    assert.equal(fixture.getHandlerCalls(), 0);

    // Attempt 4: valid proof -> 200, handler reached exactly once
    const resOffer = await fetch(`${server.origin}/protected`);
    const offer = await resOffer.json();

    fixture.txProvider.txs.set(TXID_1, {
      txid: TXID_1,
      outputs: [{ sats: 1000n, outputScript: PAY_TO_SCRIPT }],
    });

    const resUnlock = await fetch(`${server.origin}/protected`, {
      headers: {
        [PAYMENT_PROOF_HEADER]: JSON.stringify({
          x402Version: 1,
          network: "xec:mainnet",
          invoiceHash: offer.invoiceId,
          txid: TXID_1,
        }),
      },
    });
    assert.equal(resUnlock.status, 200);
    assert.equal(fixture.getHandlerCalls(), 1);
  } finally {
    await server.close();
  }
});
