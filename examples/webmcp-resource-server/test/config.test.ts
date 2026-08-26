import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PUBLIC_ORIGIN,
  resolveGateH2ARuntimeConfig,
} from "../src/config.js";

test("runtime configuration preserves local defaults", () => {
  assert.deepEqual(resolveGateH2ARuntimeConfig({}), {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    publicOrigin: DEFAULT_PUBLIC_ORIGIN,
  });
  assert.equal(DEFAULT_HOST, "127.0.0.1");
  assert.equal(DEFAULT_PORT, 4020);
});

test("H2A_HOST overrides only the listen host", () => {
  assert.deepEqual(resolveGateH2ARuntimeConfig({ H2A_HOST: "0.0.0.0" }), {
    host: "0.0.0.0",
    port: 4020,
    publicOrigin: "http://127.0.0.1:4020",
  });
});

test("invalid explicit hosts fail closed", () => {
  for (const value of ["", " 0.0.0.0", "0.0.0.0 "]) {
    assert.throws(
      () => resolveGateH2ARuntimeConfig({ H2A_HOST: value }),
      /H2A_HOST must be a non-empty host without surrounding whitespace/,
    );
  }
});

test("PORT supplies a platform-assigned listen port", () => {
  assert.deepEqual(resolveGateH2ARuntimeConfig({ PORT: "8080" }), {
    host: "127.0.0.1",
    port: 8080,
    publicOrigin: "http://127.0.0.1:4020",
  });
});

test("H2A_PORT takes precedence over PORT", () => {
  assert.equal(
    resolveGateH2ARuntimeConfig({ H2A_PORT: "4402", PORT: "8080" }).port,
    4402,
  );
});

test("explicit public origin remains independent from the bind address", () => {
  assert.deepEqual(resolveGateH2ARuntimeConfig({
    H2A_HOST: "0.0.0.0",
    PORT: "8080",
    H2A_PUBLIC_ORIGIN: "https://resource.example",
  }), {
    host: "0.0.0.0",
    port: 8080,
    publicOrigin: "https://resource.example",
  });
});

test("invalid explicit ports fail closed without fallback", () => {
  for (const value of ["", "not-a-port", "4020.5", " 4020"]) {
    assert.throws(
      () => resolveGateH2ARuntimeConfig({ H2A_PORT: value, PORT: "8080" }),
      /H2A_PORT must be an integer between 1 and 65535/,
    );
  }
});

test("digit-only ports with leading zeroes resolve deterministically", () => {
  assert.equal(resolveGateH2ARuntimeConfig({ PORT: "04020" }).port, 4020);
});

test("TCP port range boundaries are accepted", () => {
  assert.equal(resolveGateH2ARuntimeConfig({ PORT: "1" }).port, 1);
  assert.equal(resolveGateH2ARuntimeConfig({ PORT: "65535" }).port, 65_535);
});

test("out-of-range ports fail closed", () => {
  for (const value of ["0", "65536", "999999999999999999999999"]) {
    assert.throws(
      () => resolveGateH2ARuntimeConfig({ PORT: value }),
      /PORT must be an integer between 1 and 65535/,
    );
  }
});
