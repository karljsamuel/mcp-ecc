# Cloudflare Workers Deployment

Run mcp-ecc on the Cloudflare edge with a serverless worker and a D1 database. This gives global low-latency access and automatic scaling, ideal for a publicly reachable HTTP endpoint.

> **Important limitation:** Cloudflare Workers runs on the V8 edge runtime — it **cannot** open raw TCP sockets or hold long-lived network connections. Therefore **IMAP/SMTP, CalDAV and CardDAV are NOT available on Cloudflare Workers.** Only the HTTP-API providers (Google, Microsoft, Zoho) work.

## Supported matrix (Workers)

| Provider | Works on Workers? |
|----------|-------------------|
| Google | ✅ |
| Microsoft | ✅ |
| Zoho | ✅ |
| IMAP / SMTP | ❌ (needs Node runtime) |
| CalDAV | ❌ (needs Node runtime) |
| CardDAV | ❌ (needs Node runtime) |

Use the **Docker** or **CLI** modes for full provider coverage.

## Prerequisites

- A Cloudflare account
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed (`npm i -g wrangler`)
- Node.js 20+ for building

## 1. Build the worker

```bash
cd packages/workers-entry
npm install
npm run build
```

This compiles the Hono-based worker to `dist/index.js`.

## 2. Create the D1 database

```bash
# Create the database (returns a database_id)
wrangler d1 create mcp-ecc
```

Copy the returned `database_id` into `packages/workers-entry/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "mcp-ecc"
database_id = "your-database-id-here"
```

The D1 schema (accounts, credentials, sync state, cached mail/calendar/contacts) is created automatically on first use by the `D1Storage` adapter.

## 3. Configure secrets & variables

Set the production secrets via Wrangler. Environment variables marked as secrets (`*_CLIENT_SECRET`, `MCP_ENCRYPTION_KEY`) should be set with `wrangler secret`.

```bash
wrangler secret put MCP_ENCRYPTION_KEY
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put MICROSOFT_CLIENT_SECRET
wrangler secret put ZOHO_CLIENT_SECRET
```

Set the non-secret variables in `wrangler.toml` (or via `wrangler secret` / dashboard):

```toml
[env]
MCP_ENCRYPTION_KEY = ""          # put via secret instead
GOOGLE_CLIENT_ID = "..."
GOOGLE_CLIENT_SECRET = ""        # put via secret instead
MICROSOFT_CLIENT_ID = "..."
MICROSOFT_CLIENT_SECRET = ""     # put via secret instead
ZOHO_CLIENT_ID = "..."
ZOHO_CLIENT_SECRET = ""          # put via secret instead
BASE_URL = "https://mcp-ecc.your-subdomain.workers.dev"
```

## 4. Deploy

```bash
wrangler deploy
```

A second environment (staging) is preconfigured in `wrangler.toml`; deploy to it with:

```bash
wrangler deploy --env staging
```

## 5. Endpoints exposed by the worker

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check |
| `GET` | `/api/accounts` | List accounts |
| `GET` | `/api/accounts/:id` | Account detail |
| `POST` | `/api/accounts` | Start OAuth for a new account |
| `DELETE` | `/api/accounts/:id` | Remove an account |
| `GET` | `/oauth/start` | Begin OAuth flow |
| `GET` | `/oauth/callback` | OAuth redirect target |
| `POST` | `/oauth/device-poll` | Poll device-code flow |
| `GET` | `/sse` | MCP SSE placeholder |
| `POST` | `/messages` | MCP message placeholder |

## MCP transport on Workers — current status

The MCP SDK's `SSEServerTransport` depends on Node's `ServerResponse`, which **does not exist** on the Workers runtime. The `/sse` and `/messages` endpoints are therefore placeholders that return a helpful message. **Use the CLI's stdio transport (Node) or the Docker server for real MCP agent integration.** A Workers-compatible MCP transport (e.g. streamable HTTP) is planned — track the repo for updates.

## Provider scopes on Workers

Because only HTTP providers run here, ensure the OAuth clients request the full mail + calendar + contacts scopes listed in the [Google](providers-google.md), [Microsoft](providers-microsoft.md) and [Zoho](providers-zoho.md) docs.

## Local development

```bash
cd packages/workers-entry
wrangler dev --local  # emulate D1 locally
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `D1` binding error at deploy | Confirm `database_id` is set in `wrangler.toml` and the database exists |
| Secrets not applied | Use `wrangler secret put` (secrets can't be stored in `wrangler.toml`) |
| OAuth redirect fails | Set `BASE_URL` to the exact deployed `.workers.dev` URL, and register it as a redirect URI in the provider's OAuth console |
| IMAP/CardDAV errors | These providers do not run on Workers; use Docker/CLI mode instead |