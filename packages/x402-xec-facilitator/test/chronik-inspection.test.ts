import assert from "node:assert/strict";
import test from "node:test";
import { inspectFundingTransaction } from "@x402-xec/core";
import {
  avalancheFinalTransactionFixture,
  confirmedTransactionFixture,
  insufficientSatsFixture,
  missingTransactionFixture,
  MockChronik,
  tokenOutputFixture,
  unfinalizedTransactionFixture,
  validFundingFixture,
  wrongOutIdxFixture,
  wrongPayToFixture,
  type ChronikInspectionFixture,
} from "../src/index.js";

async function inspect(fixture: ChronikInspectionFixture) {
  return inspectFundingTransaction({
    chronik: new MockChronik(fixture.transactions),
    fundingOutpoint: fixture.fundingOutpoint,
    outputScript: fixture.outputScript,
    amountSats: fixture.amountSats,
  });
}

test("valid funding transaction fixture passes", async () => {
  const result = await inspect(validFundingFixture);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.transaction.txid, validFundingFixture.fundingOutpoint.txid);
  assert.equal(result.ok && result.output.sats, 2_000n);
});

test("missing transaction fails", async () => {
  assert.deepEqual(await inspect(missingTransactionFixture), {
    ok: false,
    code: "TRANSACTION_NOT_FOUND",
  });
});

test("missing output fails", async () => {
  assert.deepEqual(await inspect(wrongOutIdxFixture), {
    ok: false,
    code: "OUTPUT_NOT_FOUND",
  });
});

test("wrong payTo output script fails", async () => {
  assert.deepEqual(await inspect(wrongPayToFixture), {
    ok: false,
    code: "OUTPUT_SCRIPT_MISMATCH",
  });
});

test("insufficient sats fails", async () => {
  assert.deepEqual(await inspect(insufficientSatsFixture), {
    ok: false,
    code: "INSUFFICIENT_SATS",
  });
});

test("token-bearing output fails", async () => {
  assert.deepEqual(await inspect(tokenOutputFixture), {
    ok: false,
    code: "TOKEN_OUTPUT",
  });
});

test("unconfirmed non-final transaction fails", async () => {
  assert.deepEqual(await inspect(unfinalizedTransactionFixture), {
    ok: false,
    code: "TRANSACTION_NOT_FINAL",
  });
});

test("confirmed transaction passes", async () => {
  assert.equal((await inspect(confirmedTransactionFixture)).ok, true);
});

test("Avalanche-final transaction passes", async () => {
  assert.equal((await inspect(avalancheFinalTransactionFixture)).ok, true);
});
