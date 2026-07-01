import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

/** Minimal browser build alias for the createHash usage in @x402-xec/core. */
export function createHash(algorithm: string): {
  update(value: string, encoding?: string): { digest(encoding: string): string };
} {
  if (algorithm !== "sha256") throw new Error(`unsupported hash: ${algorithm}`);
  return {
    update(value: string, encoding = "utf8") {
      if (encoding !== "utf8") throw new Error(`unsupported encoding: ${encoding}`);
      const digest = sha256(new TextEncoder().encode(value));
      return {
        digest(outputEncoding: string): string {
          if (outputEncoding !== "hex") {
            throw new Error(`unsupported digest encoding: ${outputEncoding}`);
          }
          return bytesToHex(digest);
        },
      };
    },
  };
}
