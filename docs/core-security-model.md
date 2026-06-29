# Core security model

## Values and authorization

`amountSats` is a canonical positive base-10 string on the wire. Leading zeroes,
signs, decimals, and exponent notation are rejected. Core comparisons convert it
to `bigint`; JavaScript `number` is never used for value.

Invoices bind `xec:mainnet`, destination, exact amount, issue and expiry times, a
high-entropy nonce, and a SHA-256 `resourceHash`. Authorizations repeat the
security-sensitive fields and contain the SHA-256 hash of the complete canonical
invoice. Applications inject an XEC-compatible signature verifier; the core does
not prematurely select a wallet-specific signature format.

## Resource binding

The request data hash is `SHA256(canonical({ body, query }))`. The resource hash
is `SHA256(canonical({ bodyAndQueryHash, method, path, serverOrigin }))`.

Origins are normalized HTTP(S) origins without credentials. Methods are uppercased
HTTP tokens. Paths must be origin-form without query or fragment. Query pairs are
sorted by key and value while retaining duplicates. JSON keys are sorted
recursively. A domain, method, path, query, or body change alters `resourceHash`.

## Replay behavior

Verification completes stateless binding, expiry, and signature checks before
atomically consuming the nonce. Distributed `NonceStore` implementations must use
compare-and-set. The in-memory implementation is single-process only. Expiry is
Invoices are also rejected when `now < issuedAt`.
exclusive: `now >= expiresAt` is expired.

`TxProvider` is the read-only transaction boundary used by funding inspection.
Missing transactions reject with `TxNotFoundError`. Core configures no endpoint
and exposes no broadcast method; real Chronik integration is deferred.
