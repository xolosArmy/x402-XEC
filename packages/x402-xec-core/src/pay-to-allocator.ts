/**
 * @file pay-to-allocator.ts
 *
 * Watch-only public key derivation for per-invoice unique CashAddr allocation (Gate C3B P0).
 *
 * Invariants:
 * - Purely watch-only. Absolutely NO private keys, xpriv/tprv, seed, mnemonic, WIF, or signing authority.
 * - Standard BIP32 public child derivation (non-hardened: 0 <= index < 0x80000000).
 * - Generates canonical eCash CashAddr addresses (P2PKH hash160).
 * - Fails closed on any attempt to pass private key material.
 */

import { HDKey } from "@scure/bip32";
import { createHash } from "node:crypto";
import { decodeCashAddress } from "./cashaddr.js";
import ecashaddr from "ecashaddrjs";

export interface InvoicePayToAllocator {
  /**
   * Derives a canonical CashAddr payment address for the given non-hardened child index.
   * Fails closed if the child index is out of the valid 31-bit non-hardened range [0, 0x7FFFFFFF].
   */
  deriveAddress(derivationIndex: number): string;
}

const PRIVATE_KEY_PREFIXES = ["xprv", "tprv"];

export class XpubPayToAllocator implements InvoicePayToAllocator {
  private readonly hdkey: HDKey;

  constructor(xpub: string) {
    if (typeof xpub !== "string" || xpub.trim() === "") {
      throw new TypeError("Merchant xpub must be a non-empty string");
    }

    const trimmed = xpub.trim();

    // Security fail-closed check: strictly reject any private key material
    for (const prefix of PRIVATE_KEY_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        throw new TypeError("Private extended key material (xprv/tprv) is strictly prohibited on the x402 server");
      }
    }

    if (!trimmed.startsWith("xpub") && !trimmed.startsWith("tpub")) {
      throw new TypeError("Expected standard watch-only extended public key starting with 'xpub' or 'tpub'");
    }

    try {
      this.hdkey = HDKey.fromExtendedKey(trimmed);
    } catch (err) {
      throw new TypeError(`Invalid extended public key: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fail-closed verification: ensure NO private key authority exists
    if (this.hdkey.privateKey !== null && this.hdkey.privateKey !== undefined) {
      throw new TypeError("Extended key contains private key material, which is strictly prohibited");
    }
  }

  deriveAddress(derivationIndex: number): string {
    if (
      typeof derivationIndex !== "number" ||
      !Number.isInteger(derivationIndex) ||
      !Number.isSafeInteger(derivationIndex) ||
      derivationIndex < 0 ||
      derivationIndex >= 0x80000000
    ) {
      throw new RangeError(
        `Invalid non-hardened derivation index: ${derivationIndex}. Must be an integer in [0, 2147483647].`,
      );
    }

    // Public non-hardened child derivation
    const child = this.hdkey.deriveChild(derivationIndex);
    if (!child.publicKey) {
      throw new Error(`Failed to derive public key for index ${derivationIndex}`);
    }

    // Standard hash160: ripemd160(sha256(compressedPublicKey))
    const sha = createHash("sha256").update(child.publicKey).digest();
    const hash160 = createHash("ripemd160").update(sha).digest();

    const address = ecashaddr.encodeCashAddress("ecash", "p2pkh", hash160);

    // Validate the generated address with our strict validator before returning
    decodeCashAddress(address);

    return address;
  }
}

export function createXpubPayToAllocator(xpub: string): InvoicePayToAllocator {
  return new XpubPayToAllocator(xpub);
}
