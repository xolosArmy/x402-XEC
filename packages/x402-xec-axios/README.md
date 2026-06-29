# `@x402-xec/axios`

Local-only Axios response interceptor for x402-XEC. It validates a compatible
HTTP 402 offer, enforces `maxPaymentSats`, prepares a `PAYMENT-SIGNATURE`
header, and retries the original request once.

## OfflinePaymentPreparer mode (preferred)

Use `OfflinePaymentPreparer` for realistic local simulations. The preparer
reads deterministic UTXOs, constructs and signs a funding transaction entirely
offline, signs the authorization message, and returns the encoded envelope.

`rawTx` is prepared in memory but is not broadcast. The interceptor only uses
the returned `paymentSignature`; callers may retain `rawTx` for fixture setup
or inspection.

```ts
import axios from "axios";
import { withX402XecPaymentInterceptor } from "@x402-xec/axios";
import { OfflinePaymentPreparer } from "@x402-xec/payments";

const paymentPreparer = new OfflinePaymentPreparer({
  utxoProvider,          // deterministic local UTXOs
  signatureProvider,    // message signing boundary
  payer,
  changeAddress,
  signatoryForUtxo,     // caller-controlled transaction signing
  maxPaymentSats: 1_000n,
});

const client = withX402XecPaymentInterceptor(axios.create(), {
  paymentPreparer,
  maxPaymentSats: 1_000n,
});

const response = await client.get("http://127.0.0.1:3000/weather");
```

The facilitator verifies the authorization funding outpoint through its injected
`TxProvider`. For an offline simulation, the prepared transaction must be added
to a fixture provider before the paid retry reaches the facilitator. No real
Chronik lookup occurs automatically.

## Legacy mock signer mode

The existing mock signer API remains available for backward-compatible local
tests:

```ts
import { createTestOnlyMockXecSigner } from "@x402-xec/axios";

const client = withX402XecPaymentInterceptor(axios.create(), {
  maxPaymentSats: 1_000n,
  signer: createTestOnlyMockXecSigner({
    payer: "ecash:q...",
    transaction: { txid: "00...00", vout: 0 },
  }),
});
```

`createTestOnlyMockXecSigner` produces deterministic hashes accepted by the
local `TestOnlyMockSignatureVerifier`. It is legacy/local-only behavior, not a
cryptographic wallet signature. Configure exactly one of `signer` or
`paymentPreparer`.

## Safety boundary

This package does not discover UTXOs, fetch Chronik, broadcast transactions, or
provide wallet custody. Real broadcast will require a later, explicit opt-in
integration. Tonalli Wallet, RMZ, and Teyolia are not integrated. Do not use the
current local flow on mainnet.
