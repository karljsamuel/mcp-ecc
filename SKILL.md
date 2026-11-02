---
name: mcp-ecc
description: Operate an mcp-ecc server end to end — deploy (Docker/npm/source), first-run setup, users and per-user MCP keys, provider accounts and OAuth clients, and all 26 mail/calendar/contacts/accounts MCP tools. Use when setting up, configuring, administering, connecting a client to, or calling tools on mcp-ecc (email, calendar and contacts aggregation for Google, Microsoft 365/Outlook, Zoho, IMAP/SMTP, CalDAV, CardDAV).
---

# mcp-ecc — operating runbook

mcp-ecc is a **multi-user** MCP server that aggregates **email, calendar and contacts** from
Google, Microsoft 365/Outlook, Zoho, IMAP/SMTP, CalDAV and CardDAV behind one MCP endpoint.
It ships as a single Node service that serves four things on one port: the **web UI**, the
**REST/OAuth API**, the **MCP endpoint** (`/mcp`), and a **CLI**.

Every user manages only their own accounts and holds their own MCP API key. Credentials are
encrypted at rest and never leave the server.

**This file is the operating contract.** Anything you can do to or with an mcp-ecc server
should be findable here. See [Keeping this file current](#keeping-this-file-current) — a test
enforces that the tool and CLI surfaces below match the code.

---

## 1. Provider capability matrix

| Provider | Mail | Calendar | Contacts | Auth |
|---|---|---|---|---|
| Google | ✅ | ✅ | ✅ | OAuth client (browser flow only) |
| Microsoft (Graph) | ✅ | ✅ | ✅ | OAuth client (device code preferred) |
| Zoho | ✅ | ✅ | ✅ | OAuth client (region-dependent) |
| IMAP / SMTP | ✅ | ❌ | ❌ | Stored app password |
| CalDAV | ❌ | ✅ | ❌ | Stored app password |
| CardDAV | ❌ | ❌ | ✅ | Stored app password |

- **Microsoft 365 is OAuth-only.** App passwords / SMTP basic auth are retired or retiring
  during 2026 — never suggest app-password IMAP for an organisational M365 account.
- **CalDAV/CardDAV** are standard WebDAV (RFC 4791 / RFC 6352) with Basic auth, tested against
  Radicale 3.7.8; any compliant server (Nextcloud, Baikal, DAViCal) works. OAuth-only DAV
  providers are not supported.
- **No Cloudflare Workers target.** It was removed in August 2026 — IMAP/SMTP/DAV need raw TCP
  and long-lived connections. Deployment is Docker, npm, or a source checkout on Node.
- **Node.js >= 26** is required (`engines.node` in the root `package.json`).

---

## 2. Deploy

### Docker (recommended — web UI + REST + MCP on one port)

```bash
docker run -d --name mcp-ecc \
  --env-file ./mcp-ecc.env \
  -p 127.0.0.1:3001:3001 \
  -v ./data:/data \
  karljsamuel/mcp-ecc:latest
```

- Published to **Docker Hub** (`karljsamuel/mcp-ecc`) and **GHCR**
  (`ghcr.io/karljsamuel/mcp-ecc`); `:latest` plus semver tags per release.
- **Bind the host side to `127.0.0.1`.** The container listens on `0.0.0.0` internally, so the
  loopback bind is what keeps it off the LAN; put a tunnel or reverse proxy in front.
- **The container runs as uid/gid `1001`.** A bind-mounted data directory must be owned by it:
  `sudo chown -R 1001:1001 ./data`. A *named volume* is seeded with that ownership
  automatically. Symptoms of getting it wrong: `EACCES` on `/data`, restart loop, 502 at the proxy.
- **The CLI is on `PATH` inside the image** (`mcp-ecc` → `/app/packages/cli/dist/bin.js`), e.g.
  `docker exec -it mcp-ecc mcp-ecc --help`.

### npm / source (stdio, for a local agent host)

```bash
npm install -g mcp-ecc          # or: git clone … && npm install && npm run build
mcp-ecc start                   # stdio MCP server
```

Twelve public packages publish as `@mcp-ecc/*` plus the `mcp-ecc` CLI; the admin UI is bundled
into the image and is not published separately.

### CLI reference

The same service is drivable without the web UI. `mcp-ecc` works locally (stdio) and inside the
container.

| Command | Purpose |
|---|---|
| `mcp-ecc setup` | First-run wizard: choose the database, verify it, write `.env` |
| `mcp-ecc login` | Log into a user account — or bootstrap the first admin when none exists |
| `mcp-ecc logout` | End the current CLI session |
| `mcp-ecc status` | Show the current login session status |
| `mcp-ecc password` | Update the logged-in user's password |
| `mcp-ecc add account` | Add a provider account (Google, Microsoft, Zoho, IMAP/SMTP, CalDAV, CardDAV) |
| `mcp-ecc add user` | Add a user account (admin only) |
| `mcp-ecc add oauth-client` | Add an OAuth client credentials config |
| `mcp-ecc edit account` / `edit …` | Edit an existing resource |
| `mcp-ecc remove account` / `remove …` | Remove a resource |
| `mcp-ecc list accounts` / `list …` | List resources |
| `mcp-ecc reauthenticate [slug]` | Re-run the OAuth flow for an account after failure or expiry |
| `mcp-ecc start` | Start the stdio MCP server |
| `mcp-ecc --help` | Command help; `mcp-ecc <command> --help` for detail |

The resource verbs are `account` (alias `accounts`), `user`, and `oauth-client` (alias
`oauth-clients`), used with `add`, `edit`, `remove` and `list`. The CLI talks to the database
**in-process** — it does not go through the REST API — so it needs the same `.env`
(`MCP_ENCRYPTION_KEY`, DB settings) as the server.

---

## 3. Configuration

Settings live in `.env` (or the environment). Never put a non-credential setting in `.env`.

| Key | Purpose |
|---|---|
| `MCP_ENCRYPTION_KEY` | **Required.** Master key for credential encryption. No fallback. |
| `MCP_DB_PROVIDER` | `sqlite` (default) or `d1` |
| `MCP_STORAGE_FILE` | SQLite path, e.g. `/data/mcp-ecc.db` |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_DATABASE_ID` / `CLOUDFLARE_API_TOKEN` | Required for `d1` |
| `PORT` / `HOST` | Listener inside the process/container (default `3001` / `0.0.0.0`) |
| `HOST_PORT` | Compose-side published port only |
| `PUBLIC_URL` | External base URL — must be the tunnel domain, not localhost |
| `SESSION_SECRET` | Signs session cookies. **Independent of the master key.** |

**Encryption key rules** — these are load-bearing:

- A missing, empty or **placeholder** key is a **hard startup error**. Well-known placeholders
  (`default-secret-key`, `change-me`, `change-me-to-a-long-random-secret`, `your-secret-here`,
  `replace-me`) are refused.
- There is **no fallback key**, and the key is never read from or written to the database.
- Generate one: `openssl rand -hex 32`.
- Losing the key (or the database) makes stored credentials unreadable — every account must be
  re-authenticated. Rotating via `MCP_ENCRYPTION_KEY_PREVIOUS` keeps old rows readable during a
  rotation window.

Environment variables are captured **at container creation**: after editing `.env` or rotating
a credential, recreate the container (`docker compose up -d --force-recreate`).

---

## 4. First-run setup

A server with no usable configuration starts in **setup mode**: it binds the setup UI, serves
`/setup`, and answers **`503`** on `/api/*` and `/mcp`. That is not an outage — it means the
`.env` is missing or incomplete. `GET /health` still returns `200`.

Complete it either way:

- **CLI:** `mcp-ecc setup` — interactive; writes the `.env`, **verifies the database connection
  before** creating the first admin, and offers to generate an encryption key.
- **Web UI:** open `/setup`. The page is protected by a **one-time token printed to the server
  console** (`docker logs mcp-ecc | grep 'Setup token'`) and, by default, a loopback bind.

Order matters: DB provider → DB-specific config → **verify the connection** → encryption key →
remaining settings → first admin account.

Bootstrap the first admin without the wizard (only while no users exist):

```http
POST /api/auth/bootstrap
{ "username": "admin", "password": "…", "displayName": "Site Admin" }
```

---

## 5. Accounts, identity and auth

**Account identity.** Each account has a `name` (free text), a `slug` (`[a-z0-9-_]`, unique per
owner, the **stable key** used by tools and resources), an `email`, and an optional
`displayName` that becomes the **sender name on outbound mail**. The internal account id is a
UUID and is never a mailbox login or a `From` address.

**Two credential styles.**

- *OAuth providers* reference a **per-user OAuth client** created in the provider's console
  (Google Cloud Console / Azure App registrations / Zoho API Console) and registered via
  `POST /api/oauth-clients`. The client secret is encrypted at rest.
- *Password providers* (IMAP/SMTP/CalDAV/CardDAV) store an app password on the account. It is
  accepted on create and update, **never returned in any response**, and a blank value on
  update means "keep the stored one".

**Flow selection** is automatic per provider:

| Provider | Flow |
|---|---|
| Google | Browser authorisation-code only (Google rejects Gmail scopes for the device flow) |
| Microsoft | **Device code first**, browser flow only if the app registration is not enabled for public client flows |
| Zoho | Follows the client's platform |

A device flow returns `flowType`, `userCode`, `verificationUri`, `deviceCode` and a `state`.
The device code **is** returned deliberately so a Microsoft client can complete authentication
itself; treat it as short-lived and single-authorisation. The browser UI instead polls
`POST /api/oauth/device/poll { state }` → `pending` / `complete` / `expired` / `error`
(`retryable: true` for a dropped request); on completion the server exchanges the token exactly
as `/oauth/callback` does, and the state is single-use.

**Roles.** `admin` can create/delete users and reset passwords (`/api/users`); every user owns
their own accounts and OAuth clients. There is no self-registration.

**Connecting an MCP client:**

```
URL:           http(s)://<host>/mcp
transport:     streamable-http
Authorization: Bearer <that user's MCP API key>
```

The key comes from **Settings** in the web UI (`GET /api/settings/me`), and
`POST /api/settings/me/rotate-apikey` replaces it. One key per user, scoped to that user's
accounts — never share keys between people or agents. `/mcp` needs a Cloudflare Access **bypass**
when the host sits behind Access.

---

## 6. MCP tool reference — all 26

Tools are namespaced `accounts.*`, `mail.*`, `calendar.*`, `contacts.*`. Results are structured;
failures return `isError: true` with an explanatory message.

### accounts.* (5) — every provider

| Tool | Input | Notes |
|---|---|---|
| `accounts.list` | `{}` | `{ id, provider, email, status }` per account |
| `accounts.get` | `{ accountId }` | Account object without secrets |
| `accounts.add` | `{ provider, email }` | Starts an OAuth flow; the CLI/web UI completes it |
| `accounts.remove` | `{ accountId }` | Deletes the account and its credentials |
| `accounts.sync` | `{ accountId, types[] }` | Triggers a sync; folder counts written here may be `-1` (see §7) |

### mail.* (8) — Google, Microsoft, Zoho, IMAP/SMTP

| Tool | Input | Notes |
|---|---|---|
| `mail.listFolders` | `{ accountId, folderId?, withUnreadCounts? }` | Exact per-folder counts; see §7 |
| `mail.listMessages` | `{ accountId, folderId, limit?, cursor?, query? }` | `query` accepts provider syntax incl. `is:unread` |
| `mail.getMessage` | `{ accountId, messageId }` | Full body, HTML, headers, attachment metadata |
| `mail.sendMessage` | `{ accountId, to[], subject, body, cc?, bcc?, htmlBody?, inReplyTo? }` | Sender is `displayName <email>`; fails loudly if no address resolves |
| `mail.searchMessages` | `{ accountId, query, limit?, cursor? }` | |
| `mail.moveMessage` | `{ accountId, messageId, folderId }` | |
| `mail.setFlags` | `{ accountId, messageId, addFlags[], removeFlags[] }` | `\Seen`, `\Flagged`, `\Deleted` (provider-mapped) |
| `mail.deleteMessage` | `{ accountId, messageId, permanent? }` | `permanent:false` → trash, `true` → hard delete |

### calendar.* (7) — Google, Microsoft, Zoho, CalDAV

| Tool | Input |
|---|---|
| `calendar.listCalendars` | `{ accountId }` |
| `calendar.listEvents` | `{ accountId, calendarId, timeMin, timeMax, limit?, cursor? }` — **epoch ms** |
| `calendar.getEvent` | `{ accountId, calendarId, eventId }` |
| `calendar.createEvent` | `{ accountId, calendarId, summary, startAt, endAt, description?, location?, attendees[]?, allDay?, recurrenceRule? }` |
| `calendar.updateEvent` | `{ accountId, calendarId, eventId, …patchable fields }` |
| `calendar.deleteEvent` | `{ accountId, calendarId, eventId }` |
| `calendar.freeBusy` | `{ accountId, calendarIds[], timeMin, timeMax }` |

### contacts.* (6) — Google, Microsoft, Zoho, CardDAV

| Tool | Input |
|---|---|
| `contacts.list` | `{ accountId, limit?, cursor? }` |
| `contacts.get` | `{ accountId, contactId }` |
| `contacts.create` | `{ accountId, displayName, emails[]?, phones[]?, organization?, jobTitle?, notes? }` |
| `contacts.update` | `{ accountId, contactId, …patchable fields }` |
| `contacts.delete` | `{ accountId, contactId }` |
| `contacts.search` | `{ accountId, query, limit?, cursor? }` |

### Resources and prompts

- `mcp-ecc://{accountId}/today-agenda` — markdown: today's events + recent unread mail.
- `mcp-ecc://{accountId}/mail/folders` — exact per-folder unread counts as JSON.
- Prompts: `daily_briefing`, `weekly_review`.

---

## 7. Unread counts — read this before trusting a number

- `0` means **the provider checked and the folder is empty**.
- `-1` means **not determined** — never "empty".
- `unreadCountError` explains a failed or impossible measurement, distinguishing it from
  "counts were not requested".

`withUnreadCounts: false` is the cheap name-only path: on Microsoft the count still comes free
from Graph; everywhere else, including Gmail, it is `-1`. `folderId` narrows to one folder.

| Provider | Exact count source | Cost |
|---|---|---|
| Google | `labels.list` to enumerate, then `labels.get` **per folder** — `labels.list` never carries counts | 1 + one per folder (5 in flight) |
| Microsoft | Graph `mailFolder.unreadItemCount` / `totalItemCount` | 1 per 100 folders |
| Zoho | pages the folder's messages, counting unread | ≤10 pages/folder, 4 parallel, 20s budget |
| IMAP/SMTP | `LIST` with `statusQuery`, else one `STATUS` per folder | 1 round-trip, or 5-way pool under 20s |

`mail.listMessages` reports `total` **only when the provider can state a real count**. It is
**absent for Google**: Gmail's `resultSizeEstimate` returns the same round number for mailboxes of
very different sizes, so it is not a count. Use `mail.listFolders` for exact Google totals.

`accounts.sync` writes folders with `withUnreadCounts: false`, so rows written during a sync may
carry `-1`.

---

## 8. Common operations

| Goal | Do this |
|---|---|
| List everything an agent can reach | `accounts.list`, then `mail.listFolders` per mail account |
| Unread across accounts | `mail.listFolders` (default) → sum `unreadCount`; treat `-1` as unknown, not zero |
| Read the newest mail | `mail.listMessages` with `folderId: INBOX`, `limit: 1` |
| Find unread | `mail.listMessages` with `query: "is:unread"` |
| Send mail | `mail.sendMessage` — set the account's `displayName` first if the From name matters |
| Add a Google account | Create an OAuth client → `POST /api/oauth-clients` → `POST /api/accounts` → browser flow |
| Add a Microsoft account | Same, but expect device code; the panel shows the code and polls |
| Add an IMAP account | `POST /api/accounts` with `appPassword` + `imapHost/Port/Tls`, `smtpHost/Port/Secure`, optional `username` |
| Verify an account | `POST /api/accounts/:id/test-connection` |
| Fix an expired token | `POST /api/accounts/:id/reauth` |
| Rotate an MCP key | `POST /api/settings/me/rotate-apikey` |
| Add a user | `POST /api/users` as an admin |

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/health` 200 but `/mcp`, `/api/*` 503 | Setup mode — incomplete `.env` | Finish setup (§4); check the `.env` is beside the compose file |
| `docker logs` shows D1 `401 Authentication error` | Missing/blank Cloudflare credentials | Set all three `CLOUDFLARE_*` values and recreate |
| `EACCES` on `/data`, restart loop, 502 at the proxy | Bind mount not owned by uid 1001 | `sudo chown -R 1001:1001 ./data` |
| `/mcp` returns 401 with a valid-looking key | Key belongs to a different user, or was rotated | Copy the current key from Settings |
| Every folder reports `-1` | Counts not requested, or the lookup failed | Read `unreadCountError`; call with `folderId` for one folder |
| `Account not found: <id>` on a tool that just listed it | The bearer key's user does not own that account | Use the owning user's key |
| Tool call fails with `Mail not supported for this account` | Provider has no mail (CalDAV/CardDAV-only) | Use the matching tool family |
| An account stops working after a key/DB change | Credentials can no longer be decrypted | Re-authenticate the account |
| Settings change had no effect in Docker | Env captured at container creation | Recreate the container |

---

## 10. Keeping this file current

**Rule: any change to the runtime surface updates this file in the same PR.** That means:

- a new, renamed or removed **MCP tool** → update §6 (and `docs/mcp-tools.md`);
- a new or renamed **CLI command** → update §2/§8;
- a change to **providers, flows, config keys or limits** → update §1, §3, §5, §7;
- a new deployment mode or image behaviour → update §2 when the Dockerfile/runtime changes.

`tests/skill-doc-coverage.test.cjs` enforces the mechanical half: it extracts every tool name
from `packages/mcp-server/src/index.ts` and every top-level CLI command from
`packages/cli/src/bin.ts`, and **fails the build** if one is missing from this file. Adding a
tool without documenting it breaks CI, so the invariant does not rely on memory.

Full prose detail lives in `docs/` (`mcp-tools.md`, `providers-*.md`, `deployment-docker.md`,
`deployment-cli.md`, `auth-users.md`, `accounts-identity.md`) and `llms.txt`.
