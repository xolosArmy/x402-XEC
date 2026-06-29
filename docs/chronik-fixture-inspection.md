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

## Deferred real Chronik integration

A `RealChronikTxProvider` is intentionally not included. This PR prepares the
provider boundary needed for future mainnet or testnet integration but does not
enable either network. A future implementation must be explicitly configured;
there is no default endpoint or implicit fallback to a real service.

Nothing in this layer performs network I/O, constructs or broadcasts a
transaction, holds keys, or takes custody of funds. It does not integrate an
`ecash-lib` wallet, Tonalli Wallet, RMZ, or Teyolia. All current behavior is
deterministic and process-local.
