import {
  canonicalHash,
  type SignatureVerifier,
} from "@x402-xec/core";

export function createMockSignature(payer: string, message: string): string {
  return canonicalHash({ domain: "x402-xec-local-mock-signature-v1", message, payer });
}

/** Local test verifier. This is deliberately not a cryptographic wallet signature. */
export class TestOnlyMockSignatureVerifier implements SignatureVerifier {
  verify(input: { readonly payer: string; readonly message: string; readonly signature: string }): boolean {
    return input.signature === createMockSignature(input.payer, input.message);
  }
}

/** @deprecated Use TestOnlyMockSignatureVerifier to make the local-only scope explicit. */
export { TestOnlyMockSignatureVerifier as MockSignatureVerifier };
