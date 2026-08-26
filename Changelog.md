# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-10

### Added
- Created the core TypeScript Model Context Protocol (MCP) server architecture.
- Added localized secure storage (`src/storage.ts`) supporting optional AES-256-GCM encryption.
- Implemented OAuth 2.0 Device Authorization Grant (Device Code Flow) helper in `src/auth.ts`.
- Integrated abstract multi-provider registry (`src/providers/registry.ts`) routing standard interfaces.
- Implemented full Google Workspace integration (`src/providers/google.ts`) covering Gmail, Calendar, and Contacts.
- Implemented Microsoft Graph integration (`src/providers/microsoft.ts`) covering Outlook Mail, Calendars, and Contacts (supports Tenant ID configuration for M365 organization accounts).
- Implemented Zoho Mail integration (`src/providers/zoho.ts`) for email reading and sending.
- Implemented traditional IMAP/SMTP standard provider (`src/providers/imap-smtp.ts`).
- Created standardized MCP Router layer (`src/mcp-server.ts`) exposing custom resources (daily agenda) and tools (`email_*`, `calendar_*`, `contacts_*`).
- Developed a comprehensive interactive executable CLI wrapper (`src/bin.ts`, `src/bin-handler.ts`).
- Created lightweight container configurations (`Dockerfile`, `docker-compose.yml`) and local bin installer (`install.sh`).
- Added a GitHub Actions workflow (`.github/workflows/publish.yml`) to automatically build and publish the container image to GHCR under the name `mcp-ecc`.
- Cleaned up and deleted legacy/temporary personal repositories (`mcp-email-calendar-contacts`, `mcc-ecp`) and moved active development to the public `mcp-ecc` repository.
