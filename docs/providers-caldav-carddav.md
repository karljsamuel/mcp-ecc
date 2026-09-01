# CalDAV & CardDAV Providers

The CalDAV and CardDAV providers connect to calendars and address books over the standard WebDAV-based protocols. They are ideal for self-hosted servers such as **Radicale**, **Nextcloud**, **BAIKAL** and **DAVx5**, and hosted services exposing CalDAV/CardDAV.

> **Node.js only.** These providers require outbound HTTP to your DAV server and persistent sessions; they **do not run on Cloudflare Workers**. Use CLI or Docker mode.

> **Compatibility & testing:** the providers implement standard WebDAV — CalDAV (RFC 4791) and CardDAV (RFC 6352) — with **Basic auth**. They were **tested against Radicale 3.7.8** (all calendar/contact operations, local server). They should work with any standards-compliant server; **OAuth-only providers are not supported** (e.g. iCloud requires an app-specific password, not your Apple ID password). Enter the **server base URL**, not a deep calendar path — service discovery (`.well-known` + PROPFIND) resolves the principal and home.

These providers authenticate with a **username and password** stored per account. They do **not** use OAuth clients, so they need no client registration in mcp-ecc.

## Capabilities

| Provider | Domain | Status |
|----------|--------|--------|
| CalDAV | Calendar | ✅ list, read, create, update, delete events, free/busy |
| CardDAV | Contacts | ✅ list, read, create, update, delete, search contacts |

## 1. General setup

Every DAV account needs:

- **Server URL** — the CalDAV/CardDAV base endpoint (e.g. `https://cloud.example.com/remote.php/dav/` or `http://localhost:5232/`)
- **Username** — the DAV login (often the account email; for Radicale the user path segment)
- **Password** — an app-specific password where the server requires one (singular DAV users like Radicale often accept the normal password)

All of these values, including the server URL and password, are stored **on the account**, encrypted at rest. The account's `name` (free text) and `slug` (`[a-z0-9-_]`, unique per owner) label it for mcp-ecc — see [Accounts & Identity](accounts-identity.md).

## 2. Add a CalDAV account

```bash
mcp-ecc add account
# choose 5 (CalDAV)
```

CLI prompts:

- **CalDAV URL** — e.g. `https://nextcloud.example.com/remote.php/dav/`
- **App password** — the DAV password (masked, confirmed)

Account config equivalent:

```json
{
  "provider": "caldav",
  "name": "Team Calendar",
  "slug": "team-calendar",
  "email": "calendar-user@example.com",
  "appPassword": "dav-password",
  "config": {
    "caldavUrl": "https://nextcloud.example.com/remote.php/dav/"
  }
}
```

### MCP tools

`calendar.listCalendars`, `calendar.listEvents`, `calendar.getEvent`, `calendar.createEvent`, `calendar.updateEvent`, `calendar.deleteEvent`, `calendar.freeBusy` (computed from fetched events).

## 3. Add a CardDAV account

```bash
mcp-ecc add account
# choose 6 (CardDAV)
```

CLI prompts:

- **CardDAV URL** — e.g. `https://nextcloud.example.com/remote.php/dav/`
- **App password** — the DAV password (masked, confirmed)

Account config equivalent:

```json
{
  "provider": "carddav",
  "name": "Work Contacts",
  "slug": "work-contacts",
  "email": "contacts-user@example.com",
  "appPassword": "dav-password",
  "config": {
    "carddavUrl": "https://nextcloud.example.com/remote.php/dav/"
  }
}
```

### MCP tools

`contacts.list`, `contacts.get`, `contacts.create`, `contacts.update`, `contacts.delete`, `contacts.search`.

## 4. Common server endpoints

| Server | CalDAV URL | CardDAV URL |
|--------|------------|-------------|
| Nextcloud | `https://<host>/remote.php/dav/` | `https://<host>/remote.php/dav/` |
| Radicale | `http://<host>:5232/` | `http://<host>:5232/` |
| BAIKAL | `https://<host>/dav.php/` | `https://<host>/dav.php/` |
| iCloud | `https://caldav.icloud.com/` (app-specific password) | `https://contacts.icloud.com/` (app-specific password) |

## Notes & pitfalls

- **Tested against Radicale 3.7.8.** Other servers are expected to work but are not yet verified; report issues with the server name/version.
- CalDAV servers often require a **stable event UID** across updates — the provider preserves the existing UID on `updateEvent`; vCards include a UID for the same reason.
- Event recurrence uses RRULE strings; CalDAV maps these to iCalendar components.
- Free/busy is derived by listing events in a range (there is no standard CalDAV free/busy endpoint).
- DAV credentials are stored encrypted alongside other account credentials.
