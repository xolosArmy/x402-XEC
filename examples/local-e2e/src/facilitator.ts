import type { SignatureVerifier } from "@x402-xec/core";
import { Address, Ecc, shaRmd160 } from "ecash-lib";
import {
  Facilitator,
  FixtureChronikTxProvider,
  InMemoryTransactionalLedger,
  TestOnlyMockSignatureVerifier,
  createApp,
} from "@x402-xec/facilitator";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const DEMO_NOW = 1_800_000_000;
export const DEMO_SECRET_KEY = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 1,
]);
export const DEMO_PUBLIC_KEY = new Ecc().derivePubkey(DEMO_SECRET_KEY);
export const DEMO_PAYER = Address.p2pkh(shaRmd160(DEMO_PUBLIC_KEY)).toString();
export const DEMO_PAY_TO = Address.p2pkh("11".repeat(20)).toString();
export const DEMO_SOURCE_SCRIPT = Address.fromCashAddress(DEMO_PAYER).toScriptHex();
export const DEMO_TXID = "c".repeat(64);
export const DEMO_VOUT = 0;

export interface StartedFacilitator {
  readonly facilitator: Facilitator;
  readonly ledger: InMemoryTransactionalLedger;
  readonly txProvider: FixtureChronikTxProvider;
  readonly origin: string;
  close(): Promise<void>;
}

export interface StartFacilitatorOptions {
  readonly signatureVerifier?: SignatureVerifier;
}

export async function startFacilitator(
  options: StartFacilitatorOptions = {},
): Promise<StartedFacilitator> {
  const ledger = new InMemoryTransactionalLedger();
  const txProvider = new FixtureChronikTxProvider([{
    txid: DEMO_TXID,
    outputs: [{
      sats: 10_000n,
      outputScript: "51",
    }],
    block: { height: 800_000, hash: "d".repeat(64), timestamp: DEMO_NOW - 100 },
    isFinal: true,
  }]);
  const facilitator = new Facilitator({
    txProvider,
    ledger,
    signatureVerifier: options.signatureVerifier ?? new TestOnlyMockSignatureVerifier(),
    now: () => DEMO_NOW,
  });
  const server = createApp(facilitator).listen(0, "127.0.0.1");
  await listening(server);
  const { port } = server.address() as AddressInfo;

  return {
    facilitator,
    ledger,
    txProvider,
    origin: `http://127.0.0.1:${port}`,
    close: () => close(server),
  };
}

function listening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
