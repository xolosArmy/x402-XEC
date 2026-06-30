#!/usr/bin/env node

import { runManualPaymentCli } from "./cli.js";

runManualPaymentCli(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown CLI failure";
  console.error(`manual-payment-cli: ${message}`);
  process.exitCode = 1;
});
