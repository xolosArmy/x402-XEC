# Local end-to-end demo

This example runs the complete x402-XEC HTTP flow with local HTTP servers and
in-memory fixtures:

1. A facilitator starts with `FixtureChronikTxProvider` and an in-memory ledger.
2. Express protects `GET /weather` for 1,000 sats.
3. Axios receives HTTP 402 and validates the invoice and resource metadata.
4. `OfflinePaymentPreparer` selects a deterministic UTXO, constructs a signed
   funding transaction offline, and signs the authorization message.
5. The demo adds the prepared funding transaction to the fixture provider.
6. Axios retries once with `PAYMENT-SIGNATURE`; Express sends it to the local
   facilitator, which verifies and debits the fixture output.
7. The API returns HTTP 200 with deterministic weather JSON.

Run it from the repository root:

```sh
pnpm --filter local-e2e start
```

Expected output includes:

```text
requesting protected resource
received 402
prepared PAYMENT-SIGNATURE and rawTx offline
facilitator verified payment
received 200
```

The test suite also retains the legacy mock-signer variant for backward
compatibility. `createOfflineClient()` is the preferred local simulation;
`createClient()` exercises the legacy signer path.

## Safety and scope

The deterministic key and UTXOs are test fixtures controlled by the caller, not
a wallet or custody implementation. The prepared `rawTx` is never broadcast.
The facilitator only sees the transaction because the demo explicitly registers
it with `FixtureChronikTxProvider`; it does not fetch real Chronik. All network
traffic is limited to the local API and facilitator servers. Real broadcast will
arrive in a later explicit opt-in change. Tonalli Wallet, RMZ, and Teyolia are
not integrated.
