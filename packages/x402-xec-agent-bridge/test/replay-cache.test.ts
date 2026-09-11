import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAuthorizationReplayCache } from "../src/replay-cache.js";
import { X402AgentBridgeError } from "../src/errors.js";

test("InMemoryAuthorizationReplayCache: reserves and commits successfully", () => {
  const cache = new InMemoryAuthorizationReplayCache();
  const invoiceHash = "a".repeat(64);
  const nonce = "b64url_test_nonce_123456789";
  const now = 1_800_000_000;
  const expiresAt = now + 300;

  assert.equal(cache.hasSeenInvoice(invoiceHash), false);
  assert.equal(cache.hasSeenNonce(nonce), false);
  assert.equal(cache.isInFlight(invoiceHash, nonce), false);

  cache.reserve(invoiceHash, nonce, expiresAt, now);

  assert.equal(cache.hasSeenInvoice(invoiceHash), true);
  assert.equal(cache.hasSeenNonce(nonce), true);
  assert.equal(cache.isInFlight(invoiceHash, nonce), true);

  cache.commit(invoiceHash, nonce, expiresAt);

  assert.equal(cache.hasSeenInvoice(invoiceHash), true);
  assert.equal(cache.hasSeenNonce(nonce), true);
  assert.equal(cache.isInFlight(invoiceHash, nonce), false);
});

test("InMemoryAuthorizationReplayCache: rejects concurrent reservations for same invoice or nonce", () => {
  const cache = new InMemoryAuthorizationReplayCache();
  const invoice1 = "1".repeat(64);
  const invoice2 = "2".repeat(64);
  const nonce1 = "b64url_nonce_1_123456789012";
  const nonce2 = "b64url_nonce_2_123456789012";
  const now = 1_800_000_000;

  cache.reserve(invoice1, nonce1, now + 300, now);

  // Same invoice in flight
  assert.throws(
    () => cache.reserve(invoice1, nonce2, now + 300, now),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "CONCURRENT_CONFLICT"
  );

  // Same nonce in flight
  assert.throws(
    () => cache.reserve(invoice2, nonce1, now + 300, now),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "CONCURRENT_CONFLICT"
  );
});

test("InMemoryAuthorizationReplayCache: rejects duplicate invoice or reused nonce after commit", () => {
  const cache = new InMemoryAuthorizationReplayCache();
  const invoice = "3".repeat(64);
  const nonce = "b64url_nonce_3_123456789012";
  const now = 1_800_000_000;
  const expiresAt = now + 300;

  cache.reserve(invoice, nonce, expiresAt, now);
  cache.commit(invoice, nonce, expiresAt);

  // Duplicate invoice
  assert.throws(
    () => cache.reserve(invoice, "different_nonce_1234567890", expiresAt, now + 10),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "DUPLICATE_INVOICE"
  );

  // Reused nonce
  assert.throws(
    () => cache.reserve("4".repeat(64), nonce, expiresAt, now + 10),
    (err: unknown) =>
      err instanceof X402AgentBridgeError &&
      err.code === "NONCE_REUSE"
  );
});

test("InMemoryAuthorizationReplayCache: rollback releases reservation without commit", () => {
  const cache = new InMemoryAuthorizationReplayCache();
  const invoice = "5".repeat(64);
  const nonce = "b64url_nonce_5_123456789012";
  const now = 1_800_000_000;
  const expiresAt = now + 300;

  cache.reserve(invoice, nonce, expiresAt, now);
  assert.equal(cache.isInFlight(invoice, nonce), true);

  cache.rollback(invoice, nonce);
  assert.equal(cache.isInFlight(invoice, nonce), false);
  assert.equal(cache.hasSeenInvoice(invoice), false);
  assert.equal(cache.hasSeenNonce(nonce), false);

  // Can now be reserved again
  assert.doesNotThrow(() => cache.reserve(invoice, nonce, expiresAt, now + 1));
});

test("InMemoryAuthorizationReplayCache: prunes expired entries", () => {
  const cache = new InMemoryAuthorizationReplayCache();
  const invoice = "6".repeat(64);
  const nonce = "b64url_nonce_6_123456789012";
  const now = 1_800_000_000;
  const expiresAt = now + 60;

  cache.reserve(invoice, nonce, expiresAt, now);
  cache.commit(invoice, nonce, expiresAt);

  // Before expiry
  assert.equal(cache.hasSeenInvoice(invoice), true);

  // Prune after expiry
  const pruned = cache.prune(expiresAt + 1);
  assert.equal(pruned, 1);
  assert.equal(cache.hasSeenInvoice(invoice), false);
  assert.equal(cache.hasSeenNonce(nonce), false);
});
