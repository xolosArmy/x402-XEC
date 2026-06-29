import type { ChronikTransaction } from "@x402-xec/core";
import { createApp } from "./app.js";
import { Facilitator } from "./facilitator.js";
import { FixtureChronikTxProvider } from "./tx-provider.js";
import { TestOnlyMockSignatureVerifier } from "./mock-signature.js";

const port = parsePort(process.env["PORT"] ?? "3402");
const transactions = parseFixtures(process.env["MOCK_CHRONIK_FIXTURES"] ?? "[]");
const facilitator = new Facilitator({
  txProvider: new FixtureChronikTxProvider(transactions),
  signatureVerifier: new TestOnlyMockSignatureVerifier(),
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
      outputs: candidate.outputs.map((output) => ({
        sats: BigInt(output.sats),
        outputScript: output.outputScript,
        ...(output.token === undefined ? {} : {
          token: {
            tokenId: output.token.tokenId,
            atoms: BigInt(output.token.atoms),
            isMintBaton: output.token.isMintBaton,
          },
        }),
      })),
      ...(candidate.block === undefined ? {} : { block: candidate.block }),
      isFinal: candidate.isFinal,
    };
  });
}

interface FixtureToken {
  tokenId: string;
  atoms: string;
  isMintBaton: boolean;
}

interface FixtureOutput {
  sats: string;
  outputScript: string;
  token?: FixtureToken;
}

interface Fixture {
  txid: string;
  outputs: FixtureOutput[];
  block?: { height: number; hash: string; timestamp: number };
  isFinal: boolean;
}

function isFixture(value: unknown): value is Fixture {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Fixture>;
  return typeof candidate.txid === "string"
    && Array.isArray(candidate.outputs)
    && candidate.outputs.every(isFixtureOutput)
    && (candidate.block === undefined || isFixtureBlock(candidate.block))
    && typeof candidate.isFinal === "boolean";
}

function isFixtureOutput(output: unknown): output is FixtureOutput {
  if (!output || typeof output !== "object") return false;
  const candidate = output as Partial<FixtureOutput>;
  return typeof candidate.sats === "string"
    && /^[1-9][0-9]*$/.test(candidate.sats)
    && typeof candidate.outputScript === "string"
    && /^[0-9a-f]*$/.test(candidate.outputScript)
    && (candidate.token === undefined || isFixtureToken(candidate.token));
}

function isFixtureToken(token: unknown): token is FixtureToken {
  if (!token || typeof token !== "object") return false;
  const candidate = token as Partial<FixtureToken>;
  return typeof candidate.tokenId === "string"
    && /^[0-9a-f]{64}$/.test(candidate.tokenId)
    && typeof candidate.atoms === "string"
    && /^[1-9][0-9]*$/.test(candidate.atoms)
    && typeof candidate.isMintBaton === "boolean";
}

function isFixtureBlock(block: unknown): block is NonNullable<Fixture["block"]> {
  if (!block || typeof block !== "object") return false;
  const candidate = block as Partial<NonNullable<Fixture["block"]>>;
  return Number.isSafeInteger(candidate.height)
    && typeof candidate.hash === "string"
    && /^[0-9a-f]{64}$/.test(candidate.hash)
    && Number.isSafeInteger(candidate.timestamp);
}
