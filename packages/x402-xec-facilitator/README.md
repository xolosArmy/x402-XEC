# `@x402-xec/facilitator`

Local-only Express service for verifying x402-XEC authorizations against
`@x402-xec/core`, a `MockChronik`, and an in-memory transactional ledger.

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

## Offline Chronik inspection bridge

The package exports deterministic Chronik-shaped funding fixtures used with
`inspectFundingTransaction` from core. The helper verifies txid, output index,
payee script, sats, token absence, and confirmation or Avalanche finality. See
[`docs/chronik-fixture-inspection.md`](../../docs/chronik-fixture-inspection.md)
for the fixture matrix and integration boundary.

## Scope boundary

`MockChronik` is an injected in-memory map. This package has no real Chronik URL
or network client, transaction broadcast path, wallet keys, or custody. It does
not integrate Tonalli Wallet, RMZ, or Teyolia.
