# Single-container image for mcp-ecc.
# Runs the Management API (Fastify) which serves the web UI, REST/OAuth API and
# the MCP endpoint (/mcp) in one process on one port.
#
# Build:  docker build -t mcp-ecc .
# Run:    docker run -p 3001:3001 -v $(pwd)/data:/data -e MCP_ENCRYPTION_KEY=... mcp-ecc
#
# .dockerignore excludes node_modules/dist/.git so the workspace copies cleanly.

FROM node:26-alpine AS builder
WORKDIR /app
RUN apk upgrade --no-cache && apk add --no-cache python3 make g++ && npm install -g turbo

# Copy the full repo workspace (source + manifests; node_modules/dist excluded)
COPY package.json package-lock.json turbo.json ./
COPY packages/ ./packages/

# Install all workspace dependencies and compile.
# Clean first: `composite`/`incremental` builds trust .tsbuildinfo, so a stale
# one arriving in the build context without its dist/ makes tsc emit nothing and
# silently produce an empty package.
RUN npm ci --legacy-peer-deps
RUN npm run clean && npm run build

# --- runner: minimal image, production deps only ---
FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_STORAGE_FILE=/data/mcp-ecc.db
ENV PORT=3001
ENV HOST=0.0.0.0

# OCI metadata (shown on GHCR and Docker Hub overview)
LABEL org.opencontainers.image.title="mcp-ecc"
LABEL org.opencontainers.image.description="MCP server for Email, Calendar & Contacts — Google, Microsoft 365, Zoho, IMAP/SMTP, CalDAV, CardDAV. Multi-user admin UI and per-user MCP API keys."
LABEL org.opencontainers.image.licenses="MIT"

# The user must belong to the nodejs group, not just have uid 1001. Without --ingroup
# it lands in nogroup (gid 65533), so its primary group does not match the group the
# data directory is chowned to below — and a bind-mounted /data then looks writable to
# root and read-only to the app. uid and gid are both 1001, which is what the README
# tells operators to chown host directories to.
RUN apk upgrade --no-cache \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 --ingroup nodejs mcp-ecc

# Copy manifests + full workspace from the builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/turbo.json ./turbo.json

# Keep only production deps (drops dev deps; keeps workspace links + built dist)
RUN npm prune --omit=dev --ignore-scripts && \
    mkdir -p /data && chown -R mcp-ecc:nodejs /data

# Put the CLI on PATH. `mcp-ecc` is the documented entry point for the stdio transport,
# `docker exec` maintenance and the setup flow, but the package bin was never linked into
# a PATH directory, so the command simply did not exist inside the image. The build output
# already carries a node shebang and is executable; only the link was missing.
# `command -v` fails the build if the link is ever broken.
RUN ln -sf /app/packages/cli/dist/bin.js /usr/local/bin/mcp-ecc && \
    command -v mcp-ecc

USER mcp-ecc

EXPOSE 3001

ENTRYPOINT ["node", "packages/management-api/dist/bin.js"]