import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Facilitator, MockChronik, MockSignatureVerifier, createApp } from "../src/index.js";

test("health and supported endpoints describe a local-only service", async (t) => {
  const app = createApp(new Facilitator({
    chronik: new MockChronik(),
    signatureVerifier: new MockSignatureVerifier(),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await health.json(), { ok: true, service: "x402-xec-facilitator" });

  const supported = await fetch(`http://127.0.0.1:${port}/facilitator/supported`);
  assert.deepEqual(await supported.json(), {
    localOnly: true,
    x402Version: 1,
    schemes: [{ scheme: "exact", network: "xec:mainnet" }],
    chronik: "mock",
    broadcast: false,
    walletCustody: false,
  });
});

test("verify endpoint rejects malformed input as JSON", async (t) => {
  const app = createApp(new Facilitator({
    chronik: new MockChronik(),
    signatureVerifier: new MockSignatureVerifier(),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/facilitator/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, code: "MALFORMED" });
});
