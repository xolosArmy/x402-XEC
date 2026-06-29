import assert from "node:assert/strict";
import test from "node:test";
import {
  RealChronikTxProvider,
  TxNotFoundError,
  type ChronikTxReader,
} from "../src/index.js";

const TXID = "a".repeat(64);
const TOKEN_ID = "b".repeat(64);
const ENDPOINT = "https://chronik.example";

test("real provider maps a mocked Chronik tx into the internal model", async () => {
  const requestedTxids: string[] = [];
  const client: ChronikTxReader = {
    tx: async (txid) => {
      requestedTxids.push(txid);
      return {
        txid,
        outputs: [
          { sats: 2_000n, outputScript: "51" },
          {
            sats: 546n,
            outputScript: "6a",
            token: {
              tokenId: TOKEN_ID,
              atoms: 42n,
              isMintBaton: false,
            },
          },
        ],
        block: {
          height: 800_000,
          hash: "c".repeat(64),
          timestamp: 1_700_000_000,
        },
        isFinal: true,
      };
    },
  };
  const provider = new RealChronikTxProvider({ endpoint: ENDPOINT, client });

  const transaction = await provider.getTx(TXID);

  assert.equal(provider.endpoint, ENDPOINT);
  assert.deepEqual(requestedTxids, [TXID]);
  assert.deepEqual(transaction, {
    txid: TXID,
    outputs: [
      { sats: 2_000n, outputScript: "51" },
      {
        sats: 546n,
        outputScript: "6a",
        token: {
          tokenId: TOKEN_ID,
          atoms: 42n,
          isMintBaton: false,
        },
      },
    ],
    block: {
      height: 800_000,
      hash: "c".repeat(64),
      timestamp: 1_700_000_000,
    },
    isFinal: true,
  });
});

test("real provider maps a mocked missing tx to TxNotFoundError", async () => {
  const client: ChronikTxReader = {
    tx: async (txid) => {
      throw new Error(
        `Failed getting /tx/${txid}: 404: Transaction ${txid} not found in the index`,
      );
    },
  };
  const provider = new RealChronikTxProvider({ endpoint: ENDPOINT, client });

  await assert.rejects(provider.getTx(TXID), (error: unknown) => {
    assert.ok(error instanceof TxNotFoundError);
    assert.equal(error.code, "TX_NOT_FOUND");
    assert.equal(error.txid, TXID);
    return true;
  });
});

test("real provider requires an explicit endpoint", () => {
  const client: ChronikTxReader = {
    tx: async () => {
      throw new Error("unexpected call");
    },
  };

  assert.throws(
    () => new RealChronikTxProvider({ endpoint: "", client }),
    /Chronik endpoint is required/,
  );
});
