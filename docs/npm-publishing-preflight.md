# npm publishing preflight

Use this checklist before the first npm release of the x402-XEC packages. Stop
the release if any check fails or produces an unexpected result.

## Registry access and package names

- [ ] Authenticate with the intended npm account:

  ```sh
  npm login
  npm whoami
  ```

- [ ] Confirm that the account has permission to publish public packages under
  the `@x402-xec` organization or scope. Verify membership and package access in
  the npm website or with the applicable `npm org` and `npm access` commands.
- [ ] Confirm that each intended package name is available or already belongs to
  the `@x402-xec` organization. A `404 Not Found` from `npm view` indicates that
  a name is not currently published; any existing package must be controlled by
  the intended organization and account:

  ```sh
  npm view @x402-xec/core name version
  npm view @x402-xec/axios name version
  npm view @x402-xec/express name version
  npm view @x402-xec/payments name version
  npm view @x402-xec/transactions name version
  ```

## Package scope

Only these packages are intended to be public:

- [ ] `@x402-xec/core`
- [ ] `@x402-xec/axios`
- [ ] `@x402-xec/express`
- [ ] `@x402-xec/payments`
- [ ] `@x402-xec/transactions`

Explicitly do **not** publish these private workspace packages:

- [ ] `@x402-xec/facilitator`
- [ ] `local-e2e`
- [ ] `browser-e2e`
- [ ] `manual-payment-cli`

- [ ] Verify the repository root `package.json` still has `"private": true`.
- [ ] Verify every package in the do-not-publish list still has
  `"private": true`.

## Repository validation

Run from the repository root:

```sh
pnpm test
pnpm build
pnpm typecheck
pnpm changeset status
```

- [ ] `pnpm test` passes.
- [ ] `pnpm build` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm changeset status` reports the expected release state.
- [ ] `git status --short` contains only the deliberately approved release
  changes.

## Package archive inspection

Build first, then inspect an npm dry run for every publishable package:

```sh
(cd packages/x402-xec-core && npm pack --dry-run)
(cd packages/x402-xec-axios && npm pack --dry-run)
(cd packages/x402-xec-express && npm pack --dry-run)
(cd packages/x402-xec-payments && npm pack --dry-run)
(cd packages/x402-xec-transactions && npm pack --dry-run)
```

For every dry-run archive:

- [ ] The package name, version, license, entry points, dependency declarations,
  and public access expectations are correct.
- [ ] The archive includes `dist`, `README.md`, and `package.json`.
- [ ] The archive includes the generated type declarations referenced by the
  package's `types` field.
- [ ] The archive excludes tests and test fixtures.
- [ ] The archive excludes `src` unless source publication is explicitly
  intended and approved.
- [ ] The archive excludes `.env` files, credentials, secrets, examples, and
  `node_modules`.
- [ ] The archive contains no mnemonic, WIF, private key, seed phrase, API token,
  registry token, or other secret. Test-looking credentials must also be reviewed
  and confirmed harmless.
- [ ] No package enables real transaction broadcast or live payment behavior by
  default. Live network endpoints, payment execution, and broadcast must remain
  explicit, opt-in, and fail closed.

## Release commands — NOT TO RUN until final approval

The following sequence is recorded for a later approved release. **Do not run
any of these commands during preflight or before explicit final approval:**

```sh
pnpm changeset
pnpm release:version
pnpm release:publish
```

Before final approval, review the generated changeset and version changes,
repeat all validation and archive checks above, confirm the npm identity and
scope access again, and obtain approval for the exact package names and
versions.
