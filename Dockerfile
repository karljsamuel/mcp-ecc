# Single-container image for mcp-ecc.
# Runs the Management API (Fastify) which serves the web UI, REST/OAuth API and
# the MCP endpoint (/mcp) in one process on one port.
#
# Build:  docker build -t mcp-ecc .
# Run:    docker run -p 3001:3001 -v $(pwd)/data:/data -e MCP_ENCRYPTION_KEY=... mcp-ecc
#
# .dockerignore excludes node_modules/dist/.git so the workspace copies cleanly.

FROM node:24-alpine AS builder
WORKDIR /app
RUN npm install -g turbo && apk add --no-cache python3 make g++

# Copy the full repo workspace (source + manifests; node_modules/dist excluded)
COPY package.json package-lock.json turbo.json ./
COPY packages/ ./packages/

# Install all workspace dependencies and compile
RUN npm ci --legacy-peer-deps
RUN npx turbo run build

# --- runner: minimal image, production deps only ---
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_STORAGE_FILE=/data/mcp-ecc.db
ENV PORT=3001
ENV HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 mcp-ecc \
  && apk add --no-cache python3 make g++

# Copy manifests + full workspace from the builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/turbo.json ./turbo.json

# Keep only production deps (drops dev deps; keeps workspace links + built dist)
RUN npm prune --omit=dev --ignore-scripts

USER mcp-ecc

RUN mkdir -p /data && chown -R mcp-ecc:nodejs /data

EXPOSE 3001

ENTRYPOINT ["node", "packages/management-api/dist/bin.js"]