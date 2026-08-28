# mcp-ecc Documentation

Model Context Protocol server for Email, Calendar, and Contacts (ECC), aggregating Google, Microsoft (365/Outlook), Zoho, IMAP/SMTP, CalDAV and CardDAV accounts.

This folder contains detailed, mode-by-mode documentation. The top-level `README.md` provides the quick start; these documents go deeper into deployment, configuration and provider setup.

## Deployment modes

| Mode | Runtime | Data store | Use case | Docs |
|------|---------|-----------|----------|------|
| [Local clone / CLI](deployment-cli.md) | Node.js 20+ | in-memory or SQLite | Development, single-user, agent hosts | `docs/deployment-cli.md` |
| [Docker](deployment-docker.md) | Container | SQLite (persisted volume) | Self-hosted server + web UI | `docs/deployment-docker.md` |
| [Cloudflare Workers](deployment-cloudflare-workers.md) | Edge / serverless | D1 | Global edge deployment, HTTP providers only | `docs/deployment-cloudflare-workers.md` |

## Providers

Each provider supports a subset of the three data domains (mail / calendar / contacts). The capabilities matrix below is authoritative.

| Provider | Mail | Calendar | Contacts | Auth | Docs |
|----------|------|----------|----------|------|------|
| Google | ✅ | ✅ | ✅ | OAuth 2.0 (device code / auth code) | `docs/providers-google.md` |
| Microsoft 365 / Outlook | ✅ | ✅ | ✅ | OAuth 2.0 (device code / auth code) | `docs/providers-microsoft.md` |
| Zoho | ✅ | ✅ | ✅ | OAuth 2.0 (auth code) | `docs/providers-zoho.md` |
| IMAP / SMTP | ✅ | ❌ | ❌ | App password | `docs/providers-imap-smtp.md` |
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
                │  JSON-RPC 2.0 (stdio / HTTP / SSE)
                ▼
┌─────────────────────────────────────────────────────┐
│                       mcp-ecc                        │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────┐  │
│  │  MCP Server  │   │  OAuth       │   │ Storage │  │
│  │  (tools/     │   │  Manager     │   │ SQLite/ │  │
│  │  resources)  │   │  PKCE/device │   │ D1/mem  │  │
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

See `docs/mcp-tools.md` for the full tool reference with input schemas.