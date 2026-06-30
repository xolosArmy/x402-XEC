import assert from "node:assert/strict";
import test from "node:test";
import {
  StaticUtxoProvider,
  TestOnlyApprovalProvider,
  TestOnlyMockBroadcastProvider,
} from "@x402-xec/payments";
import { Address, Ecc, shaRmd160 } from "ecash-lib";
import {
  BROADCAST_CONFIRMATION_PHRASE,
  DEFAULT_MAX_BROADCAST_SATS,
  parseCliArgs,
  runManualPaymentCli,
} from "../src/cli.js";

const NOW = 1_800_000_000;
const PRIVATE_KEY = "00".repeat(31) + "01";
const SECRET_BYTES = Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex"));
const PUBLIC_KEY = new Ecc().derivePubkey(SECRET_BYTES);
const FROM_ADDRESS = Address.p2pkh(shaRmd160(PUBLIC_KEY)).toString();
const PAY_TO = Address.p2pkh("11".repeat(20)).toString();
const SOURCE_SCRIPT = Address.fromCashAddress(FROM_ADDRESS).toScriptHex();
const CHRONIK_URL = "https://chronik.example";

const baseArgs = [
  "--chronik-url", CHRONIK_URL,
  "--from-address", FROM_ADDRESS,
  "--private-key", PRIVATE_KEY,
  "--pay-to", PAY_TO,
  "--amount-sats", "1000",
] as const;

function dependencies(
  broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32)),
) {
  return {
    now: () => NOW,
    utxoProvider: new StaticUtxoProvider([{
      txid: "22".repeat(32),
      outIdx: 1,
      sats: "10000",
      outputScript: SOURCE_SCRIPT,
    }]),
    broadcastProvider: broadcaster,
    log: (_line: string) => {},
  };
}

test("default CLI mode is dry-run", () => {
  assert.equal(parseCliArgs([]).mode, "dry-run");
  assert.equal(parseCliArgs(baseArgs).mode, "dry-run");
});

