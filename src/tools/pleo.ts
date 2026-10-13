import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { formatUnknownError } from '../errors.js';
import {
  DRY_RUN_TOOL_ANNOTATIONS,
  READ_TOOL_ANNOTATIONS,
  searchCapabilities,
  WRITE_TOOL_ANNOTATIONS,
} from '../pleo/capabilities.js';
import { writeAuditEvent } from '../pleo/audit.js';
import { paginationQuery, type PleoClient } from '../pleo/client.js';
import { checkRequestPolicy, checkToolPolicy } from '../pleo/policy.js';
import {
  assertAllowedReadPath,
  pathParam,
  preparePleoRequest,
  verifyPreparedRequest,
} from '../pleo/requests.js';

const uuidSchema = z.string().trim().uuid();
const cursorSchema = z.string().trim().min(1).optional();
const stringArraySchema = z.array(z.string().trim().min(1)).max(100).optional();
const querySchema = z.record(z.string(), z.unknown()).default({});
const paginationInputShape = {
  before: cursorSchema,
  after: cursorSchema,
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  sortingKeys: z.array(z.string().trim().min(1)).max(10).optional(),
  sortingOrder: z
    .array(
      z.enum([
        'ASC',
        'ASC_NULLS_FIRST',
        'ASC_NULLS_LAST',
        'DESC',
        'DESC_NULLS_FIRST',
        'DESC_NULLS_LAST',
      ]),
    )
    .max(10)
    .optional(),
};

const preparedRequestSchema = z.object({
  type: z.literal('pleo_prepared_request'),
  createdAt: z.string().trim().min(1),
  expiresAt: z.string().trim().min(1),
  method: z.enum(['POST', 'PUT', 'PATCH']),
  path: z.string().trim().min(1),
  query: querySchema,
  body: z.unknown().optional(),
  reason: z.string().trim().min(1),
  operation: z.string().trim().min(1),
  operationHash: z.string().trim().min(1),
});

