# CalDAV & CardDAV Providers

The CalDAV and CardDAV providers connect to calendars and address books over the standard WebDAV-based protocols. They are ideal for self-hosted servers such as **Nextcloud**, **Radicale**, **BAIKAL**, **DAVx5** and hosted services exposing CalDAV/CardDAV.

> **Node.js only.** These providers require outbound HTTP to your DAV server and persistent sessions; they **do not run on Cloudflare Workers**. Use CLI or Docker mode.

## Capabilities

| Provider | Domain | Status |
|----------|--------|--------|
| CalDAV | Calendar | ✅ list, read, create, update, delete events |
| CardDAV | Contacts | ✅ list, read, create, update, delete contacts |

## 1. General setup

Every DAV account needs:

- **Server URL** — the CalDAV/CardDAV endpoint (e.g. `https://cloud.example.com/remote.php/dav/`)
- **Username** — often the account email or a DAV-specific login
- **Password** — an app-specific password
- **Account name** (optional) — for servers hosting multiple principals

You must enable the server to accept a client (many servers require generating an **app password**; singular DAV users like Radicale often accept the normal password).

## 2. Add a CalDAV account

```bash
mcp-ecc auth
# choose 5 (CalDAV)
```

CLI prompts:

- **CalDAV URL** — e.g. `https://nextcloud.example.com/remote.php/dav/`
- **Account name** (optional)

Account config equivalent:

```json
{
  "accountId": "calendar-user@example.com",
  "provider": "caldav",
  "appPassword": "dav-password",
  "config": {
    "caldavUrl": "https://nextcloud.example.com/remote.php/dav/",
    "accountName": "default"
  }
}
```

### MCP tools

`calendar.listCalendars`, `calendar.listEvents`, `calendar.getEvent`, `calendar.createEvent`, `calendar.updateEvent`, `calendar.deleteEvent`, `calendar.freeBusy` (computed from fetched events).

## 3. Add a CardDAV account

```bash
mcp-ecc auth
# choose 6 (CardDAV)
```

CLI prompts:

- **CardDAV URL** — e.g. `https://nextcloud.example.com/remote.php/dav/`
- **Account name** (optional)

Account config equivalent:

```json
{
  "accountId": "contacts-user@example.com",
  "provider": "carddav",
  "appPassword": "dav-password",
  "config": {
    "carddavUrl": "https://nextcloud.example.com/remote.php/dav/",
    "accountName": "default"
  }
}
```

### MCP tools

`contacts.list`, `contacts.get`, `contacts.create`, `contacts.update`, `contacts.delete`, `contacts.search`.

## 4. Common server endpoints

| Server | CalDAV URL | CardDAV URL |
|--------|------------|-------------|
| Nextcloud | `https://<host>/remote.php/dav/` | `https://<host>/remote.php/dav/` |
| Radicale | `https://<host>/` | `https://<host>/` |
| BAIKAL | `https://<host>/dav.php/` | `https://<host>/dav.php/` |
| iCloud | `https://caldav.icloud.com/` | `https://contacts.icloud.com/` |

## Notes & pitfalls

- **Current status:** the CalDAV/CardDAV adapters are **scaffolded stubs** — they implement the provider interface but return empty results / throw "not implemented" pending a full WebDAV implementation (planned). Use the Google/Microsoft/Zoho cloud providers today for working calendar/contacts.
- Event recurrence uses RRULE strings; CalDAV maps these to iCalendar components.
- Free/busy is derived by listing events in a range (there is no standard CalDAV free/busy endpoint).
- DAV credentials are stored encrypted alongside other account credentials.