# IMAP / SMTP Provider

The IMAP/SMTP provider connects to any traditional mail server via **IMAP** (read/search/manage) and **SMTP** (send). It supports Gmail/Google Workspace app passwords, iCloud, Fastmail, Zoho (IMAP mode), self-hosted mail servers, and any provider exposing IMAP+SMTP.

> **Node.js only.** IMAP and SMTP require raw TCP sockets, so this provider **does not run on Cloudflare Workers**. Use CLI or Docker mode.

## Capabilities

| Domain | Status |
|--------|--------|
| Mail (IMAP) | ✅ read, search, move, set flags (\\Seen, \\Flagged, \\Deleted), delete |
| Send (SMTP) | ✅ send text/HTML with attachments |
| Calendar / Contacts | ❌ not supported |

## 1. Obtain credentials

You need the account email plus a password (prefer an **app password** where available):

| Provider | IMAP host:port | SMTP host:port | App password |
|----------|----------------|----------------|--------------|
| Gmail / Workspace | `imap.gmail.com:993` | `smtp.gmail.com:465` | yes |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:465` | yes (app-specific) |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | yes |
| Zoho | `imap.zoho.com:993` | `smtp.zoho.com:465` | app password |
| Outlook/Office365 | `outlook.office365.com:993` | `smtp.office365.com:587` | app password |
| Generic | host of your mail server | host of your mail server | varies |

Enable 2-step verification and generate an app password in your provider's security settings. Do **not** use your plain account password if the provider supports app passwords.

## 2. Configure the account

Add the account via the CLI with the IMAP/SMTP option (**4**), providing host/port/TLS details interactively, or pre-seed the account config:

```json
{
  "accountId": "me@example.com",
  "provider": "imap",
  "appPassword": "abcd-efgh-ijkl-mnop",
  "config": {
    "imapHost": "imap.gmail.com",
    "imapPort": 993,
    "imapTls": true,
    "smtpHost": "smtp.gmail.com",
    "smtpPort": 465,
    "smtpSecure": true
  }
}
```

The CLI wizard prompts for these values with Gmail defaults.

## 3. MCP tools available

- `mail.listFolders` — enumerate IMAP folders
- `mail.listMessages` / `mail.getMessage` — read mail
- `mail.sendMessage` — send via SMTP (with attachments)
- `mail.searchMessages` — IMAP full-text search
- `mail.moveMessage` — move between folders
- `mail.setFlags` — mark seen/flagged/deleted
- `mail.deleteMessage` — trash or hard-delete

Calendar and contacts tools return errors for this provider (not supported).

## Notes & pitfalls

- Message IDs are IMAP **UIDs**; they are only stable within a folder and invalidate when the mailbox is rebuilt (UIDVALIDITY changes).
- `mail.moveMessage` and hard-delete force a folder context (mcp-ecc operates on the current box, defaulting to INBOX).
- TLS certificate verification can be disabled with `rejectUnauthorized: false` for self-hosted servers, but this lowers security.
- Attachments are parsed with `mailparser`; large messages incur memory/time cost.
- Gmail IMAP **does not support the `ARCHIVE` folder** directly; archiving is simulated by moving to `All Mail` / applying flags.