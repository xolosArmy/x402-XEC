import type {
  SignatureVerificationInput,
  SignatureVerifier,
} from "@x402-xec/core";
import { Address, verifyMsg } from "ecash-lib";

/**
 * Opt-in verifier for eCash signed messages.
 *
 * x402-XEC authorizations use unpadded base64url on the wire, while ecash-lib
 * uses standard padded base64. This adapter performs only that encoding
 * translation and message verification.
 */
export class EcashMessageSignatureVerifier implements SignatureVerifier {
  verify(input: SignatureVerificationInput): boolean {
    let address: Address;
    try {
      address = Address.fromCashAddress(input.payer);
    } catch {
      return false;
    }
    if (address.prefix !== "ecash" || address.type !== "p2pkh") return false;

    const signature = toEcashLibSignature(input.signature);
    return signature !== undefined
      && verifyMsg(input.message, signature, input.payer);
  }
}

function toEcashLibSignature(signature: string): string | undefined {
  // An eCash recoverable signature is 65 bytes: 87 unpadded base64url chars.
  if (!/^[A-Za-z0-9_-]{87}$/.test(signature)) return undefined;
  const standard = signature.replaceAll("-", "+").replaceAll("_", "/") + "=";
  try {
    const bytes = Uint8Array.from(atob(standard), (character) => character.charCodeAt(0));
    if (bytes.length !== 65) return undefined;
    const canonical = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    return canonical === signature ? standard : undefined;
  } catch {
    return undefined;
  }
}
