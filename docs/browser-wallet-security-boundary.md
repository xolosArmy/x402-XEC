# Browser wallet security boundary

`@x402-xec/payments` exports `BrowserWalletAdapter` as the future integration
boundary for a Tonalli Wallet approval UI. No Tonalli Wallet, RMZ, or Teyolia
integration is implemented.

The browser adapter follows these rules:

- The adapter never receives a mnemonic, WIF, private key, or seed phrase.
- Tonalli Wallet owns and retains all key material.
- x402-XEC receives only public account data, approval results, signatures, and
  an optionally signed prepared transaction.
- x402-XEC does not take custody of funds or credentials.
- The adapter has no broadcast API. Broadcast remains disabled by default.
- The adapter does not enable automatic payments. Human approval is explicit,
  and rejection or cancellation prevents wallet signing.

`DisabledBrowserWalletAdapter` is the safe default and fails closed.
`TestOnlyBrowserWalletAdapter` is deterministic, performs no I/O, and produces
fixture hashes rather than real proof of key ownership.

Adapter requests use fixed public metadata shapes. Arbitrary wallet context and
credential fields are stripped by `BrowserWalletApprovalSigningBoundary`.
The boundary is not wired into Axios, does not send HTTP requests, and does not
broadcast. Future integration must preserve spending policy and broadcast gates.
