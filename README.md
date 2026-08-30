<div align="center">

# 📨 mcp-ecc

**Email · Calendar · Contacts — one MCP server**

A Model Context Protocol (MCP) server that aggregates email, calendar and contacts from Google, Microsoft 365/Outlook, Zoho, IMAP/SMTP, CalDAV and CardDAV into a single interface for AI agents.

</div>

<div align="center">

| | |
|---|---|
| **🪪 Licence** | MIT |
| **🗣 Language** | TypeScript |
| **🔖 Version** | v0.3.1-beta.1 |
| **🟢 Node** | 24+ (LTS) |
| **🐳 Images** | `karljsamuel/mcp-ecc:beta` · `ghcr.io/karljsamuel/mcp-ecc:beta` |
| **📦 npm** | `@karljsamuel/mcp-ecc` |

</div>

<div align="center">

[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6.svg)](#)
[![Version](https://img.shields.io/badge/version-0.3.1--beta.1-purple.svg)](#)
[![Node](https://img.shields.io/badge/node-24-green.svg)](#)
[![Multi-arch](https://img.shields.io/badge/multi--arch-amd64%20%7C%20arm64-blueviolet.svg)](#)

</div>

---

<div align="center">

**One OAuth consent** per cloud provider covers mail + calendar + contacts. Tokens are encrypted at rest (AES-256-GCM). A **multi-user** server: each user self-manages their own provider accounts and connects with their **own per-user MCP API key**.

</div>

## ✨ Highlights

- **Multi-user** — first-run admin bootstrap, admin/user roles, session login, per-user API keys.
- **Per-account OAuth clients** — client IDs/secrets stored per account (personal, org-A, org-B), not in `.env`.
- **Provider coverage** — Google, Microsoft 365/Outlook, Zoho, IMAP/SMTP, CalDAV, CardDAV.
- **Admin web UI** — manage accounts (auth + health badges), users, OAuth clients, settings.
- **Self-hostable** — single container serving web UI + REST + MCP on one port.

---

## 🚀 Quick start

### Docker (recommended)

```bash
docker run -d --name mcp-ecc \
  -p 3001:3001 \
  -e MCP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  karljsamuel/mcp-ecc:beta
```

Open **http://localhost:3001** → create the first admin account, add an OAuth client, add an account.

### From source

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
npm run build
```

---

## 🔌 Connecting an agent

Point your MCP client at the authenticated endpoint (per-user API key):

```text
Endpoint : http://<host>:3001/mcp
Auth     : Authorization: Bearer <your-mcp-api-key>
```

```json
{
  "mcpServers": {
    "mcp-ecc": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <your-mcp-api-key>" }
    }
  }
}
```

Agents can read the [SKILL.md](SKILL.md) runbook and [llms.txt](llms.txt) for a guided setup.

---

## 🧭 Documentation

| Area | Guides |
|------|--------|
| **Getting started** | [Overview](docs/README.md) · [Auth & users](docs/auth-users.md) · [Account identity](docs/accounts-identity.md) |
| **Deployment** | [CLI](docs/deployment-cli.md) · [Docker](docs/deployment-docker.md) · [Cloudflare Workers](docs/deployment-cloudflare-workers.md) |
| **Providers** | [Google](docs/providers-google.md) · [Microsoft 365](docs/providers-microsoft.md) · [Zoho](docs/providers-zoho.md) · [IMAP/SMTP](docs/providers-imap-smtp.md) · [CalDAV/CardDAV](docs/providers-caldav-carddav.md) |
| **Reference** | [MCP tools](docs/mcp-tools.md) · [SKILL.md](SKILL.md) · [llms.txt](llms.txt) |

### Provider coverage

| Provider | Mail | Calendar | Contacts | Auth | Deployable on |
|----------|:---:|:---:|:---:|------|---------------|
| Google | ✅ | ✅ | ✅ | OAuth 2.0 | CLI · Docker · Workers |
| Microsoft 365/Outlook | ✅ | ✅ | ✅ | OAuth 2.0 | CLI · Docker · Workers |
| Zoho | ✅ | ✅ | ✅ | OAuth 2.0 | CLI · Docker · Workers |
| IMAP / SMTP | ✅ | ❌ | ❌ | App password | CLI · Docker |
| CalDAV | ❌ | ✅ | ❌ | Password | CLI · Docker |
| CardDAV | ❌ | ❌ | ✅ | Password | CLI · Docker |

> **Microsoft 365:** app passwords are being retired — use OAuth (Microsoft Graph) only.

---

## 🧰 MCP tools

Namespaced: **`mail.*`**, **`calendar.*`**, **`contacts.*`**, **`accounts.*`**.

```text
mail.listFolders · mail.listMessages · mail.getMessage · mail.sendMessage
mail.searchMessages · mail.moveMessage · mail.setFlags · mail.deleteMessage

calendar.listCalendars · calendar.listEvents · calendar.getEvent · calendar.freeBusy
calendar.createEvent · calendar.updateEvent · calendar.deleteEvent

contacts.list · contacts.get · contacts.create · contacts.update
contacts.delete · contacts.search

accounts.list · accounts.get · accounts.add · accounts.remove · accounts.sync
```

Full reference with input schemas: [`docs/mcp-tools.md`](docs/mcp-tools.md).

---

## 📦 Deployment modes

| Mode | Runtime | Storage | Best for |
|------|---------|---------|----------|
| **Local / CLI** | Node.js 24+ | SQLite / in-memory | Single-user stdio agent hosts |
| **Docker (single container)** | Container | SQLite (volume) | Self-hosted web UI + REST + MCP |
| **Cloudflare Workers** | Edge / serverless | D1 | Global HTTP endpoint (HTTP providers only) |

---

## 🏗 Monorepo layout

```
packages/
├── core/              # Types, storage interface, OAuth/Auth managers
├── storage/           # sqlite · d1 · memory adapters
├── providers/         # google · microsoft · zoho · imap-smtp · caldav · carddav
├── mcp-server/        # MCP tools, resources, prompts
├── management-api/    # Fastify REST + admin UI
├── admin-ui/          # React web app
├── cli/               # mcp-ecc command-line tool
└── workers-entry/     # Cloudflare Workers (Hono)
```

---

## 🤝 Contributing

- Feature branches off `dev`; PRs against `dev`.
- `npm run build` compiles all packages; keep `Changelog.md` and `docs/` in sync.

## 📄 Licence

[MIT](LICENSE) © 2026 Karl J Samuel

---

**Note:** CalDAV/CardDAV adapters are scaffolded; Cloudflare Workers supports HTTP-API providers only.