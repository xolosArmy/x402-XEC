import assert from "node:assert/strict";
import test from "node:test";
import type { XecSigner } from "@x402-xec/axios";
import { FixtureChronikTxProvider } from "@x402-xec/facilitator";
import axios from "axios";
import { DEMO_PAYER, DEMO_TXID, DEMO_VOUT } from "../src/facilitator.js";
import { startLocalE2e } from "../src/index.js";

test("local e2e returns 200 with interceptor", async (t) => {
  const demo = await startLocalE2e();
  t.after(() => demo.close());

  assert.ok(demo.facilitator.txProvider instanceof FixtureChronikTxProvider);

  const response = await demo.createClient().get(demo.url);

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    city: "Mérida",
    condition: "sunny",
    temperatureC: 29,
  });
  assert.equal(demo.facilitator.ledger.entries().length, 1);
  assert.equal(demo.facilitator.ledger.entries()[0]?.debitedSats, 1_000n);
});

test("direct request without interceptor returns 402", async (t) => {
  const demo = await startLocalE2e();
  t.after(() => demo.close());

  const response = await axios.get(demo.url, {
    proxy: false,
    validateStatus: () => true,
  });

  assert.equal(response.status, 402);
  assert.equal(response.data.invoice.amountSats, "1000");
  assert.equal(demo.server.stats.facilitatorVerifications, 0);
});

test("invalid signature fails", async (t) => {
  const demo = await startLocalE2e();
  t.after(() => demo.close());
  const invalidSigner: XecSigner = {
    payer: DEMO_PAYER,
    transaction: { txid: DEMO_TXID, vout: DEMO_VOUT },
    sign: () => "invalid",
  };

  await assert.rejects(
    demo.createClient(invalidSigner).get(demo.url),
    (error: unknown) => {
      assert.equal(axios.isAxiosError(error) && error.response?.status, 402);
      assert.equal(error.response?.data.error.code, "INVALID_SIGNATURE");
      return true;
    },
  );
  assert.equal(demo.facilitator.ledger.entries().length, 0);
});

test("retry loop is prevented if facilitator verification fails", async (t) => {
  const demo = await startLocalE2e({
    signatureVerifier: { verify: () => false },
  });
  t.after(() => demo.close());

  await assert.rejects(
    demo.createClient().get(demo.url),
    (error: unknown) => {
      assert.equal(axios.isAxiosError(error) && error.response?.status, 402);
      return true;
    },
  );
  assert.equal(demo.server.stats.apiRequests, 2);
  assert.equal(demo.server.stats.facilitatorVerifications, 1);
});
