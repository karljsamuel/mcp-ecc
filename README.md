# mcp-ecc — Email, Calendar & Contacts MCP Server

A Model Context Protocol (MCP) server that aggregates **email, calendar and contacts** across multiple providers from a single interface.

- **Google** (Gmail, Calendar, People/Contacts)
- **Microsoft 365 / Outlook** (Graph API: Mail, Calendar, Contacts)
- **Zoho** (Mail, Calendar, Contacts)
- **IMAP / SMTP** (any traditional mail server)
- **CalDAV** / **CardDAV** (Nextcloud, Radicale, BAIKAL, …)

One OAuth consent per cloud provider covers all three domains. Tokens are encrypted at rest (AES-256-GCM).

> v0.2.0 · monorepo (Turbo + npm workspaces) · TypeScript · Node.js 20+

---

## Quick start — 30 seconds

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
npm run build
```

Point your MCP host (Claude, Cursor, …) at the CLI's **stdio** server:

```json
{
  "mcpServers": {
    "mcp-ecc": {
      "command": "node",
      "args": ["/abs/path/to/mcp-ecc/packages/cli/dist/bin.js", "start"],
      "env": { "MCP_ENCRYPTION_KEY": "a-long-random-secret" }
    }
  }
}
```

```bash
npx turbo run build --filter=@mcp-ecc/cli   # build the CLI
node packages/cli/dist/bin.js auth          # add your first account
```

---

## Deployment modes

mcp-ecc has **three** supported deployment modes. Each is documented fully under [`docs/`](docs/README.md).

| Mode | Runtime | Storage | Best for | Doc |
|------|---------|---------|----------|-----|
| **Local / CLI** | Node.js 20+ | SQLite or in-memory | Single-user agent hosts; stdio transport | [`docs/deployment-cli.md`](docs/deployment-cli.md) |
| **Docker (single container)** | Containers | SQLite on a volume | Self-hosted server: web UI + REST + MCP on one port; all providers | [`docs/deployment-docker.md`](docs/deployment-docker.md) |
| **Cloudflare Workers** | Edge / serverless | D1 | Global HTTP endpoint; cloud API providers only | [`docs/deployment-cloudflare-workers.md`](docs/deployment-cloudflare-workers.md) |

### Which mode suits your needs?

- **Want to connect a desktop agent quickly?** → Local/CLI (stdio).
- **Want a persistent server with a browser UI, all providers, and remote access?** → Docker (single container, one port: web UI + REST + MCP).
- **Want a globally distributed public endpoint for Google/Microsoft/Zoho only?** → Cloudflare Workers.

> ⚠️ **Workers limitation:** IMAP/SMTP, CalDAV and CardDAV need a Node.js runtime and **do not run on Cloudflare Workers**. Use Docker or CLI for those providers.

---

## Provider coverage

| Provider | Mail | Calendar | Contacts | Auth | Deployable on |
|----------|------|----------|----------|------|---------------|
| Google | ✅ | ✅ | ✅ | OAuth 2.0 | CLI · Docker · Workers |
| Microsoft 365/Outlook | ✅ | ✅ | ✅ | OAuth 2.0 | CLI · Docker · Workers |
| Zoho | ✅ | ✅ | ✅ | OAuth 2.0 | CLI · Docker · Workers |
| IMAP / SMTP | ✅ | ❌ | ❌ | App password | CLI · Docker |
| CalDAV | ❌ | ✅ | ❌ | Password | CLI · Docker |
| CardDAV | ❌ | ❌ | ✅ | Password | CLI · Docker |

Per-provider setup guides with exact scopes and client-creation steps:

- [Google](docs/providers-google.md)
- [Microsoft 365 / Outlook](docs/providers-microsoft.md)
- [Zoho](docs/providers-zoho.md)
- [IMAP / SMTP](docs/providers-imap-smtp.md)
- [CalDAV / CardDAV](docs/providers-caldav-carddav.md)

---

## MCP tools

Tools are namespaced: **`mail.*`**, **`calendar.*`**, **`contacts.*`**, **`accounts.*`**.

```text
mail.listFolders · mail.listMessages · mail.getMessage · mail.sendMessage
mail.searchMessages · mail.moveMessage · mail.setFlags · mail.deleteMessage

calendar.listCalendars · calendar.listEvents · calendar.getEvent
calendar.createEvent · calendar.updateEvent · calendar.deleteEvent · calendar.freeBusy

contacts.list · contacts.get · contacts.create · contacts.update
contacts.delete · contacts.search

accounts.list · accounts.get · accounts.add · accounts.remove · accounts.sync
```

Full reference with input schemas: [`docs/mcp-tools.md`](docs/mcp-tools.md).

---

## Monorepo layout

```
packages/
├── core/                 # Types, storage interface, OAuth manager, utils
├── storage/
│   ├── sqlite/           # SQLite adapter (Docker/local)
│   ├── d1/               # Cloudflare D1 adapter (Workers)
│   └── memory/           # In-memory adapter (dev/tests)
├── providers/
│   ├── google/           # Gmail, Calendar, People API
│   ├── microsoft/        # Microsoft Graph API
│   ├── zoho/             # Zoho Mail, Calendar, Contacts
│   ├── imap-smtp/        # IMAP + SMTP
│   ├── caldav/           # CalDAV (stub)
│   └── carddav/          # CardDAV (stub)
├── mcp-server/           # MCP protocol: tools, resources, prompts
├── management-api/       # Fastify REST + WebSocket + embedded UI
├── cli/                  # mcp-ecc command-line tool
└── workers-entry/        # Cloudflare Workers (Hono)
```

---

## Contributing

- Feature branches off `dev`; PRs against `dev`.
- `npm run build` / `npx turbo run build` compiles all packages.
- Update `Changelog.md` on user-facing changes.
- Docs live in `docs/`; keep them in sync with provider capabilities.

## License & status

- **CalDAV / CardDAV** adapters are scaffolded but not yet fully implemented — see [docs/providers-caldav-carddav.md](docs/providers-caldav-carddav.md).
- The Cloudflare Workers MCP SSE endpoint is a placeholder pending a Workers-compatible MCP transport — see [docs/deployment-cloudflare-workers.md](docs/deployment-cloudflare-workers.md).