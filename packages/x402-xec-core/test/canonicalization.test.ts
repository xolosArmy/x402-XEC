import assert from "node:assert/strict";
import test from "node:test";
import { canonicalQuery, canonicalize, computeResourceHash, parseAmountSats, type QueryPair, type ResourceRequest } from "../src/index.js";

test("canonicalization recursively sorts object keys", () => {
  assert.equal(canonicalize({ z: [3, { b: true, a: null }], a: "first" }), '{"a":"first","z":[3,{"a":null,"b":true}]}');
});
test("query ordering and normalized origin/method are deterministic", () => {
  const first: ResourceRequest = { serverOrigin: "https://API.EXAMPLE.COM:443", method: "get", path: "/resource", query: [["b", "2"], ["a", "1"]] };
  const second: ResourceRequest = { serverOrigin: "https://api.example.com", method: "GET", path: "/resource", query: [["a", "1"], ["b", "2"]] };
  assert.equal(computeResourceHash(first), computeResourceHash(second));
});
test("duplicate query values retain encounter order without mutating input", () => {
  const forward: readonly QueryPair[] = [["item", "basic"], ["item", "admin"]];
  const reverse: readonly QueryPair[] = [["item", "admin"], ["item", "basic"]];
  const mixed: readonly QueryPair[] = [["z", "9"], ...forward, ["a", "1"]];
  const snapshot = structuredClone(mixed);

  assert.deepEqual(canonicalQuery(forward), forward);
  assert.deepEqual(canonicalQuery(reverse), reverse);
  assert.deepEqual(canonicalQuery(mixed), [["a", "1"], ...forward, ["z", "9"]]);
  assert.deepEqual(mixed, snapshot);
  assert.notStrictEqual(canonicalQuery(mixed), mixed);
});
test("resource hashes distinguish duplicate order while canonicalizing distinct keys", () => {
  const base = { serverOrigin: "https://api.example.com", method: "GET", path: "/protected" };
  const forward: readonly QueryPair[] = [["item", "basic"], ["item", "admin"]];
  const reverse: readonly QueryPair[] = [["item", "admin"], ["item", "basic"]];
  const hash = (query: readonly QueryPair[]) => computeResourceHash({ ...base, query });

  assert.notEqual(hash(forward), hash(reverse));
  assert.equal(hash([["a", "1"], ["b", "2"]]), hash([["b", "2"], ["a", "1"]]));
  assert.equal(hash([["z", "9"], ...forward, ["a", "1"]]), hash([["a", "1"], ...forward, ["z", "9"]]));
  assert.notEqual(hash([["z", "9"], ...forward, ["a", "1"]]), hash([["a", "1"], ...reverse, ["z", "9"]]));
});
test("amount parser rejects unsafe wire forms and returns bigint", () => {
  assert.equal(parseAmountSats("900719925474099312345"), 900719925474099312345n);
  for (const invalid of ["0", "01", "-1", "1.0", "1e3", " 1"]) assert.throws(() => parseAmountSats(invalid));
});
