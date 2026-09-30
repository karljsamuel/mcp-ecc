# Single-container image for mcp-ecc.
# Runs the Management API (Fastify) which serves the web UI, REST/OAuth API and
# the MCP endpoint (/mcp) in one process on one port.
#
# Build:  docker build -t mcp-ecc .
# Run:    docker run -p 3001:3001 -v $(pwd)/data:/data -e MCP_ENCRYPTION_KEY=... mcp-ecc
#
# .dockerignore excludes node_modules/.git so the workspace copies cleanly.
# Note: dist folders are INCLUDED so pre-built artifacts can be copied.

FROM node:24-alpine AS builder
WORKDIR /app
RUN apk upgrade --no-cache && apk add --no-cache python3 make g++ && npm install -g turbo

# Copy the full repo workspace (source + manifests + pre-built dist)
COPY package.json package-lock.json turbo.json ./
COPY packages/ ./packages/

# Install dependencies using npm workspaces
RUN npm install --legacy-peer-deps --workspaces

# Build all packages - force sequential to ensure dependencies are available
RUN npx turbo run build --filter=@mcp-ecc/core
RUN npx turbo run build --filter=@mcp-ecc/storage-sqlite --filter=@mcp-ecc/storage-d1
RUN npx turbo run build --filter=@mcp-ecc/mcp-server --filter=@mcp-ecc/management-api --filter=mcp-ecc
RUN npx turbo run build --filter=@mcp-ecc/provider-google --filter=@mcp-ecc/provider-microsoft --filter=@mcp-ecc/provider-zoho --filter=@mcp-ecc/provider-imap-smtp --filter=@mcp-ecc/provider-caldav --filter=@mcp-ecc/provider-carddav
RUN npx turbo run build --filter=@mcp-ecc/admin-ui

# --- runner: minimal image, production deps only ---
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_STORAGE_FILE=/data/mcp-ecc.db
ENV PORT=3001
ENV HOST=0.0.0.0
ENV PATH="/app/packages/cli/dist:${PATH}"

# OCI metadata (shown on GHCR and Docker Hub overview)
LABEL org.opencontainers.image.title="mcp-ecc"
LABEL org.opencontainers.image.description="MCP server for Email, Calendar & Contacts — Google, Microsoft 365, Zoho, IMAP/SMTP, CalDAV, CardDAV. Multi-user admin UI and per-user MCP API keys."
LABEL org.opencontainers.image.licenses="MIT"

RUN apk upgrade --no-cache \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 mcp-ecc

# Copy manifests + full workspace from the builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/turbo.json ./turbo.json

# Keep only production deps (drops dev deps; keeps workspace links + built dist)
RUN npm prune --omit=dev --ignore-scripts && \
    mkdir -p /data && chown -R mcp-ecc:nodejs /data

# Make CLI binary executable
RUN chmod +x packages/cli/dist/bin.js || true

USER mcp-ecc

EXPOSE 3001

# Default to Management API; CLI is available via PATH as `mcp-ecc`
ENTRYPOINT ["node", "packages/management-api/dist/bin.js"]