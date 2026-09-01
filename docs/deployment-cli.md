# Local / CLI Deployment

Run mcp-ecc directly on a machine with Node.js. This is the simplest mode and the one used when connecting an MCP agent host (Claude, Cursor, etc.) to a **stdio** server.

For the full command reference, see **[CLI Reference](cli.md)**.

## Prerequisites

- **Node.js** 24 or newer
- **npm** (bundled with Node.js)

## 1. Install from npm

The CLI is published as the npm package **`mcp-ecc`** and ships with compiled `dist/` — no clone or build needed:

```bash
npm install -g mcp-ecc
```

Verify:

```bash
mcp-ecc --help
```

## 2. Configure environment (optional)

Create a `.env` file **in the directory where you run mcp-ecc**. The only variable strictly required for encrypted credential storage is the encryption key. If it is omitted, credentials are stored with a default key (not recommended).

```dotenv
# Required — used to encrypt stored credentials (AES)
MCP_ENCRYPTION_KEY=your-long-random-secret

# Optional — override the SQLite database location
# MCP_STORAGE_FILE=/absolute/path/to/mcp-ecc.db
```

OAuth client credentials are **not** environment variables — they are entered interactively during `mcp-ecc add account` and stored per-user in the database.

## 3. Run the CLI

**Running `mcp-ecc` with no arguments opens the interactive TUI** — commands are typed without the `mcp-ecc` prefix:

```text
mcp-ecc › login
mcp-ecc › list accounts
mcp-ecc › exit
```

### CLI commands

| Command | Purpose |
|---------|---------|
| `mcp-ecc login` | Log in, or bootstrap the first admin account on first run |
| `mcp-ecc logout` | End the current session |
| `mcp-ecc status` | Show current login session status |
| `mcp-ecc password` | Update password for currently logged-in user |
| `mcp-ecc add account` | Add a new provider account (Google, Microsoft, Zoho, IMAP/SMTP, CalDAV, CardDAV) |
| `mcp-ecc add user` | Add a new user account (Admin only) |
| `mcp-ecc list accounts` | List configured accounts and their status |
| `mcp-ecc edit account` | Edit an account's name, slug, email or status |
| `mcp-ecc reauthenticate [slug]` | Re-authenticate a Google / Microsoft / Zoho account |
| `mcp-ecc remove account` | Remove a configured account |
| `mcp-ecc start` | Start the MCP server on **stdio** (default transport for agent hosts) |

## 4. Connect an MCP agent host

Point your agent host's MCP config at the `mcp-ecc start` command. For Claude Code / Cursor, add to your MCP config:

```json
{
  "mcpServers": {
    "mcp-ecc": {
      "command": "mcp-ecc",
      "args": ["start"],
      "env": {
        "MCP_ENCRYPTION_KEY": "your-long-random-secret"
      }
    }
  }
}
```

If `mcp-ecc` is not on the agent host's PATH, use the full path (from `which mcp-ecc`), e.g. `"command": "/usr/local/bin/mcp-ecc"`.

The server speaks the Model Context Protocol over stdio: it reads JSON-RPC requests on stdin and writes responses on stdout. When the host launches `mcp-ecc start`, it can then call the `mail.*`, `calendar.*`, `contacts.*` and `accounts.*` tools.

## Storage note

The CLI uses **SQLite storage** by default. The database is created at `data/mcp-ecc.db` (relative to the working directory; override with `MCP_STORAGE_FILE`) on first run, and all accounts, OAuth clients and users persist across restarts. Credentials (tokens, app passwords) are stored encrypted inside the database using `MCP_ENCRYPTION_KEY`.

## Adding accounts

`mcp-ecc add account` runs an interactive wizard:

1. Enter the account name, slug and email
2. Choose a provider (Google = 1, Microsoft = 2, Zoho = 3, IMAP/SMTP = 4, CalDAV = 5, CardDAV = 6)
3. For OAuth providers: pick a saved OAuth client or enter a new Client ID (and secret when required)
4. Follow the on-screen flow — **Google** opens the loopback authorization-code flow, **Microsoft** and **Zoho** use the device flow

See the individual provider docs for the exact scopes and client setup each provider requires.

## Developing from source

For contributors — clone, install, build, then run the local binary:

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
npm run build

node packages/cli/dist/bin.js --help
# or link it globally to use `mcp-ecc` from anywhere:
npm link
```