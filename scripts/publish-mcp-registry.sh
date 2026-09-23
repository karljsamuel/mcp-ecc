#!/usr/bin/env bash
set -euo pipefail

# Publish the MCP server from a locally authenticated session.
# Authenticate once with: mcp-publisher login github
command -v mcp-publisher >/dev/null 2>&1 || {
  printf '%s\n' 'mcp-publisher is required; install it from the MCP Registry releases.' >&2
  exit 1
}

mcp-publisher publish
