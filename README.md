# MCP Email, Calendar, and Contacts Server

A comprehensive Model Context Protocol (MCP) server that aggregates email, calendar, and contacts across Google Workspace, Microsoft Graph (Office 365), Zoho Mail, and traditional IMAP/SMTP services. 

It is specifically architected for **headless, remote, or containerized environments**, featuring OAuth 2.0 Device Authorization Grant (Device Code Flow) support and local encrypted token storage.

---

## 1. High-Level Core Architecture

```
  ┌────────────────────────────────────────────────────────┐
  │                   AI IDE / Agent Host                  │
  └───────────────────────────┬────────────────────────────┘
                              │ JSON-RPC 2.0 (stdio / sse)
                              ▼
  ┌────────────────────────────────────────────────────────┐
  │                    Your MCP Server                     │
  │                                                        │
  │  ┌──────────────────┐           ┌──────────────────┐   │
  │  │   MCP Protocol   │           │  Credential/Token│   │
  │  │  Router (Tools)  │           │     Storage      │   │
  │  └────────┬─────────┘           └────────┬─────────┘   │
  │           │                              │             │
  │           ▼                              ▼             │
  │  ┌─────────────────────────────────────────────────┐   │
  │  │               Account Manager                   │   │
  │  └────┬──────────────┬──────────────┬──────────┬───┘   │
  └───────┼──────────────┼──────────────┼──────────┼───────┘
          ▼              ▼              ▼          ▼
     ┌──────────┐   ┌──────────┐   ┌─────────┐┌──────────┐
     │  Google  │   │Microsoft │   │  Zoho   ││ IMAP/SMTP│
     │   API    │   │Graph API │   │   API   ││ Server  │
     └──────────┘   └──────────┘   └─────────┘└──────────┘
```

- **MCP Router Layer**: Exposes standardized tools (`email_*`, `calendar_*`, `contacts_*`) and resources (`comms://{accountId}/today-agenda`) using the `@modelcontextprotocol/sdk`.
- **Account Provider Registry**: Dynamically routes actions to correct integrations based on provider type.
- **Headless Auth Manager**: Generates device authorization codes, prints user prompts, polls endpoints for tokens, and handles token expiration refreshes automatically.
- **Encrypted Local Storage**: A JSON file securing tokens with AES-256-GCM.

---

## 2. Prerequisites & Setup

### Requirements
- **Node.js** v18+ or v20+
- **npm** (comes with Node.js)

### Installation
1. Clone or copy this repository to your target server.
2. Install the dependencies:
   ```bash
   npm install
   ```
3. Build the TypeScript source code:
   ```bash
   npm run build
   ```

### Configuration (`.env`)
Create a `.env` file in the root directory to store client credentials and configurations:

```env
# Encryption Key (Used to encrypt credentials.json via AES-256-GCM)
# If omitted, credentials will be stored in plain JSON.
MCP_ENCRYPTION_KEY=my_secure_encryption_key

# Google OAuth Credentials (for Google Device Authorization Flow)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Microsoft OAuth Credentials (for Microsoft Device Authorization Flow)
MICROSOFT_CLIENT_ID=your_microsoft_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_client_secret

# Optional parameters
# PORT=3001
# MCP_STORAGE_FILE=./credentials.json
```

---

## 3. Registering / Authenticating Accounts

You can register and configure accounts using the interactive CLI tool or directly via the `authenticate_account` tool:

### Method 1: Interactive CLI Tool (Recommended)
Run the interactive CLI configurator from your terminal:
```bash
npm run configure
```
This utility will prompt you to choose your provider, enter your account identifier, and guide you through the device authorization flow or password setup.

### Method 2: Via MCP Tool Call
You can also authenticate accounts directly using the `authenticate_account` tool:

### A. Google or Microsoft (Device Authorization Grant)
1. Run `authenticate_account` with the target `provider` (e.g. `"google"` or `"microsoft"`) and your target `accountId` (e.g., `"user@gmail.com"`).
2. The server will output a terminal instruction:
   ```
   Please configure this account by going to: https://google.com/device
   Enter the code: ABCD-EFGH
   ```
