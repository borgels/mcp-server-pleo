import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PleoClient, type PleoClientOptions } from './pleo/client.js';
import { registerPleoTools } from './tools/pleo.js';
import { PACKAGE_VERSION } from './version.js';

export interface CreateServerOptions {
  client?: PleoClient;
  clientOptions?: PleoClientOptions;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'pleo',
    version: PACKAGE_VERSION,
  });

  const client = options.client ?? new PleoClient(options.clientOptions);
  registerPleoTools(server, client);

  return server;
}
