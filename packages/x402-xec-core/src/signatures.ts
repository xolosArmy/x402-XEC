export type MaybePromise<T> = T | Promise<T>;

export interface SignatureVerificationInput {
  readonly payer: string;
  readonly message: string;
  readonly signature: string;
}

/** Verifies a signature over an already-canonicalized authorization message. */
export interface SignatureVerifier {
  verify(input: SignatureVerificationInput): MaybePromise<boolean>;
}

/**
 * Signs messages only. Transaction construction and transaction signing are
 * deliberately outside this boundary.
 */
export interface SignatureProvider {
  sign(message: string): MaybePromise<string>;
}

/** @deprecated Use SignatureVerifier. */
export type AuthorizationSignatureVerifier = SignatureVerifier;
