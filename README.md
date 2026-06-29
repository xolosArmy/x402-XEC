# x402-XEC

Security-first protocol primitives for HTTP 402 payments settled in eCash (XEC).

The core package contains strict invoice and authorization schemas, deterministic
request binding, local authorization verification with atomic nonce consumption,
a read-only Chronik interface, and replay-protection test vectors.

The local facilitator package adds an Express verification API, mock-only Chronik
funding lookup, and a transactional in-memory credit ledger. See
[`packages/x402-xec-facilitator`](packages/x402-xec-facilitator/README.md).

Offline Chronik-shaped transaction inspection fixtures and their scope are
documented in [`docs/chronik-fixture-inspection.md`](docs/chronik-fixture-inspection.md).

The [`examples/local-e2e`](examples/local-e2e/README.md) demo connects the
facilitator, Express middleware, and Axios interceptor in one deterministic local
flow.

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

There is no production Chronik client or configured mainnet endpoint. The code
cannot construct or broadcast transactions, hold keys, or custody funds. Tonalli
Wallet, RMZ, Teyolia, and facilitator wallet behavior are not included.
