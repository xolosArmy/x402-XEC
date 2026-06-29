import type { XecSigner } from "@x402-xec/axios";
import type { SignatureVerifier } from "@x402-xec/core";
import type { AxiosInstance, AxiosResponse } from "axios";
import { pathToFileURL } from "node:url";
import { createOfflinePaymentClient, createPaymentClient } from "./client.js";
import { startFacilitator, type StartedFacilitator } from "./facilitator.js";
import {
  startWeatherServer,
  type DemoLogger,
  type StartedWeatherServer,
} from "./server.js";

export interface LocalE2e {
  readonly facilitator: StartedFacilitator;
  readonly server: StartedWeatherServer;
  readonly url: string;
  createClient(signer?: XecSigner): AxiosInstance;
  createOfflineClient(): AxiosInstance;
  close(): Promise<void>;
}

export interface StartLocalE2eOptions {
  readonly logger?: DemoLogger;
  readonly signatureVerifier?: SignatureVerifier;
}

export async function startLocalE2e(
  options: StartLocalE2eOptions = {},
): Promise<LocalE2e> {
  const logger = options.logger ?? (() => undefined);
  const facilitator = await startFacilitator({
    ...(options.signatureVerifier === undefined
      ? {}
      : { signatureVerifier: options.signatureVerifier }),
  });
  try {
    const server = await startWeatherServer(facilitator.origin, logger);
    return {
      facilitator,
      server,
      url: `${server.origin}/weather`,
      createClient: (signer) => createPaymentClient(logger, signer),
      createOfflineClient: () => createOfflinePaymentClient(logger, (result) => {
        facilitator.txProvider.addTransaction({
          txid: result.fundingTransaction.txid,
          outputs: [{
            sats: BigInt(result.fundingTransaction.fundingOutput.amountSats),
            outputScript: result.fundingTransaction.fundingOutput.outputScript,
          }],
          block: {
            height: 800_001,
            hash: "e".repeat(64),
            timestamp: 1_799_999_950,
          },
          isFinal: true,
        });
      }),
      close: async () => {
        await Promise.all([server.close(), facilitator.close()]);
      },
    };
  } catch (error) {
    await facilitator.close();
    throw error;
  }
}

export async function runDemo(logger: DemoLogger = console.log): Promise<AxiosResponse> {
  const demo = await startLocalE2e({ logger });
  try {
    logger("requesting protected resource");
    const response = await demo.createOfflineClient().get(demo.url);
    logger(`received ${response.status}`);
    console.log("weather:", response.data);
    return response;
  } finally {
    await demo.close();
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runDemo().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
