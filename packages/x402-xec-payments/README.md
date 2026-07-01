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

## Live payment orchestration

`LivePaymentOrchestrator` composes a `UtxoProvider`, the offline funding
transaction builder, caller-controlled transaction signatories, a message-only
`SignatureProvider`, a `PaymentPolicy`, an `ApprovalProvider`, and a `BroadcastProvider`. Despite its name, it
defaults to
`dryRun: true`; dry-run is the recommended mode.

In dry-run mode, `execute()` reads configured UTXOs, builds the signed funding
transaction, signs the authorization, and returns `rawTxHex`, the funding
outpoint, authorization, `PAYMENT-SIGNATURE` value, and planned broadcast
metadata. It never calls the approval provider or `broadcastTx`, even if those providers were supplied. The result
reports that live execution requires approval.

```ts
const orchestrator = new LivePaymentOrchestrator({
  utxoProvider,
  signatureProvider,
  payer,
  changeAddress,
  signatoryForUtxo,
  // dryRun defaults to true
});

const plan = await orchestrator.execute({ invoice, resource });
console.log(plan.rawTxHex, plan.plannedBroadcast);
```

Broadcast is dangerous and potentially irreversible. Live mode is accepted only
when every safety control is explicit:

```ts
const orchestrator = new LivePaymentOrchestrator({
  utxoProvider,
  signatureProvider,
  broadcastProvider, // must not be DisabledBroadcastProvider
  approvalProvider, // DisabledApprovalProvider is the default
  paymentPolicy: {
    maxPaymentSats: 10_000n,
    maxFeeSats: 500n,
    allowedNetworks: ["xec:mainnet"],
    allowedSchemes: ["exact"],
    requireManualApproval: true,
  },
  payer,
  changeAddress,
  signatoryForUtxo,
  dryRun: false,
  allowBroadcast: true,
});
```

Before broadcasting, the orchestrator validates invoice expiry and resource
binding; evaluates amount, network, scheme, optional payTo allowlist, fee, expiry,
and execution-mode policy; builds and signs the payment; and requests an approved
`ApprovalDecision`. Failure at any stage prevents the broadcaster call.

`DisabledApprovalProvider` is the default and always rejects live approval.
`TestOnlyApprovalProvider` returns a configured decision for deterministic tests
only. A future Tonalli Wallet integration can implement `ApprovalProvider` as its
user-approval UX while keeping signing material and custody outside this package.

This API is not wired into `@x402-xec/axios`, does not enable automatic mainnet
payments, and does not create wallet custody. It does not integrate Tonalli
Wallet, RMZ, or Teyolia. A future Tonalli Wallet integration should supply
caller-controlled signers and an explicit user-approval UX before any broadcast.

## Browser wallet adapter

`BrowserWalletAdapter` is the future Tonalli Wallet approval and signing
boundary. It requests public account data, explicit invoice approval,
authorization signing, and optionally prepared-transaction signing.
`BrowserWalletApprovalSigningBoundary` enforces approval before signing and has
no broadcast capability.

`DisabledBrowserWalletAdapter` is the fail-closed default.
`TestOnlyBrowserWalletAdapter` is deterministic and performs no I/O. Neither is
wired into Axios or changes the orchestrator or CLI defaults.

The adapter never receives a mnemonic, WIF, private key, or seed phrase.
Tonalli Wallet retains key ownership and custody; x402-XEC receives only public
account data, approval results, and signatures. There is no automatic payment
or default broadcast path. See
[the browser wallet security boundary](../../docs/browser-wallet-security-boundary.md).

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
`BroadcastProvider`. `OfflinePaymentPreparer` and the Axios interceptor never
invoke it. `LivePaymentOrchestrator` invokes it only after live mode and all
safety controls have been explicitly enabled.

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
The local E2E demo stays offline and uses no broadcaster. Tonalli Wallet, RMZ,
and Teyolia are not integrated.

A facilitator can verify the candidate funding outpoint only when its configured
fixture or `TxProvider` knows the generated transaction. Any future live payment
integration must preserve explicit user approval and caller-controlled limits.

See [the broadcast security boundary](../../docs/broadcast-security-boundary.md)
for the full scope.
