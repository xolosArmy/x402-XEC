# Offline Chronik transaction inspection

This change is a bridge between the original in-memory funding lookup and future
verification against a real Chronik service. It defines the read-only subset of
a Chronik transaction that payment verification needs and exercises that model
with deterministic local fixtures.

`inspectFundingTransaction` receives an injected `ChronikClient`, a funding
outpoint, the expected payee output script, and the required XEC amount in sats.
It verifies all of the following:

- the transaction returned by the client matches `fundingOutpoint.txid`;
- `fundingOutpoint.outIdx` selects an existing output;
- the selected `outputScript` is the expected payee script;
- the output has at least the required `sats`;
- the output has no token data; and
- the transaction is confirmed (`block` exists) or Avalanche-final
  (`isFinal === true`).

The facilitator package exports fixtures for valid funding, a missing
transaction, a wrong output index, a wrong payee script, insufficient sats, a
token-bearing output, a non-final transaction, a confirmed transaction, and an
Avalanche-final transaction. Txids, scripts, block metadata, token metadata,
and amounts are fixed values with no external dependencies.

## Scope boundary

The fixture client remains an in-memory map. Nothing in this layer configures or
calls a Chronik endpoint, constructs or broadcasts a transaction, holds wallet
keys, or takes custody of funds. It does not depend on `ecash-lib` and does not
integrate Tonalli Wallet, RMZ, or Teyolia.

The helper deliberately accepts the expected output script. Converting the
invoice's eCash `payTo` address to a locking script and wiring the helper into a
production Chronik adapter are later integration steps. Keeping that boundary
explicit avoids introducing an incomplete address codec in this offline bridge.
