import express, { type Express } from "express";
import { Facilitator } from "./facilitator.js";

export function createApp(facilitator: Facilitator): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "x402-xec-facilitator" });
  });
  app.get("/facilitator/supported", (_request, response) => {
    response.json({
      localOnly: true,
      x402Version: 1,
      schemes: [{ scheme: "exact", network: "xec:mainnet" }],
      chronik: "mock",
      broadcast: false,
      walletCustody: false,
    });
  });
  app.post("/facilitator/verify", async (request, response, next) => {
    try {
      const result = await facilitator.verify(request.body);
      response.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  });
  app.use((
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    if (error instanceof SyntaxError) {
      response.status(400).json({ ok: false, code: "MALFORMED" });
      return;
    }
    response.status(500).json({ ok: false, code: "INTERNAL_ERROR" });
  });
  return app;
}
