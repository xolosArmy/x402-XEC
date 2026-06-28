import type { ChronikTransaction } from "@x402-xec/core";
import { createApp } from "./app.js";
import { Facilitator } from "./facilitator.js";
import { MockChronik } from "./mock-chronik.js";
import { MockSignatureVerifier } from "./mock-signature.js";

const port = parsePort(process.env["PORT"] ?? "3402");
const transactions = parseFixtures(process.env["MOCK_CHRONIK_FIXTURES"] ?? "[]");
const facilitator = new Facilitator({
  chronik: new MockChronik(transactions),
  signatureVerifier: new MockSignatureVerifier(),
  ...(process.env["FACILITATOR_NOW"] === undefined
    ? {}
    : { now: () => parseTimestamp(process.env["FACILITATOR_NOW"] as string) }),
});

createApp(facilitator).listen(port, "127.0.0.1", () => {
  console.log(`Local x402-XEC facilitator listening on http://127.0.0.1:${port}`);
});

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return parsed;
}

function parseTimestamp(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("FACILITATOR_NOW must be a non-negative integer Unix timestamp");
  }
  return parsed;
}

function parseFixtures(json: string): ChronikTransaction[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value)) throw new Error("MOCK_CHRONIK_FIXTURES must be a JSON array");
  return value.map((candidate) => {
    if (!isFixture(candidate)) throw new Error("Invalid MOCK_CHRONIK_FIXTURES entry");
    return {
      txid: candidate.txid,
      blockHeight: candidate.blockHeight,
      isCoinbase: candidate.isCoinbase,
      outputs: candidate.outputs.map((output) => ({
        outputIndex: output.outputIndex,
        valueSats: BigInt(output.valueSats),
        lockingScriptHex: output.lockingScriptHex,
      })),
    };
  });
}

interface Fixture {
  txid: string;
  blockHeight: number | null;
  isCoinbase: boolean;
  outputs: Array<{ outputIndex: number; valueSats: string; lockingScriptHex: string }>;
}

function isFixture(value: unknown): value is Fixture {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Fixture>;
  return typeof candidate.txid === "string"
    && (candidate.blockHeight === null || Number.isSafeInteger(candidate.blockHeight))
    && typeof candidate.isCoinbase === "boolean"
    && Array.isArray(candidate.outputs)
    && candidate.outputs.every((output) => (
      Number.isSafeInteger(output.outputIndex)
      && typeof output.valueSats === "string"
      && /^[1-9][0-9]*$/.test(output.valueSats)
      && typeof output.lockingScriptHex === "string"
    ));
}
