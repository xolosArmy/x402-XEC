# Local end-to-end demo

This example runs the complete x402-XEC HTTP flow in one local process:

1. A local facilitator starts with `MockChronik` and an in-memory transactional ledger.
2. An Express API protects `GET /weather` for 1,000 sats.
3. An Axios client requests the resource and receives HTTP 402.
4. The interceptor validates the invoice and resource, then uses a test-only mock signer.
5. The client retries with `PAYMENT-SIGNATURE`.
6. Express asks the facilitator to verify and debit the mock funding output.
7. The API returns HTTP 200 with deterministic weather JSON.

From the repository root:

```sh
pnpm --filter local-e2e start
```

Expected output includes:

```text
requesting protected resource
received 402
generated PAYMENT-SIGNATURE
facilitator verified payment
received 200
```

## Safety and scope

This demo is local-only. The signer is a deterministic mock and is not a
cryptographic wallet signature. It uses no real XEC, no real Chronik, no
broadcasting, and no wallet or key custody. Tonalli Wallet, RMZ, and Teyolia are
not integrated yet.

The mock transaction and ledger exist only in memory and are discarded when the
process exits.
