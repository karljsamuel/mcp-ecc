FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist

# Create location for mapped volume containing token storage
ENV MCP_STORAGE_FILE=/data/config.json
RUN mkdir -p /data && chown -R node:node /data

USER node

# Default port exposed for SSE transport mode
EXPOSE 3000

# The container can run in stdio mode by default, or be configured for SSE using arguments
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["start"]
