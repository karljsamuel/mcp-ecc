# Accounts & Identity

Every provider account in mcp-ecc carries two identifiers: a human-friendly **`name`** and a machine-stable **`slug`**. This page explains how they differ and where each is used. For how accounts are owned and how a user is authenticated, see [Authentication & Users](auth-users.md).

## The two identifiers

| Field | `name` | `slug` |
|-------|--------|--------|
| Purpose | Human display label | Stable machine key |
| Format | Free text — may contain spaces and special characters | `[a-z0-9]`, `-` and `_` allowed; lowercase |
| Uniqueness | Not required to be unique | **Unique per owner** |
| Mutable? | Yes — change freely | Yes, but it is the key used in MCP resource URIs, so changing it moves references |
| Example | `Karl's Gmail`, `Work Outlook (UK)`, `Q3 Team Calendar!` | `karls-gmail`, `work-outlook-uk`, `q3-team-calendar` |

The internal database row also has a UUID `id` and an `ownerId` (the owning user); neither is usually shown to end users.

## `name` — the human display label

- Any string is accepted: spaces, punctuation, emoji, mixed case.
- It is what the web UI and account listings show to a human.
- Two different accounts owned by the same user may share the same `name`; it is not used as a key.
- Set it when creating the account; change it at any time (`PATCH /api/accounts/:id`).

## `slug` — the stable MCP resource key

- Lowercase `[a-z0-9]` with `-` and `_` as separators; spaces are **not** allowed.
- **Unique per owner**, so two users can each have a `work-gmail`, but one user cannot have two accounts with the same slug.
- It is the identifier used to address the account across the MCP surface — for example the `accounts.*` tools and per-account **resources** such as:

  ```text
  mcp-ecc://<slug>/today-agenda
  ```

  and the `accountId` argument used by `mail.*`, `calendar.*` and `contacts.*` tools resolves to your slug.

- Because it is a stable key, prefer to keep it stable once it is referenced by clients. Changing a slug moves these resource URIs; update any MCP client configuration accordingly.
- If left unset, mcp-ecc derives a slug from the account name (lowercased, spaces/special characters replaced with `-`).

## Managing accounts

Accounts are self-managed by their owner through the web UI or the management REST API:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/accounts` | Create an account `{ "name", "slug", "provider", "email", "config" }` |
| `GET` | `/api/accounts` | List your accounts |
| `GET` | `/api/accounts/:id` | Account detail |
| `PATCH` | `/api/accounts/:id` | Update `name`, `slug`, `displayName`, `status`, … |
| `POST` | `/api/accounts/:id/reauth` | Re-run OAuth for an expired / revoked token |
| `POST` | `/api/accounts/:id/test-connection` | Verify the account's credentials still work |
| `DELETE` | `/api/accounts/:id` | Remove the account |

Every route is automatically scoped to the signed-in **user**: a user can only read/write their own accounts, and actions through the MCP endpoint are further scoped by the bearer key to that user's accounts.

## Relationship to OAuth clients

An account of a cloud provider (Google / Microsoft / Zoho) references one of the **owner's** OAuth clients for authentication; both are owned by the same user. Accounts are free to reuse a client (e.g. several Gmail accounts under one "Personal" client) or use dedicated ones. See the provider docs for the app-creation and client-registration steps.

## Example

A user owns a single Microsoft client and adds two accounts:

- `name` = `Work Outlook`, `slug` = `work-outlook`
- `name` = `Personal Outlook`, `slug` = `personal`

Agent tools then address them as `accountId: "work-outlook"` and `accountId: "personal"`, and the daily-briefing resource URL is `mcp-ecc://work-outlook/today-agenda`.