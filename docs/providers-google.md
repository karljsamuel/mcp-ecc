# Google Provider (Gmail, Calendar, Contacts)

The Google provider aggregates **Gmail**, **Google Calendar** and **Google Contacts** through the Google APIs using a single OAuth 2.0 consent.

It works in all deployment modes: CLI, Docker, and Cloudflare Workers (HTTP APIs only).

> **OAuth clients are per account — not environment variables.** There is no `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` global setting any longer. Each mcp-ecc **user** registers their own Google OAuth client(s) inside the application (see [Register the client in mcp-ecc](#3-register-the-client-in-mcp-ecc-not-env)); the client secret is encrypted at rest. See [Authentication & Users](auth-users.md).

## Capabilities

| Domain | API | Status |
|--------|-----|--------|
| Mail | Gmail API v1 | ✅ read, send, search, move, flags, delete |
| Calendar | Google Calendar API v3 | ✅ CRUD, free/busy |
| Contacts | People API v1 | ✅ CRUD, search |

## 1. Create a Google Cloud project and OAuth client (per user)

Each user who wants to connect a Google account must have their own OAuth client. Create it once in Google Cloud:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the APIs you need:
   - **Gmail API**
   - **Google Calendar API**
   - **People API** (for Contacts)
4. **APIs & Services → OAuth consent screen**
   - Choose **External** (or **Internal** if you manage the domain) — see account-type guidance below
   - Add the scopes / user type as appropriate
5. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - **Application type: Desktop app** — for the device-code flow (CLI)
   - Or **Web application** — for the authorisation-code flow (web UI / Docker)
   - For the web application add the redirect URIs:
     - `http://localhost:3001/oauth/callback` (Docker / local UI)
     - your deployed `BASE_URL/oauth/callback`
6. Note the **Client ID** and **Client Secret**

### Account type: personal Google Account vs Google Workspace

| Account | Consent screen type | Notes |
|---------|---------------------|-------|
| Personal Gmail | **External** | Add your Google Account as a test user until the app leaves testing. Works with both device-code and authorisation-code flows. |
| Google Workspace | **Internal** (preferred) | Internal apps are only usable by people in your Workspace domain and skip the external verification review. Requires a Workspace account with admin approval of the OAuth consent screen. |
| Google Workspace (wider rollout) | **External** | Use if accounts from multiple Workspaces / personal accounts must connect. Expect Google's verification process for production use. |

Google does **not** use a tenant ID like Microsoft; a single client works for both personal and Workspace accounts.

## 2. Scopes requested

One consent grants all three domains:

```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

> Use the more granular `gmail.readonly` / `gmail.send` if you want to restrict write access.

## 3. Register the client in mcp-ecc (not `.env`)

Client credentials live **inside** the application, owned by the current user, not in environment variables.

1. Sign in to the web UI (see [Authentication & Users](auth-users.md))
2. Go to **Settings → OAuth Clients**
3. **Add OAuth client** → provider **Google**
   - **Label** (free text, e.g. `Personal`, `KCET Workspace`)
   - **Client ID** and **Client Secret** from the Google Cloud Console
   - **Scopes** — pre-filled with the set above; edit if you restricted access
4. Save. The secret is encrypted at rest with the master key.

When adding a **Google account** later, you select which of your Google OAuth clients to use. You can register several clients (e.g. separate client IDs for personal and Workspace) and reuse them across accounts.

## 4. Authenticate

### CLI (device code)

```bash
mcp-ecc auth
# choose 1 (Google), enter the account email / name / slug, then select an OAuth client
```

The CLI prints a URL and code. Open the URL, sign in, enter the code, authorise. The server polls for the token and stores it encrypted.

### Web UI / Management API (authorisation code)

Open the UI, click **Add Account → Google**, choose an OAuth client, and complete the browser flow. The redirect returns to `/oauth/callback`.

To re-authorise a Google account whose token has expired or been revoked, use **Re-authenticate** on the account (`POST /api/accounts/:id/reauth`).

## 5. Data model mapping

| mcp-ecc entity | Google equivalent |
|----------------|---------------------|
| Mail folder | Gmail label (INBOX, SENT, DRAFT, TRASH, SPAM, STARRED + custom labels) |
| Message flags | `UNREAD` / `STARRED` labels |
| Calendar | Calendar list entry (primary + shared) |
| Contact | People API `Person` (resourceName, names, emailAddresses, phoneNumbers, organizations) |

## 6. Notes & pitfalls

- Gmail message IDs are per-message; use `threadId` to follow conversations.
- Attachments are returned as metadata only; fetching binary content requires an extra API call.
- The People API requires the `contacts` scope even just to read `people/me`.
- Tokens expire (≈1 hour); the OAuth manager refreshes automatically using the stored refresh token.
- A `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` value in `.env` or a Workers secret is **ignored** for OAuth; use per-account OAuth clients.