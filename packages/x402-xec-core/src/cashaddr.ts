/**
 * @file cashaddr.ts
 *
 * Strict eCash CashAddr validator, decoder, and locking script generator.
 *
 * Security & Integrity Invariants:
 * - Prefix MUST be exactly 'ecash:' (mainnet).
 * - Mixed-case and uppercase addresses are strictly rejected.
 * - Polymod checksum MUST validate.
 * - Version byte and size bits MUST be valid for standard 20-byte hash.
 * - Supported types only: P2PKH (type 0) and P2SH (type 1).
 * - Hash length MUST be exactly 20 bytes (40 hex chars).
 * - Bit conversion MUST have zero dirty/residual padding bits.
 * - Canonical re-encoding MUST equal the normalized input address.
 * - Zero use of ignoreChecksum across settlement paths.
 */

import ecashaddr from "ecashaddrjs";

export interface DecodedCashAddress {
  readonly prefix: "ecash";
  readonly type: number; // 0 = P2PKH, 1 = P2SH
  readonly hash: string; // 40-char lowercase hex (20 bytes)
}

/**
 * Strictly validates and decodes an eCash CashAddress into prefix, type, and 20-byte hash hex.
 * Fails closed on any corruption, non-canonical encoding, or unsupported type.
 */
export function decodeCashAddress(address: string): DecodedCashAddress {
  if (typeof address !== "string" || address.trim() === "") {
    throw new TypeError("Address must be a non-empty string");
  }

  // Reject mixed-case and uppercase
  if (address !== address.toLowerCase()) {
    throw new TypeError("CashAddr addresses must be strictly lowercase (mixed case and uppercase are prohibited)");
  }

  // Enforce eCash mainnet prefix
  if (!address.startsWith("ecash:")) {
    throw new TypeError("Expected eCash mainnet prefix 'ecash:'");
  }

  const parts = address.split(":");
  if (parts.length !== 2 || parts[0] !== "ecash") {
    throw new TypeError("Invalid CashAddr prefix format");
  }

  const body = parts[1]!;
  // Standard 20-byte P2PKH/P2SH CashAddr has exactly 42 characters in body (34 payload words + 8 checksum)
  if (body.length !== 42) {
    throw new TypeError(
      `Expected canonical CashAddr length of 42 body characters for standard 20-byte payload, got ${body.length}`,
    );
  }

  // Decode with ecashaddrjs for polymod checksum & base32 conversion
  let decoded: { prefix: string; type: string; hash: string };
  try {
    decoded = ecashaddr.decodeCashAddress(address) as {
      prefix: string;
      type: string;
      hash: string;
    };
  } catch (err) {
    throw new TypeError(
      `Invalid CashAddr checksum or encoding: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (decoded.prefix !== "ecash") {
    throw new TypeError(`Decoded prefix must be 'ecash', got '${decoded.prefix}'`);
  }

  if (decoded.type !== "p2pkh" && decoded.type !== "p2sh") {
    throw new TypeError(`Unsupported address type: ${decoded.type}`);
  }

  if (
    typeof decoded.hash !== "string" ||
    decoded.hash.length !== 40 ||
    !/^[0-9a-f]{40}$/.test(decoded.hash)
  ) {
    throw new TypeError("Expected 20-byte canonical hash");
  }

  // Canonical re-encoding check: re-encoding decoded data must match input identically
  const reencoded = ecashaddr.encodeCashAddress("ecash", decoded.type as any, decoded.hash);
  if (reencoded !== address) {
    throw new TypeError(`Canonical re-encoding mismatch: ${address} vs ${reencoded}`);
  }

  const typeCode = decoded.type === "p2pkh" ? 0 : 1;
  return {
    prefix: "ecash",
    type: typeCode,
    hash: decoded.hash,
  };
}

/**
 * Returns true if the address is a strictly valid canonical eCash CashAddress.
 */
export function isValidCashAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  try {
    decodeCashAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts a strictly validated eCash cash address to its canonical locking script hex.
 * - P2PKH (type 0): OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG -> 76a914<hash>88ac
 * - P2SH (type 1): OP_HASH160 <20-byte hash> OP_EQUAL -> a914<hash>87
 *
 * Strictly rejects any invalid checksum or malformed address.
 */
export function cashAddressToOutputScriptHex(address: string): string {
  const decoded = decodeCashAddress(address);
  if (decoded.type === 0) {
    return `76a914${decoded.hash}88ac`;
  }
  if (decoded.type === 1) {
    return `a914${decoded.hash}87`;
  }
  throw new TypeError(`Unsupported address type: ${decoded.type}`);
}
