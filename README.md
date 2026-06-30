# x402-XEC

Security-first protocol primitives for HTTP 402 payments settled in eCash (XEC).

The core package contains strict invoice and authorization schemas, deterministic
request binding, local authorization verification with atomic nonce consumption,
a read-only transaction provider interface, and replay-protection test vectors.

The local facilitator package adds an Express verification API, fixture-backed
Chronik funding lookup, an opt-in read-only real Chronik adapter, an opt-in eCash
message-signature verifier, and a transactional in-memory credit ledger. See
[`packages/x402-xec-facilitator`](packages/x402-xec-facilitator/README.md).

Deterministic Chronik transaction-provider fixtures and their scope are
documented in [`docs/chronik-fixture-inspection.md`](docs/chronik-fixture-inspection.md).

The [`examples/local-e2e`](examples/local-e2e/README.md) demo connects the
facilitator, Express middleware, and Axios interceptor in one deterministic local
flow.

The [`@x402-xec/transactions`](packages/x402-xec-transactions/README.md) package
constructs signed XEC funding transactions offline from caller-provided UTXOs and
signatories. It has no network or broadcast capability and holds no keys.

The [`@x402-xec/payments`](packages/x402-xec-payments/README.md) package includes
the deterministic `StaticUtxoProvider` and an opt-in, read-only
`ChronikUtxoProvider` for controlled UTXO discovery. The Chronik provider
requires an explicit endpoint and eCash address. The package also defines a
separate broadcast boundary that is disabled by default; its
`ChronikTxBroadcaster` requires an explicit endpoint and explicit invocation.
See [`docs/broadcast-security-boundary.md`](docs/broadcast-security-boundary.md).

The provisional network identifier is `xec:mainnet`. It is isolated as a constant
so a future standards-based identifier can replace it.

## Development

Requires Node.js 20 or newer.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Scope boundary

`EcashMessageSignatureVerifier`, `RealChronikTxProvider`, and
`ChronikUtxoProvider`, and `ChronikTxBroadcaster` are opt-in. None is selected by
the local server or demo, and all Chronik adapters require explicit endpoints.
Local E2E uses
`StaticUtxoProvider` and `TestOnlyMockSignatureVerifier`; mock signatures are
never wallet signatures. The transactions package can construct and sign a raw
transaction through caller-owned callbacks, but no automatic flow broadcasts,
holds keys, custodies funds, or initiates mainnet payment. Broadcast requires a
separately configured provider and explicit method call. Future orchestration
must also require explicit user configuration and spending caps. Tonalli Wallet,
RMZ, Teyolia, and facilitator wallet behavior are not included.
