# Controlled manual payment smoke test

This procedure is for a deliberate, operator-run mainnet smoke test of the
manual CLI. It does not enable automatic Axios payments, wallet custody, or
broadcast in the local E2E demo. Tonalli Wallet, RMZ, and Teyolia remain out of
scope.

> **Danger:** A broadcast is irreversible. Run a dry-run first, use a tiny
> amount, and use a dedicated low-value wallet created only for testing. Never
> paste a primary wallet WIF. Never commit a WIF, private key, populated `.env`,
> terminal transcript, or other secret.

## Preconditions

- Review the recipient address and exact amount with another operator.
- Fund a dedicated test wallet with only the amount needed plus a small fee.
- Use a trusted, explicitly selected mainnet Chronik endpoint.
- Prevent shell history from recording the command. CLI arguments can also be
  visible in the operating-system process list while the command runs.
- Leave `examples/manual-payment-cli/.env.example` unchanged. It contains
  documentation placeholders only; the CLI does not load it automatically.

## 1. Validate offline behavior

Run the repository checks before touching a real key:

```sh
pnpm test
pnpm build
pnpm typecheck
```

The local E2E remains deterministic and offline. These checks do not authorize
or perform a mainnet broadcast.

## 2. Run the required dry-run

Disable history in the current shell using the mechanism appropriate to your
environment. Substitute only a dedicated test-wallet WIF:

```sh
pnpm --filter manual-payment-cli start -- dry-run \
  --chronik-url https://your-explicit-chronik.example \
  --from-address ecash:your_dedicated_test_wallet \
  --wif 'DEDICATED_TEST_WALLET_WIF' \
  --pay-to ecash:reviewed_recipient \
  --amount-sats 100
```

Confirm that output says `"mode": "dry-run"`, `"broadcasted": false`, and
`DRY RUN ONLY`. Verify the amount, recipient, funding outpoint, fee, and change.
The command signs in memory and reads UTXOs, but does not broadcast.

Stop if the derived address does not match, the UTXOs are unexpected, or any
value differs from the reviewed plan. Do not proceed by increasing limits.

## 3. Broadcast once, manually

Broadcast stays disabled unless all gates are present: broadcast mode,
`--allow-broadcast`, the conspicuous acknowledgement flag, the exact
confirmation phrase, an explicit `maxPaymentSats`, and approval. For amounts
above the independent 1,000-sat conservative ceiling, the CLI also requires
`--override-conservative-limit`; do not use that override for this smoke test.

```sh
pnpm --filter manual-payment-cli start -- broadcast \
  --allow-broadcast \
  --yes-i-understand-this-broadcasts-xec \
  --confirmation-phrase 'I UNDERSTAND THIS BROADCASTS XEC' \
  --chronik-url https://your-explicit-chronik.example \
  --from-address ecash:your_dedicated_test_wallet \
  --wif 'DEDICATED_TEST_WALLET_WIF' \
  --max-payment-sats 100 \
  --pay-to ecash:reviewed_recipient \
  --amount-sats 100
```

`maxPaymentSats` must equal the reviewed ceiling and must not be treated as a
convenient high default. A successful live result contains `"broadcasted":
true` and a transaction ID. Record only the transaction ID and non-secret test
metadata. Clear any temporary secret material and history immediately.

## Guardrails and recovery

- Dry-run is the default; broadcast is never inferred from configuration.
- The CLI accepts one signing key for the current process, stores no key, and
  redacts supplied key text from output errors.
- Mainnet use always emits a warning.
- Policy rejection, missing approval, missing flags, an excessive amount, build
  failure, or broadcast failure fails closed.
- Re-running after an ambiguous network error can create a conflicting or
  duplicate attempt. Check the transaction ID and wallet UTXOs independently
  before deciding whether to retry.
