<<<<<<< HEAD
<<<<<<< HEAD
# x402-XEC
=======
=======
>>>>>>> a84672a (feat(core): scaffold x402-XEC protocol verification)
# x402-XEC

Security-first protocol primitives for HTTP 402 payments settled in eCash (XEC).

The first core package contains strict invoice and authorization schemas,
deterministic request binding, local authorization verification with atomic nonce
consumption, a read-only Chronik interface, and replay-protection test vectors.

The provisional network identifier is `xec:mainnet`. It is isolated as a constant
so a future standards-based identifier can replace it.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run typecheck
npm run build
```

## Scope boundary

There is no production Chronik client or configured mainnet endpoint. The code
cannot construct or broadcast transactions, hold keys, or custody funds. Tonalli
Wallet, RMZ, Teyolia, and facilitator wallet behavior are not included.
<<<<<<< HEAD
>>>>>>> a84672a (feat(core): scaffold x402-XEC protocol verification)
=======
>>>>>>> a84672a (feat(core): scaffold x402-XEC protocol verification)
