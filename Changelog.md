# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0-beta.1] - 2026-09-01

### Added
- **Interactive TUI**: running `mcp-ecc` with no arguments opens a terminal UI — ASCII-art banner, centered subtitle, and a `mcp-ecc ›` prompt where commands are typed without the `mcp-ecc` prefix (`login`, `list accounts`, `add account`, `edit account`, `reauthenticate`, `remove account`, `start`, `exit`).
- **CalDAV provider** (calendar) — full implementation replacing the placeholder stub: list calendars, list/get/create/update/delete events, free/busy. Uses standard WebDAV (tsdav client) — service discovery, PROPFIND, PUT/GET/DELETE with etags. Stable event UIDs on update.
- **CardDAV provider** (contacts) — full implementation replacing the placeholder stub: list/get/create/update/delete/search contacts, vCard 3.0 with stable UIDs.
- **`edit account`** — now edits name, slug, email and status, and (for IMAP/SMTP/CalDAV/CardDAV) can update the app password.
- **`reauthenticate [slug]`** — re-runs the OAuth flow for a Google/Microsoft/Zoho account whose token expired or was revoked; resets status to `active`.
- **OAuth client type** — new clients record whether they are **public** (Desktop / Installed / Non-browser app) or **confidential** (Web app / server-side). Token refresh behaves accordingly (public clients never send a client secret).
- **Zoho device flow** — implemented against Zoho's v3 device endpoints (`/oauth/v3/device/code`, `/oauth/v3/device/token`) with correct `device_request`/`device_token` grant types and millisecond intervals.
- **Zoho HTML send** — `mail.sendMessage` now sends HTML (was plaintext-only) using the correct `/api/accounts/{accountId}/messages` endpoint and the authenticated mailbox address as the From address.
- **Zoho folder-aware mail** — `mail.listMessages` resolves folder names (e.g. `INBOX`) to Zoho folder IDs; `mail.getMessage` fetches metadata + content via the folder-scoped content endpoint.
- **Microsoft token refresh** — real refresh implementation (was a no-op placeholder); empty-body responses (e.g. `sendMail` 202) handled gracefully.
- **IMAP/SMTP** — fixed UID-based fetch/flag/move/delete operations; message flags now read correctly (read/unread state).
- **Google flags** — `mail.setFlags` `\Seen` semantics corrected (mark read ↔ unread mapping to the UNREAD label).
- **MCP integration tests** — reusable scripts under `scripts/` exercising every tool over the real stdio MCP protocol against live accounts.

