import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationSchema,
  authorizationSigningMessage,
  canonicalHash,
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
  type Invoice,
  type ResourceRequest,
  type SignatureProvider,
  type SignatureVerifier,
} from "@x402-xec/core";
import {
  InsufficientFundsError,
  type FundingUtxo,
} from "@x402-xec/transactions";
import {
  Address,
  ALL_BIP143,
  Ecc,
  P2PKHSignatory,
  shaRmd160,
} from "ecash-lib";
import {
  OfflinePaymentPreparer,
  StaticUtxoProvider,
  type OfflinePaymentPreparerOptions,
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
const SOURCE_SCRIPT = Address.fromCashAddress(PAYER).toScriptHex();
const PAY_TO = Address.p2pkh("11".repeat(20)).toString();
const OTHER_PAY_TO = Address.p2pkh("33".repeat(20)).toString();
const RESOURCE: ResourceRequest = {
  serverOrigin: "https://merchant.example",
  method: "POST",
  path: "/api/weather",
  query: [["units", "metric"]],
  body: { city: "Mexico City" },
};

class DeterministicSignatureProvider
implements SignatureProvider, SignatureVerifier {
  readonly messages: string[] = [];

  sign(message: string): string {
    this.messages.push(message);
    return signatureFor(message);
  }

  verify(input: {
    readonly payer: string;
    readonly message: string;
    readonly signature: string;
  }): boolean {
    return input.payer === PAYER && input.signature === signatureFor(input.message);
  }
}

function signatureFor(message: string): string {
  return canonicalHash({
    domain: "x402-xec-payments-test-signature-v1",
    message,
    payer: PAYER,
  });
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    ...createInvoice({
      request: RESOURCE,
      amountSats: 1_000n,
      payTo: PAY_TO,
      nonce: "offline_payment_fixture_nonce_0001",
      issuedAt: NOW - 1,
      expiresAt: NOW + 60,
    }),
    ...overrides,
  };
}

function utxo(overrides: Partial<FundingUtxo> = {}): FundingUtxo {
  return {
    txid: "22".repeat(32),
    outIdx: 1,
    sats: "10000",
    outputScript: SOURCE_SCRIPT,
    ...overrides,
  };
}

function options(
  signatureProvider: DeterministicSignatureProvider,
  overrides: Partial<OfflinePaymentPreparerOptions> = {},
): OfflinePaymentPreparerOptions {
  return {
    utxoProvider: new StaticUtxoProvider([utxo()]),
    signatureProvider,
    payer: PAYER,
    changeAddress: PAYER,
    signatoryForUtxo: () => (
      P2PKHSignatory(SECRET_KEY, PUBLIC_KEY, ALL_BIP143)
    ),
    maxPaymentSats: 2_000n,
    now: () => NOW,
    ...overrides,
  };
}

