# mcp-ecc CLI Reference

The `mcp-ecc` command-line interface manages users, provider accounts and OAuth credentials from the terminal. It mirrors the operations available in the web admin UI.

Requires **Node.js 24+**.

## Installing

The CLI is distributed as the npm package **`mcp-ecc`**. Install it globally:

```bash
npm install -g mcp-ecc
```

This puts the `mcp-ecc` binary on your PATH. No build step, no clone required — `dist/` ships in the published package.

```bash
mcp-ecc --help
mcp-ecc          # opens the interactive TUI
```

### Upgrading

```bash
npm update -g mcp-ecc
```

### Local development (from source)

Only needed when working on the code itself — clone, install, build, then run the local binary:

```bash
git clone https://github.com/karljsamuel/mcp-ecc.git
cd mcp-ecc
npm install
npm run build
node packages/cli/dist/bin.js --help

# or link it globally to use the `mcp-ecc` command from anywhere
npm link
```

## Interactive TUI

**No arguments opens the interactive TUI** — the ASCII-art banner plus a prompt where you type commands *without* the `mcp-ecc` prefix:

```text
mcp-ecc › login
mcp-ecc › list accounts
mcp-ecc › exit
```

`help` lists commands inside the TUI; `exit`, `quit` or `q` leaves it.

## Command reference

| Command | Purpose |
|---------|---------|
| `mcp-ecc login` | Log in, or bootstrap the first admin account on first run |
| `mcp-ecc logout` | End the current session |
| `mcp-ecc status` | Show login status, username, display name and role |
| `mcp-ecc password` | Change the current user's password |
| `mcp-ecc add account` | Add a provider account (Google, Microsoft, Zoho, IMAP/SMTP, CalDAV, CardDAV) |
| `mcp-ecc add user` | Create a user account (admin only) |
| `mcp-ecc list accounts` | List the current user's accounts and their status |
| `mcp-ecc edit account` | Edit an account's name, slug, email or status |
| `mcp-ecc reauthenticate [slug]` | Re-run OAuth for a failed/expired OAuth account |
| `mcp-ecc remove account` | Delete a configured account |
| `mcp-ecc start` | Start the MCP server over stdio for an agent host |

## First run: create the admin account

If no user exists, `mcp-ecc login` — and any command that needs a session — prompts you to create the first admin account:

```text
=== Create First Admin Account ===
Username: jane
Display name: Jane Doe
Password: ********
Confirm Password: ********

✔ Admin account successfully created and logged in: Jane Doe (@jane)
```

## Sessions

A session is a local file (`data/cli-session.json` next to the database). `login` writes it, `logout` removes it.

- `status` shows whether you are logged in.
- Commands that require a session (`add account`, `list accounts`, etc.) prompt you to log in if no session exists.
- If no user accounts exist at all, they route you through first-admin bootstrap instead.

## Managing users

### Add a user (admin only)

```text
mcp-ecc add user
=== Create User Account ===
Username: jane
Display name: Jane Doe
Password: ********
Confirm Password: ********

Select Role:
1. Admin
2. Standard User
Choose option [2]:
✔ User account successfully created: Jane Doe (@jane) [user]
```

### Change password

```text
mcp-ecc password
Current password:
New password:
Confirm new password:
✔ Password updated successfully.
```

## Managing accounts

### Add an account

```text
mcp-ecc add account
=== Add Account ===
Account name (e.g. Work Gmail): Personal Gmail
Account slug (e.g. work-gmail): kjs-gmail
Email: user@example.com

Select Provider:
1. Google (Gmail, Calendar, Contacts)
2. Microsoft (Outlook, Calendars, Contacts)
3. Zoho Mail, Calendar, Contacts
4. IMAP / SMTP (Traditional)
5. CalDAV (Calendar only)
6. CardDAV (Contacts only)
Choose option (1-6): 1
```

**OAuth providers (1–3).** If you have already saved an OAuth client for that provider, you can pick it or create a new one:

```text
Select OAuth Client:
  1. Hermes Desktop (1234567890-xxxx.apps.googleusercontent.com)
  2. Create a new client
Choose option (1-2): 1
```

If you create a new client you are prompted for its label, Client ID and Client Secret, plus:

- **Microsoft:** whether it is an M365 organisation account, and the Tenant ID if so
- **Zoho:** the region (`us` / `eu` / `in` / `cn` / `jp` / `au`)

