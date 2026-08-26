# Gate H2A — Static Payment-Required Resource Server

This package is the smallest truthful resource-server experiment for the
x402eCash WebMCP Challenge. It exposes a health endpoint and a demo endpoint
that always advertises a deterministic experimental XEC payment requirement.

Gate H2A is a mock payment-requirement server:

- HTTP 402 is real.
- `PAYMENT-REQUIRED` transport signaling is real.
- The XEC payment requirement is experimental.
- No payment occurs.
- No transaction exists.
- No settlement occurs.

The identifiers `xec-prepaid-utxo`, `xec:mainnet`, and `XEC` are provisional
experiment values. This package tests the x402 v2 HTTP transport shape and does
not claim full x402 v2 compatibility or standardized XEC identifiers.

The fixture price is `100 XEC`, represented as `10000` atomic units (sats). A
runtime assertion and deterministic test bind those two representations.

The deterministic `payTo` value is a fixture only. Do not send funds to it.
The endpoint has no success path in H2A: supplying `PAYMENT-SIGNATURE` returns a
fail-closed error and never unlocks a protected resource.

## Run locally

From the repository root:

```sh
pnpm install
pnpm --filter webmcp-resource-server start
```

The server listens on `127.0.0.1:4020`.

```sh
curl -i http://127.0.0.1:4020/health

curl -i \
  -H 'Origin: https://x402.ecash.mx' \
  http://127.0.0.1:4020/v1/resource/demo
```

The second response is always HTTP 402 and includes a base64-encoded JSON
object in the `PAYMENT-REQUIRED` response header.

## Container and platform configuration

Gate H2A is not deployed by this example. A future container or platform
deployment can configure its bind address independently from its canonical
public origin:

```sh
H2A_HOST=0.0.0.0 \
PORT=<platform-assigned> \
H2A_PUBLIC_ORIGIN=https://<public-origin> \
pnpm --filter webmcp-resource-server start
```

The listen port resolves in this order: `H2A_PORT`, then `PORT`, then the local
default `4020`. An explicitly supplied malformed or out-of-range port stops
startup instead of falling back. `H2A_HOST` defaults to `127.0.0.1`.

`H2A_PUBLIC_ORIGIN` controls only the canonical URL advertised in
`PAYMENT-REQUIRED`. Bind host and port overrides never alter that value or
derive a replacement canonical URL. When it is unset, the canonical local
default remains `http://127.0.0.1:4020`.

## Validate

```sh
pnpm --filter webmcp-resource-server test
pnpm --filter webmcp-resource-server typecheck
pnpm --filter webmcp-resource-server build
```
