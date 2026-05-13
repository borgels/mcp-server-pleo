import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PleoClient, type PleoClientOptions } from './pleo/client.js';
import { registerPleoTools } from './tools/pleo.js';

export interface CreateServerOptions {
  client?: PleoClient;
  clientOptions?: PleoClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'pleo',
    version: '0.1.0',
  });

  const client = options.client ?? new PleoClient(options.clientOptions);
  registerPleoTools(server, client);

  return server;
}
