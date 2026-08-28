# Docker Deployment

Run mcp-ecc as one or more containers. This is the recommended self-hosted mode: it provides persistent storage (SQLite on a volume), all providers work (including IMAP/SMTP, CalDAV, CardDAV), and the **Management API + embedded web UI** gives a browser-based way to add accounts and run the server over HTTP.

## Prerequisites

- **Docker** (with Docker Compose v2)
- A writable `./data` directory on the host (persisted credentials)

## Two entry points

The project ships two containers:

| Container | Image source | Purpose |
|-----------|--------------|---------|
| `mcp-ecc` | `Dockerfile` | The **MCP CLI/server** (stdio default, can also run HTTP) |
| `mcp-ecc-api` | `Dockerfile.api` | The **Management API** (Fastify REST + WebSocket + embedded admin UI, serves on port 3001) |

### Ports

- **3000** — MCP server (SSE/HTTP endpoint for `mcp-ecc` container)
- **3001** — Management API + web UI (`mcp-ecc-api` container)

## 1. Configure environment

Create a `.env` file in the repository root. `docker-compose.yml` reads these variables:

```dotenv
# Required — used to encrypt stored credentials
MCP_ENCRYPTION_KEY=your-long-random-secret

# OAuth client credentials (only for providers you use)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
```

## 2. Build and start

```bash
# Build both images
docker compose build

# Start in the background
docker compose up -d

# Watch logs
docker compose logs -f
```

Both containers share a mounted volume at `./data`, so accounts configured in one are visible to the other.

## 3. Using the Management API + Web UI

Once running:

- Open **http://localhost:3001** (or the host IP/port) to reach the web UI
- **Add an account** → select a provider → complete OAuth in the browser; the server stores the tokens (encrypted) and shows status

The Management API also exposes REST endpoints:

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
| `WS` | `/ws` | Real-time sync status updates |

## 4. Running the MCP server alone (HTTP/SSE)

If you only need the MCP server exposed over HTTP (e.g. for a remote agent host), launch the `mcp-ecc` container with the SSE entrypoint:

```bash
# Run the MCP server container on SSE
docker run -d --name mcp-ecc \
  -p 3000:3000 \
  -v $(pwd)/data:/data \
  -e MCP_ENCRYPTION_KEY=your-long-random-secret \
  mcp-ecc start --sse --port 3000
```

You can also change the `command` in `docker-compose.yml`:

```yaml
services:
  mcp-ecc:
    command: ["start", "--sse", "--port", "3000"]
```

## 5. Point an agent host at the HTTP endpoint

Some MCP hosts support HTTP/SSE transports. Configure the server URL as `http://<host>:3000/sse` (SSE) and POST messages to `/messages`. Most desktop agent hosts prefer **stdio** — in that case attach the CLI container's stdio as described in the [CLI docs](deployment-cli.md).

## Storage

- Credentials and account config are stored in `./data/mcp-ecc.db` (SQLite), encrypted with AES-256-GCM using `MCP_ENCRYPTION_KEY`.
- Back up the `./data` directory; without the encryption key the database cannot be decrypted by anyone else.

## Security notes

- **Never** commit the `.env` file (it is gitignored).
- Put the Management API behind TLS (reverse proxy / HTTPS) when exposed beyond localhost.
- Restrict access to ports 3000/3001 if the host is internet-facing.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `better-sqlite3` fails to build during `docker build` | Install `python3`, `make`, `g++` in the builder stage (the provided `Dockerfile` already does this) |
| Web UI shows "account connected" but server can't read mail | Confirm the provider's OAuth scopes include mail/calendar/contacts; see the provider docs |
| Accounts not shared between containers | Ensure both mount the same `./data` volume and run on the same host |