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

## Global Directory & Storage Path
When installed globally (`npm install -g mcp-ecc`) and run, the CLI automatically saves configurations, encryption keys, and the database in the standard user config path for your operating system:
* **Linux:** `~/.config/mcp-ecc/` (respects `$XDG_CONFIG_HOME`)
* **macOS:** `~/Library/Application Support/mcp-ecc/`
* **Windows:** `%APPDATA%\mcp-ecc\`

Inside this directory, it creates `config.json` and `data/mcp-ecc.db` so everything survives upgrades and packages update.

## 5. Storage Options: Local SQLite vs Cloudflare D1
By default, `mcp-ecc` uses a local SQLite file. However, you can configure it to use Cloudflare D1 as a centralized, hosted database instead.

### Local SQLite Config (Default)
To configure local SQLite, specify the database file path:
```dotenv
MCP_DB_PROVIDER=sqlite
MCP_STORAGE_FILE=/absolute/path/to/mcp-ecc.db
```

### Centralized Cloudflare D1 Config
To run central D1 database backend, configure your `.env` as:
```dotenv
MCP_DB_PROVIDER=d1
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
CLOUDFLARE_DATABASE_ID=your-cloudflare-d1-database-id
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
```

#### Step 1: Create a Cloudflare D1 Database
You can create a D1 database via the Cloudflare Dashboard or using the wrangler CLI:

##### Option A: Cloudflare Dashboard
1. Go to the **Cloudflare Dashboard** and select your account.
2. Navigate to **Workers & Pages** > **D1**.
3. Click **Create Database** > **Create with Dashboard**.
4. Enter a name (e.g., `mcp-ecc-db`) and click **Create**.
5. Copy the **Database ID** and your **Account ID** from the page.

##### Option B: Wrangler CLI
If you have wrangler installed globally:
```bash
# Log in to Cloudflare
npx wrangler login

# Create the database
npx wrangler d1 create mcp-ecc-db
```
Wrangler will output:
```text
✅ Successfully created database 'mcp-ecc-db'
- database_id = 'xxxx-xxxx-xxxx-xxxx'
```

#### Step 2: Create a Cloudflare API Token
1. Go to **My Profile** > **API Tokens** > **Create Token**.
2. Select **Create Custom Token**.
3. Set the following permissions:
   * **Account** > **D1** > **Edit**
4. Click **Continue to summary** and click **Create Token**.
5. Copy your API Token.

#### Step 3: Run database migrations on D1
To set up database tables, `mcp-ecc` automatically initializes them upon first boot. You do not need manual schemas!

## 6. Adding accounts

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