test("prepares a deterministic PAYMENT-SIGNATURE envelope offline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;
  const signer = new DeterministicSignatureProvider();

  try {
    const preparer = new OfflinePaymentPreparer(options(signer));
    const first = await preparer.prepare({
      invoice: invoice(),
      resource: RESOURCE,
    });
    const second = await preparer.prepare({
      invoice: invoice(),
      resource: RESOURCE,
    });
    const decoded = JSON.parse(
      Buffer.from(first.paymentSignature, "base64url").toString("utf8"),
    ) as unknown;

    assert.deepEqual(decoded, first.envelope);
    assert.equal(first.rawTx, first.fundingTransaction.rawTx);
    assert.deepEqual(
      first.fundingOutpoint,
      first.fundingTransaction.fundingOutpoint,
    );
    assert.deepEqual(first.fundingOutpoint, {
      txid: first.fundingTransaction.txid,
      outIdx: 0,
    });
    assert.equal(first.paymentSignature, second.paymentSignature);
    assert.equal(first.rawTx, second.rawTx);
    assert.equal(signer.messages.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects an expired invoice before reading UTXOs", async () => {
  let providerCalls = 0;
  const signer = new DeterministicSignatureProvider();
  const preparer = new OfflinePaymentPreparer(options(signer, {
    utxoProvider: {
      getUtxos() {
        providerCalls += 1;
        return [utxo()];
      },
    },
  }));

  await assert.rejects(
    preparer.prepare({
      invoice: invoice({ expiresAt: NOW }),
      resource: RESOURCE,
    }),
    /invoice has expired/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(signer.messages.length, 0);
});

test("rejects an unsupported network", async () => {
  const preparer = new OfflinePaymentPreparer(
    options(new DeterministicSignatureProvider()),
  );
  await assert.rejects(
    preparer.prepare({
      invoice: invoice({ network: "xec:testnet" } as Partial<Invoice>),
      resource: RESOURCE,
    }),
    /unsupported x402-XEC network: xec:testnet/,
  );
});

test("rejects an amount above maxPaymentSats", async () => {
  const preparer = new OfflinePaymentPreparer(
    options(new DeterministicSignatureProvider(), {
      maxPaymentSats: 999n,
    }),
  );
  await assert.rejects(
    preparer.prepare({ invoice: invoice(), resource: RESOURCE }),
    /payment amount 1000 exceeds maxPaymentSats 999/,
  );
});

test("rejects insufficient UTXOs", async () => {
  const preparer = new OfflinePaymentPreparer(
    options(new DeterministicSignatureProvider(), {
      utxoProvider: new StaticUtxoProvider([utxo({ sats: "1100" })]),
    }),
  );
  await assert.rejects(
    preparer.prepare({ invoice: invoice(), resource: RESOURCE }),
    (error: unknown) => error instanceof InsufficientFundsError,
  );
});

test("rejects token-bearing UTXOs", async () => {
  const preparer = new OfflinePaymentPreparer(
    options(new DeterministicSignatureProvider(), {
      utxoProvider: new StaticUtxoProvider([utxo({
        token: {
          tokenId: "44".repeat(32),
          atoms: 1n,
          isMintBaton: false,
        },
      })]),
    }),
  );
  await assert.rejects(
    preparer.prepare({ invoice: invoice(), resource: RESOURCE }),
    /Token-bearing UTXOs cannot fund XEC transactions/,
  );
});

test("binds authorization to resource, payee, amount, and nonce", async () => {
  const signer = new DeterministicSignatureProvider();
  const result = await new OfflinePaymentPreparer(options(signer)).prepare({
    invoice: invoice(),
    resource: RESOURCE,
  });
  const authorization = result.envelope.authorization;

  assert.equal(authorization.resourceHash, computeResourceHash(RESOURCE));
  assert.notEqual(authorization.resourceHash, computeResourceHash({
    ...RESOURCE,
    method: "GET",
  }));
  assert.notEqual(authorization.resourceHash, computeResourceHash({
    ...RESOURCE,
    path: "/api/forecast",
  }));
  assert.notEqual(authorization.resourceHash, computeResourceHash({
    ...RESOURCE,
    serverOrigin: "https://other.example",
  }));
  assert.equal(authorization.payTo, PAY_TO);
  assert.equal(authorization.amountSats, "1000");
  assert.equal(authorization.nonce, "offline_payment_fixture_nonce_0001");
  assert.equal(
    signer.messages[0],
    authorizationSigningMessage(authorization),
  );
});

test("tampering with invoice-bound fields invalidates the signature", async () => {
  const signer = new DeterministicSignatureProvider();
  const result = await new OfflinePaymentPreparer(options(signer)).prepare({
    invoice: invoice(),
    resource: RESOURCE,
  });
  const original = result.envelope.authorization;
  const tamperedInvoice = invoice({
    payTo: OTHER_PAY_TO,
    nonce: "tampered_payment_fixture_nonce_001",
  });
  const tampered = authorizationSchema.parse({
    ...original,
    invoiceHash: computeInvoiceHash(tamperedInvoice),
    payTo: tamperedInvoice.payTo,
    nonce: tamperedInvoice.nonce,
    signature: original.signature,
  });

  assert.equal(await signer.verify({
    payer: tampered.payer,
    message: authorizationSigningMessage(tampered),
    signature: tampered.signature,
  }), false);
});

test("exports no network or broadcast operation", async () => {
  const exports = await import("../src/index.js");
  assert.equal("fetch" in exports, false);
  assert.equal("broadcast" in exports, false);
  assert.equal("broadcastTx" in exports, false);
  assert.equal("chronik" in exports, false);
});
