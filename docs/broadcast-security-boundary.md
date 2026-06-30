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

The broadcaster does not create an automatic mainnet payment flow and is not
wired into the Axios interceptor, `OfflinePaymentPreparer`, or the local E2E
demo. Automated tests use injected mock Chronik clients and never submit a
transaction to a network.

This boundary does not accept, derive, store, or manage private keys and provides
no wallet custody. Tonalli Wallet, RMZ, and Teyolia are not integrated.

Any future live payment orchestrator must require explicit user configuration,
an explicitly selected broadcaster, and caller-controlled spending caps. It must
not turn transaction preparation into implicit broadcast.
