# npm Trusted Publishing

Configure a separate npm Trusted Publisher connection for each public package.
Use the following identical GitHub Actions values:

| Setting | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `karljsamuel` |
| Repository | `mcp-ecc` |
| Workflow filename | `npm-publish.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable direct publishing |
| Publishing access | Require 2FA and disallow bypass 2FA tokens |

Packages to configure:

- `@mcp-ecc/core`
- `@mcp-ecc/storage-sqlite`
- `@mcp-ecc/storage-d1`
- `@mcp-ecc/provider-google`
- `@mcp-ecc/provider-microsoft`
- `@mcp-ecc/provider-zoho`
- `@mcp-ecc/provider-imap-smtp`
- `@mcp-ecc/provider-caldav`
- `@mcp-ecc/provider-carddav`
- `@mcp-ecc/mcp-server`
- `@mcp-ecc/management-api`
- `mcp-ecc`

The workflow requests `id-token: write` and publishes with npm provenance.
No `NPM_TOKEN` secret is used. Configure every package before publishing a
release; otherwise publication stops at the first package without a trusted
publisher connection.
