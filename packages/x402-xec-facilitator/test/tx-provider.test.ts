import assert from "node:assert/strict";
import test from "node:test";
import {
  FixtureChronikTxProvider,
  MISSING_FIXTURE_TXID,
  TxNotFoundError,
  validFundingFixture,
} from "../src/index.js";

test("fixture provider returns a Chronik-style transaction", async () => {
  const provider = new FixtureChronikTxProvider(validFundingFixture.transactions);

  const transaction = await provider.getTx(validFundingFixture.fundingOutpoint.txid);

  assert.equal(transaction.txid, validFundingFixture.fundingOutpoint.txid);
  assert.equal(transaction.outputs[0]?.sats, 2_000n);
  assert.equal(transaction.isFinal, true);
});

test("fixture provider rejects a missing txid with a typed error", async () => {
  const provider = new FixtureChronikTxProvider(validFundingFixture.transactions);

  await assert.rejects(
    provider.getTx(MISSING_FIXTURE_TXID),
    (error: unknown) => {
      assert.ok(error instanceof TxNotFoundError);
      assert.equal(error.code, "TX_NOT_FOUND");
      assert.equal(error.txid, MISSING_FIXTURE_TXID);
      return true;
    },
  );
});

test("fixture provider performs no network calls", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const provider = new FixtureChronikTxProvider(validFundingFixture.transactions);
  await provider.getTx(validFundingFixture.fundingOutpoint.txid);
  await assert.rejects(provider.getTx(MISSING_FIXTURE_TXID), TxNotFoundError);

  assert.equal(fetchCalls, 0);
});
