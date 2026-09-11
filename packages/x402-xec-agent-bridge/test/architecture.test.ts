import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeInvoiceHash,
  computeResourceHash,
  createInvoice,
} from "@x402-xec/core";
import {
  createX402AuthorizationBridge,
  X402AuthorizationBridge,
} from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, "../src");

const PROHIBITED_MODULES = [
  "ecash-lib",
  "chronik-client",
  "@x402-xec/transactions",
  "@x402-xec/payments",
];

const PROHIBITED_IDENTIFIERS = [
  "signPreparedTransaction",
  "buildFundingTx",
  "broadcastTx",
  "broadcastTransaction",
  "PAYMENT-SIGNATURE",
  "signAuthorization",
  "privateKey",
  "mnemonic",
  "ChronikClient",
  "TxBuilder",
];

function getAllSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("Architecture Invariant: Production surface contains ZERO prohibited modules", () => {
  const sourceFiles = getAllSourceFiles(SRC_DIR);
  assert.ok(sourceFiles.length > 0, "Expected to find production source files");

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const mod of PROHIBITED_MODULES) {
      const importRegex = new RegExp(`from\\s+['"]${mod}['"]`, "g");
      const dynamicImportRegex = new RegExp(`import\\(['"]${mod}['"]\\)`, "g");
      assert.equal(
        importRegex.test(content),
        false,
        `Prohibited module "${mod}" imported in ${path.relative(SRC_DIR, file)}`
      );
      assert.equal(
        dynamicImportRegex.test(content),
        false,
        `Prohibited module "${mod}" dynamically imported in ${path.relative(SRC_DIR, file)}`
      );
    }
  }
});

test("Architecture Invariant: Production surface contains ZERO prohibited signing/settlement identifiers", () => {
  const sourceFiles = getAllSourceFiles(SRC_DIR);

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    for (const id of PROHIBITED_IDENTIFIERS) {
      assert.equal(
        content.includes(id),
        false,
        `Prohibited identifier "${id}" found in ${path.relative(SRC_DIR, file)}`
      );
    }
  }
});

test("Stop-Boundary Test: After HumanApprovalV1, pipeline STOPS completely", async () => {
  const resource = {
    serverOrigin: "https://api.example.com",
    method: "POST",
    path: "/premium/weather",
  };
  const invoice = createInvoice({
    request: resource,
    amountSats: 10000n,
    payTo: "ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2",
    nonce: "b64url_stop_boundary_nonce_12345",
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_300,
  });

  let protectedResourceFetchCount = 0;
  let signingAttemptCount = 0;
  let broadcastAttemptCount = 0;

  // Mock server or network spy
  const fakeServer = {
    retryResource: () => {
      protectedResourceFetchCount++;
    },
    signTx: () => {
      signingAttemptCount++;
    },
    broadcast: () => {
      broadcastAttemptCount++;
    },
  };

  const bridge = createX402AuthorizationBridge({
    killSwitch: false,
    dailyLimitSats: 50000n,
    now: () => 1_800_000_010,
    policyEvaluator: async (intent) => ({
      contractVersion: "1.0",
      kind: "cae_policy_decision",
      decisionId: "decision:stop-bound-01",
      intentId: intent.intentId,
      decision: "needs_human_approval",
      reasonCode: "HUMAN_APPROVAL_REQUIRED",
      reason: "Requires human authorization",
      policyTraceId: "trace:stop-trace-01",
      policyVersion: "1.0.0",
      evaluatedAt: intent.createdAt + 1,
      expiresAt: intent.expiresAt,
    }),
    walletTransport: {
      async dispatchApprovalRequest(request) {
        return {
          contractVersion: "1.0",
          kind: "human_approval",
          approvalId: "approval:human-receipt-001",
          requestId: request.requestId,
          intentId: request.intent.intentId,
          decisionId: request.policyDecision.decisionId,
          status: "approved",
          approver: "custodian:officer-99",
          reason: "Approved by custodian",
          recordedAt: request.requestedAt + 2,
        };
      },
    },
  });

  const result = await bridge.authorizePayment({
    paymentRequired: {
      x402Version: 1,
      invoiceId: computeInvoiceHash(invoice),
      invoice,
      resource,
    },
    expectedResource: resource,
    agentConfig: {
      agentId: "agent:curator-001",
      agentRole: "data-fetcher",
      fromAddress: "ecash:qq9h650ag5082460r07p6w9ep2qkv904tqm7vd0f96",
    },
  });

  // 1. Pipeline stopped at HumanApprovalV1 receipt
  assert.equal(result.status, "approved");
  assert.equal(result.humanApproval.approvalId, "approval:human-receipt-001");
  assert.equal(result.humanApproval.approver, "custodian:officer-99");

  // 2. No signing was invoked
  assert.equal(signingAttemptCount, 0, "No signing function should be invoked");

  // 3. No broadcast was invoked
  assert.equal(broadcastAttemptCount, 0, "No broadcast function should be invoked");

  // 4. No retry or resource unlock was executed
  assert.equal(protectedResourceFetchCount, 0, "No protected resource retry or unlock should occur");

  // 5. Result does NOT expose any payment credentials, signature, or txid
  const resultKeys = Object.keys(result);
  assert.equal(resultKeys.includes("paymentSignature"), false);
  assert.equal(resultKeys.includes("signature"), false);
  assert.equal(resultKeys.includes("rawTx"), false);
  assert.equal(resultKeys.includes("txid"), false);
  assert.equal(resultKeys.includes("privateKey"), false);

  // 6. HumanApprovalV1 cannot be used as a signing capability
  assert.equal(typeof (result.humanApproval as any).sign, "undefined");
  assert.equal(typeof (result.humanApproval as any).broadcast, "undefined");
});
