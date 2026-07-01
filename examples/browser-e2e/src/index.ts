import { pathToFileURL } from "node:url";
import { startBrowserDemoServer } from "./server.js";

export async function runBrowserDemo(): Promise<void> {
  const demo = await startBrowserDemoServer();
  console.log(`Browser dry-run demo: ${demo.origin}`);
  console.log("Fake Tonalli wallet; no funds, keys, Chronik, or broadcast.");

  const stop = async (): Promise<void> => {
    await demo.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runBrowserDemo().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
