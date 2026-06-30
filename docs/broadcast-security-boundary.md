# Broadcast security boundary

Transaction broadcast is a dangerous, irreversible network boundary. Preparing
and signing a transaction does not authorize this repository to submit it.

`@x402-xec/payments` exposes a narrow `BroadcastProvider` interface.
`DisabledBroadcastProvider` is the safe provider for every path without explicit
broadcast configuration and always throws `BroadcastDisabledError`.
`TestOnlyMockBroadcastProvider` exists only for deterministic local tests.

`ChronikTxBroadcaster` is opt-in. Callers must provide a Chronik HTTP(S) endpoint
explicitly; the package has no hardcoded or default public endpoint and does not
read environment variables to activate broadcasting. Construction performs no
network request. A request occurs only when the caller explicitly invokes
`broadcastTx`.

`LivePaymentOrchestrator` composes the existing read, build, sign, and broadcast
boundaries. It defaults to `dryRun: true`, which is the recommended mode. A
dry-run may read UTXOs through an explicitly configured provider, but it only
returns a signed raw transaction, authorization, `PAYMENT-SIGNATURE` envelope,
and planned broadcast metadata. It does not call `broadcastTx`.

Live mode is intentionally redundant. It requires all of the following:

- `dryRun: false`
- `allowBroadcast: true`
- an explicitly supplied provider other than `DisabledBroadcastProvider`
- an explicit `maxPaymentSats`
- an invoice amount no greater than that maximum

Invoice, UTXO, construction, or signing failures occur before the broadcast
call. Broadcast remains dangerous and potentially irreversible.

The orchestrator is not wired into the Axios interceptor or local E2E demo and
does not create an automatic mainnet payment flow. Automated tests use static
UTXOs and mock broadcasters and never submit a transaction to a network. The
local E2E remains entirely offline.

This boundary does not accept, derive, store, or manage private keys and provides
no wallet custody. Tonalli Wallet, RMZ, and Teyolia are not integrated.

Future Tonalli Wallet integration should provide explicit user-approval UX before
broadcast and keep signing material under wallet control.
