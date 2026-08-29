# Single-container image for mcp-ecc.
# Runs the Management API (Fastify) which serves the web UI, REST/OAuth API and
# the MCP endpoint (/mcp) in one process on one port.
#
# Build:  docker build -t mcp-ecc .
# Run:    docker run -p 3001:3001 -v $(pwd)/data:/data -e MCP_ENCRYPTION_KEY=... mcp-ecc
#
# .dockerignore excludes node_modules/dist/.git so COPY is clean.

FROM node:24-alpine AS base
WORKDIR /app
RUN npm install -g turbo

# --- deps: prune the monorepo to just the API + its workspace deps ---
# Copy the entire workspace tree (package.json files only, thanks to .dockerignore)
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY packages/ ./packages/
RUN npx turbo prune @mcp-ecc/management-api --docker

# --- builder: install and compile ---
FROM base AS builder
RUN apk add --no-cache python3 make g++
COPY --from=deps /app/out/json/ .
COPY --from=deps /app/out/package-lock.json ./package-lock.json
RUN npm ci

COPY --from=deps /app/out/full/ .
COPY turbo.json ./

RUN npx turbo run build --filter=@mcp-ecc/management-api...

# --- runner ---
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_STORAGE_FILE=/data/mcp-ecc.db
ENV PORT=3001
ENV HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 mcp-ecc \
  && apk add --no-cache python3 make g++

# Copy the pruned runtime tree (package.json + node_modules + built dist).
# out/full contains the workspace with node_modules resolved; copy it and prune dev deps.
COPY --from=builder /app/out/full/ ./
COPY --from=builder /app/packages/management-api/dist ./packages/management-api/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/storage/sqlite/dist ./packages/storage/sqlite/dist
COPY --from=builder /app/packages/storage/memory/dist ./packages/storage/memory/dist
COPY --from=builder /app/packages/providers/google/dist ./packages/providers/google/dist
COPY --from=builder /app/packages/providers/microsoft/dist ./packages/providers/microsoft/dist
COPY --from=builder /app/packages/providers/zoho/dist ./packages/providers/zoho/dist
COPY --from=builder /app/packages/providers/imap-smtp/dist ./packages/providers/imap-smtp/dist
COPY --from=builder /app/packages/providers/caldav/dist ./packages/providers/caldav/dist
COPY --from=builder /app/packages/providers/carddav/dist ./packages/providers/carddav/dist
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/dist

COPY --from=builder /app/packages/management-api/package.json ./packages/management-api/package.json
COPY --from=builder /app/packages/core/package.json ./packages/core/package.json
COPY --from=builder /app/packages/storage/sqlite/package.json ./packages/storage/sqlite/package.json
COPY --from=builder /app/packages/storage/memory/package.json ./packages/storage/memory/package.json
COPY --from=builder /app/packages/providers/google/package.json ./packages/providers/google/package.json
COPY --from=builder /app/packages/providers/microsoft/package.json ./packages/providers/microsoft/package.json
COPY --from=builder /app/packages/providers/zoho/package.json ./packages/providers/zoho/package.json
COPY --from=builder /app/packages/providers/imap-smtp/package.json ./packages/providers/imap-smtp/package.json
COPY --from=builder /app/packages/providers/caldav/package.json ./packages/providers/caldav/package.json
COPY --from=builder /app/packages/providers/carddav/package.json ./packages/providers/carddav/package.json
COPY --from=builder /app/packages/mcp-server/package.json ./packages/mcp-server/package.json

RUN npm prune --omit=dev --ignore-scripts

USER mcp-ecc

RUN mkdir -p /data && chown -R mcp-ecc:nodejs /data

EXPOSE 3001

ENTRYPOINT ["node", "packages/management-api/dist/bin.js"]