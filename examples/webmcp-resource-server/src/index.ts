import { createServer } from "node:http";
import {
  createGateH2AHandler,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PUBLIC_ORIGIN,
  RESOURCE_PATH,
} from "./server.js";

const publicOrigin = process.env.H2A_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN;
const { handler, canonicalResourceUrl } = createGateH2AHandler({ publicOrigin });
const server = createServer(handler);

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  console.log(`Gate H2A listening at ${canonicalResourceUrl}`);
  console.log(`GET ${RESOURCE_PATH} always returns HTTP 402 in this gate.`);
});

server.once("error", (error) => {
  console.error("Gate H2A server failed", error);
  process.exitCode = 1;
});
