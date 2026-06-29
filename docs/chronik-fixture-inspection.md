# Chronik transaction provider and offline inspection

This layer separates funding verification from transaction retrieval. Core
exports the read-only `TxProvider` contract (and its Chronik-specific marker,
`ChronikTxProvider`):

```ts
interface TxProvider {
  getTx(txid: string): Promise<ChronikTransaction>;
}
```

A provider returns the existing Chronik-shaped transaction model. A missing
transaction rejects with `TxNotFoundError`, which includes the stable
`TX_NOT_FOUND` code and requested txid. The interface has no endpoint,
broadcast, wallet, or mutation methods.

## Deterministic fixture provider

`FixtureChronikTxProvider` implements `ChronikTxProvider` with an in-memory map.
Its constructor accepts the deterministic transactions exported by the
facilitator fixture module. It performs no network calls and is used by the
facilitator tests, local server, and `examples/local-e2e`.

The facilitator receives a `TxProvider` through `FacilitatorOptions` and passes
it to `inspectFundingTransaction`. Inspection verifies the txid, output index,
required sats, token absence, and confirmation or Avalanche finality before a
ledger debit. The fixture tests can additionally provide an expected locking
script to verify the payee output script.

The facilitator does not yet convert an invoice's eCash `payTo` address into a
locking script, so its provider-backed inspection intentionally omits that
comparison. Address decoding belongs with the future real Chronik integration;
this PR does not introduce a partial codec.

## Disabled-by-default real Chronik provider

`RealChronikTxProvider` is available as a read-only adapter for future
integration. It has no default endpoint and can only be created with an explicit
Chronik HTTP(S) endpoint:

```ts
const txProvider = new RealChronikTxProvider({
  endpoint: "https://your-chronik.example",
});
```

Constructing the provider does not connect to Chronik. Calling `getTx` retrieves
one transaction through the official `chronik-client` package and maps its txid,
outputs, token data, block metadata, and finality into the core model. A Chronik
404 becomes `TxNotFoundError`; other connection and service failures remain
visible to the caller.

The local server and `examples/local-e2e` continue to construct
`FixtureChronikTxProvider`. Automated tests use fixtures or an injected mocked
Chronik reader. They do not read a Chronik endpoint from the environment and make
no public Chronik calls. Enabling the real provider requires an application-level
code/configuration change.

Neither provider constructs or broadcasts a transaction, holds keys, takes
custody of funds, or implements a real payment flow. This layer does not
integrate an `ecash-lib` wallet, Tonalli Wallet, RMZ, or Teyolia.
