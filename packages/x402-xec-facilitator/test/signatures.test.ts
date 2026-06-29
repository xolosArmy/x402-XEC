import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationSigningMessage,
  type Authorization,
  type SignatureProvider,
} from "@x402-xec/core";
import {
  EcashMessageSignatureVerifier,
  TestOnlyMockSignatureVerifier,
  createMockSignature,
} from "../src/index.js";

const PAYER = "ecash:qq7s9t9cucf0rsnh0yazxteqk6f7sacquv5w7c6mjj";
const authorization: Authorization = {
  x402Version: 1,
  scheme: "exact",
  network: "xec:mainnet",
  invoiceHash: "1".repeat(64),
  resourceHash: "2".repeat(64),
  amountSats: "1000",
  payTo: PAYER,
  nonce: "MDEyMzQ1Njc4OWFiY2RlZg",
  payer: PAYER,
  transaction: { txid: "3".repeat(64), vout: 0 },
  signature: "placeholder",
};
const message = authorizationSigningMessage(authorization);

test("test-only mock verifier accepts a matching local signature", async () => {
  const provider: SignatureProvider = {
    sign: (candidate) => createMockSignature(PAYER, candidate),
  };
  const signature = await provider.sign(message);

  assert.equal(
    new TestOnlyMockSignatureVerifier().verify({ payer: PAYER, message, signature }),
    true,
  );
});

test("test-only mock verifier rejects an invalid local signature", () => {
  assert.equal(
    new TestOnlyMockSignatureVerifier().verify({
      payer: PAYER,
      message,
      signature: "invalid",
    }),
    false,
  );
});

test("eCash verifier validates a deterministic canonical authorization vector", () => {
  const signature = "H7rC0mo77BY7YAQT7XLVWRZGrfAFTuq6qDh1RgpYaR_7FxRV6q5dO_mTd4Ky71UEqkMplYUX_djaPJWWTLOfrKc";
  const verifier = new EcashMessageSignatureVerifier();

  assert.equal(verifier.verify({ payer: PAYER, message, signature }), true);

  for (const tampered of [
    { ...authorization, amountSats: "1001" },
    { ...authorization, payTo: "ecash:qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { ...authorization, nonce: "YWJjZGVmZ2hpamtsbW5vcA" },
  ]) {
    assert.equal(verifier.verify({
      payer: PAYER,
      message: authorizationSigningMessage(tampered),
      signature,
    }), false);
  }
  assert.equal(verifier.verify({ payer: PAYER, message: message + " ", signature }), false);
  assert.equal(verifier.verify({ payer: PAYER, message, signature: "invalid" }), false);
  const alteredSignature = signature.slice(0, 20) + "A" + signature.slice(21);
  assert.equal(verifier.verify({ payer: PAYER, message, signature: alteredSignature }), false);
});
