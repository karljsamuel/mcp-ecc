# Zoho Provider (Zoho Mail, Calendar, Contacts)

The Zoho provider aggregates **Zoho Mail**, **Zoho Calendar** and **Zoho Contacts** through Zoho's APIs using a single OAuth 2.0 consent.

> **Note:** Zoho does **not** support the OAuth device-code grant. Authentication uses the **authorization-code** (browser) flow. This works in the Docker/UI modes and via the CLI's browser flow; it is **not** available where only device code is possible.

Works in all deployment modes (HTTP APIs only).

## Capabilities

| Domain | Zoho API | Status |
|--------|----------|--------|
| Mail | Zoho Mail API v1 | ✅ read, send, search, flags, delete |
| Calendar | Zoho Calendar API v1 | ✅ CRUD |
| Contacts | Zoho Contacts API v1 | ✅ CRUD, search |

## 1. Create a Zoho client

1. Go to the [Zoho API Console](https://api-console.zoho.com/)
2. **Create a self-client** (or a client of the relevant type)
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

Scopes are `module.operation` — use `.READ` / `.UPDATE` variants to restrict.

## 3. Configure the server (including region)

Zoho has regional endpoints. Set the `accounts-server` in the account config to your region:

| Region | Server |
|--------|--------|
| US / Global | `accounts.zoho.com` |
| Europe | `accounts.zoho.eu` |
| India | `accounts.zoho.in` |
| China | `accounts.zoho.com.cn` |
| Japan | `accounts.zoho.jp` |
| Australia | `accounts.zoho.com.au` |

Environment variables:

```dotenv
ZOHO_CLIENT_ID=your-client-id
ZOHO_CLIENT_SECRET=your-client-secret
BASE_URL=http://localhost:3001
```

The accounts-server is prompted during CLI auth, or set in the account `config.accountsServer`.

## 4. Authenticate

### Web UI / Management API (authorization code)

Add account → Zoho → choose region → complete the browser flow. The redirect returns to `/oauth/callback`.

### CLI

```bash
mcp-ecc auth
# choose 3 (Zoho), enter the account email, Client ID/Secret, then the region
```

The CLI opens the authorization-code URL; complete it in the browser.

## 5. Data model mapping

| mcp-ecc entity | Zoho equivalent |
|----------------|-----------------|
| Mail account | `mail.zoho.com/api/v1/accounts` (per-account ZUID) |
| Mail folder | Mail folder (`folderId`, `folderName`) |
| Calendar | Calendar (`calendarId`) |
| Contact | Contact (`contactId`) |

## Notes & pitfalls

- Zoho Mail requires resolving a **Zoho account ID** (`zuid`) before addressing mail endpoints; mcp-ecc fetches it automatically on first use.
- Mail timestamps (`receivedTime`) are epoch milliseconds — the provider converts to ISO.
- Zoho's Calendar/Contacts APIs use distinct base URLs (`calendar.zoho.com`, `contacts.zoho.com`) from Mail (`mail.zoho.com`).
- Self-client tokens are typically short-lived; the OAuth manager refreshes with the refresh token when provided. If no refresh token is issued, re-authenticate.