3. Open the URL on any device (phone, laptop), log in, and enter the code.
4. The server polls in the background, obtains the refresh token, encrypts it, and saves it locally.

### B. IMAP / SMTP (App Passwords)
For standard email providers (e.g., iCloud, Fastmail, or self-hosted mail servers):
1. Call `authenticate_account` with `provider: "imap_smtp"`.
2. Provide your `appPassword` and a `config` object containing the host details:
   ```json
   {
     "provider": "imap_smtp",
     "accountId": "me@example.com",
     "appPassword": "abcd-efgh-ijkl-mnop",
     "config": {
       "imapHost": "imap.example.com",
       "imapPort": 993,
       "imapTls": true,
       "smtpHost": "smtp.example.com",
       "smtpPort": 465,
       "smtpSecure": true
     }
   }
   ```

---

## 4. MCP Data Exposure & Functionality

### Resources
Allows agents to fetch a daily summary instantly.
- `comms://{accountId}/today-agenda`: Returns a consolidated markdown overview containing today's calendar events and recent unread email counts.

### Tools

#### ✉️ Email (`email_*`)
- `email_list_emails(accountId, folder, limit, query)`: Search or view recent email headers and snippets.
- `email_get_email(accountId, messageId)`: Fetches clean text body/contents of an email.
- `email_send_email(accountId, to, subject, body, cc, bcc)`: Dispatches text emails.
- `email_manage_email(accountId, messageId, action)`: Actions: `archive` | `read` | `unread` | `star`.
- `email_delete_email(accountId, messageId)`: Trashes or deletes messages.

#### 📅 Calendar (`calendar_*`)
- `calendar_list_events(accountId, startTime, endTime)`: View scheduled calendar entries.
- `calendar_create_event(accountId, title, startTime, endTime, description, attendees)`: Inject new appointments.
- `calendar_update_event(accountId, eventId, patches)`: Patch time/description/attendees.
- `calendar_delete_event(accountId, eventId)`: Cancel or delete calendar items.

#### 👥 Contacts (`contacts_*`)
- `contacts_search_contacts(accountId, query)`: Find details by name/keyword.
- `contacts_create_contact(accountId, name, email, phone)`: Create address book entries.
- `contacts_delete_contact(accountId, contactId)`: Delete contacts.

---

## 5. Running & Deployment

### A. One-Command Local Installer
For quick setup and local bin registration, run:
```bash
chmod +x install.sh
./install.sh
```
This installs npm packages, compiles TypeScript, copies default environment parameters to `.env`, and registers the `mcp-ecc` command globally.

### B. Running locally via CLI (mcp-ecc)
Once installed or linked, you can execute commands directly:
- **Configure / Add account**: `mcp-ecc auth`
- **Re-authenticate account**: `mcp-ecc reauth <account-id>`
- **Edit account settings**: `mcp-ecc edit-account <account-id>`
- **Delete account**: `mcp-ecc delete-account <account-id>`
- **List registered accounts**: `mcp-ecc list-accounts`
- **Launch Stdio Server (default)**: `mcp-ecc start`
- **Launch SSE Server**: `mcp-ecc start --sse --port 3001`

### C. Running in Docker (Lightweight Container)
You can run this server inside a lightweight alpine container. Credentials and settings persist on your host machine.

#### Build the image:
```bash
docker build -t mcp-ecc .
```

#### Run with Stdio (Attached to an Agent Host process):
```bash
docker run -i --rm -v $(pwd)/data:/data mcp-ecc start
```
*Note: The `-i` flag ensures standard input and output streams are kept open for stdio JSON-RPC communication.*

#### Run with Server-Sent Events (SSE / HTTP):
```bash
docker run -d --name mcp-ecc -p 3001:3001 -v $(pwd)/data:/data -e PORT=3001 -e MCP_ENCRYPTION_KEY=your_key mcp-ecc start --sse
```

#### Using Docker Compose:
To spin it up quickly in background HTTP mode:
```bash
docker compose up -d
```
All account credentials will be persisted inside the `./data` directory on the host.
