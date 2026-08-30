# Zoho Provider (Zoho Mail, Calendar, Contacts)

The Zoho provider aggregates **Zoho Mail**, **Zoho Calendar** and **Zoho Contacts** through Zoho's APIs using a single OAuth 2.0 consent.

> **Note:** Zoho does **not** support the OAuth device-code grant. Authentication uses the **authorisation-code** (browser) flow. This works in the Docker/UI modes and via the CLI's browser flow; it is **not** available where only device code is possible.

It works in all deployment modes (HTTP APIs only).

> **OAuth clients are per account — not environment variables.** There is no `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` global setting any longer. Each mcp-ecc **user** registers their own Zoho client(s) inside the application (see [Register the client in mcp-ecc](#3-register-the-client-in-mcp-ecc-not-env)). See [Authentication & Users](auth-users.md).

## Capabilities

| Domain | Zoho API | Status |
|--------|----------|--------|
| Mail | Zoho Mail API v1 | ✅ read, send, search, flags, delete |
| Calendar | Zoho Calendar API v1 | ✅ CRUD |
| Contacts | Zoho Contacts API v1 | ✅ CRUD, search |

## 1. Create a Zoho client (per user)

Each user connecting a Zoho account creates their own client in the Zoho API Console:

1. Go to the [Zoho API Console](https://api-console.zoho.com/)
2. **Create a self-client** (or a client of the relevant type); for Mail/Calendar/Contacts a *self client* is simplest
3. Enable the scopes for the products you use (see below)
4. Set the redirect URI: `http://localhost:3001/oauth/callback` and your deployed `BASE_URL/oauth/callback`
5. Note the **Client ID** and **Client Secret**

## 2. Scopes requested

One consent covers all three domains (adjust to your needs):

```
ZohoMail.messages.ALL
ZohoCalendar.events.ALL
ZohoContacts.contacts.ALL
ZohoMail.accounts.READ
```

Scopes are `module.operation` — use the `.READ` / `.UPDATE` variants to restrict writes.

## 3. Register the client in mcp-ecc (not `.env`), including region

Client credentials live inside the application, owned by the current user, not in environment variables. Zoho is **regional**, so you also record the region (`accounts-server`) on the client and account.

1. Sign in to the web UI (see [Authentication & Users](auth-users.md))
2. Go to **Settings → OAuth Clients**
3. **Add OAuth client** → provider **Zoho**
   - **Label** (free text, e.g. `Indigo`, `Work`)
   - **Client ID** and **Client Secret** from the Zoho API Console
   - **Scopes** — pre-filled with the set above; edit if you restricted access
   - **Accounts server / region** — choose the region your Zoho data is hosted in:
     | Region | Server |
     |--------|--------|
     | US / Global | `accounts.zoho.com` |
     | Europe | `accounts.zoho.eu` |
     | India | `accounts.zoho.in` |
     | China | `accounts.zoho.com.cn` |
     | Japan | `accounts.zoho.jp` |
     | Australia | `accounts.zoho.com.au` |
4. Save. The secret is encrypted at rest with the master key.

When adding a **Zoho account**, select the Zoho OAuth client (and region) to use. The region is also stored on the account's `config.accountsServer`.

## 4. Authenticate

### Web UI / Management API (authorisation code)

Add account → Zoho → choose region and OAuth client → complete the browser flow. The redirect returns to `/oauth/callback`.

### CLI

```bash
mcp-ecc auth
# choose 3 (Zoho), enter the account email / name / slug, then select the region and OAuth client
```

The CLI opens the authorisation-code URL; complete it in the browser.

Re-authorise an expired / revoked account via **Re-authenticate** (`POST /api/accounts/:id/reauth`).

## 5. Data model mapping

| mcp-ecc entity | Zoho equivalent |
|----------------|-----------------|
| Mail account | `mail.zoho.com/api/v1/accounts` (per-account ZUID) |
| Mail folder | Mail folder (`folderId`, `folderName`) |
| Calendar | Calendar (`calendarId`) |
| Contact | Contact (`contactId`) |

## 6. Notes & pitfalls

- Zoho Mail requires resolving a **Zoho account ID** (`zuid`) before addressing mail endpoints; mcp-ecc fetches it automatically on first use.
- Mail timestamps (`receivedTime`) are epoch milliseconds — the provider converts to ISO.
- Zoho's Calendar/Contacts APIs use distinct base URLs (`calendar.zoho.com`, `contacts.zoho.com`) from Mail (`mail.zoho.com`).
- Self-client tokens are typically short-lived; the OAuth manager refreshes with the refresh token when provided. If no refresh token is issued, re-authenticate.
- A `ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET` value in `.env` or a Workers secret is **ignored** for OAuth; use per-account OAuth clients.