import { createX402XecMiddleware } from "@x402-xec/express";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEMO_NOW, DEMO_PAY_TO } from "./facilitator.js";

export type DemoLogger = (message: string) => void;

export interface StartedWeatherServer {
  readonly origin: string;
  readonly stats: {
    apiRequests: number;
    facilitatorVerifications: number;
    paymentSignatureHeaders: number;
  };
  close(): Promise<void>;
}

export async function startWeatherServer(
  facilitatorOrigin: string,
  logger: DemoLogger = () => undefined,
): Promise<StartedWeatherServer> {
  const server = createServer();
  await listen(server);
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const stats = { apiRequests: 0, facilitatorVerifications: 0, paymentSignatureHeaders: 0 };
  const app = express();

  app.use((request, _response, next) => {
    stats.apiRequests += 1;
    if (request.get("payment-signature") !== undefined) {
      stats.paymentSignatureHeaders += 1;
    }
    next();
  });
  app.use(createX402XecMiddleware({
    publicOrigin: origin,
    facilitatorUrl: facilitatorOrigin,
    payTo: DEMO_PAY_TO,
    routes: {
      "GET /weather": {
        amountSats: "1000",
        description: "Local weather forecast",
        asset: "XEC",
        network: "xec:mainnet",
        scheme: "xec-prepaid-utxo",
      },
    },
    now: () => DEMO_NOW,
    fetch: async (input, init) => {
      stats.facilitatorVerifications += 1;
      const response = await fetch(input, init);
      if (response.ok) logger("facilitator verified payment");
      return response;
    },
  }));
  app.get("/weather", (_request, response) => {
    response.json({ city: "Mérida", condition: "sunny", temperatureC: 29 });
  });
  server.on("request", app);

  return { origin, stats, close: () => close(server) };
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
