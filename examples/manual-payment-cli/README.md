# Manual payment CLI

This experimental CLI supports controlled x402-XEC payment tests. Dry-run is
the default: it reads UTXOs from an explicitly configured Chronik endpoint,
builds and signs a funding transaction in memory, creates the authorization and
`PAYMENT-SIGNATURE`, prints the payment plan, and never broadcasts.

Tonalli Wallet / RMZWallet uses BIP39 mnemonic seed phrases as its primary
wallet model. x402-XEC follows its derivation paths:

- mnemonic/default receive address: `m/44'/899'/0'/0/0`
- receive address N: `m/44'/899'/0'/0/{index}`
- change address N: `m/44'/899'/0'/1/{index}`

The CLI's `EcashMnemonicSigner` provides both authorization-message and
transaction signing. The signer does not retain the mnemonic or seed after
derivation. WIF/private-key input is deprecated, developer-only compatibility
and is not the Tonalli-compatible primary model.

Never use a primary Tonalli Wallet seed phrase. Use only a dedicated disposable,
low-value test wallet. The mnemonic is read from
`X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY`; it is not accepted as a CLI argument and
is redacted from surfaced errors. Environment variables can still be exposed by
the host or child processes, so this mechanism is unsafe/local-only. Never
commit a mnemonic, populated `.env`, terminal transcript, WIF, or private key.

`--wif` and `--private-key` remain deprecated low-level developer escape hatches
for isolated compatibility tests. CLI arguments may appear in shell history and
the operating-system process list.

Follow the complete [controlled smoke-test guide](../../docs/manual-smoke-test.md)
before any live experiment.

## Dry-run

Capture the disposable test mnemonic without putting it in the command line:

```sh
read -rsp 'Disposable test wallet mnemonic: ' X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY
export X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY
printf '\n'

pnpm --filter manual-payment-cli start -- dry-run \
  --chronik-url https://your-explicit-chronik.example \
  --pay-to ecash:... \
  --amount-sats 100

unset X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY
```

The `dry-run` positional argument may be omitted. `--from-address` is optional;
when supplied, it must match the address derived by the signer.

## Broadcast

Broadcast mode is dangerous and irreversible. Use a tiny amount and only a
wallet created for this test. It runs only when every broadcast gate is present:

```sh
pnpm --filter manual-payment-cli start -- broadcast \
  --allow-broadcast \
  --yes-i-understand-this-broadcasts-xec \
  --confirmation-phrase 'I UNDERSTAND THIS BROADCASTS XEC' \
  --chronik-url https://your-explicit-chronik.example \
  --max-payment-sats 100 \
  --pay-to ecash:... \
  --amount-sats 100
```

The mnemonic environment variable must already be exported as shown for the
dry-run and must be unset immediately afterward. The CLI applies
`PaymentPolicy`, crosses an explicit `ApprovalProvider` boundary, and then uses
`ChronikTxBroadcaster`. Missing gates fail closed. Amounts above the independent
1,000-sat default are refused unless `--override-conservative-limit` is supplied;
the override does not replace `--max-payment-sats`.

Axios live payments remain disabled. This CLI is not Tonalli Wallet UI and does
not provide wallet custody. Tonalli UI, RMZ, and Teyolia are not integrated.
