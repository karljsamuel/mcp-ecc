# Docker Deployment (Single Container)

Run mcp-ecc as **one container** that serves everything — the web UI, REST/OAuth API, and the MCP endpoint — in a single process on a single port. This is the recommended self-hosted mode: persistent storage (SQLite on a volume), all providers work (including IMAP/SMTP, CalDAV, CardDAV), and a browser UI for adding accounts.

## Prerequisites

- **Docker** (with Docker Compose v2)
- A writable `./data` directory on the host (persisted credentials)

## Single container — what it runs

The image entrypoint is the **management API** (`mcp-ecc-api`), which hosts three surfaces on **one port (3001)**:

| Surface | Path | Purpose |
|---------|------|---------|
| Web UI | `/` | Browser admin UI for adding/managing accounts |
| REST + OAuth API | `/api/*`, `/oauth/*` | Programmatic account management |
| **MCP endpoint** | `/mcp` | Model Context Protocol over Streamable HTTP (for remote agent hosts) |

All three share the same process, same storage, same port.

## 1. Configure environment

Create a `.env` file in the repository root. `docker-compose.yml` reads these variables:

```dotenv
# Required — used to encrypt stored credentials (AES-256-GCM)
MCP_ENCRYPTION_KEY=your-long-random-secret

# OAuth client credentials (only for providers you use)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...

# Public base URL (used for OAuth redirects)
BASE_URL=http://localhost:3001
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `MCP_ENCRYPTION_KEY` | required | AES-256-GCM key for stored credentials |
| `PORT` | `3001` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `BASE_URL` | `http://localhost:3001` | OAuth redirect base |
| `MCP_STORAGE_FILE` | `/data/mcp-ecc.db` | SQLite path |
| `MCP_PUBLIC_DIR` | embedded `admin-ui` build | Static UI directory |

## 2. Build and start

```bash
# Build the image
docker compose build

# Start in the background
docker compose up -d

# Watch logs
docker compose logs -f
```

Or without Compose:

```bash
docker build -t mcp-ecc .
docker run -d --name mcp-ecc \
  -p 3001:3001 \
  -v $(pwd)/data:/data \
  -e MCP_ENCRYPTION_KEY=your-long-random-secret \
  mcp-ecc
```

## 3. Storage behaviour

The `bin.ts` entrypoint prefers **SQLite** (`better-sqlite3`, persistent on the `/data` volume) and **falls back to in-memory** automatically if the native module is unavailable. The Docker builder installs native build tools so SQLite is the default there.

Back up the `./data` directory; without the encryption key the database cannot be read by anyone else.

## 4. Using the web UI

Open **http://localhost:3001**:

1. **Add an Account** → select a provider → complete OAuth in the browser
2. Tokens are stored encrypted; account status is shown

## 5. REST/OAuth API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness check |
| `GET` | `/api/accounts` | List accounts |
| `GET` | `/api/accounts/:id` | Account detail |
| `POST` | `/api/accounts` | Start OAuth for a new account |
| `DELETE` | `/api/accounts/:id` | Remove an account |
| `GET` | `/oauth/start` | Begin OAuth flow (browser) |
| `GET` | `/oauth/callback` | OAuth redirect target |
| `POST` | `/oauth/device-poll` | Poll device-code flow |
| `WS` | `/ws` | Real-time sync status |

## 6. Connecting an MCP agent host

Point a remote MCP client at the Streamable HTTP endpoint:

```
MCP endpoint URL: http://<host>:3001/mcp
transport:        streamable-http
```

The client performs the standard MCP handshake (`initialize` → `notifications/initialized` → `tools/list`), exchanging the `Mcp-Session-Id` header. All `mail.*`, `calendar.*`, `contacts.*` and `accounts.*` tools are exposed.

For local desktop agents (Claude, Cursor) that prefer **stdio**, use the CLI as described in the [CLI docs](deployment-cli.md) instead.

## Security notes

- **Never** commit the `.env` file (it is gitignored).
- Put the endpoint behind TLS (reverse proxy / HTTPS) when exposed beyond localhost.
- Restrict access to port 3001 if the host is internet-facing.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `better-sqlite3` fails to build during `docker build` | The provided `Dockerfile` installs `python3`, `make`, `g++` in the builder stage |
| Web UI shows "account connected" but server can't read mail | Confirm the provider's OAuth scopes include mail/calendar/contacts; see the provider docs |
| MCP client gets "Already connected to a transport" | Each HTTP session must use its own `Mcp-Session-Id`; ensure your client persists it |
| `GET /mcp` not streaming | Streamable HTTP requires the `Accept: application/json, text/event-stream` header |