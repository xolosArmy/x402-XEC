# Manual smoke-test result

Use this template to record a controlled x402-XEC manual dry-run or explicitly
approved future broadcast smoke test. Record only non-secret metadata. Redact
addresses if the record will be shared publicly.

## Test context

- Date/time (include time zone):
- Git commit tested:
- Mode: `dry-run` / `broadcast`
- Chronik endpoint:

## Payment details

- From address (redact if needed):
- Pay-to address:
- `amountSats`:
- `maxPaymentSats`:
- Wallet model used: `mnemonic` / `browser adapter` / `WIF developer-only`
- Derivation path if mnemonic: `m/44'/899'/0'/0/{index}`

## Planning and authorization

- Selected UTXOs summary (outpoints and values only; no secrets):
- Estimated fee:
- Policy result:
- Approval result:

## Broadcast and confirmation

- Broadcast result, if applicable:
- Transaction ID (`txid`), if applicable:
- Confirmation status, if applicable:

## Secret-safety checks

- [ ] Confirmed that no secrets were printed in command output or captured
      logs.
- [ ] Confirmed that no seed phrase, WIF, or private key was committed.

## Notes

-
