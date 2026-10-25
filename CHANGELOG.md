# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-10-25

### Breaking

- **Credential encryption was rebuilt. Stored credentials written by earlier
  versions can no longer be read, and every account must be re-authenticated
  once after upgrading.** Encrypted at-rest data includes OAuth refresh tokens,
  OAuth client secrets, IMAP/SMTP app passwords, and per-user API keys (these are
  regenerated). The database can be recreated instead of upgraded if that is
  preferable.
- The `0.6.x` → `0.7.x` intermediate migration step is no longer required or
  supported. Going straight from `0.6.0` to `0.7.0` is the supported path.
- A missing or placeholder `MCP_ENCRYPTION_KEY` is now a hard startup error.
  There is no fallback key, and the key is never read from or written to the
  database.
- The session cookie secret is now independent of `MCP_ENCRYPTION_KEY`; the
  master key is no longer used to sign sessions.

### Added

- **First-run setup for both the CLI and the web UI.** `mcp-ecc setup` walks the
  same steps as the setup page: choose SQLite or Cloudflare D1, verify the
  connection actually works, generate an encryption key, configure the server,
  write `.env` (mode 600), then create the first admin account.
- **The management API starts in setup mode when it is unconfigured** instead of
  exiting. It prints a one-time setup token to stdout, binds to `127.0.0.1`
  only, serves the setup page, and returns 503 for every other API route. The
  setup routes are further gated on no admin existing and are reachable only
  from loopback; the token is compared in constant time and never logged or
  echoed in a response.
- **Container-aware setup handoff.** In a container the generated `.env` is
  offered through a copy button rather than rendered in the page, with
  instructions to place it beside the `docker-compose.yml` and pass the values
  through.
- **Key rotation.** Each encrypted row records a key generation in the database.
  Rotate by setting a new `MCP_ENCRYPTION_KEY` and listing the previous one as
  `MCP_ENCRYPTION_KEY_PREVIOUS` in `"<generation>:<key>"` form, then calling
  `rotateEncryptionKeys(batchSize)`. Both generations decrypt during the
  changeover.
- A `.env` path that honours `MCP_ENV_FILE`, falling back to the working
  directory, so a local checkout, a global install, and a container all behave
  the same way.

### Changed

- Credential encryption now uses **one canonical ciphertext format for every
  backend**: `base64(iv[12] || authTag[16] || ciphertext)` with AES-256-GCM. The
  SQLite and D1 layouts previously differed.
- Keys are **derived per owner** with HKDF-SHA256 over the master key using the
  owner id, replacing a single global key. A value encrypted for one user cannot
  be decrypted as another, which is the groundwork for multi-tenant deployment.
- A decrypt failure now raises an error naming the affected record. Previously
  SQLite returned an empty value, which allowed a later save to overwrite
  credentials with an empty object. Both backends now share one failure contract.
- The account health check probes a single folder per provider instead of
  enumerating every folder, so the periodic health sweep no longer multiplies
  network round-trips per account.

### Fixed

- **Folder unread counts are now exact and per-folder.**
  - Google: the redundant extra `messages.list` probe is gone, and counts for
    every label come from the single `labels.list` response. System folders
    previously reported 0, and the inbox value was a `resultSizeEstimate`.
  - Microsoft: `totalCount` was hardcoded to 0, and the request ignored
    `@odata.nextLink`, so accounts with more than ten folders silently lost
    folders.
  - Zoho: counts no longer come from a query the code itself documents as
    returning account-wide rather than per-folder totals. Folders are counted
    from their own messages under a strict page cap.
  - IMAP: the per-folder `SELECT` + `SEARCH` loop — roughly two round-trips per
    folder on every call — is replaced by one `LIST-STATUS` call, with a bounded
    fallback pool, explicit timeouts, a reused connection, and a short
    folder-list cache.
  - A count that genuinely cannot be determined is reported as `-1` alongside an
    `unreadCountError` instead of a misleading `0`.
- Callers that only need folder names can pass `withUnreadCounts: false` and pay
  a single round-trip.
- The management API's `__dirname` reference threw a `ReferenceError` whenever
  `MCP_PUBLIC_DIR` was unset, which was the default.
- `PORT` is now written to the generated `.env` alongside `HOST_PORT`. The API
  reads `PORT` while `docker-compose` reads `HOST_PORT`; emitting only the latter
  produced a port nothing read.

### Removed

- The `crypto-js` dependency, its types, the legacy ciphertext reader, and the
  automatic migration path.
- The `default-secret-key` fallback in both storage adapters and the CLI.

### CI

- **The real test suites now run.** Every package's test script is
  `vitest run --passWithNoTests` and `packages/` contains no test files, so
  `npm test` exited 0 without executing anything and CI was green while testing
  nothing. CI now runs `node --test tests/*.test.cjs tests/*.test.mjs` after the
  build as a failing gate, and fails loudly if either suite family disappears —
  `node --test` treats an unmatched glob as a passing no-op.
