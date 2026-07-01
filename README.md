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

The experimental
[`examples/manual-payment-cli`](examples/manual-payment-cli/README.md) supports
recommended dry-run payment planning and a dangerous, explicitly gated manual
broadcast mode. It is not connected to Axios, provides no custody or automatic
payments, and must not be used with large amounts.
The manual CLI remains a developer and testing layer; it is not the wallet user
experience.
See the [controlled manual smoke-test guide](docs/manual-smoke-test.md) for the
required dry-run procedure and live guardrails.

The [`@x402-xec/transactions`](packages/x402-xec-transactions/README.md) package
constructs signed XEC funding transactions offline from caller-provided UTXOs and
signatories. It has no network or broadcast capability and holds no keys.

The [`@x402-xec/payments`](packages/x402-xec-payments/README.md) package includes
the deterministic `StaticUtxoProvider` and an opt-in, read-only
`ChronikUtxoProvider` for controlled UTXO discovery. The Chronik provider
requires an explicit endpoint and eCash address. `LivePaymentOrchestrator`
composes payment planning in recommended dry-run mode by default. Its separate
broadcast boundary requires live mode, explicit permission, a non-disabled
provider, a caller-defined `PaymentPolicy`, and an approved decision from an
explicit `ApprovalProvider`. It is not wired into Axios or the
offline local E2E. See
[`docs/broadcast-security-boundary.md`](docs/broadcast-security-boundary.md).

The payments package also exports a fail-closed `BrowserWalletAdapter` boundary
for a future Tonalli Wallet approval and signing UI. The wallet retains all key
material and x402-XEC receives only public account data, decisions, and
signatures. No Tonalli, RMZ, or Teyolia integration is included. See
[`docs/browser-wallet-security-boundary.md`](docs/browser-wallet-security-boundary.md).
Axios live payment remains disabled until an explicit future PR.

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
holds keys, custodies funds, or initiates mainnet payment. Broadcast requires a separately configured provider, `dryRun: false`,
`allowBroadcast: true`, an explicit spending policy, and approval. The default
`DisabledApprovalProvider` rejects every live payment. Tonalli Wallet, RMZ, Teyolia, and facilitator wallet
behavior are not included; future wallet integration must add user approval
before broadcast.
