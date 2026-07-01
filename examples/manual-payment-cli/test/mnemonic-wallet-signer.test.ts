import assert from "node:assert/strict";
import test from "node:test";
import {
  StaticUtxoProvider,
  TestOnlyMockBroadcastProvider,
} from "@x402-xec/payments";
import { Address } from "ecash-lib";
import {
  MNEMONIC_ENV,
  runManualPaymentCli,
} from "../src/cli.js";
import {
  EcashMnemonicSigner,
  TONALLI_ECASH_DERIVATION_PATH,
} from "../src/wallet-signer.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const EXPECTED_ADDRESS = "ecash:qrwzys2q6xq98vwz0kjn6ulu5m6yljr5fyc909kalg";
const EXPECTED_SIGNATURE = "ILd1kUwqb2HFRRrraEuptQlZZ55NxPlcA8Qkk2D2hvwea5E95ZoqZsd_IgR8LAaJA970XuMEXKNeh40Nd7HT2pc";
const PAY_TO = Address.p2pkh("11".repeat(20)).toString();

test("mnemonic signer derives Tonalli-compatible first eCash address", () => {
  const signer = new EcashMnemonicSigner(MNEMONIC);
  try {
    assert.equal(TONALLI_ECASH_DERIVATION_PATH, "m/44'/1899'/0'/0/0");
    assert.equal(signer.address, EXPECTED_ADDRESS);
  } finally {
    signer.destroy();
  }
});

test("mnemonic signer signs authorization messages deterministically", () => {
  const signer = new EcashMnemonicSigner(MNEMONIC);
  try {
    assert.equal(
      signer.sign("x402-XEC authorization fixture"),
      EXPECTED_SIGNATURE,
    );
  } finally {
    signer.destroy();
  }
});

test("CLI rejects mnemonic and low-level key options together", async () => {
  await assert.rejects(
    runManualPaymentCli([
      "--private-key", "00".repeat(31) + "01",
      "--pay-to", PAY_TO,
      "--amount-sats", "100",
    ], {
      env: { [MNEMONIC_ENV]: MNEMONIC },
      utxoProvider: new StaticUtxoProvider([]),
      log: () => undefined,
    }),
    /cannot be combined/,
  );
});

test("mnemonic dry-run signs offline and never broadcasts by default", async () => {
  const broadcaster = new TestOnlyMockBroadcastProvider("ab".repeat(32));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Unexpected network call");
  }) as typeof fetch;

  try {
    const result = await runManualPaymentCli([
      "--pay-to", PAY_TO,
      "--amount-sats", "100",
    ], {
      env: { [MNEMONIC_ENV]: MNEMONIC },
      now: () => 1_800_000_000,
      utxoProvider: new StaticUtxoProvider([{
        txid: "22".repeat(32),
        outIdx: 1,
        sats: "10000",
        outputScript: Address.fromCashAddress(EXPECTED_ADDRESS).toScriptHex(),
      }]),
      broadcastProvider: broadcaster,
      log: () => undefined,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.broadcasted, false);
    assert.match(result.rawTxHex, /^[0-9a-f]+$/);
    assert.deepEqual(broadcaster.broadcasts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mnemonic text is redacted from errors and logs", async () => {
  const lines: string[] = [];
  await assert.rejects(
    runManualPaymentCli([
      "--pay-to", PAY_TO,
      "--amount-sats", "100",
    ], {
      env: { [MNEMONIC_ENV]: MNEMONIC },
      utxoProvider: {
        getUtxos() {
          throw new Error(`provider accidentally included ${MNEMONIC}`);
        },
      },
      log: (line) => lines.push(line),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(MNEMONIC), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
  assert.equal(lines.join("\n").includes(MNEMONIC), false);
});
