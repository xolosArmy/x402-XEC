import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalHash,
  createInvoice,
  type Invoice,
  type ResourceRequest,
  type SignatureProvider,
} from "@x402-xec/core";
import {
  buildFundingTx,
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
  DisabledApprovalProvider,
  DisabledBroadcastProvider,
  LivePaymentOrchestrator,
  StaticUtxoProvider,
  TestOnlyApprovalProvider,
  TestOnlyMockBroadcastProvider,
  type LivePaymentOrchestratorConfig,
  type PaymentPolicy,
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
const RESOURCE: ResourceRequest = {
  serverOrigin: "https://merchant.example",
  method: "POST",
  path: "/api/weather",
  query: [["units", "metric"]],
  body: { city: "Mexico City" },
};

function policy(overrides: Partial<PaymentPolicy> = {}): PaymentPolicy {
  return {
    maxPaymentSats: 2_000n,
    allowedNetworks: ["xec:mainnet"],
    allowedSchemes: ["exact"],
    requireManualApproval: true,
    ...overrides,
  };
}

class DeterministicSignatureProvider implements SignatureProvider {
  readonly messages: string[] = [];

  sign(message: string): string {
    this.messages.push(message);
    return canonicalHash({ domain: "live-payment-test-v1", message, payer: PAYER });
  }
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    ...createInvoice({
      request: RESOURCE,
      amountSats: 1_000n,
      payTo: PAY_TO,
      nonce: "live_payment_fixture_nonce_000001",
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

function config(
  overrides: Partial<LivePaymentOrchestratorConfig> = {},
): LivePaymentOrchestratorConfig {
  return {
    utxoProvider: new StaticUtxoProvider([utxo()]),
    signatureProvider: new DeterministicSignatureProvider(),
    payer: PAYER,
    changeAddress: PAYER,
    signatoryForUtxo: () => (
      P2PKHSignatory(SECRET_KEY, PUBLIC_KEY, ALL_BIP143)
    ),
    now: () => NOW,
    paymentPolicy: policy(),
    ...overrides,
  };
}

const request = (value: Invoice = invoice()) => ({
  invoice: value,
  resource: RESOURCE,
});

test("dry-run is default, composes the builder, and never broadcasts", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  let builderCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;

  try {
    const orchestrator = new LivePaymentOrchestrator(config({
      broadcastProvider: broadcaster,
      transactionBuilder(input) {
        builderCalls += 1;
        return buildFundingTx(input);
      },
    }));
    const result = await orchestrator.execute(request());

    assert.equal(result.dryRun, true);
    assert.equal(result.broadcasted, false);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.requiresManualApproval, true);
    assert.equal(builderCalls, 1);
    assert.deepEqual(broadcaster.broadcasts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dry-run returns raw tx, funding outpoint, authorization, and PAYMENT-SIGNATURE", async () => {
  const result = await new LivePaymentOrchestrator(config()).execute(request());
  const decoded = JSON.parse(
    Buffer.from(result.paymentSignature, "base64url").toString("utf8"),
  ) as unknown;

  assert.match(result.rawTxHex, /^[0-9a-f]+$/);
  assert.deepEqual(result.fundingOutpoint, {
    txid: result.fundingTransaction.txid,
    outIdx: 0,
  });
  assert.deepEqual(result.authorization, result.envelope.authorization);
  assert.deepEqual(decoded, result.envelope);
  assert.deepEqual(result.plannedBroadcast, {
    transactionTxid: result.fundingTransaction.txid,
    rawTxHex: result.rawTxHex,
    fundingOutpoint: result.fundingOutpoint,
    amountSats: "1000",
    payTo: PAY_TO,
  });
});

test("DisabledBroadcastProvider prevents live broadcast", () => {
  assert.throws(
    () => new LivePaymentOrchestrator(config({
      dryRun: false,
      allowBroadcast: true,
      broadcastProvider: new DisabledBroadcastProvider(),
    })),
    /explicit non-disabled BroadcastProvider/,
  );
});

test("live mode requires allowBroadcast true", () => {
  assert.throws(
    () => new LivePaymentOrchestrator(config({
      dryRun: false,
      broadcastProvider: new TestOnlyMockBroadcastProvider("ab".repeat(32)),
    })),
    /requires allowBroadcast: true/,
  );
});

test("live mode requires an explicit non-disabled broadcaster", () => {
  assert.throws(
    () => new LivePaymentOrchestrator(config({
      dryRun: false,
      allowBroadcast: true,
    })),
    /explicit non-disabled BroadcastProvider/,
  );
});

test("live mode fails with the default DisabledApprovalProvider", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const orchestrator = new LivePaymentOrchestrator(config({
    dryRun: false,
    allowBroadcast: true,
    broadcastProvider: broadcaster,
    approvalProvider: new DisabledApprovalProvider(),
  }));

  await assert.rejects(
    orchestrator.execute(request()),
    new RegExp("approval is disabled", "i"),
  );
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("amount above maxPaymentSats fails without broadcasting", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const orchestrator = new LivePaymentOrchestrator(config({
    dryRun: false,
    allowBroadcast: true,
    paymentPolicy: policy({ maxPaymentSats: 999n }),
    broadcastProvider: broadcaster,
  }));

  await assert.rejects(orchestrator.execute(request()), /exceeds maxPaymentSats 999/);
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("expired invoice fails before UTXO discovery or broadcast", async () => {
  let utxoCalls = 0;
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const orchestrator = new LivePaymentOrchestrator(config({
    utxoProvider: {
      getUtxos() {
        utxoCalls += 1;
        return [utxo()];
      },
    },
    broadcastProvider: broadcaster,
  }));

  await assert.rejects(
    orchestrator.execute(request(invoice({ expiresAt: NOW }))),
    /invoice has expired/,
  );
  assert.equal(utxoCalls, 0);
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("insufficient UTXOs fail without broadcasting", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const orchestrator = new LivePaymentOrchestrator(config({
    utxoProvider: new StaticUtxoProvider([utxo({ sats: "1100" })]),
    broadcastProvider: broadcaster,
  }));

  await assert.rejects(
    orchestrator.execute(request()),
    (error: unknown) => error instanceof InsufficientFundsError,
  );
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("token UTXOs fail without broadcasting", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const orchestrator = new LivePaymentOrchestrator(config({
    utxoProvider: new StaticUtxoProvider([utxo({ token: { atoms: 1n } })]),
    broadcastProvider: broadcaster,
  }));

  await assert.rejects(
    orchestrator.execute(request()),
    /Token-bearing UTXOs cannot fund XEC transactions/,
  );
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("manual approval rejection prevents live broadcast", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const approval = new TestOnlyApprovalProvider({
    approved: false,
    reason: "user rejected payment",
  });
  const orchestrator = new LivePaymentOrchestrator(config({
    dryRun: false,
    allowBroadcast: true,
    broadcastProvider: broadcaster,
    approvalProvider: approval,
  }));

  await assert.rejects(
    orchestrator.execute(request()),
    new RegExp("user rejected payment"),
  );
  assert.equal(approval.plans.length, 1);
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("mock broadcaster is called only in fully enabled live mode", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const orchestrator = new LivePaymentOrchestrator(config({
    dryRun: false,
    allowBroadcast: true,
    broadcastProvider: broadcaster,
    approvalProvider: new TestOnlyApprovalProvider({
      approved: true,
      approvedAt: NOW,
      approver: "test-suite",
    }),
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;

  try {
    const result = await orchestrator.execute(request());
    assert.equal(result.dryRun, false);
    assert.equal(result.broadcasted, true);
    assert.deepEqual(result.broadcastResult, { txid: "ab".repeat(32) });
    assert.deepEqual(broadcaster.broadcasts, [result.rawTxHex]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
