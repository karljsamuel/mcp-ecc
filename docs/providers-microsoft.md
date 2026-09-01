# Microsoft Provider (Outlook / Microsoft 365)

The Microsoft provider aggregates mail, calendar and contacts through the **Microsoft Graph API**. It supports both personal **Outlook.com** accounts and **Microsoft 365 / Office 365** organisational accounts (via a tenant ID).

A single OAuth 2.0 consent covers all three domains.

It works in all deployment modes: CLI, Docker, and Cloudflare Workers (HTTP APIs only).

> **OAuth is the only supported method for Microsoft 365.** Microsoft is **retiring basic authentication**: Exchange Online basic auth for most protocols was disabled through 2022–2024, and **Exchange Online SMTP AUTH itself is being retired during 2026**. Consequently mcp-ecc **does not support app passwords or username/password SMTP auth for Microsoft 365**. Connect organisational accounts exclusively through **Microsoft Graph OAuth** as described below. App passwords remain available **only** for personal Outlook.com accounts with multi-factor authentication enabled — and even there they are a legacy fallback, not the recommended path.

> **OAuth clients are per account — not environment variables.** There is no `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` global setting any longer. Each mcp-ecc **user** registers their own Microsoft App registration(s) inside the application (see [Register the client in mcp-ecc](#3-register-the-client-in-mcp-ecc-not-env)). See [Authentication & Users](auth-users.md).

## Capabilities

| Domain | Graph endpoint | Status |
|--------|----------------|--------|
| Mail | `/me/messages` | ✅ read, send, search, move, flags, delete |
| Calendar | `/me/calendars` | ✅ CRUD, free/busy (getSchedule) |
| Contacts | `/me/contacts` | ✅ CRUD, search |

## 1. App registration in Azure (per user)

Each user connecting a Microsoft account registers their own app in Azure:

1. Go to the [Azure Portal](https://portal.azure.com/) → **App registrations**
2. **New registration**
   - Name, e.g. `mcp-ecc`
   - **Supported account types** — choose per the account type below
3. Note the **Application (client) ID** and the **Directory (tenant) ID**
4. **Certificates & secrets → New client secret** → copy the value (shown once). This becomes the client secret you store in mcp-ecc.
5. **Authentication → Add a platform → Web** and add redirect URIs:
   - `http://localhost:3001/oauth/callback` (Docker / UI)
   - your deployed `BASE_URL/oauth/callback`
   - For the **device-code** flow used by the CLI, a desktop-app / native client is fine and no redirect URI is strictly required.

### Account type: personal Outlook, single-tenant M365, multi-tenant

| Account type | Supported account types | Tenant ID | Admin consent? |
|--------------|-------------------------|-----------|----------------|
| Personal Outlook.com | **Personal Microsoft accounts only** | — (none) | No |
| Microsoft 365 – single organisation | **Accounts in this organisational directory only** (single tenant) | Set the directory tenant ID | Required for delegated `ReadWrite` scopes depending on org policy |
| Microsoft 365 – multiple organisations / common | **Accounts in any organisational directory** (multi-tenant) | `common` (leave unset) | Required — each consuming tenant's admin must consent |

**Admin consent:** For organisational (single-tenant and multi-tenant) accounts, the Graph delegated permissions below are `ReadWrite`. Many tenants require an **administrator to grant consent** before the app can access mail/calendar/contacts. In the Azure portal under **API permissions** for your app, use ** Grant admin consent for <tenant> **, and authorise the flow as a user with the needed admin role. Without it the OAuth consent may fail with `AADSTS65001` (consent required) or `AADSTS50105`.

## 2. Delegated permissions (scopes)

These Graph delegated permissions drive one consent that covers mail, calendar and contacts:

```
offline_access
https://graph.microsoft.com/Mail.ReadWrite
https://graph.microsoft.com/Mail.Send
https://graph.microsoft.com/Calendars.ReadWrite
https://graph.microsoft.com/Contacts.ReadWrite
https://graph.microsoft.com/User.Read
```

> Restricting to `Mail.Read`, `Calendars.Read`, `Contacts.Read` gives read-only access if preferred.

For **Microsoft 365** specifically, **do not** use app passwords or Exchange Online SMTP basic auth — they are being retired (see note at the top). Keep the delegated Graph permissions above and use OAuth.

## 3. Register the client in mcp-ecc (not `.env`)

Client credentials live inside the application, owned by the current user, not in environment variables.

1. Sign in to the web UI (see [Authentication & Users](auth-users.md))
2. Go to **Settings → OAuth Clients**
3. **Add OAuth client** → provider **Microsoft**
   - **Label** (free text, e.g. `My Work`, `Outlook Personal`)
   - **Client ID** and **Client Secret** from the Azure app registration
   - **Scopes** — pre-filled with the set above; edit if you restricted access
   - **Tenant ID** — set for a single-tenant M365 org; **leave blank** for personal Outlook or multi-tenant / `common`
4. Save. The secret is encrypted at rest with the master key.

When adding a **Microsoft account**, select which of your Microsoft OAuth clients to use. Register separate clients for personal Outlook and for each organisation (their tenant IDs and consent differ). An account's stored `tenantId` drives which tenant's OAuth endpoint is used.

## 4. Authenticate

### CLI (device code)

```bash
mcp-ecc auth
# choose 2 (Microsoft), enter the account email / name / slug, then select an OAuth client
```

The CLI prints `https://microsoft.com/devicelogin` and a code. Sign in there and authorise.

### Web UI / authorisation code

Add account → Microsoft → choose an OAuth client → complete the browser flow. Works for personal and work accounts depending on the app registration and tenant.

Re-authorise an account whose token has been revoked / expired via **Re-authenticate** (`POST /api/accounts/:id/reauth`).

## 5. Data model mapping

| mcp-ecc entity | Microsoft Graph equivalent |
|----------------|----------------------------|
| Mail folder | Mail folder (`id`, `displayName`) |
| Message flags | `isRead`, `categories` (`Starred`) |
| Calendar | Calendar (`isDefaultCalendar`, `canEdit`) |
| Contact | Contact (`displayName`, `emailAddresses`, `businessPhones`, `companyName`) |

## 6. Notes & pitfalls

- **Microsoft 365 is OAuth-only** — app passwords and SMTP basic auth are deprecated / being retired; do not configure them.
- Use `$select` to limit fields — Graph returns large payloads by default.
- `sendMail` does not return the sent message ID; mcp-ecc synthesises a placeholder message.
- Free/busy uses the `getSchedule` endpoint — it returns schedule items per attendee.
- Personal vs work accounts require the correct **supported account types** + **tenant ID** in the app registration / OAuth client; misconfiguration yields `AADSTS700016` (application not found) or `AADSTS50105`.
- A `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`/`MICROSOFT_TENANT_ID` value in `.env` or a Workers secret is **ignored** for OAuth; use per-account OAuth clients.