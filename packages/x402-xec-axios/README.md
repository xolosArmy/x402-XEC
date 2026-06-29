# `@x402-xec/axios`

Local-only Axios response interceptor for the current x402-XEC test stack. It
makes the original request normally, validates a compatible HTTP 402 offer,
creates a mock authorization, and retries once with a `PAYMENT-SIGNATURE`
header.

```ts
import axios from "axios";
import {
  createTestOnlyMockXecSigner,
  withX402XecPaymentInterceptor,
} from "@x402-xec/axios";

const client = withX402XecPaymentInterceptor(axios.create(), {
  maxPaymentSats: 1_000n,
  signer: createTestOnlyMockXecSigner({
    payer: "ecash:q...",
    transaction: { txid: "00...00", vout: 0 },
  }),
});

const response = await client.get("http://127.0.0.1:3000/weather");
```

## Payment envelope

`PAYMENT-SIGNATURE` contains unpadded base64url-encoded JSON:

```json
{
  "invoice": {},
  "authorization": {}
}
```

The authorization is bound to the invoice, resource, amount, recipient, nonce,
payer, and mock funding outpoint. The interceptor validates the invoice and
advertised XEC payment method, enforces `maxPaymentSats`, and retries a request
at most once.

## Scope boundary

`createTestOnlyMockXecSigner` creates deterministic hashes accepted by the facilitator's local
`TestOnlyMockSignatureVerifier`. It is not a cryptographic wallet signature and has no keys or custody.

This package has no Chronik client, transaction construction, broadcast, wallet
custody, or `ecash-lib` integration. It does not integrate Tonalli, RMZ, or
Teyolia. Do not use it on mainnet; the current `xec:mainnet` identifier is only
provisional protocol metadata for local tests.
