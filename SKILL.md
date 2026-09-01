---
name: mcp-ecc
description: Runbook for driving the mcp-ecc MCP server — install/run (CLI stdio or single-container Docker), add a provider account, register per-user OAuth clients, and authenticate the /mcp endpoint with a user's per-user MCP API key. Use when setting up, configuring, or connecting a client to mcp-ecc (email/calendar/contacts aggregation for Google, Microsoft 365/Outlook, Zoho, IMAP/SMTP, CalDAV, CardDAV).
---

# mcp-ecc runbook

mcp-ecc is a multi-user MCP server aggregating **email, calendar and contacts** from Google, Microsoft 365/Outlook, Zoho, IMAP/SMTP, CalDAV and CardDAV. Each user self-manages their own accounts and has their own per-user MCP API key.

## Infer provider capabilities

| Provider | Mail | Calendar | Contacts | Cloudflare Workers? |
|----------|------|----------|----------|---------------------|
| Google | ✅ | ✅ | ✅ | ✅ |
| Microsoft (Graph) | ✅ | ✅ | ✅ | ✅ |
| Zoho | ✅ | ✅ | ✅ | ✅ |
| IMAP / SMTP | ✅ | ❌ | ❌ | ❌ (Node only) |
| CalDAV | ❌ | ✅ | ❌ | ❌ (Node only) |
| CardDAV | ❌ | ❌ | ✅ | ❌ (Node only) |

- Google / Microsoft / Zoho are full-fidelity (mail + calendar + contacts, OAuth).
- IMAP/SMTP is **mail only** (no calendar/contacts); **Microsoft 365 is OAuth-only** — app passwords / SMTP basic auth are retired or being retired during 2026.
- CalDAV is **calendar only**, CardDAV is **contacts only** (currently scaffolded stubs).
- **Cloudflare Workers** supports only the HTTP providers (Google, Microsoft, Zoho).

## Install & run

### Local CLI (stdio — for a desktop agent host)

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
npm run build
node packages/cli/dist/bin.js start
```

Point an MCP host at the stdio command `node /abs/path/packages/cli/dist/bin.js start` (set `MCP_ENCRYPTION_KEY` in the host env).

### Docker (single container — web UI + REST + MCP on one port 3001)

```bash
docker compose up -d      # builds + starts; web UI at http://localhost:3001
```

The `/mcp` endpoint is Streamable HTTP on the **same port**: `http://<host>:3001/mcp`.

## First run: bootstrap the admin

Fresh installs have no users. Either use the web UI bootstrap screen, or:

```http
POST /api/auth/bootstrap
{ "username": "admin", "password": "...", "displayName": "Site Admin" }
```

Only available while the system is empty; this creates the sole admin. Admin endpoints (create/delete users, reset passwords) live under `/api/users`.

## Add a provider account

1. Sign in (web UI) or login via API: `POST /api/auth/login { "username", "password" }` → session cookie.
2. **Register an OAuth client** for the cloud provider (Google/Microsoft/Zoho). These are **per user**, not `.env`:
   - `POST /api/oauth-clients` with `{ "provider", "label", "clientId", "clientSecret", "scopes", "tenantId? (Microsoft)", "accountsServer? (Zoho region)" }`
   - Each user creates their client from the provider's developer console (Google Cloud Console / Azure App registrations / Zoho API Console). The secret is encrypted at rest.
3. **Add the account**:
   - `POST /api/accounts` with `{ "name", "slug", "provider", "email", "config" }` → returns an `authorizeUrl`/`state`; complete the browser OAuth.
   - Account `slug` is `[a-z0-9-_]`, **unique per owner**, and is the stable key used by MCP tools/resources (e.g. `accountId`, `mcp-ecc://<slug>/today-agenda`).
   - IMAP/SMTP & CalDAV/CardDAV need no OAuth client — credentials (app password / username-password) are stored on the account and never in `.env`.
4. Verify with `POST /api/accounts/:id/test-connection`; re-auth a stale token with `POST /api/accounts/:id/reauth`.

## Authenticate an MCP client (/mcp)

The MCP endpoint needs a **per-user MCP API key** as a static bearer token. A key is scoped to its owning user's accounts only.

- View / rotate your key: `GET /api/settings/me` and `POST /api/settings/me/rotate-apikey` (rotating invalidates the old one).

```
MCP endpoint URL: http://<host>:3001/mcp
transport:        streamable-http
Authorization:    Bearer <user's MCP API key>
```

Give each agent/developer **their own user and key** — never share.

## Key REST endpoints

- Auth/settings: `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`, `/api/users` (admin), `/api/settings/me`, `/api/settings/me/rotate-apikey`
- Accounts: `/api/accounts`, `/api/accounts/:id`, `/api/accounts/:id/reauth`, `/api/accounts/:id/test-connection`
- OAuth clients: `/api/oauth-clients`

Full detail: `docs/` (see `llms.txt` / `docs/README.md`).