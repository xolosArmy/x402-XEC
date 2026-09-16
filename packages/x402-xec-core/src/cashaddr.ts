/**
 * @file cashaddr.ts
 *
 * Lightweight, zero-dependency eCash CashAddr decoder and locking script generator.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_MAP = new Map<string, number>();
for (let i = 0; i < CHARSET.length; i++) {
  CHARSET_MAP.set(CHARSET[i]!, i);
}

const GENERATOR = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

function polymod(values: readonly number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = Number(c >> 35n);
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) {
      if ((c0 >> i) & 1) {
        c ^= GENERATOR[i]!;
      }
    }
  }
  return c ^ 1n;
}

function prefixTo5Bit(prefix: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < prefix.length; i++) {
    result.push(prefix.charCodeAt(i) & 31);
  }
  result.push(0);
  return result;
}

export interface DecodedCashAddress {
  readonly prefix: string;
  readonly type: number; // 0 = P2PKH, 1 = P2SH
  readonly hash: string; // 40-char lowercase hex
}

/**
 * Decodes an eCash CashAddress into prefix, type, and 20-byte hash hex.
 */
export function decodeCashAddress(
  address: string,
  options?: { readonly ignoreChecksum?: boolean },
): DecodedCashAddress {
  if (typeof address !== "string" || address.trim() === "") {
    throw new TypeError("Address must be a non-empty string");
  }

  const lower = address.toLowerCase();
  const parts = lower.split(":");
  let prefix = "ecash";
  let body = lower;

  if (parts.length === 2) {
    prefix = parts[0]!;
    body = parts[1]!;
  } else if (parts.length > 2) {
    throw new TypeError(`Malformed address: ${address}`);
  }

  const data: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    const val = CHARSET_MAP.get(char);
    if (val === undefined) {
      throw new TypeError(`Invalid CashAddr character '${char}' at index ${i}`);
    }
    data.push(val);
  }

  if (data.length < 8) {
    throw new TypeError("CashAddr payload too short");
  }

  if (!options?.ignoreChecksum) {
    const prefixData = prefixTo5Bit(prefix);
    const checksumValid = polymod([...prefixData, ...data]) === 0n;
    if (!checksumValid) {
      throw new TypeError(`Invalid CashAddr checksum for ${address}`);
    }
  }

  // 8 checksum chars at the end
  const payload5 = data.slice(0, -8);

  // Convert 5-bit array to 8-bit array
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const val of payload5) {
    acc = (acc << 5) | val;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }

  if (out.length < 21) {
    throw new TypeError("Decoded payload too short for standard address");
  }

  const versionByte = out[0]!;
  const type = (versionByte >> 3) & 0x0f;
  const hashBytes = out.slice(1, 21);
  const hash = Buffer.from(hashBytes).toString("hex");

  return { prefix, type, hash };
}

/**
 * Converts an eCash cash address to its canonical locking script hex.
 * - P2PKH (type 0): OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG -> 76a914<hash>88ac
 * - P2SH (type 1): OP_HASH160 <20-byte hash> OP_EQUAL -> a914<hash>87
 */
export function cashAddressToOutputScriptHex(
  address: string,
  options?: { readonly ignoreChecksum?: boolean },
): string {
  const decoded = decodeCashAddress(address, options);
  if (decoded.type === 0) {
    return `76a914${decoded.hash}88ac`;
  }
  if (decoded.type === 1) {
    return `a914${decoded.hash}87`;
  }
  throw new TypeError(`Unsupported address type: ${decoded.type}`);
}