test("dry-run builds a payment and never calls broadcaster", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;

  try {
    const result = await runManualPaymentCli(baseArgs, dependencies(broadcaster));
    assert.equal(result.dryRun, true);
    assert.equal(result.broadcasted, false);
    assert.match(result.paymentSignature, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(broadcaster.broadcasts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("broadcast fails without explicit confirmation flag", () => {
  assert.throws(
    () => parseCliArgs([
      "broadcast",
      "--allow-broadcast",
      "--max-payment-sats", "1000",
      ...baseArgs,
    ]),
    /--yes-i-understand-this-broadcasts-xec/,
  );
});

test("broadcast requires the exact confirmation phrase", () => {
  assert.throws(
    () => parseCliArgs([
      "broadcast",
      "--allow-broadcast",
      "--yes-i-understand-this-broadcasts-xec",
      "--confirmation-phrase", "broadcast please",
      "--max-payment-sats", "1000",
      ...baseArgs,
    ]),
    new RegExp(BROADCAST_CONFIRMATION_PHRASE),
  );
});

test("broadcast fails without maxPaymentSats", () => {
  assert.throws(
    () => parseCliArgs([
      "broadcast",
      "--allow-broadcast",
      "--yes-i-understand-this-broadcasts-xec",
      "--confirmation-phrase", BROADCAST_CONFIRMATION_PHRASE,
      ...baseArgs,
    ]),
    /--max-payment-sats/,
  );
});

test("broadcast fails if policy rejects amount", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  await assert.rejects(
    runManualPaymentCli([
      "broadcast",
      "--allow-broadcast",
      "--yes-i-understand-this-broadcasts-xec",
      "--confirmation-phrase", BROADCAST_CONFIRMATION_PHRASE,
      "--max-payment-sats", "999",
      ...baseArgs,
    ], {
      ...dependencies(broadcaster),
      approvalProvider: new TestOnlyApprovalProvider({ approved: true }),
    }),
    /exceeds maxPaymentSats 999/,
  );
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("broadcast never runs when approval provider rejects", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  await assert.rejects(
    runManualPaymentCli([
      "broadcast",
      "--allow-broadcast",
      "--yes-i-understand-this-broadcasts-xec",
      "--confirmation-phrase", BROADCAST_CONFIRMATION_PHRASE,
      "--max-payment-sats", "1000",
      ...baseArgs,
    ], {
      ...dependencies(broadcaster),
      approvalProvider: new TestOnlyApprovalProvider({
        approved: false,
        reason: "manual test rejection",
      }),
    }),
    /manual test rejection/,
  );
  assert.deepEqual(broadcaster.broadcasts, []);
});

test("broadcast succeeds with explicit test approval and mock broadcaster", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const approval = new TestOnlyApprovalProvider({
    approved: true,
    approvedAt: NOW,
    approver: "test-suite",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;

  try {
    const result = await runManualPaymentCli([
      "broadcast",
      "--allow-broadcast",
      "--yes-i-understand-this-broadcasts-xec",
      "--confirmation-phrase", BROADCAST_CONFIRMATION_PHRASE,
      "--max-payment-sats", "1000",
      ...baseArgs,
    ], {
      ...dependencies(broadcaster),
      approvalProvider: approval,
    });
    assert.equal(result.broadcasted, true);
    assert.equal(result.dryRun, false);
    if (!result.broadcasted) assert.fail("expected broadcast result");
    assert.equal(result.broadcastResult.txid, "ab".repeat(32));
    assert.equal(approval.plans.length, 1);
    assert.deepEqual(broadcaster.broadcasts, [result.rawTxHex]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI output never logs private key material", async () => {
  const lines: string[] = [];
  await runManualPaymentCli(baseArgs, {
    ...dependencies(),
    log: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  assert.equal(output.includes(PRIVATE_KEY), false);
  assert.equal(output.includes(Buffer.from(SECRET_BYTES).toString("base64")), false);
  assert.equal(output.includes("--private-key"), false);
});

test("broadcast refuses amounts above the conservative default", () => {
  const highAmountArgs = baseArgs.map((value) => value === "1000" ? "1001" : value);
  assert.throws(
    () => parseCliArgs([
      "broadcast",
      "--allow-broadcast",
      "--yes-i-understand-this-broadcasts-xec",
      "--confirmation-phrase", BROADCAST_CONFIRMATION_PHRASE,
      "--max-payment-sats", "1001",
      ...highAmountArgs,
    ]),
    new RegExp(`conservative default limit of ${DEFAULT_MAX_BROADCAST_SATS} sats`),
  );
});

test("explicit conservative-limit override retains maxPaymentSats policy", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const highAmountArgs = baseArgs.map((value) => value === "1000" ? "1001" : value);
  const result = await runManualPaymentCli([
    "broadcast",
    "--allow-broadcast",
    "--yes-i-understand-this-broadcasts-xec",
    "--confirmation-phrase", BROADCAST_CONFIRMATION_PHRASE,
    "--override-conservative-limit",
    "--max-payment-sats", "1001",
    ...highAmountArgs,
  ], {
    ...dependencies(broadcaster),
    approvalProvider: new TestOnlyApprovalProvider({ approved: true }),
  });
  assert.equal(result.broadcasted, true);
  assert.equal(result.plannedBroadcast.amountSats, "1001");
  assert.equal(broadcaster.broadcasts.length, 1);
});

test("mainnet execution emits an explicit warning", async () => {
  const lines: string[] = [];
  await runManualPaymentCli(baseArgs, {
    ...dependencies(),
    log: (line) => lines.push(line),
  });
  assert.match(lines[0] ?? "", /WARNING: eCash mainnet/);
  assert.match(lines[0] ?? "", /DRY RUN/);
});

test("provider errors redact supplied private key material", async () => {
  await assert.rejects(
    runManualPaymentCli(baseArgs, {
      ...dependencies(),
      utxoProvider: {
        getUtxos() {
          throw new Error(`provider accidentally included ${PRIVATE_KEY}`);
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(PRIVATE_KEY), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
