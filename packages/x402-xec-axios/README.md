# `@x402-xec/axios`

Local-only Axios response interceptor for x402-XEC. It validates a compatible
HTTP 402 offer, enforces `maxPaymentSats`, prepares a `PAYMENT-SIGNATURE`
header, and retries the original request at most once.

## Legacy mock signer mode

The existing signer mode remains available for local tests:

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
```

`createTestOnlyMockXecSigner` produces deterministic hashes accepted by the
local `TestOnlyMockSignatureVerifier`. It is not a cryptographic wallet
signature and contains no private key.

## Offline preparer mode

A structurally compatible offline preparer can supply an already encoded
payment signature. The interceptor does not inspect or broadcast any prepared
transaction:

```ts
const client = withX402XecPaymentInterceptor(axios.create(), {
  paymentPreparer,
  maxPaymentSats: 1_000n,
});
```

Configure exactly one payment mode: `signer`, `paymentPreparer`, or
`orchestrator`.

## Experimental orchestrator boundary

Orchestrator mode is experimental and disabled by default. It exists for safe
dry-run and test integration ahead of a future Tonalli Wallet approval UX. It
does not enable production live payments.

Using a supplied orchestrator requires an explicit opt-in:

```ts
const client = withX402XecPaymentInterceptor(axios.create(), {
  orchestrator: dryRunOrchestrator,
  enableOrchestratorPayments: true,
  maxPaymentSats: 1_000n,
});
```

The orchestrator receives only the validated invoice and canonical resource
metadata. It must return a `paymentSignature`. Axios rejects results marked
`broadcasted: true` and does not perform automatic broadcast. A supplied
orchestrator must therefore be configured for dry-run/testing only.

Supplying an orchestrator without `enableOrchestratorPayments: true` fails at
interceptor setup. Orchestrator execution errors are replaced with a generic
error so provider, wallet, or key details are not exposed through Axios.

## Safety boundary

This package has no custody and receives no wallet keys. It does not discover
UTXOs, call Chronik, construct transactions, or expose a broadcast API. It does
not integrate Tonalli Wallet UI, RMZ, or Teyolia. No Axios mode in this package
is production-ready for live payments, and the current `xec:mainnet` identifier
is provisional protocol metadata for local tests.
