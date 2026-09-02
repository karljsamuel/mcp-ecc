<div align="center">

# mcp-ecc

### Email · Calendar · Contacts — one MCP server for all your accounts

A Model Context Protocol (MCP) server that lets AI assistants read, write and manage your **email, calendar and contacts** — across **Google, Microsoft 365/Outlook, Zoho, and any IMAP/SMTP, CalDAV or CardDAV account** — from a single interface.

![License](https://img.shields.io/badge/license-MIT-blue?logo=open-source-initiative&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Version](https://img.shields.io/badge/version-0.4.0--beta.1-purple)
[![Sponsor](https://img.shields.io/github/sponsors/karljsamuel?color=ea4aaa&logo=github-sponsors&logoColor=white)](https://github.com/sponsors/karljsamuel)
![Node](https://img.shields.io/badge/node-%3E%3D24-339933?logo=nodedotjs&logoColor=white)
![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-black)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)
![Multi-arch](https://img.shields.io/badge/arch-amd64%20%7C%20arm64-lightgrey)

</div>

---

**mcp-ecc** aggregates your mail, calendar and contacts into standardised MCP tools (`mail.*`, `calendar.*`, `contacts.*`, `accounts.*`) so any MCP client — Claude, Cursor, and others — can work with all of them uniformly.

- **One OAuth consent** per cloud provider covers mail + calendar + contacts
- **Multi-user** — users self-manage their own accounts, each with a per-user MCP API key
- **Credentials encrypted at rest** (AES-256-GCM)
- **Self-hostable** — single container serving a web admin UI, REST API and the MCP endpoint on one port

---

## Quick start

### Docker

```bash
docker run -d --name mcp-ecc \
  -p 3001:3001 \
  -e MCP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  karljsamuel/mcp-ecc:beta
```

Open **http://localhost:3001** → create the admin account → add your provider accounts.

### CLI (npm)

```bash
npm install -g mcp-ecc
mcp-ecc            # interactive TUI — login, add accounts, manage everything
mcp-ecc start      # stdio MCP server for agent hosts
```

### From source

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
npm run build
node packages/cli/dist/bin.js --help
```

---

## Connecting an MCP client

Point your client at the HTTP endpoint with your per-user API key (shown in the web UI under **Settings**):

```json
{
  "mcpServers": {
    "mcp-ecc": {
      "type": "http",
      "url": "http://localhost:3001/mcp",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

Agents can read [`SKILL.md`](https://github.com/karljsamuel/mcp-ecc/blob/main/SKILL.md) or [`llms.txt`](https://github.com/karljsamuel/mcp-ecc/blob/main/llms.txt) for guided, automated setup.

---

## Providers

| Provider | Mail | Calendar | Contacts | Authentication |
|----------|:---:|:---:|:---:|------|
| **Google** (Gmail, Calendar, People) | ✅ | ✅ | ✅ | OAuth 2.0 |
| **Microsoft 365 / Outlook** (Graph) | ✅ | ✅ | ✅ | OAuth 2.0 |
| **Zoho** (Mail, Calendar, Contacts) | ✅ | ✅ | ✅ | OAuth 2.0 |
| **IMAP / SMTP** (any mail server) | ✅ | ❌ | ❌ | App password |
| **CalDAV** (Nextcloud, Radicale, BAIKAL) | ❌ | ✅ | ❌ | Password |
| **CardDAV** | ❌ | ❌ | ✅ | Password |

> **Microsoft 365:** app passwords are being retired — use OAuth (Microsoft Graph) only.

> **CalDAV/CardDAV compatibility:** the providers implement standard WebDAV (CalDAV RFC 4791, CardDAV RFC 6352) with Basic auth and should work with any standards-compliant server. **Tested against Radicale 3.7.8.** Not tested against other servers; OAuth-only providers (e.g. iCloud without an app-specific password) are not supported.

Deployment notes: Google/Microsoft/Zoho/IMAP/SMTP/CalDAV/CardDAV run under Node.js (CLI or Docker). Cloudflare D1 can be used as a hosted alternative for the local SQLite database.

---

## MCP tools

```text
mail.listFolders · mail.listMessages · mail.getMessage · mail.sendMessage
mail.searchMessages · mail.moveMessage · mail.setFlags · mail.deleteMessage

calendar.listCalendars · calendar.listEvents · calendar.getEvent · calendar.freeBusy
calendar.createEvent · calendar.updateEvent · calendar.deleteEvent

contacts.list · contacts.get · contacts.create · contacts.update
contacts.delete · contacts.search

accounts.list · accounts.get · accounts.add · accounts.remove · accounts.sync
```

Full reference with input schemas: [`docs/mcp-tools.md`](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/mcp-tools.md)

---

## Documentation

- **[Getting started](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/README.md)** — overview and quick start
- **[CLI reference](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/cli.md)** — every `mcp-ecc` command and workflow
- **[Auth & users](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/auth-users.md)** — multi-user model, bootstrap, per-user API keys
- **[Accounts & identity](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/accounts-identity.md)** — name vs slug
- **Deployment** — [CLI](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/deployment-cli.md) · [Docker](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/deployment-docker.md)
- **Providers** — [Google](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/providers-google.md) · [Microsoft 365](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/providers-microsoft.md) · [Zoho](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/providers-zoho.md) · [IMAP/SMTP](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/providers-imap-smtp.md) · [CalDAV/CardDAV](https://github.com/karljsamuel/mcp-ecc/blob/main/docs/providers-caldav-carddav.md)

---

## Contributing

Feature branches off `dev`; PRs against `dev`. Run `npm run build` to compile all packages. Keep `Changelog.md` and `docs/` in sync.

## Support & Contributions

If you find `mcp-ecc` useful, consider supporting its development:

- **PayPal:** [paypal.me/KarlJosephSamuel](https://paypal.me/KarlJosephSamuel)
- **GitHub Sponsors:** [github.com/sponsors/karljsamuel](https://github.com/sponsors/karljsamuel)
- **Ko-fi:** [ko-fi.com/karljsamuel](https://ko-fi.com/karljsamuel)
- **Patreon:** [patreon.com/karljsamuel](https://patreon.com/karljsamuel)
- **Buy Me a Coffee:** [buymeacoffee.com/karljsamuel](https://buymeacoffee.com/karljsamuel)

---

## License