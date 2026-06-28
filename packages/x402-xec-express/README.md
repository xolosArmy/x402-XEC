# @x402-xec/express

Express middleware for the local x402-XEC end-to-end demo. It issues short-lived
invoices for configured routes and sends submitted authorizations to the local
facilitator's `/facilitator/verify` endpoint.

```ts
import express from "express";
import { createX402XecMiddleware } from "@x402-xec/express";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(createX402XecMiddleware({
  publicOrigin: "https://api.example.com",
  facilitatorUrl: "http://127.0.0.1:4020",
  payTo: "ecash:qaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  routes: {
    "GET /weather": {
      amountSats: "1000",
      asset: "XEC",
      network: "xec:mainnet",
      scheme: "xec-prepaid-utxo",
      description: "Local weather forecast",
    },
  },
}));
```

An unpaid protected request receives a `402` offer. To retry, encode this JSON
as unpadded base64url and send it in the `PAYMENT-SIGNATURE` header:

```json
{
  "invoice": {},
  "authorization": {},
  "idempotencyKey": "optional-client-key"
}
```

The `invoice` is copied from the 402 response. `xec-prepaid-utxo` is the local
offer mechanism; invoices and authorizations retain the core `exact` scheme required
by the current local facilitator. `authorization` uses the
`@x402-xec/core` authorization schema. The middleware validates the invoice's
origin, method, path, query/body hash, amount, recipient, and expiry before
contacting the facilitator. `publicOrigin` is always configuration-derived;
the request `Host` header is not trusted.

This package is local middleware only. It does not use mainnet or real Chronik,
broadcast XEC transactions, hold wallet keys, or provide custody. It has no
Tonalli Wallet, RMZ, or Teyolia integration yet. It prepares only the server
side of the local end-to-end demo.
