import { withX402XecPaymentInterceptor } from "@x402-xec/axios";
import axios, { type AxiosInstance } from "axios";
import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserDryRunPaymentOrchestrator,
  createFakeTonalliWallet,
  type DemoFlowEvent,
} from "../src/demo-orchestrator.js";
import {
  DEMO_NOW,
  startBrowserDemoServer,
  type StartedBrowserDemoServer,
} from "../src/server.js";

test("server boots, serves HTML, and protects the weather route", async (t) => {
  const server = await startBrowserDemoServer();
  t.after(() => server.close());

  const root = await axios.get(server.origin, { proxy: false });
  assert.equal(root.status, 200);
  assert.match(root.data as string, /Browser dry-run demo only/);
  assert.match(root.data as string, /Get Weather/);

  const protectedResponse = await axios.get(server.url, {
    proxy: false,
    validateStatus: () => true,
  });
  assert.equal(protectedResponse.status, 402);
  assert.equal(protectedResponse.data.invoice.amountSats, "1000");
  assert.equal(server.stats.facilitatorVerifications, 0);
});

test("fake wallet approves, signs, sends PAYMENT-SIGNATURE, and succeeds", async (t) => {
  const server = await startBrowserDemoServer();
  t.after(() => server.close());
  const events: DemoFlowEvent[] = [];
  const requests: unknown[] = [];
  let retryHeader: string | undefined;
  const wallet = createFakeTonalliWallet({
    onEvent: (event) => events.push(event),
    onRequest: (request) => requests.push(request),
  });
  const orchestrator = new BrowserDryRunPaymentOrchestrator(wallet);
  const client = paymentClient(server, orchestrator);
  client.interceptors.request.use((config) => {
    const header = config.headers.get("PAYMENT-SIGNATURE");
    if (typeof header === "string") retryHeader = header;
    return config;
  });

  const response = await client.get(server.url);

  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    city: "Mérida",
    condition: "sunny",
    temperatureC: 29,
    broadcasted: false,
    notice: "DRY RUN ONLY",
  });
  assert.deepEqual(events, [
    "approval requested",
    "mock approval accepted",
    "mock signature returned",
  ]);
  assert.ok(retryHeader);
  assert.equal(server.stats.apiRequests, 2);
  assert.equal(server.stats.facilitatorVerifications, 1);
  assert.deepEqual(Object.keys(wallet).sort(), [
    "getActiveAccount",
    "requestApproval",
    "signAuthorization",
  ]);
  assert.equal("broadcast" in wallet, false);
  assert.equal("broadcast" in orchestrator, false);

  const serializedRequests = JSON.stringify(requests).toLowerCase();
  for (const forbidden of [
    "mnemonic",
    "wif",
    "privatekey",
    "private_key",
    "seedphrase",
    "seed_phrase",
    "secret",
  ]) {
    assert.equal(serializedRequests.includes(forbidden), false);
  }
});

test("rejected wallet approval prevents signing and retry", async (t) => {
  const server = await startBrowserDemoServer();
  t.after(() => server.close());
  const events: DemoFlowEvent[] = [];
  const wallet = createFakeTonalliWallet({
    approve: false,
    onEvent: (event) => events.push(event),
  });

  await assert.rejects(
    paymentClient(
      server,
      new BrowserDryRunPaymentOrchestrator(wallet),
    ).get(server.url),
    /x402-XEC orchestrator payment failed/,
  );

  assert.deepEqual(events, ["approval requested", "mock approval rejected"]);
  assert.equal(server.stats.apiRequests, 1);
  assert.equal(server.stats.facilitatorVerifications, 0);
});

test("demo uses in-process fixture verification without global fetch", async (t) => {
  const server = await startBrowserDemoServer();
  t.after(() => server.close());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("real network fetch is forbidden in browser demo tests");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await paymentClient(
    server,
    new BrowserDryRunPaymentOrchestrator(createFakeTonalliWallet()),
  ).get(server.url);

  assert.equal(response.status, 200);
  assert.equal(response.data.broadcasted, false);
});

function paymentClient(
  server: StartedBrowserDemoServer,
  orchestrator: BrowserDryRunPaymentOrchestrator,
): AxiosInstance {
  return withX402XecPaymentInterceptor(axios.create({ proxy: false }), {
    orchestrator,
    enableOrchestratorPayments: true,
    maxPaymentSats: "1000",
    now: () => DEMO_NOW,
  });
}