export function registerPleoTools(server: McpServer, client: PleoClient): void {
  server.registerTool(
    'pleo_search_capabilities',
    {
      title: 'Search Pleo Capabilities',
      description:
        'Search the Pleo MCP server capabilities and examples. Use this first when deciding which Pleo tool to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_search_capabilities', input, async () =>
        jsonToolResult(searchCapabilities(input.query, input.limit)),
      ),
  );

  server.registerTool(
    'pleo_check_connection',
    {
      title: 'Check Pleo Connection',
      description:
        'Verify PLEO_API_KEY or PLEO_ACCESS_TOKEN using Pleo /v1/introspect. Returns ok=true when Pleo accepts the credential.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_check_connection', input, async () => {
        const data = await client.get('/v1/introspect');
        return jsonToolResult({ ok: true, introspection: data });
      }),
  );

  server.registerTool(
    'pleo_introspect_auth',
    {
      title: 'Introspect Pleo Authentication',
      description:
        'Return Pleo authentication metadata including auth method, scope string, application name, and subject URN.',
      inputSchema: {},
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_introspect_auth', input, async () =>
        jsonToolResult(await client.get('/v1/introspect')),
      ),
  );

  server.registerTool(
    'pleo_search_companies',
    {
      title: 'Search Pleo Companies',
      description:
        'Search companies associated with the authenticated Pleo organisation. Requires companies:read.',
      inputSchema: paginationInputShape,
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_search_companies', input, async () =>
        jsonToolResult(await client.get('/v1/companies', paginationQuery(input))),
      ),
  );

  server.registerTool(
    'pleo_get_company',
    {
      title: 'Get Pleo Company',
      description: 'Fetch one Pleo company by company UUID. Requires companies:read.',
      inputSchema: {
        companyId: uuidSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_get_company', input, async () =>
        jsonToolResult(await client.get(`/v1/companies/${pathParam(input.companyId)}`)),
      ),
  );

  server.registerTool(
    'pleo_search_employees',
    {
      title: 'Search Pleo Employees',
      description:
        'Search employees by companyId, email, external code, and pagination. Requires employees:read.',
      inputSchema: {
        companyId: uuidSchema.optional(),
        email: z.string().trim().email().optional(),
        code: z.string().trim().min(1).optional(),
        ...paginationInputShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_search_employees', input, async () =>
        jsonToolResult(
          await client.get('/v2/employees', {
            companyId: input.companyId,
            email: input.email,
            code: input.code,
            ...paginationQuery(input),
          }),
        ),
      ),
  );

  server.registerTool(
    'pleo_get_employee',
    {
      title: 'Get Pleo Employee',
      description: 'Fetch one Pleo employee by employee UUID. Requires employees:read.',
      inputSchema: {
        employeeId: uuidSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_get_employee', input, async () =>
        jsonToolResult(await client.get(`/v2/employees/${pathParam(input.employeeId)}`)),
      ),
  );

  server.registerTool(
    'pleo_search_accounts',
    {
      title: 'Search Pleo Chart Of Accounts',
      description:
        'Search chart-of-accounts records for a company. This is a read-oriented Pleo POST search endpoint and requires accounts:read.',
      inputSchema: {
        companyId: uuidSchema,
        excludeIfAssignedToCategory: z.boolean().default(false),
        excludeIfAssignedToContraAccount: z.boolean().default(false),
        archived: z.boolean().nullable().optional(),
        code: z.string().trim().min(1).optional(),
        codes: stringArraySchema,
        externalId: z.string().trim().min(1).optional(),
        ids: z.array(uuidSchema).max(100).optional(),
        name: z.string().trim().min(1).optional(),
        ...paginationInputShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_search_accounts', input, async () =>
        jsonToolResult(
          await client.post('/v1/chart-of-accounts:search', paginationQuery(input), {
            companyId: input.companyId,
            excludeIfAssignedToCategory: input.excludeIfAssignedToCategory,
            excludeIfAssignedToContraAccount: input.excludeIfAssignedToContraAccount,
            archived: input.archived,
            code: input.code,
            codes: input.codes,
            externalId: input.externalId,
            ids: input.ids,
            name: input.name,
          }),
        ),
      ),
  );

  server.registerTool(
    'pleo_search_vendors',
    {
      title: 'Search Pleo Vendors',
      description:
        'Search vendors for a company by name, code, country, external id, state, or tax registration number. Requires vendors:read.',
      inputSchema: {
        companyId: uuidSchema,
        accountingSystems: stringArraySchema,
        codes: stringArraySchema,
        countries: z.array(z.string().trim().length(2)).max(100).optional(),
        externalIds: stringArraySchema,
        ids: z.array(uuidSchema).max(100).optional(),
        name: z.string().trim().min(1).optional(),
        states: z.array(z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED'])).max(4).optional(),
        taxRegistrationNumbers: stringArraySchema,
        ...paginationInputShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_search_vendors', input, async () =>
        jsonToolResult(
          await client.post(
            '/v1/vendors:search',
            { company_id: input.companyId, ...paginationQuery(input) },
            {
              accountingSystems: input.accountingSystems,
              codes: input.codes,
              countries: input.countries,
              externalIds: input.externalIds,
              ids: input.ids,
              name: input.name,
              states: input.states,
              taxRegistrationNumbers: input.taxRegistrationNumbers,
            },
          ),
        ),
      ),
  );

  server.registerTool(
    'pleo_get_vendor',
    {
      title: 'Get Pleo Vendor',
      description: 'Retrieve a vendor by Pleo vendor UUID. Requires vendors:read.',
      inputSchema: {
        vendorId: uuidSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_get_vendor', input, async () =>
        jsonToolResult(await client.get(`/v1/vendors/${pathParam(input.vendorId)}`)),
      ),
  );

  server.registerTool(
    'pleo_list_export_jobs',
    {
      title: 'List Pleo Export Jobs',
      description:
        'List Pleo Export API v3 export jobs by optional company_id, status, and pagination. Requires export-jobs:read.',
      inputSchema: {
        companyId: uuidSchema.optional(),
        status: z.enum(['pending', 'in_progress', 'failed', 'completed', 'completed_with_errors']).optional(),
        ...paginationInputShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_list_export_jobs', input, async () =>
        jsonToolResult(
          await client.get('/v3/export-jobs', {
            company_id: input.companyId,
            status: input.status,
            ...paginationQuery(input),
          }),
        ),
      ),
  );

  server.registerTool(
    'pleo_get_export_job',
    {
      title: 'Get Pleo Export Job',
      description: 'Retrieve one Pleo Export API v3 export job by id. Requires export-jobs:read.',
      inputSchema: {
        jobId: uuidSchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_get_export_job', input, async () =>
        jsonToolResult(await client.get(`/v3/export-jobs/${pathParam(input.jobId)}`)),
      ),
  );

  server.registerTool(
    'pleo_list_export_job_items',
    {
      title: 'List Pleo Export Job Items',
      description:
        'List export job items and item statuses for a Pleo Export API v3 export job. Requires export-jobs:read.',
      inputSchema: {
        jobId: uuidSchema,
        status: z.enum(['pending', 'in_progress', 'failed', 'successful', 'abandoned']).optional(),
        ...paginationInputShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_list_export_job_items', input, async () =>
        jsonToolResult(
          await client.get(`/v3/export-jobs/${pathParam(input.jobId)}/items`, {
            status: input.status,
            ...paginationQuery(input),
          }),
        ),
      ),
  );

  server.registerTool(
    'pleo_list_export_items',
    {
      title: 'List Pleo Export Items',
      description:
        'List Export API v3 export items containing transformed accounting and bookkeeping data. Requires export-items:read.',
      inputSchema: {
        jobId: uuidSchema.optional(),
        ...paginationInputShape,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_list_export_items', input, async () =>
        jsonToolResult(
          await client.get('/v3/export-items', {
            job_id: input.jobId,
            ...paginationQuery(input),
          }),
        ),
      ),
  );

  server.registerTool(
    'pleo_rest_read',
    {
      title: 'Run Guarded Pleo REST Read',
      description:
        'Run an allowlisted Pleo GET request for long-tail read coverage. Rejects write methods and non-allowlisted paths.',
      inputSchema: {
        path: z.string().trim().min(1),
        query: querySchema,
      },
      annotations: READ_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_rest_read', input, async () => {
        assertAllowedReadPath(input.path);
        return jsonToolResult(await client.get(input.path, input.query));
      }),
  );

  server.registerTool(
    'pleo_prepare_request',
    {
      title: 'Prepare Pleo Write Request',
      description:
        'Dry-run a governed Pleo write request. Returns a prepared request and operation hash; does not call Pleo.',
      inputSchema: {
        method: z.enum(['POST', 'PUT', 'PATCH']),
        path: z.string().trim().min(1),
        query: querySchema,
        body: z.unknown().optional(),
        reason: z.string().trim().min(1),
      },
      annotations: DRY_RUN_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool('pleo_prepare_request', input, async () =>
        jsonToolResult(preparePleoRequest(input)),
      ),
  );

  server.registerTool(
    'pleo_commit_prepared_request',
    {
      title: 'Commit Prepared Pleo Request',
      description:
        'Execute a previously prepared Pleo write request after hash confirmation and policy checks.',
      inputSchema: {
        preparedRequest: preparedRequestSchema,
        confirmOperationHash: z.string().trim().min(1),
        idempotencyKey: z.string().trim().min(8),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async input =>
      runAuditedTool(
        'pleo_commit_prepared_request',
        input,
        async () => {
          const prepared = verifyPreparedRequest(input.preparedRequest, input.confirmOperationHash);
          const decision = await checkRequestPolicy(prepared);
          if (!decision.allowed) {
            await writeAuditEvent({
              tool: 'pleo_commit_prepared_request',
              action: 'policy_denied',
              target: auditTarget(input),
              reason: decision.reason,
              operationHash: input.confirmOperationHash,
              idempotencyKey: input.idempotencyKey,
            });
            throw new Error(decision.reason);
          }

          const result = await client.request({
            method: prepared.method,
            path: prepared.path,
            query: prepared.query,
            body: prepared.body,
            idempotencyKey: input.idempotencyKey,
          });
          return jsonToolResult(result);
        },
        {
          operationHash: input.confirmOperationHash,
          idempotencyKey: input.idempotencyKey,
        },
      ),
  );
}

async function runAuditedTool<T>(
  tool: string,
  input: unknown,
  call: () => Promise<T>,
  auditOptions: { operationHash?: string; idempotencyKey?: string } = {},
): Promise<T> {
  const policy = checkToolPolicy(tool);
  const target = auditTarget(input);

  if (!policy.allowed) {
    await writeAuditEvent({
      tool,
      action: 'policy_denied',
      target,
      reason: policy.reason,
      ...auditOptions,
    });
    throw new Error(policy.reason);
  }

  await writeAuditEvent({ tool, action: 'start', target, reason: policy.reason, ...auditOptions });

  try {
    const result = await call();
    await writeAuditEvent({ tool, action: 'finish', target, status: 'ok', ...auditOptions });
    return result;
  } catch (error) {
    await writeAuditEvent({
      tool,
      action: 'error',
      target,
      status: 'error',
      error: formatUnknownError(error),
      ...auditOptions,
    });
    throw error;
  }
}

function auditTarget(input: unknown): unknown {
  if (!input || typeof input !== 'object') {
    return input;
  }

  const value = input as Record<string, unknown>;
  return {
    path: value.path,
    method: value.method,
    query: value.query,
    companyId: value.companyId,
    employeeId: value.employeeId,
    vendorId: value.vendorId,
    jobId: value.jobId,
    email: value.email,
    code: value.code,
    status: value.status,
    before: value.before,
    after: value.after,
    offset: value.offset,
    limit: value.limit,
    sortingKeys: value.sortingKeys,
    sortingOrder: value.sortingOrder,
    reason: value.reason,
    operationHash: value.operationHash,
    confirmOperationHash: value.confirmOperationHash,
  };
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
