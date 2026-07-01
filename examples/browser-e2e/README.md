# Browser E2E dry-run demo

This is a browser dry-run demo only. It illustrates the approval and
authorization-signing boundary intended for a future Tonalli Wallet UI. It is
not production-ready.

The injected `window.tonalli` object is a fake test wallet. It contains no real
funds, mnemonic, WIF, private key, seed phrase, or other secret. The flow uses a
fixture funding transaction and a deterministic test-only signature. It makes
no real Chronik request, has no broadcast provider, never broadcasts, and
always reports `broadcasted: false`.

The demo provides no custody and includes no RMZ or Teyolia integration. A
future Tonalli Wallet UI will implement this adapter boundary while retaining
key material and approval inside the wallet.

## Run locally

From the repository root:

```sh
pnpm --filter browser-e2e start
```

Open the printed loopback URL and select **Get Weather**. The UI shows the
initial 402, fake approval and signing steps, the retry with
`PAYMENT-SIGNATURE`, and the protected fixture response. All HTTP traffic stays
on the local demo server; facilitator verification is an in-process fixture.
