import { createX402XecMiddleware } from "@x402-xec/express";
import {
  Facilitator,
  FixtureChronikTxProvider,
  InMemoryTransactionalLedger,
  TestOnlyMockSignatureVerifier,
} from "@x402-xec/facilitator";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { DEMO_FUNDING_TXID } from "./demo-orchestrator.js";

export const DEMO_NOW = 1_800_000_000;
export const DEMO_PAY_TO = `ecash:q${"a".repeat(41)}`;

export interface StartedBrowserDemoServer {
  readonly origin: string;
  readonly url: string;
  readonly stats: {
    apiRequests: number;
    facilitatorVerifications: number;
  };
  close(): Promise<void>;
}

export async function startBrowserDemoServer(): Promise<StartedBrowserDemoServer> {
  const server = createServer();
  await listen(server);
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const stats = { apiRequests: 0, facilitatorVerifications: 0 };
  const facilitator = createFixtureFacilitator();
  const app = express();

  app.use("/api", (_request, _response, next) => {
    stats.apiRequests += 1;
    next();
  });
  app.use(createX402XecMiddleware({
    publicOrigin: origin,
    facilitatorUrl: "http://fixture-facilitator.invalid",
    payTo: DEMO_PAY_TO,
    routes: {
      "GET /api/weather": {
        amountSats: "1000",
        description: "Browser dry-run weather forecast",
        asset: "XEC",
        network: "xec:mainnet",
        scheme: "xec-prepaid-utxo",
      },
    },
    now: () => DEMO_NOW,
    fetch: async (input, init) => {
      if (
        String(input) !== "http://fixture-facilitator.invalid/facilitator/verify"
        || init?.method !== "POST"
        || typeof init.body !== "string"
      ) {
        throw new Error("browser demo blocked a non-fixture network request");
      }
      stats.facilitatorVerifications += 1;
      const result = await facilitator.verify(JSON.parse(init.body) as unknown);
      return Response.json(result.body, { status: result.status });
    },
  }));
  app.get("/api/weather", (_request, response) => {
    response.json({
      city: "Mérida",
      condition: "sunny",
      temperatureC: 29,
      broadcasted: false,
      notice: "DRY RUN ONLY",
    });
  });

  const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));
  const browserBundleDirectory = fileURLToPath(
    new URL("../dist/browser", import.meta.url),
  );
  app.use("/assets", express.static(browserBundleDirectory));
  app.use(express.static(publicDirectory));
  server.on("request", app);

  return {
    origin,
    url: `${origin}/api/weather`,
    stats,
    close: () => close(server),
  };
}

function createFixtureFacilitator(): Facilitator {
  return new Facilitator({
    txProvider: new FixtureChronikTxProvider([{
      txid: DEMO_FUNDING_TXID,
      outputs: [{ sats: 10_000n, outputScript: "51" }],
      block: {
        height: 800_000,
        hash: "d".repeat(64),
        timestamp: DEMO_NOW - 100,
      },
      isFinal: true,
    }]),
    ledger: new InMemoryTransactionalLedger(),
    signatureVerifier: new TestOnlyMockSignatureVerifier(),
    now: () => DEMO_NOW,
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
