#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "=== Installing MCP Email, Calendar, and Contacts CLI ==="

# Check for node
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed. Please install it first."
    exit 1
fi

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed. Please install it first."
    exit 1
fi

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Build typescript files
echo "Compiling TypeScript project..."
npm run build

# Link binary globally/locally
echo "Linking executable binary (mcp-ecc) globally..."
npm link

# Create environment template if it does not exist
if [ ! -f .env ]; then
    echo "Creating template .env configuration..."
    cat <<EOT >> .env
# Encrypted token key (used to encrypt config.json credentials)
MCP_ENCRYPTION_KEY=my_secure_encryption_key
EOT
fi

echo "=================================================="
echo "✔ Installation successfully completed!"
echo "You can now run:"
echo "  mcp-ecc help                # To view commands"
echo "  mcp-ecc auth                # To set up your first account"
echo "  mcp-ecc start               # To start the MCP server"
echo "=================================================="
