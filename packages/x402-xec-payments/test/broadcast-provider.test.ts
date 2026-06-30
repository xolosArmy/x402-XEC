import assert from "node:assert/strict";
import test from "node:test";
import {
  BroadcastDisabledError,
  BroadcastNetworkError,
  BroadcastRejectedError,
  ChronikTxBroadcaster,
  DisabledBroadcastProvider,
  TestOnlyMockBroadcastProvider,
  type ChronikBroadcastClient,
} from "../src/index.js";

const ENDPOINT = "https://chronik.example";
const TXID = "ab".repeat(32);
const RAW_TX = "02000000000000000000";

test("DisabledBroadcastProvider rejects every broadcast attempt", async () => {
  const provider = new DisabledBroadcastProvider();

  for (const rawTxHex of ["", RAW_TX, "not hex"]) {
    await assert.rejects(
      provider.broadcastTx(rawTxHex),
      (error: unknown) => {
        assert.ok(error instanceof BroadcastDisabledError);
        assert.equal(error.code, "BROADCAST_DISABLED");
        return true;
      },
    );
  }
});

test("TestOnlyMockBroadcastProvider records raw txs and returns its configured txid", async () => {
  const provider = new TestOnlyMockBroadcastProvider(TXID);

  assert.deepEqual(await provider.broadcastTx(RAW_TX), { txid: TXID });
  assert.deepEqual(await provider.broadcastTx("00"), { txid: TXID });
  assert.deepEqual(provider.broadcasts, [RAW_TX, "00"]);
});

test("ChronikTxBroadcaster maps a mocked success response", async () => {
  const calls: Array<{ rawTx: string; skipTokenChecks?: boolean }> = [];
  const response = { txid: TXID };
  const client: ChronikBroadcastClient = {
    async broadcastTx(rawTx, skipTokenChecks) {
      calls.push({ rawTx, skipTokenChecks });
      return response;
    },
  };

  const result = await new ChronikTxBroadcaster({
    endpoint: ENDPOINT,
    client,
  }).broadcastTx(RAW_TX);

  assert.deepEqual(result, { txid: TXID, rawResponse: response });
  assert.deepEqual(calls, [{ rawTx: RAW_TX, skipTokenChecks: false }]);
});

test("ChronikTxBroadcaster maps a mocked Chronik rejection", async () => {
  const cause = new Error(
    "Failed getting /broadcast-tx: Broadcast failed: Transaction rejected by mempool",
  );
  const client: ChronikBroadcastClient = {
    async broadcastTx() {
      throw cause;
    },
  };

  await assert.rejects(
    new ChronikTxBroadcaster({ endpoint: ENDPOINT, client }).broadcastTx(RAW_TX),
    (error: unknown) => {
      assert.ok(error instanceof BroadcastRejectedError);
      assert.equal(error.code, "BROADCAST_REJECTED");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("ChronikTxBroadcaster maps a mocked network failure", async () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const client: ChronikBroadcastClient = {
    async broadcastTx() {
      throw cause;
    },
  };

  await assert.rejects(
    new ChronikTxBroadcaster({ endpoint: ENDPOINT, client }).broadcastTx(RAW_TX),
    (error: unknown) => {
      assert.ok(error instanceof BroadcastNetworkError);
      assert.equal(error.code, "BROADCAST_NETWORK_ERROR");
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

test("ChronikTxBroadcaster requires an explicit endpoint and does no I/O during construction", () => {
  let calls = 0;
  const client: ChronikBroadcastClient = {
    async broadcastTx() {
      calls += 1;
      return { txid: TXID };
    },
  };

  assert.throws(
    () => new ChronikTxBroadcaster({ endpoint: "", client }),
    /Chronik endpoint is required/,
  );
  new ChronikTxBroadcaster({ endpoint: ENDPOINT, client });
  assert.equal(calls, 0);
});
