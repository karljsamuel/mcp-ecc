# mcp-ecc Documentation

Model Context Protocol server for Email, Calendar, and Contacts (ECC), aggregating Google, Microsoft (365/Outlook), Zoho, IMAP/SMTP, CalDAV and CardDAV accounts.

This folder contains detailed, mode-by-mode documentation. The top-level `README.md` provides the quick start; these documents go deeper into deployment, configuration, users and provider setup. The repo root also ships an [`llms.txt`](../llms.txt) and a [`SKILL.md`](../SKILL.md) for AI agents.

## Users & identity

mcp-ecc is a **multi-user** server. Read these first if you are new to the access model:

- [Authentication & Users](auth-users.md) — multi-user model, first-run admin bootstrap, session login for the UI/API, and the per-user MCP API key (`Authorization: Bearer`) that scopes `/mcp` to one user's accounts.
- [Accounts & Identity](accounts-identity.md) — the human `name` vs the stable `slug` (`[a-z0-9-_]`, unique per owner) used as the MCP resource key.

OAuth client IDs/secrets are stored **per user, per account** inside the application (see the provider docs); they are **not** configured via `.env` variables.

## Deployment modes

| Mode | Runtime | Data store | Use case | Docs |
|------|---------|-----------|----------|------|
| [Local clone / CLI](deployment-cli.md) | Node.js 20+ | in-memory or SQLite | Development, single-user, agent hosts | `docs/deployment-cli.md` |
| [Docker](deployment-docker.md) | Container | SQLite (persisted volume) | Self-hosted server + web UI | `docs/deployment-docker.md` |
| [Cloudflare Workers](deployment-cloudflare-workers.md) | Edge / serverless | D1 | Global edge deployment, HTTP providers only | `docs/deployment-cloudflare-workers.md` |

## Providers

Each provider supports a subset of the three data domains (mail / calendar / contacts). The capabilities matrix below is authoritative. For every cloud provider, the OAuth client is created by the user in the relevant developer console and registered inside mcp-ecc (per account) — see `docs/providers-*.md`.

| Provider | Mail | Calendar | Contacts | Auth | Docs |
|----------|------|----------|----------|------|------|
| Google | ✅ | ✅ | ✅ | OAuth 2.0 (per-user client; device / auth code) | `docs/providers-google.md` |
| Microsoft 365 / Outlook | ✅ | ✅ | ✅ | OAuth 2.0 (per-user client; Graph only — app passwords retired) | `docs/providers-microsoft.md` |
| Zoho | ✅ | ✅ | ✅ | OAuth 2.0 (per-user client; auth code + region) | `docs/providers-zoho.md` |
| IMAP / SMTP | ✅ | ❌ | ❌ | App password (per account; M365 not supported) | `docs/providers-imap-smtp.md` |
| CalDAV | ❌ | ✅ | ❌ | Username / password | `docs/providers-caldav-carddav.md` |
| CardDAV | ❌ | ❌ | ✅ | Username / password | `docs/providers-caldav-carddav.md` |

## Runtime matrix

Important constraint: **not every provider works in every deployment mode.** Cloudflare Workers cannot open raw TCP sockets or hold long-lived connections, so IMAP/SMTP, CalDAV and CardDAV require a Node.js runtime (local CLI or Docker).

| Provider | Local CLI | Docker | Cloudflare Workers |
|----------|-----------|--------|--------------------|
| Google | ✅ | ✅ | ✅ |
| Microsoft | ✅ | ✅ | ✅ |
| Zoho | ✅ | ✅ | ✅ |
| IMAP / SMTP | ✅ | ✅ | ❌ |
| CalDAV | ✅ | ✅ | ❌ |
| CardDAV | ✅ | ✅ | ❌ |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    MCP Client                        │
│          (Claude, Cursor, other agent host)          │
└───────────────┬─────────────────────────────────────┘
                │  JSON-RPC 2.0 (stdio / HTTP, Bearer key)
                ▼
┌─────────────────────────────────────────────────────┐
│                       mcp-ecc                        │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────┐  │
│  │  MCP Server  │   │  OAuth /     │   │ Storage │  │
│  │  (tools/     │   │  Auth/Users  │   │ SQLite/ │  │
│  │  resources)  │   │  (per-user)  │   │ D1/mem  │  │
│  └──────┬───────┘   └──────────────┘   └─────────┘  │
│         │                  │                         │
│         ▼                  ▼                         │
│  ┌───────────────────────────────────────────────┐   │
│  │              Provider Registry                 │   │
│  └───┬───────────┬───────────┬───────────┬──────┘   │
│      ▼           ▼           ▼           ▼          │
│  Google      Microsoft      Zoho      IMAP/SMTP     │
│                                     CalDAV/CardDAV  │
└─────────────────────────────────────────────────────┘
```

## MCP Tools

- **Mail**: `mail.listFolders`, `mail.listMessages`, `mail.getMessage`, `mail.sendMessage`, `mail.searchMessages`, `mail.moveMessage`, `mail.setFlags`, `mail.deleteMessage`
- **Calendar**: `calendar.listCalendars`, `calendar.listEvents`, `calendar.getEvent`, `calendar.createEvent`, `calendar.updateEvent`, `calendar.deleteEvent`, `calendar.freeBusy`
- **Contacts**: `contacts.list`, `contacts.get`, `contacts.create`, `contacts.update`, `contacts.delete`, `contacts.search`
- **Accounts**: `accounts.list`, `accounts.get`, `accounts.add`, `accounts.remove`, `accounts.sync`

Tools are addressed by the account **slug**; all access through `/mcp` is scoped to the bearer key's user. See `docs/mcp-tools.md` for the full tool reference with input schemas.