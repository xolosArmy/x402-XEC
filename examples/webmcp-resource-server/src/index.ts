import { createServer } from "node:http";
import { resolveGateH2ARuntimeConfig } from "./config.js";
import {
  createGateH2AHandler,
  RESOURCE_PATH,
} from "./server.js";

const { host, port, publicOrigin } = resolveGateH2ARuntimeConfig(process.env);
const { handler, canonicalResourceUrl } = createGateH2AHandler({ publicOrigin });
const server = createServer(handler);

server.listen(port, host, () => {
  console.log(`Gate H2A listening on ${host}:${port}`);
  console.log(`Canonical resource URL: ${canonicalResourceUrl}`);
  console.log(`GET ${RESOURCE_PATH} always returns HTTP 402 in this gate.`);
});

server.once("error", (error) => {
  console.error("Gate H2A server failed", error);
  process.exitCode = 1;
});
