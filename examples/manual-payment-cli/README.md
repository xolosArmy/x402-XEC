# Manual payment CLI

This is an experimental CLI for controlled x402-XEC payment experiments.
Dry-run is the default and recommended mode. It reads UTXOs from an explicitly
configured Chronik endpoint, builds and signs a funding transaction in memory,
creates the authorization and `PAYMENT-SIGNATURE`, prints the payment plan, and
never broadcasts.

This CLI provides no wallet custody and stores no private keys. A key supplied
with `--wif` or `--private-key` is used only in the running process. Command-line
arguments may still be visible in shell history and the operating-system process
list, so use only isolated local/manual test environments and disposable,
low-value keys.

## Dry-run

```sh
pnpm --filter manual-payment-cli start -- dry-run \
  --chronik-url https://your-explicit-chronik.example \
  --from-address ecash:... \
  --wif ... \
  --pay-to ecash:... \
  --amount-sats 100
```

The `dry-run` positional argument may be omitted. `--private-key` accepts exactly
32 bytes of hex as a local-testing alternative to a compressed mainnet WIF.
Neither key form is written to output.

## Broadcast

Broadcast mode is dangerous: it creates a real, irreversible XEC transaction.
Do not use large amounts. It will run only when every broadcast gate is present:

```sh
pnpm --filter manual-payment-cli start -- broadcast \
  --allow-broadcast \
  --yes-i-understand-this-broadcasts-xec \
  --chronik-url https://your-explicit-chronik.example \
  --from-address ecash:... \
  --wif ... \
  --max-payment-sats 100 \
  --pay-to ecash:... \
  --amount-sats 100
```

The CLI applies `PaymentPolicy`, crosses an explicit `ApprovalProvider`
boundary, and then uses `ChronikTxBroadcaster`. Missing gates fail closed.

There are no automatic payments, and this CLI is not connected to the Axios
interceptor. It is not a wallet and does not custody funds or persist secrets.
Tonalli Wallet approval UX comes later; RMZ and Teyolia are not integrated.
