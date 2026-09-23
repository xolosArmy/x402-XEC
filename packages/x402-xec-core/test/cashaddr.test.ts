/**
 * @file cashaddr.test.ts
 *
 * Strict CashAddr validation & test vectors (Gate C3B P1-3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import ecashaddr from "ecashaddrjs";
import {
  cashAddressToOutputScriptHex,
  decodeCashAddress,
  isValidCashAddress,
} from "../src/cashaddr.js";

const VALID_P2PKH_1 = "ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w";
const VALID_P2PKH_2 = "ecash:qpm2qsznhks23z7629mms6s4cwef74vcwva87rkuu2";
// Valid P2SH address (type 1)
const VALID_P2SH = ecashaddr.encodeCashAddress("ecash", "p2sh", "11".repeat(20));

test("P1-3: decodes valid canonical P2PKH CashAddr", () => {
  const decoded = decodeCashAddress(VALID_P2PKH_1);
  assert.equal(decoded.prefix, "ecash");
  assert.equal(decoded.type, 0);
  assert.equal(decoded.hash, "11".repeat(20));
  assert.equal(isValidCashAddress(VALID_P2PKH_1), true);

  const script = cashAddressToOutputScriptHex(VALID_P2PKH_1);
  assert.equal(script, `76a914${"11".repeat(20)}88ac`);
});

test("P1-3: decodes valid canonical P2SH CashAddr", () => {
  const decoded = decodeCashAddress(VALID_P2SH);
  assert.equal(decoded.prefix, "ecash");
  assert.equal(decoded.type, 1);
  assert.equal(decoded.hash, "11".repeat(20));
  assert.equal(isValidCashAddress(VALID_P2SH), true);

  const script = cashAddressToOutputScriptHex(VALID_P2SH);
  assert.equal(script, `a914${"11".repeat(20)}87`);
});

test("P1-3: rejects bad checksums / hostile mutation", () => {
  // Mutate last character of a valid address
  const mutated = VALID_P2PKH_1.slice(0, -1) + (VALID_P2PKH_1.endsWith("w") ? "q" : "w");
  assert.throws(
    () => decodeCashAddress(mutated),
    /Invalid CashAddr checksum/,
  );
  assert.equal(isValidCashAddress(mutated), false);
});

test("P1-3: rejects wrong prefix", () => {
  // bitcoincash prefix
  assert.throws(
    () => decodeCashAddress("bitcoincash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w"),
    /Expected eCash mainnet prefix 'ecash:'/,
  );
  // ectest prefix
  assert.throws(
    () => decodeCashAddress("ectest:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w"),
    /Expected eCash mainnet prefix 'ecash:'/,
  );
  // missing prefix
  assert.throws(
    () => decodeCashAddress("qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w"),
    /Expected eCash mainnet prefix 'ecash:'/,
  );
});

test("P1-3: rejects mixed-case and all-uppercase CashAddr", () => {
  // Mixed case in prefix
  assert.throws(
    () => decodeCashAddress("eCash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w"),
    /CashAddr addresses must be strictly lowercase/,
  );
  // Mixed case in payload
  assert.throws(
    () => decodeCashAddress("ecash:Qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w"),
    /CashAddr addresses must be strictly lowercase/,
  );
  // All uppercase
  assert.throws(
    () => decodeCashAddress(VALID_P2PKH_1.toUpperCase()),
    /CashAddr addresses must be strictly lowercase/,
  );
});

test("P1-3: rejects truncated CashAddr", () => {
  const truncated = VALID_P2PKH_1.slice(0, 30);
  assert.throws(
    () => decodeCashAddress(truncated),
    /Expected canonical CashAddr length of 42 body characters/,
  );
  assert.equal(isValidCashAddress(truncated), false);
});

test("P1-3: rejects extra payload CashAddr", () => {
  const bloated = `${VALID_P2PKH_1}qq`;
  assert.throws(
    () => decodeCashAddress(bloated),
    /Expected canonical CashAddr length of 42 body characters/,
  );
  assert.equal(isValidCashAddress(bloated), false);
});

test("P1-3: rejects unsupported version / type", () => {
  // 32-byte hash (P2SH-32 or unsupported type)
  // Even if checksum is valid for that 32-byte payload, body length != 42 characters
  const encoded32 = ecashaddr.encodeCashAddress("ecash", "p2sh" as any, "11".repeat(32));
  assert.throws(
    () => decodeCashAddress(encoded32),
    /Expected canonical CashAddr length of 42 body characters/,
  );
});

test("P1-3: rejects invalid hash size or non-hex hash", () => {
  assert.throws(
    () => decodeCashAddress(""),
    /Address must be a non-empty string/,
  );
  assert.throws(
    () => decodeCashAddress("   "),
    /Address must be a non-empty string/,
  );
  assert.equal(isValidCashAddress(""), false);
  assert.equal(isValidCashAddress(null), false);
  assert.equal(isValidCashAddress(undefined), false);
  assert.equal(isValidCashAddress(123), false);
});

test("P1-3: cashAddressToOutputScriptHex strictly rejects invalid inputs without fallback", () => {
  assert.throws(
    () => cashAddressToOutputScriptHex("ecash:invalid_garbage_address"),
  );
  assert.throws(
    () => cashAddressToOutputScriptHex("ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5"),
    /Invalid CashAddr checksum/,
  );
});
