# MCP Tools Reference

The mcp-ecc server exposes a namespaced set of tools over the Model Context Protocol. An MCP client lists them via `tools/list` and invokes them via `tools/call`. Tool names use dotted namespaces: `mail.*`, `calendar.*`, `contacts.*`, `accounts.*`.

## accounts.*

Account lifecycle and discovery. These work for every provider.

### `accounts.list`
List all configured accounts.

*Input:* `{}`
*Output:* array of `{ id, provider, email, status }`

### `accounts.get`
*Input:* `{ "accountId": "user@example.com" }`
*Output:* the account object (without secrets)

### `accounts.add`
Start adding an OAuth account (device/auth-code). In the current build this returns an instruction to use the CLI or web UI to complete the flow.

*Input:* `{ "provider": "google|microsoft|zoho|imap|smtp|caldav|carddav", "email": "..." }`

### `accounts.remove`
*Input:* `{ "accountId": "..." }`

### `accounts.sync`
Trigger a sync for an account (placeholder in the current build).

*Input:* `{ "accountId": "...", "types": ["mail","calendar","contacts"] }`

Mail sync lists folders with `withUnreadCounts: false` (it crawls every folder's messages immediately afterwards, so folder unread counts are not needed), so folder rows written during a sync may carry `unreadCount: -1`. Call `mail.listFolders` or read the `mail/folders` resource for exact counts.

## mail.*

Available for Google, Microsoft, Zoho and IMAP/SMTP. Not for CalDAV/CardDAV-only accounts.

### `mail.listFolders`
*Input:* `{ "accountId": "...", "folderId": "optional", "withUnreadCounts": true }`
*Output:* folders with `{ id, name, parentId, type, unreadCount, totalCount, unreadCountError? }` — plus `folders` omitted for non-mail accounts.

Getting unread counts right:

- **Default (`withUnreadCounts` omitted or `true`)** returns an **exact unread count for every folder**. Where a provider can only answer by measuring, it does so (bounded — see per-provider notes below) and never substitutes a global total.
- **`folderId`** restricts the answer to one folder (matched by id, or case-insensitively by name) and returns that folder's exact count. This is the cheap single-folder probe: one folder-list request plus at most one count lookup (empty `folders` array if nothing matches).
- **`withUnreadCounts: false`** is the cheap, name-only path: one round-trip and no per-folder measurement. On providers whose folder response already contains an authoritative count (Gmail labels, Graph `mailFolders`) that count is still returned, because it costs nothing; otherwise `unreadCount` is `-1`.
- **`unreadCount: -1` (and `totalCount: -1`) means "not determined"**, never "empty". `0` always means the provider actually checked and the folder is empty. When a measurement was attempted and failed, `unreadCountError` explains why (e.g. a folder larger than the scan cap), which distinguishes it from "counts were not requested".

Per provider:

| Provider | Exact count source | Cost |
| --- | --- | --- |
| Google | `users.labels.list` → `messagesUnread` for every label, system labels included (STARRED is `type: "starred"`) | 1 request, no extras |
| Microsoft | Graph `mailFolder.unreadItemCount` (`totalItemCount` for `totalCount`) | 1 request per 100 folders (pagination followed) |
| Zoho | pages through the folder's messages, counting `status === "0"` | ≤ 10 pages (2000 messages) per folder, 4 folders in parallel, 20s budget |
| IMAP/SMTP | `LIST` with `statusQuery {unseen, messages}` (LIST-STATUS / IMAP4rev2) | 1 round-trip; on servers without LIST-STATUS, one `STATUS` per folder through a 5-way pool under a 20s budget |

IMAP note: the connection is reused across calls (no connect/logout per call), timeouts are explicit (20s connect, 10s greeting, 60s socket), and the folder list is cached for 30s.

### `mail.listMessages`
*Input:* `{ "accountId": "...", "folderId": "INBOX", "limit": 20, "cursor": "optional", "query": "optional" }`
*Output:* `{ "items": [message envelopes], "nextCursor": "optional", "total": "optional" }`.
Pass `nextCursor` into the next request's `cursor` to retrieve subsequent pages.

### `mail.getMessage`
*Input:* `{ "accountId": "...", "messageId": "..." }`
*Output:* full message incl. body/htmlBody, headers, attachments metadata

### `mail.sendMessage`
*Input:* `{ "accountId": "...", "to": [{"address": "..."}], "subject": "...", "body": "...", "cc": [], "bcc": [], "htmlBody": "...", "inReplyTo": "..." }`

### `mail.searchMessages`
*Input:* `{ "accountId": "...", "query": "...", "limit": 20, "cursor": "optional" }`
*Output:* `{ "items": [message envelopes], "nextCursor": "optional", "total": "optional" }`.

### `mail.moveMessage`
*Input:* `{ "accountId": "...", "messageId": "...", "folderId": "..." }`

### `mail.setFlags`
*Input:* `{ "accountId": "...", "messageId": "...", "addFlags": ["\\Seen"], "removeFlags": [] }`
Flags: `\Seen`, `\Flagged`, `\Deleted` (provider-mapped).

### `mail.deleteMessage`
*Input:* `{ "accountId": "...", "messageId": "...", "permanent": false }`
`permanent=false` moves to trash; `true` hard-deletes.

## calendar.*

Available for Google, Microsoft, Zoho and CalDAV. Not for IMAP/SMTP/CardDAV-only accounts.

### `calendar.listCalendars`
*Input:* `{ "accountId": "..." }`

### `calendar.listEvents`
*Input:* `{ "accountId": "...", "calendarId": "primary", "timeMin": 1700000000000, "timeMax": 1705000000000, "limit": 100, "cursor": "optional" }`
*Times are epoch **milliseconds**.
*Output:* `{ "items": [events], "nextCursor": "optional", "total": "optional" }`.

### `calendar.getEvent`
*Input:* `{ "accountId": "...", "calendarId": "...", "eventId": "..." }`

### `calendar.createEvent`
*Input:* `{ "accountId": "...", "calendarId": "primary", "summary": "Title", "startAt": ms, "endAt": ms, "description": "", "location": "", "attendees": [{"address": "..."}], "allDay": false, "recurrenceRule": "FREQ=WEEKLY" }`

### `calendar.updateEvent`
*Input:* `{ "accountId": "...", "calendarId": "...", "eventId": "...", "summary": "..." }` (any patchable field)

### `calendar.deleteEvent`
*Input:* `{ "accountId": "...", "calendarId": "...", "eventId": "..." }`

### `calendar.freeBusy`
*Input:* `{ "accountId": "...", "calendarIds": ["..."], "timeMin": ms, "timeMax": ms }`

## contacts.*

Available for Google, Microsoft, Zoho and CardDAV.

> **CalDAV/CardDAV tested platform:** these providers implement standard WebDAV (CalDAV RFC 4791, CardDAV RFC 6352) with Basic auth and were **tested against Radicale 3.7.8**. They should work with any standards-compliant server (Nextcloud, Baikal, DAViCal, etc.); OAuth-only providers are not supported.

### `contacts.list`
*Input:* `{ "accountId": "...", "limit": 100, "cursor": "optional" }`
*Output:* `{ "items": [contacts], "nextCursor": "optional", "total": "optional" }`.

### `contacts.get`
*Input:* `{ "accountId": "...", "contactId": "..." }`

### `contacts.create`
*Input:* `{ "accountId": "...", "displayName": "...", "emails": [{"email":"...","type":"work"}], "phones": [{"number":"...","type":"mobile"}], "organization": "", "jobTitle": "", "notes": "" }`

### `contacts.update`
*Input:* `{ "accountId": "...", "contactId": "...", ...patchable fields }`

### `contacts.delete`
*Input:* `{ "accountId": "...", "contactId": "..." }`

### `contacts.search`
*Input:* `{ "accountId": "...", "query": "...", "limit": 50, "cursor": "optional" }`
*Output:* `{ "items": [contacts], "nextCursor": "optional", "total": "optional" }`.

## Resources

The server also exposes a `today-agenda` resource per account:
`mcp-ecc://{accountId}/today-agenda` — a markdown summary of today's events plus recent unread mail. Fetch it via a client's `resources/read`.

A `mail/folders` resource per account returns the exact per-folder unread counts as JSON (`mcp-ecc://{accountId}/mail/folders`).

## Prompts

- `daily_briefing` — generate a daily briefing across all accounts
- `weekly_review` — generate a weekly review

## Error handling

Every tool returns a structured result. On failure the server responds with `isError: true` and an explanatory message in the text content. Common codes:

- `account not found: <id>`
- `Mail not supported for this account` / `Calendar not supported ...` / `Contacts not supported ...`
- `Unknown tool: <name>`