# Single-container image for mcp-ecc.
# Runs the Management API (Fastify) which serves the web UI, REST/OAuth API and
# the MCP endpoint (/mcp) in one process on one port.
#
# Build:  docker build -t mcp-ecc .
# Run:    docker run -p 3001:3001 -v $(pwd)/data:/data -e MCP_ENCRYPTION_KEY=... mcp-ecc
FROM node:20-alpine AS base
WORKDIR /app
RUN npm install -g turbo@1.13.4

# Install dependencies stage (prune the monorepo to just the API + its deps)
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY packages/*/package.json ./packages/
COPY packages/storage/*/package.json ./packages/storage/
COPY packages/providers/*/package.json ./packages/providers/
RUN turbo prune @mcp-ecc/management-api --docker

# Builder stage
FROM base AS builder
RUN apk add --no-cache python3 make g++
COPY --from=deps /app/out/json/ .
COPY --from=deps /app/out/package-lock.json ./package-lock.json
RUN npm ci

COPY --from=deps /app/out/full/ .
COPY turbo.json ./

RUN turbo run build --filter=@mcp-ecc/management-api...

# Runner stage
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV MCP_STORAGE_FILE=/data/mcp-ecc.db
ENV PORT=3001
ENV HOST=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 mcp-ecc \
  && apk add --no-cache python3 make g++

# Copy the full pruned workspace (package.json + node_modules across packages)
COPY --from=builder --chown=mcp-ecc:nodejs /app/package.json ./package.json
COPY --from=builder --chown=mcp-ecc:nodejs /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=mcp-ecc:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=mcp-ecc:nodejs /app/packages ./packages

# Keep only production dependencies (drops dev deps, keeps workspace links + built dist)
RUN npm prune --omit=dev --ignore-scripts

USER mcp-ecc

RUN mkdir -p /data && chown -R mcp-ecc:nodejs /data

EXPOSE 3001

ENTRYPOINT ["node", "packages/management-api/dist/bin.js"]