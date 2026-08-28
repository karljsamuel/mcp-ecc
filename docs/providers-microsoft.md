# Microsoft Provider (Outlook / Microsoft 365)

The Microsoft provider aggregates mail, calendar and contacts through the **Microsoft Graph API**. It supports both personal **Outlook.com** accounts and **Microsoft 365 / Office 365** organisational accounts (via a tenant ID).

A single OAuth 2.0 consent covers all three domains.

Works in all deployment modes.

## Capabilities

| Domain | Graph endpoint | Status |
|--------|----------------|--------|
| Mail | `/me/messages` | ✅ read, send, search, move, flags, delete |
| Calendar | `/me/calendars` | ✅ CRUD, free/busy (getSchedule) |
| Contacts | `/me/contacts` | ✅ CRUD, search |

## 1. App registration in Azure

1. Go to the [Azure Portal](https://portal.azure.com/) → **App registrations**
2. **New registration**
   - Name, e.g. `mcp-ecc`
   - Supported account types:
     - **Personal Microsoft accounts only** → for Outlook.com
     - **Work or school accounts** (single/multi-tenant) → for M365
     - **Accounts in any organisational directory and personal accounts** → both
3. Note the **Application (client) ID** and the **Directory (tenant) ID**

### Add a client secret

**Certificates & secrets → New client secret** → copy the value (shown once). Set it as `MICROSOFT_CLIENT_SECRET`.

### Redirect URIs

**Authentication → Add a platform → Web** and add:
- `http://localhost:3001/oauth/callback` (Docker/UI)
- your deployed `BASE_URL/oauth/callback`

For the **device code** flow used by the CLI, desktop-app clients are supported natively; no redirect URI is strictly required for device flow.

## 2. Scopes (permissions)

Enable these API permissions (Graph) — the OAuth manager requests them in one consent:

```
offline_access
https://graph.microsoft.com/Mail.ReadWrite
https://graph.microsoft.com/Mail.Send
https://graph.microsoft.com/Calendars.ReadWrite
https://graph.microsoft.com/Contacts.ReadWrite
https://graph.microsoft.com/User.Read
```

> Restricting to `Mail.Read`, `Calendars.Read`, `Contacts.Read` gives read-only access if preferred.

## 3. Configure the server

```dotenv
MICROSOFT_CLIENT_ID=your-application-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret
BASE_URL=http://localhost:3001   # or your deployed URL
```

For a **single-tenant M365** account, also set the tenant:

```dotenv
MICROSOFT_TENANT_ID=your-directory-tenant-id
```

If unset, the provider uses `organizations` / `common`.

## 4. Authenticate

### CLI (device code)

```bash
mcp-ecc auth
# choose 2 (Microsoft), enter the account email, Client ID/Secret
# answer 'y' if it is an M365 organisation account and enter the tenant ID
```

The CLI prints `https://microsoft.com/devicelogin` and a code. Sign in there and authorise.

### Web UI / auth-code

Add account → Microsoft → complete the browser flow. Works for both personal and work accounts depending on the app registration.

## 5. Data model mapping

| mcp-ecc entity | Microsoft Graph equivalent |
|----------------|----------------------------|
| Mail folder | Mail folder (`id`, `displayName`) |
| Message flags | `isRead`, `categories` (`Starred`) |
| Calendar | Calendar (`isDefaultCalendar`, `canEdit`) |
| Contact | Contact (`displayName`, `emailAddresses`, `businessPhones`, `companyName`) |

## Notes & pitfalls

- Use `.Select()` / `$select` to limit fields — Graph returns large payloads by default.
- `sendMail` does not return the sent message ID; mcp-ecc synthesises a placeholder message.
- Free/busy uses the `getSchedule` endpoint — it returns schedule items per attendee.
- Personal vs work accounts require the correct **supported account types** in the app registration; misconfiguration yields an `AADSTS700016` (application not found) error.