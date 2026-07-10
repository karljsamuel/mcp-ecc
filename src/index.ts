import dotenv from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.js';

// Load environment variables
dotenv.config();

export async function runServer(options: { sse?: boolean; port?: number } = {}) {
  const server = createMcpServer();

  const useSse = options.sse !== undefined ? options.sse : process.argv.includes('--sse');
  const port = options.port || (process.env.PORT ? parseInt(process.env.PORT, 10) : 3001);

  if (useSse) {
    console.error('SSE Server Transport is configured to listen. Setting up HTTP endpoint...');
    const http = await import('http');
    const { SSEServerTransport } = await import('@modelcontextprotocol/sdk/server/sse.js');
    
    let transport: any = null;

    const httpServer = http.createServer((req, res) => {
      if (req.url === '/sse') {
        transport = new SSEServerTransport('/messages', res);
        server.connect(transport).catch(console.error);
      } else if (req.url === '/messages' && req.method === 'POST') {
        if (transport) {
          transport.handleMessage(req, res);
        } else {
          res.writeHead(400);
          res.end('No active SSE connection');
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    httpServer.listen(port, () => {
      console.error(`MCP Server listening on SSE endpoint: http://localhost:${port}/sse`);
    });
  } else {
    // Default to stdio transport
    console.error('Starting MCP Server via Stdio transport...');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP Server connected and running.');
  }
}

// Auto-run if index.js is called directly as main file
if (process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'))) {
  runServer().catch(error => {
    console.error('Fatal error in MCP Server bootstrap:', error);
    process.exit(1);
  });
}
