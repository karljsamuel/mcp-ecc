# Local Clone / CLI Deployment

Run mcp-ecc directly on a machine with Node.js. This is the simplest mode and the one used when connecting an MCP agent host (Claude, Cursor, etc.) to a **stdio** server.

## Prerequisites

- **Node.js** 20 or newer
- **npm** (bundled with Node.js)

## 1. Clone & install

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
```

## 2. Build

The monorepo uses Turbo. Build all packages with:

```bash
npm run build
# or run turbo directly for a single package
npx turbo run build --filter=@mcp-ecc/cli
```

This compiles TypeScript to `dist/` in each package.

## 3. Configure environment (optional)

Create a `.env` file in the repository root. The only variable strictly required for encrypted credential storage is the encryption key. If it is omitted, credentials are stored in plaintext (not recommended).

```dotenv
# Required — used to encrypt stored credentials (AES-256-GCM)
MCP_ENCRYPTION_KEY=your-long-random-secret

# OAuth client credentials (required only for the providers you use)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...

# Base URL used for OAuth redirects (only needed for auth-code flow via the web UI)
BASE_URL=http://localhost:3001
```

## 4. Run the CLI

The CLI binary is `mcp-ecc` (defined in `packages/cli/bin`). Because of the workspace layout, run it with `node` from the root, or link it globally:

```bash
# Option A: run via node from the repo
node packages/cli/dist/bin.js --help

# Option B: link globally once
npm link
mcp-ecc --help
```

### CLI commands

| Command | Purpose |
|---------|---------|
| `mcp-ecc start` | Start the MCP server on **stdio** (default transport for agent hosts) |
| `mcp-ecc auth` | Interactively add + authenticate an account |
| `mcp-ecc list-accounts` | List all configured accounts |
| `mcp-ecc edit-account <id>` | Edit an account's configuration |
| `mcp-ecc reauth <id>` | Re-authenticate a Google / Microsoft / Zoho account |
| `mcp-ecc delete-account <id>` | Remove an account |

## 5. Connect an MCP agent host

Point your agent host's MCP config at the `mcp-ecc start` command. For Claude Code / Cursor, add to your MCP config:

```json
{
  "mcpServers": {
    "mcp-ecc": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ecc/packages/cli/dist/bin.js", "start"],
      "env": {
        "MCP_ENCRYPTION_KEY": "your-long-random-secret"
      }
    }
  }
}
```

The server speaks the Model Context Protocol over stdio: it reads JSON-RPC requests on stdin and writes responses on stdout. When the host launches `mcp-ecc start`, it can then call the `mail.*`, `calendar.*`, `contacts.*` and `accounts.*` tools.

## Storage note

The CLI currently defaults to **in-memory storage**, so accounts/tokens are lost when the process exits. For persistent single-user storage, use the **Docker** mode (SQLite) or swap the CLI's `MemoryStorage` for `SQLiteStorage`.

## Adding accounts

`mcp-ecc auth` runs an interactive wizard:

1. Enter the account email / identifier
2. Choose a provider (Google = 1, Microsoft = 2, Zoho = 3, IMAP/SMTP = 4, CalDAV = 5, CardDAV = 6)
3. For OAuth providers: enter the Client ID (and secret when required)
4. Follow the on-screen device-code or browser flow

For OAuth providers, the CLI uses the **device authorization grant**: it prints a URL and code, you authorise in a browser, and the server polls for the token in the background.

See the individual provider docs for the exact scopes and client setup each provider requires.