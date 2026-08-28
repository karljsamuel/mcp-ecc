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

## mail.*

Available for Google, Microsoft, Zoho and IMAP/SMTP. Not for CalDAV/CardDAV-only accounts.

### `mail.listFolders`
*Input:* `{ "accountId": "..." }`
*Output:* folders with `{ id, name, type, unreadCount, totalCount }`

### `mail.listMessages`
*Input:* `{ "accountId": "...", "folderId": "INBOX", "limit": 20, "query": "optional" }`
*Output:* message envelopes (subject, from, snippet, date, flags, id)

### `mail.getMessage`
*Input:* `{ "accountId": "...", "messageId": "..." }`
*Output:* full message incl. body/htmlBody, headers, attachments metadata

### `mail.sendMessage`
*Input:* `{ "accountId": "...", "to": [{"address": "..."}], "subject": "...", "body": "...", "cc": [], "bcc": [], "htmlBody": "...", "inReplyTo": "..." }`

### `mail.searchMessages`
*Input:* `{ "accountId": "...", "query": "...", "limit": 20 }`

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
*Input:* `{ "accountId": "...", "calendarId": "primary", "timeMin": 1700000000000, "timeMax": 1705000000000, "limit": 100 }`
Times are epoch **milliseconds**.

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

### `contacts.list`
*Input:* `{ "accountId": "...", "limit": 100, "cursor": "" }`

### `contacts.get`
*Input:* `{ "accountId": "...", "contactId": "..." }`

### `contacts.create`
*Input:* `{ "accountId": "...", "displayName": "...", "emails": [{"email":"...","type":"work"}], "phones": [{"number":"...","type":"mobile"}], "organization": "", "jobTitle": "", "notes": "" }`

### `contacts.update`
*Input:* `{ "accountId": "...", "contactId": "...", ...patchable fields }`

### `contacts.delete`
*Input:* `{ "accountId": "...", "contactId": "..." }`

### `contacts.search`
*Input:* `{ "accountId": "...", "query": "...", "limit": 50 }`

## Resources

The server also exposes a `today-agenda` resource per account:
`mcp-ecc://{accountId}/today-agenda` — a markdown summary of today's events plus recent unread mail. Fetch it via a client's `resources/read`.

## Prompts

- `daily_briefing` — generate a daily briefing across all accounts
- `weekly_review` — generate a weekly review

## Error handling

Every tool returns a structured result. On failure the server responds with `isError: true` and an explanatory message in the text content. Common codes:

- `account not found: <id>`
- `Mail not supported for this account` / `Calendar not supported ...` / `Contacts not supported ...`
- `Unknown tool: <name>`