# Authentication & Users

mcp-ecc is a **multi-user** server. Its access model has two layers:

1. **Application users** — people who sign in to the web UI / REST API and self-manage their own provider accounts.
2. **Per-user MCP API keys** — a static bearer key each user owns, which scopes the `/mcp` endpoint to **that user's accounts only**.

This page covers user administration, the first-run bootstrap, session authentication for the UI/API, and the per-user MCP API key. For how accounts are named and keyed see [Accounts & Identity](accounts-identity.md).

## Roles and ownership

| Role | Can |
|------|-----|
| **Admin** | Create and delete users, set roles, reset passwords. Also has the same abilities as a regular user for their own accounts. |
| **User** | Sign in; self-manage their own email/calendar/contact accounts, OAuth clients and settings. Cannot see or touch other users' accounts. |

- Only the first user (the **admin**) is created automatically at first boot; every further user is created by an admin.
- Every account, OAuth client and API key is owned by exactly one user (`ownerId`). A user only ever sees their own data.
- Accounts and OAuth clients owned by other users are never exposed, and a user's MCP key can only reach that user's accounts.

## First-run admin bootstrap

On a fresh install there are no users and the server must be bootstrapped once to create the admin.

**Web UI:** open the site → you are taken to the **bootstrap** screen → set an admin **username**, **display name** and **password**.

**REST API:**

```http
POST /api/auth/bootstrap
Content-Type: application/json

{ "username": "admin", "password": "a-strong-password", "displayName": "Site Admin" }
```

The bootstrap endpoint is only available while no users exist. After the admin is created it returns the same result as a login (a session).

## Session authentication (web UI / REST API)

Authentication for the web UI and the management REST API is **session-based**:

- `POST /api/auth/login` — body `{ "username", "password" }`; on success the server sets a session cookie.
- `GET /api/auth/me` — returns the current signed-in user `{ "id", "username", "displayName", "role" }`.
- `POST /api/auth/logout` — ends the session.

The web UI marks `401` responses and redirects to the login screen. Nothing secret is stored client-side — the session is cookie-held on the server. (Passwords are hashed with **argon2** at rest.)

## User administration (admin only)

Admin endpoints live under `/api/users`:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/users` | List users |
| `POST` | `/api/users` | Create a user `{ "username", "password", "displayName", "role" }` |
| `PATCH` | `/api/users/:id` | Update `displayName` / `role` |
| `POST` | `/api/users/:id/reset-password` | Reset a user's password `{ "password" }` |
| `DELETE` | `/api/users/:id` | Delete a user (and their accounts / OAuth clients / key) |

`username` is unique and **immutable**. Deleting a user revokes their MCP API key and removes all of their provider accounts.

## Per-user MCP API key

The MCP endpoint **`/mcp`** (Streamable HTTP) is protected per user. Each user has a **static API key** that:

- is used as an **`Authorization: Bearer <key>`** header on MCP requests;
- **scopes `/mcp` to that user's accounts only** — a client connecting with user A's key can only list/invoke tools for user A's accounts, never user B's;
- is stored encrypted and can be rotated at any time.

### View / rotate your key

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/settings/me` | Your settings, including your MCP API key |
| `POST` | `/api/settings/me/rotate-apikey` | Generate a new MCP API key (invalidates the old one) |
| `PATCH` | `/api/settings/me` | Update your `displayName` / change your password |

Rotate the key in **Settings** in the web UI, or via `POST /api/settings/me/rotate-apikey`. Rotating a key immediately invalidates the previous one, so update any MCP client that embeds it.

### Configure an MCP client

Point the client at the server's `/mcp` endpoint and send the user's key on every request:

```
MCP endpoint URL: http://<host>:3001/mcp
transport:        streamable-http
Authorization:    Bearer <user's MCP API key>
```

Example for an MCP client that supports OAuth-style tokens is not required — the bearer key is static. Because the key is scoped to the owning user, give each agent/developer their own account and their own key rather than sharing one.

## Enabling a new user

1. Admin creates the user (`POST /api/users` or the web UI).
2. The user signs in (`/api/auth/login`), registers any provider OAuth clients they need (see the provider docs), and adds their own accounts.
3. The user copies their MCP API key from **Settings** and configures their MCP client with `Authorization: Bearer <key>`.

## Security notes

- Put the endpoint behind TLS (HTTPS / reverse proxy) when exposed beyond localhost.
- The MCP API key is a bearer credential — treat it like a password; rotate it if it leaks.
- User passwords are argon2-hashed; OAuth client secrets and provider tokens are AES-256-GCM-encrypted at rest with the master key (`MCP_ENCRYPTION_KEY`).