### Changed
- **Port selection** — the CLI's local OAuth callback port now starts at 5000 and skips ports blocked by Chromium (`5060`, `5061`, `6000`, `6566`, `6665–6669`, `6697`), avoiding `ERR_UNSAFE_PORT` in the browser.
- **CLI documentation** — new `docs/cli.md` reference; `docs/deployment-cli.md` rewritten for the npm-install workflow (no more clone-and-build as the primary path).
- **Zoho scopes** — corrected default scope set: `ZohoMail.messages.ALL`, `ZohoMail.folders.READ`, `ZohoCalendar.calendar.ALL`, `ZohoCalendar.event.ALL`, `zohocontacts.contactapi.ALL`, `ZohoMail.accounts.READ`.
- **Browser success page** — no emoji (wasn't rendering everywhere); shows the account name and email after authorization.

### Fixed
- Zoho device flow previously printed `undefined` URL/code (snake_case response fields were not normalised) and polled with the wrong grant type.
- Zoho calendar events failed: wrong endpoint (needs calendar UID, `eventdata` query param, compact `yyyyMMdd'T'HHmmss'Z'` dates) and delete needed the event UID + etag.
- Zoho contacts failed: wrong endpoint (`/api/v1/contacts` → `/api/v1/accounts/self/contacts`) and wrong payload shape/field names.
- Microsoft accounts failed with "JWT is not well formed" — expired tokens were never refreshed (placeholder) and public clients wrongly sent a client secret.
- IMAP `listMessages` returned zero messages — `fetchOne` was called with `uid: true` inside the query instead of as an option.
- Google `setFlags` inverted read/unread.
- SQLite storage: `oauth_clients` gained a `clientType` column with an automatic migration for existing databases.

## [0.3.1] - 2026-08-30

### Added
- Public `GET /api/bootstrap-status` and `GET /api/info` endpoints (redirect URI + MCP endpoint for the UI).
- Serve `SKILL.md` and `llms.txt` at `GET /setup/skill.md` and `GET /setup/llms.txt`.
- Settings page "MCP connection" panel: endpoint, copyable client-config JSON, per-user API key, SKILL.md/llms.txt links.
- Add-Account modal: select-or-create OAuth client, inline client credentials, and display of the OAuth redirect URI.
- MIT licence (`LICENSE`) + licence field across all packages; OCI description/licence labels on the Docker image.
- Docker Hub overview sync: publish workflow pushes the README as the repository description.

### Changed
- Merge IMAP/SMTP into a single "IMAP/SMTP" provider option (was two).
- Rewrite README for public audiences (shields.io badges, concise sections).
- Upgrade GitHub Actions to Node-24-native versions (checkout@v5, docker/*@v4/v6).

### Fixed
- Bootstrap flow: fresh install now routes to a "create admin" screen instead of a bare login.
- Hard-gate `/api/auth/bootstrap` — returns 400 once an admin exists (no self-registration).
- Settings page crash ("Cannot read properties of undefined (reading 'displayName')") — `/api/settings/me` now returns the `{settings, mcpApiKey}` shape.

## [0.3.0] - 2026-08-30

### Added
- **Multi-user authentication** — `users` table (admin + user roles), first-run admin bootstrap, session-cookie auth for the web UI + REST API, scrypt password hashing.
- **Per-user MCP API keys** — each user has a unique key; the `/mcp` endpoint requires `Authorization: Bearer <key>` and scopes /mcp to that user's accounts only.
- **Per-account OAuth clients** — OAuth client IDs/secrets are stored per account (multiple per provider: personal, org-A, org-B), encrypted at rest. No OAuth credentials in `.env`.
- **Account identity** — each account has a human `name` (free text) and a URL-safe unique `slug` ([a-z0-9], `-`/`_`) used as the stable MCP resource key (`mcp-ecc://{slug}/…`).
- **Admin user management** — admin can create/delete users and reset passwords; each user self-manages their own email/calendar/contact accounts.
- **React + Vite + Tailwind admin UI** served by the Fastify API (fixes the previous 404): sidebar with Accounts / Users (admin) / Settings; account card grid with auth key (green/red) + health badges, edit + detail modal; users page; settings with MCP API key display + rotation.
- **Docker Hub publishing** — images pushed to both `ghcr.io/karljsamuel/mcp-ecc` and `karljsamuel/mcp-ecc`, multi-arch (amd64+arm64), with a `:beta` tag on beta releases and `:latest` on main.
- **npm + MCP Registry readiness** — scoped package `@karljsamuel/mcp-ecc` with `mcpName` (`io.github.karljsamuel/mcp-ecc`), `server.json`, `llms.txt`, `SKILL.md`, and a manual `npm-publish` workflow.
- **Documentation** — `docs/auth-users.md`, `docs/accounts-identity.md`; per-provider docs updated for per-account OAuth clients and OAuth-only usage for Microsoft 365.
- **Toolchain** — turbo v2 (tasks schema), Node 24 LTS, `npm audit` clean (0 vulnerabilities).

### Changed
- `.env` reduced to server-level settings only: `MCP_ENCRYPTION_KEY`, `PUBLIC_URL`, `HOST`, `HOST_PORT`, `SESSION_SECRET`.
- Single-container Docker deployment (web UI + REST + MCP on one port 3001).
- Removed `docker-compose.example.yml` (a single, env-driven `docker-compose.yml` remains).
- MCP resource URIs now use account slugs instead of raw ids.

### Notes
- Microsoft 365: app passwords / SMTP basic auth are being retired — use OAuth (Microsoft Graph) only.
- CalDAV / CardDAV adapters remain scaffolded stubs.
- Cloudflare Workers still supports only HTTP-API providers (no IMAP/CardDAV).

## [0.2.0] - 2026-08-28

### Added
- **Monorepo restructure** — single-package codebase reorganised into a Turbo + npm-workspaces monorepo under `packages/`.
- **Core package** (`@mcp-ecc/core`) — unified domain types, storage adapter interface, centralised `OAuthManager` (PKCE, device-code and authorization-code flows), and shared utilities.
- **Storage adapters**:
  - `@mcp-ecc/storage-sqlite` — SQLite adapter for local/Docker (AES-256-GCM encryption; native `better-sqlite3` optional dependency).
  - `@mcp-ecc/storage-d1` — Cloudflare D1 adapter for Workers (Web Crypto encryption).
  - `@mcp-ecc/storage-memory` — in-memory adapter for development and tests.
- **Provider packages**:
  - `@mcp-ecc/provider-google` — Gmail, Google Calendar, People/Contacts.
  - `@mcp-ecc/provider-microsoft` — Microsoft Graph (Mail, Calendar, Contacts), incl. multi-tenant M365 via tenant ID.
  - `@mcp-ecc/provider-zoho` — Zoho Mail, Calendar, Contacts (regional endpoints).
  - `@mcp-ecc/provider-imap-smtp` — IMAP (read/search/manage) and SMTP (send).
  - `@mcp-ecc/provider-caldav` — CalDAV calendar adapter (scaffolded).
  - `@mcp-ecc/provider-carddav` — CardDAV contacts adapter (scaffolded).
- **MCP Server** (`@mcp-ecc/mcp-server`) — namespaced tools (`mail.*`, `calendar.*`, `contacts.*`, `accounts.*`), resources (`mcp-ecc://{account}/today-agenda`), and prompts (`daily_briefing`, `weekly_review`).
- **Management API** (`@mcp-ecc/management-api`) — Fastify REST API, WebSocket sync endpoint, SPA serving, OAuth routes.
- **CLI** (`@mcp-ecc/cli`) — `mcp-ecc` command: interactive auth wizard, account management, and stdio MCP server transport.
- **Cloudflare Workers entry** (`@mcp-ecc/workers-entry`) — Hono-based edge worker with D1 storage and REST/OAuth endpoints.
- **Containerisation** — multi-stage `Dockerfile` (CLI/MCP server) and `Dockerfile.api` (management API), refreshed `docker-compose.yml` with two services.
- **Workers config** — `wrangler.toml` with D1 binding and staging/production environments.
- **Documentation** — `docs/` with deployment guides (CLI, Docker, Cloudflare Workers), per-provider setup guides, and an MCP tools reference; rewritten `README.md`.

### Changed
- Restructured from a single-package layout to a TurboRepo monorepo.
- Renamed MCP tools from verbose `email_*` / `calendar_*` / `contacts_*` to short namespaced `mail.*` / `calendar.*` / `contacts.*` / `accounts.*`.
- Centralised OAuth management (previously split across providers) into the core `OAuthManager`.
- Abstracted storage behind a single `StorageAdapter` interface with SQLite, D1, and in-memory backends.
- CLI storage default switched to the in-memory adapter pending a persistent default in Docker mode.
- Package exports standardised with `import` / `require` / `types` conditions for both ESM and CommonJS consumers.
- `better-sqlite3` moved to an optional dependency so the monorepo builds without native toolchain (installs cleanly in the Docker builder).

### Fixed
- GitHub Actions publish workflow — removed a duplicated `uses:` key that made the workflow file invalid.
- TypeScript compilation across all packages (strict-mode errors, project references, module resolution).
- `workers-entry` rootDir/paths errors by resolving built packages and adding Cloudflare Workers types.

### Notes
- **Cloudflare Workers limitation:** IMAP/SMTP, CalDAV and CardDAV require a Node.js runtime and do not run on Workers; the `/sse` and `/messages` MCP endpoints are placeholders pending a Workers-compatible MCP transport.
- **CalDAV / CardDAV** adapters are scaffolded stubs in this release — full WebDAV implementations are planned.

## [0.1.0] - 2026-07-10

### Added
- Created the core TypeScript Model Context Protocol (MCP) server architecture.
- Added localized secure storage (`src/storage.ts`) supporting optional AES-256-GCM encryption.
- Implemented OAuth 2.0 Device Authorization Grant (Device Code Flow) helper in `src/auth.ts`.
- Integrated abstract multi-provider registry (`src/providers/registry.ts`) routing standard interfaces.
- Implemented full Google Workspace integration (`src/providers/google.ts`) covering Gmail, Calendar, and Contacts.
- Implemented Microsoft Graph integration (`src/providers/microsoft.ts`) covering Outlook Mail, Calendars, and Contacts (supports Tenant ID configuration for M365 organization accounts).
- Implemented Zoho Mail integration (`src/providers/zoho.ts`) for email reading and sending.
- Implemented traditional IMAP/SMTP standard provider (`src/providers/imap-smtp.ts`).
- Created standardized MCP Router layer (`src/mcp-server.ts`) exposing custom resources (daily agenda) and tools (`email_*`, `calendar_*`, `contacts_*`).
- Developed a comprehensive interactive executable CLI wrapper (`src/bin.ts`, `src/bin-handler.ts`).
- Created lightweight container configurations (`Dockerfile`, `docker-compose.yml`) and local bin installer (`install.sh`).
- Added a GitHub Actions workflow (`.github/workflows/publish.yml`) to automatically build and publish the container image to GHCR under the name `mcp-ecc`.
- Cleaned up and deleted legacy/temporary personal repositories (`mcp-email-calendar-contacts`, `mcc-ecp`) and moved active development to the public `mcp-ecc` repository.
