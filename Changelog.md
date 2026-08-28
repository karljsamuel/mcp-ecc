# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
