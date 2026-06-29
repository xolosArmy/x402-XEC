# `@x402-xec/core`

Wire schemas, deterministic request binding, and local replay protection for the
first x402-XEC protocol scaffold.

Applications provide a `SignatureVerifier` and an atomic nonce store.
`SignatureProvider` is a message-signing boundary only; it does not include
transaction signing. The package performs no network or wallet operations.
