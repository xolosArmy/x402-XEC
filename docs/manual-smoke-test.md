# Controlled manual payment smoke test

This procedure is for a deliberate, operator-run mainnet smoke test of the
manual CLI. It does not enable Axios live payments, wallet custody, or broadcast
in the local E2E demo. Tonalli Wallet UI, RMZ, and Teyolia remain out of scope.

> **Danger:** A broadcast is irreversible. Use a dedicated disposable,
> low-value test wallet only. Never use a primary Tonalli Wallet seed phrase.
> Never commit seed words, a populated `.env`, terminal transcript, WIF, or
> private key.

Tonalli Wallet / RMZWallet uses mnemonic seed phrases as its primary wallet
model, and x402-XEC follows the same derivation paths:

- mnemonic/default receive address: `m/44'/899'/0'/0/0`
- receive address N: `m/44'/899'/0'/0/{index}`
- change address N: `m/44'/899'/0'/1/{index}`

WIF is not the Tonalli-compatible primary model. `--wif` and `--private-key`
are deprecated, developer-only compatibility for low-level testing.

## Preconditions

- Review the recipient and exact amount with another operator.
- Fund a newly created disposable test wallet with only the amount plus fee.
- Use a trusted, explicitly selected mainnet Chronik endpoint.
- Leave `.env.example` unchanged; it contains placeholders only.
- Understand that environment variables are unsafe/local-only and can be
  exposed by the host or child processes.

## 1. Validate offline behavior

```sh
pnpm test
pnpm build
pnpm typecheck
```

Tests use mocked providers and make no real network calls or broadcasts.

## 2. Run the required dry-run

Capture the dedicated test mnemonic without passing it in argv:

```sh
read -rsp 'Disposable test wallet mnemonic: ' X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY
export X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY
printf '\n'

pnpm --filter manual-payment-cli start -- dry-run \
  --chronik-url https://your-explicit-chronik.example \
  --pay-to ecash:reviewed_recipient \
  --amount-sats 100
```

Confirm that output says `"mode": "dry-run"`, `"broadcasted": false`, and
`DRY RUN ONLY`. Verify the derived payer address independently in the disposable
wallet, plus amount, recipient, funding outpoint, fee, and change. Stop on any
mismatch.

## 3. Broadcast once, manually

Broadcast stays disabled unless broadcast mode, `--allow-broadcast`, the
acknowledgement flag, exact confirmation phrase, explicit `maxPaymentSats`, and
approval are all present. Do not use the conservative-limit override here.

```sh
pnpm --filter manual-payment-cli start -- broadcast \
  --allow-broadcast \
  --yes-i-understand-this-broadcasts-xec \
  --confirmation-phrase 'I UNDERSTAND THIS BROADCASTS XEC' \
  --chronik-url https://your-explicit-chronik.example \
  --max-payment-sats 100 \
  --pay-to ecash:reviewed_recipient \
  --amount-sats 100

unset X402_XEC_MNEMONIC_UNSAFE_LOCAL_ONLY
```

A successful live result contains `"broadcasted": true` and a transaction ID.
Record only non-secret test metadata. Clear temporary secret material and shell
state immediately.

## Guardrails and recovery

- Dry-run is the default; broadcast is never inferred from configuration.
- Mnemonic and BIP39 seed data are not retained by the signer after derivation.
- Supplied secret text is redacted from surfaced errors and never logged.
- Policy rejection, missing approval, missing flags, excessive amount, build
  failure, or broadcast failure fails closed.
- After an ambiguous network error, inspect the transaction ID and wallet UTXOs
  independently before deciding whether to retry.
