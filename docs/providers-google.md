# Google Provider (Gmail, Calendar, Contacts)

The Google provider aggregates **Gmail**, **Google Calendar** and **Google Contacts** through the Google APIs using a single OAuth 2.0 consent.

Works in all deployment modes: CLI, Docker, and Cloudflare Workers (HTTP APIs only).

## Capabilities

| Domain | API | Status |
|--------|-----|--------|
| Mail | Gmail API v1 | ✅ read, send, search, move, flags, delete |
| Calendar | Google Calendar API v3 | ✅ CRUD, free/busy |
| Contacts | People API v1 | ✅ CRUD, search |

## 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the APIs you need:
   - **Gmail API**
   - **Google Calendar API**
   - **People API** (for Contacts)

## 2. Create an OAuth client

1. **APIs & Services → OAuth consent screen**
   - Choose **External** (or Internal if you manage the domain)
   - Add the scopes / user type as appropriate
2. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Application type: **Desktop app** (for device-code flow) or **Web application** (for auth-code flow with the web UI)
   - Add the redirect URI `http://localhost:3001/oauth/callback` (Docker/UI mode) and your deployed `BASE_URL/oauth/callback`
3. Note the **Client ID** and **Client Secret**

## 3. Scopes requested

One consent grants all three domains:

```
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/contacts
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

> Use the more granular `gmail.readonly` / `gmail.send` if you want to restrict write access.

## 4. Configure the server

Set these environment variables (in `.env` for CLI/Docker, or Secrets for Workers):

```dotenv
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
BASE_URL=http://localhost:3001   # or your deployed URL
```

## 5. Authenticate

### CLI (device code)

```bash
mcp-ecc auth
# choose 1 (Google), enter the account email, then the Client ID/Secret
```

The CLI prints a URL and code. Open the URL, sign in, enter the code, authorise. The server polls for the token and stores it encrypted.

### Web UI / Management API (authorization code)

Open the UI, click **Add Account → Google**, and complete the browser flow. The redirect returns to `/oauth/callback`.

## 6. Data model mapping

| mcp-ecc entity | Google equivalent |
|----------------|---------------------|
| Mail folder | Gmail label (INBOX, SENT, DRAFT, TRASH, SPAM, STARRED + custom labels) |
| Message flags | `UNREAD` / `STARRED` labels |
| Calendar | Calendar list entry (primary + shared) |
| Contact | People API `Person` (resourceName, names, emailAddresses, phoneNumbers, organizations) |

## Notes & pitfalls

- Gmail message IDs are per-message; use `threadId` to follow conversations.
- Attachments are returned as metadata only; fetching binary content requires an extra API call.
- The People API requires the `contacts` scope even just to read `people/me`.
- Tokens expire (≈1 hour); the OAuth manager refreshes automatically using the stored refresh token.