/**
 * @file engine-contract.test.ts
 *
 * Runtime Engine Contract & Subpath Isolation Verification (Gate C3B Pass 2.1 Finding 2).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as Core from "../src/index.js";
import * as SqliteCore from "../src/sqlite-invoice-store.js";

test("Pass 2.1 Finding 2: main @x402-xec/core barrel never exports sqlite stores", () => {
  // Main barrel must not export SQLite stores so Node >=20 and browser clients remain unaffected
  assert.equal(
    "SqliteAuthoritativeInvoiceStore" in Core,
    false,
    "Main core barrel must not export SqliteAuthoritativeInvoiceStore",
  );
  assert.equal(
    "InMemorySqliteAuthoritativeInvoiceStore" in Core,
    false,
    "Main core barrel must not export InMemorySqliteAuthoritativeInvoiceStore",
  );
  assert.equal(
    "BaseSqliteAuthoritativeInvoiceStore" in Core,
    false,
    "Main core barrel must not export BaseSqliteAuthoritativeInvoiceStore",
  );
});

test("Pass 2.1 Finding 2: explicit sqlite module exports both durable and test in-memory stores", () => {
  assert.equal(
    typeof SqliteCore.SqliteAuthoritativeInvoiceStore,
    "function",
    "Sqlite module must export SqliteAuthoritativeInvoiceStore",
  );
  assert.equal(
    typeof SqliteCore.InMemorySqliteAuthoritativeInvoiceStore,
    "function",
    "Sqlite module must export InMemorySqliteAuthoritativeInvoiceStore",
  );
  assert.equal(
    typeof SqliteCore.BaseSqliteAuthoritativeInvoiceStore,
    "function",
    "Sqlite module must export BaseSqliteAuthoritativeInvoiceStore",
  );
});

test("Pass 2.1 Finding 2: package.json preserves Node >=20 engine and declares subpath exports", () => {
  const pkgJsonPath = path.resolve(import.meta.dirname, "../package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));

  assert.equal(pkg.engines?.node, ">=20", "Main core engine must preserve node >=20");
  assert.ok(pkg.exports["."], "Exports '.' entry must be present");
  assert.ok(pkg.exports["./sqlite"], "Exports './sqlite' subpath must be present");
  assert.equal(
    pkg.exports["./sqlite"].import,
    "./dist/sqlite-invoice-store.js",
  );
  assert.equal(
    pkg.exports["./sqlite"].types,
    "./dist/sqlite-invoice-store.d.ts",
  );
});
