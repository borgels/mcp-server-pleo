import { PleoClient, paginationQuery, type PleoClientOptions } from './pleo/client.js';
import { searchCapabilities } from './pleo/capabilities.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
}

export interface PleoGatewayOptions extends PleoClientOptions {}

const uuid = { type: 'string', description: 'UUID.' } satisfies GatewayJsonObject;
const pagination = {
  before: { type: 'string' },
  after: { type: 'string' },
  offset: { type: 'number', minimum: 0 },
  limit: { type: 'number', minimum: 1, maximum: 500 },
} satisfies Record<string, GatewayJsonObject>;

export const pleoGatewayTools: GatewayToolDefinition[] = [
  {
    name: 'search_capabilities',
    title: 'Search Pleo capabilities',
    description: 'Find supported Pleo companies, employees, vendors, accounts, and export tools.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'check_connection',
    title: 'Check Pleo connection',
    description: 'Verify the configured Pleo credential with Pleo introspection.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'introspect_auth',
    title: 'Introspect Pleo auth',
    description: 'Return Pleo authentication metadata and granted scopes.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_companies',
    title: 'Search Pleo companies',
    description: 'Search companies available to the configured Pleo credential.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: { type: 'object', properties: pagination, additionalProperties: false },
  },
  {
    name: 'search_employees',
    title: 'Search Pleo employees',
    description: 'Search employees by company, email, code, and pagination.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        companyId: uuid,
        email: { type: 'string' },
        code: { type: 'string' },
        ...pagination,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_vendors',
    title: 'Search Pleo vendors',
    description: 'Search vendors for a company by name, code, country, state, or tax registration number.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      required: ['companyId'],
      properties: {
        companyId: uuid,
        name: { type: 'string' },
        codes: { type: 'array', items: { type: 'string' } },
        countries: { type: 'array', items: { type: 'string' } },
        states: { type: 'array', items: { type: 'string' } },
        taxRegistrationNumbers: { type: 'array', items: { type: 'string' } },
        ...pagination,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_export_jobs',
    title: 'List Pleo export jobs',
    description: 'List Pleo Export API jobs by company, status, and pagination.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        companyId: uuid,
        status: { type: 'string' },
        ...pagination,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_export_items',
    title: 'List Pleo export items',
    description: 'Read transformed accounting and bookkeeping export items.',
    riskLevel: 'read',
    enabledByDefault: true,
    inputSchema: {
      type: 'object',
      properties: {
        jobId: uuid,
        ...pagination,
      },
      additionalProperties: false,
    },
  },
];

export function createPleoGateway(options: PleoGatewayOptions = {}) {
  const client = new PleoClient(options);

  return {
    tools: pleoGatewayTools,
    async callTool(toolName: string, input: GatewayJsonObject = {}): Promise<GatewayToolResult> {
      switch (toolName) {
        case 'search_capabilities':
          return jsonResult('Found Pleo capabilities.', searchCapabilities(stringValue(input.query) ?? '', numberValue(input.limit) ?? 20));

        case 'check_connection':
        case 'introspect_auth':
          return jsonResult('Fetched Pleo auth metadata.', await client.get('/v1/introspect'));

        case 'search_companies':
          return jsonResult('Fetched Pleo companies.', await client.get('/v1/companies', paginationQuery(input)));

        case 'search_employees':
          return jsonResult('Fetched Pleo employees.', await client.get('/v2/employees', {
            companyId: stringValue(input.companyId),
            email: stringValue(input.email),
            code: stringValue(input.code),
            ...paginationQuery(input),
          }));

        case 'search_vendors':
          return jsonResult('Fetched Pleo vendors.', await client.post(
            '/v1/vendors:search',
            { company_id: stringValue(input.companyId), ...paginationQuery(input) },
            {
              codes: input.codes,
              countries: input.countries,
              name: input.name,
              states: input.states,
              taxRegistrationNumbers: input.taxRegistrationNumbers,
            },
          ));

        case 'list_export_jobs':
          return jsonResult('Fetched Pleo export jobs.', await client.get('/v3/export-jobs', {
            company_id: stringValue(input.companyId),
            status: stringValue(input.status),
            ...paginationQuery(input),
          }));

        case 'list_export_items':
          return jsonResult('Fetched Pleo export items.', await client.get('/v3/export-items', {
            job_id: stringValue(input.jobId),
            ...paginationQuery(input),
          }));

        default:
          return errorResult(`Unsupported Pleo gateway tool: ${toolName}`);
      }
    },
  };
}

function stringValue(value: GatewayJsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: GatewayJsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue,
  };
}

function errorResult(text: string): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}
