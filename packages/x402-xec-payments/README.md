# @x402-xec/payments

Offline payment preparation for x402-XEC.

`OfflinePaymentPreparer` validates invoice and resource metadata from an HTTP 402
response, enforces a caller-provided payment limit, obtains a deterministic
UTXO snapshot from a local `UtxoProvider`, builds a signed funding transaction
through `@x402-xec/transactions`, and signs the invoice-bound authorization
through the message-only `SignatureProvider` boundary. The result includes a
base64url JSON value ready for the `PAYMENT-SIGNATURE` request header.

```ts
const result = await preparer.prepare({ invoice, resource });
request.headers.set("PAYMENT-SIGNATURE", result.paymentSignature);
```

## Security and scope

This package only prepares payments offline. `rawTx` is generated and returned,
but it is not broadcast. The package has no network client, Chronik dependency,
or broadcast operation. `StaticUtxoProvider` is provided for fixture and local
snapshots; custom providers used by this engine must also be offline.

The preparer does not hold keys or custody funds. Transaction-input signatories
and the message-only authorization signer are supplied by caller-controlled
code. This is not an automatic mainnet payment flow.

A facilitator can verify the candidate funding outpoint only when its configured
fixture or `TxProvider` already knows the generated transaction. A future PR will
add an explicit broadcast-provider boundary. Tonalli Wallet integration will
come later as signer and approval UX.
