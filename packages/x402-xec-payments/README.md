# @x402-xec/payments

Payment preparation for x402-XEC.

`OfflinePaymentPreparer` validates invoice and resource metadata from an HTTP 402
response, enforces a caller-provided payment limit, obtains an ordered UTXO
snapshot through `UtxoProvider`, builds a signed funding transaction through
`@x402-xec/transactions`, and signs the invoice-bound authorization through the
message-only `SignatureProvider` boundary. The result includes a base64url JSON
value ready for the `PAYMENT-SIGNATURE` request header.

```ts
const result = await preparer.prepare({ invoice, resource });
request.headers.set("PAYMENT-SIGNATURE", result.paymentSignature);
```

## UTXO providers

`StaticUtxoProvider` is the deterministic default for tests, fixtures, and the
local E2E demo. It performs no network calls.

`ChronikUtxoProvider` is an opt-in, read-only bridge toward controlled mainnet
testing. Both the Chronik endpoint and eCash mainnet address are required; there
is no default endpoint or address. Constructing the provider does not make a
request. Chronik is read only when `OfflinePaymentPreparer.prepare()` calls
`getUtxos()`.

```ts
import {
  ChronikUtxoProvider,
  OfflinePaymentPreparer,
} from "@x402-xec/payments";

const address = "ecash:...";
const preparer = new OfflinePaymentPreparer({
  utxoProvider: new ChronikUtxoProvider({
    endpoint: "https://chronik.example",
    address,
  }),
  payer: address,
  // signatureProvider, changeAddress, signatoryForUtxo, maxPaymentSats...
});
```

The configured address must match the preparer's payer. Chronik satoshi `bigint`
values are converted directly to canonical decimal strings without a JavaScript
`number` conversion. Token metadata is retained so the transaction builder
rejects token-bearing inputs. All coinbase UTXOs are filtered because the
address UTXO response alone cannot establish coinbase maturity. The address
endpoint supports standard address UTXOs; malformed Chronik responses fail
closed.

## Broadcast providers

Broadcast is a separate, dangerous network boundary. The package exports
`BroadcastProvider`, but neither `OfflinePaymentPreparer` nor the Axios
interceptor invokes it.

`DisabledBroadcastProvider` is the safe choice wherever no broadcaster has been
explicitly configured and rejects every attempt. `TestOnlyMockBroadcastProvider`
records raw transaction hex and returns a configured txid for deterministic
local tests only.

`ChronikTxBroadcaster` is opt-in and requires an explicit HTTP(S) endpoint.
There is no hardcoded or default public endpoint, no environment-variable
activation, and no request during construction. Its injected client seam keeps
all automated tests offline. A network request occurs only when caller code
explicitly invokes `broadcastTx`.

## Security and scope

Payment preparation constructs and signs `rawTx` in memory, but neither the UTXO
providers nor the preparer broadcasts it. `ChronikUtxoProvider` only reads UTXOs.
The separate broadcast providers do not accept, derive, or store private keys
and do not provide wallet custody. Transaction-input signatories and the
message-only authorization signer remain in caller-controlled code.

Chronik UTXO reads and transaction broadcast are disabled by default and do not
form an automatic mainnet payment flow. Static fixtures remain deterministic.
The local E2E demo uses no real broadcaster. Tonalli Wallet, RMZ, and Teyolia are
not integrated.

A facilitator can verify the candidate funding outpoint only when its configured
fixture or `TxProvider` knows the generated transaction. Any future live payment
orchestrator must require explicit user configuration, an explicitly selected
broadcaster, and caller-controlled spending caps.

See [the broadcast security boundary](../../docs/broadcast-security-boundary.md)
for the full scope.
