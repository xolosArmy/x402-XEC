# @x402-xec/transactions

Offline-only XEC funding transaction construction for x402-XEC invoices.

`buildFundingTx` deterministically selects caller-provided UTXOs in their given
order, pays `invoice.payTo` exactly `invoice.amountSats`, signs through
caller-provided `ecash-lib` signatories, and returns serialized transaction hex,
its offline-derived txid, the selected inputs, the candidate funding outpoint,
the fee, and change.

Amounts cross this package boundary as canonical base-10 strings and are
calculated with `bigint`. Token-bearing UTXOs are rejected. Change below the
configured dust threshold is omitted and folded into the transaction fee.

## Security and scope

This package only constructs transactions offline. It performs no network calls,
does not connect to Chronik, and has no broadcast API. It does not receive or
store private keys: callers supply signing callbacks and retain custody.

This is not safe for mainnet use yet. There is no automatic payment flow or
wallet integration. Future Tonalli Wallet integration will provide signer UX.
RMZ and Teyolia are not integrated.