The authentication flow then runs automatically:

| Provider | Flow |
|----------|------|
| **Google** | Authorization-code loopback flow. Registers `http://127.0.0.1:<port>/oauth/callback`, opens the consent URL in the browser and waits for the redirect. Register the printed redirect URI in the Google Cloud Console (Desktop app client). |
| **Microsoft** | Device flow. Prints a URL + code to enter at `microsoft.com/link`. |
| **Zoho** | Device flow (Non-browser application client). Prints a URL + code via Zoho's v3 device endpoint. |

> **CalDAV/CardDAV:** standard WebDAV with Basic auth (CalDAV RFC 4791, CardDAV RFC 6352). **Tested against Radicale 3.7.8.** Should work with any standards-compliant server; OAuth-only providers are not supported. Enter the **server base URL** (e.g. `https://calendar.example.com/`), not a deep calendar path.

On success the account is saved as `active` with tokens encrypted at rest.

**Password providers (4–6).** You are prompted for an app password and the connection details:

- **IMAP/SMTP:** IMAP host/port and SMTP host/port (Gmail defaults pre-filled)
- **CalDAV:** CalDAV URL
- **CardDAV:** CardDAV URL

### List accounts

```text
mcp-ecc list accounts
=== Configure Accounts ===
  1. [google] Personal Gmail (user@example.com) - Status: active
  2. [microsoft] Work (work@example.com) - Status: error
```

### Edit an account

```text
mcp-ecc edit account
=== Edit Account ===
  1. [google] Personal Gmail (user@example.com)
  2. [microsoft] Work (work@example.com)
Select account to edit (1-2): 1
Name [Personal Gmail]:
Slug [kjs-gmail]:
Email [user@example.com]:

Select Status:
1. active
2. error
3. disabled
Current [active], choose (1-3) or leave blank:
✔ Account details updated successfully.
```

For **password-based providers** (IMAP/SMTP, CalDAV, CardDAV) you can also update the stored app password from the same flow:

```text
mcp-ecc edit account
Select account to edit (1-N): 1
Name [Work IMAP]:
Slug [kjs-algyris]:
Email [imap@example.com]:

Update App Password? (y/N): y
New App Password: ********
Confirm App Password: ********
✔ App password updated successfully.
```

Leave a field blank to keep its current value. `health` is **not** editable — it reflects live connection state. Status `error` typically means the token expired or was revoked.

### Re-authenticate

For OAuth accounts whose status is `error` (token expired/revoked) or that need new consent:

```text
mcp-ecc reauthenticate kjs-gmail
```

Without a slug, it lists accounts to pick from. Re-runs the same OAuth flow as `add account`, stores fresh tokens and resets status to `active`. Only Google, Microsoft and Zoho accounts can be re-authenticated.

### Remove an account

```text
mcp-ecc remove account
=== Remove Account ===
  1. [google] Personal Gmail (user@example.com)
Select account to remove (1-1): 1
✔ Account 'Personal Gmail' has been successfully deleted.
```

## Starting the MCP server (stdio)

```text
mcp-ecc start
```

Requires a logged-in session. Starts the Model Context Protocol server over stdio, scoped to the logged-in user's accounts. Point an agent host at it:

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

If `mcp-ecc` is not on the agent host's PATH, use the full path — e.g. `command": "/usr/local/bin/mcp-ecc"` (or the path returned by `which mcp-ecc`).

## Storage & environment

- **Database:** SQLite at `data/mcp-ecc.db` (override with `MCP_STORAGE_FILE`). Created automatically on first run.
- **Credentials:** stored inside the database in the `accounts` table's `credentials` column, AES-encrypted with `MCP_ENCRYPTION_KEY`. There is no separate token file.
- **Encryption key:** set `MCP_ENCRYPTION_KEY` in the environment or `.env` at the repository root. If omitted, a default key is used — set it explicitly in production.
- **OAuth clients** (client ID/secret) are stored in the same database, per user.

```dotenv
# .env
MCP_ENCRYPTION_KEY=your-long-random-secret
```

## Exit codes and non-interactive use

The CLI is interactive: commands prompt on stdin. For scripting, pipe input line by line in the order the prompts appear. `Ctrl+C` aborts a password prompt cleanly.
