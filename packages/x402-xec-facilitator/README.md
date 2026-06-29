# `@x402-xec/facilitator`

Express service for verifying x402-XEC authorizations against `@x402-xec/core`,
a transaction provider, and an in-memory transactional ledger. All included
server and demo entry points use `FixtureChronikTxProvider`.

It exposes:

- `GET /health`
- `GET /facilitator/supported`
- `POST /facilitator/verify`

## Run locally

From the repository root:

```sh
npm install
export FACILITATOR_NOW=1800000010
export MOCK_CHRONIK_FIXTURES='[{"txid":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","outputs":[{"sats":"10000","outputScript":"51"}],"block":{"height":800000,"hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","timestamp":1799999900},"isFinal":true}]'
npm start --workspace @x402-xec/facilitator
```

The server binds only to `127.0.0.1` and defaults to port `3402`. The fixed
`FACILITATOR_NOW` is optional and exists only to replay deterministic local test
vectors. Without it, the server uses the wall clock.

In another shell:

```sh
curl http://127.0.0.1:3402/health
curl http://127.0.0.1:3402/facilitator/supported
curl -X POST http://127.0.0.1:3402/facilitator/verify \
  -H 'content-type: application/json' \
  --data-binary @packages/x402-xec-facilitator/examples/verify-request.json
```

The complete deterministic payloads are in
[`examples/verify-request.json`](examples/verify-request.json) and
[`examples/verify-response.json`](examples/verify-response.json).

## Verification and ledger behavior

Invoice and authorization schemas, request canonicalization, resource hashing,
amount parsing, signature message construction, and nonce consumption all come
from `@x402-xec/core`. The local mock signature is deterministic and is not a
wallet signature.

The ledger serializes each idempotency check, core verification, mock funding
lookup, and debit as one process-local transaction. A failed debit does not
commit its staged nonce. Successful retries with the same idempotency key and
request return the stored response. Reusing a key for another request returns
`IDEMPOTENCY_CONFLICT`.

Ledger entries retain the funding outpoint (`txid` + `outIdx`), payer, payee,
initial and remaining funding values, debit, invoice ID, nonce, authorization
digest, and idempotency key. Amounts remain `bigint` internally and serialize as
canonical decimal strings.

## Transaction provider boundary

`Facilitator` depends on the read-only `TxProvider` interface.
`FixtureChronikTxProvider` supplies deterministic Chronik-shaped transactions
from an in-memory map and rejects unknown txids with `TxNotFoundError`. Funding
verification runs through `inspectFundingTransaction` before a ledger debit.

`RealChronikTxProvider` is available for future read-only integration through an
explicit `{ endpoint }` constructor configuration. It is disabled by default:
the package has no default endpoint, no environment-variable switch, and no
implicit fallback from fixtures to a network service.
See [`docs/chronik-fixture-inspection.md`](../../docs/chronik-fixture-inspection.md)
for the provider contract and configuration boundary.

## Scope boundary

The real provider only reads transactions. This package has no transaction
broadcast path, wallet keys, custody, or real payment flow. It does not integrate
Tonalli Wallet, RMZ, or Teyolia.
