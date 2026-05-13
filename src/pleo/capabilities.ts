export type CapabilityRisk = 'read' | 'dry-run' | 'write';

export interface PleoCapability {
  id: string;
  title: string;
  description: string;
  risk: CapabilityRisk;
  requiredScopes: string[];
  examples: unknown[];
  identifierFormats: string[];
  safetyNotes: string[];
  keywords: string[];
}

export const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const DRY_RUN_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const PLEO_CAPABILITIES: PleoCapability[] = [
  {
    id: 'pleo_search_capabilities',
    title: 'Search Pleo Capabilities',
    description: 'Find the right Pleo MCP tool for expenses, exports, companies, employees, accounts, vendors, and governed writes.',
    risk: 'read',
    requiredScopes: [],
    examples: [{ query: 'export items' }],
    identifierFormats: ['Tool id such as pleo_list_export_items.'],
    safetyNotes: ['Discovery only. Does not call Pleo.'],
    keywords: ['discover', 'help', 'capabilities', 'tools'],
  },
  {
    id: 'pleo_check_connection',
    title: 'Check Pleo Connection',
    description: 'Validate configured credentials using Pleo authentication introspection.',
    risk: 'read',
    requiredScopes: [],
    examples: [{}],
    identifierFormats: ['Uses PLEO_API_KEY or PLEO_ACCESS_TOKEN from the server environment.'],
    safetyNotes: ['Read-only. Does not expose the secret credential.'],
    keywords: ['auth', 'connection', 'introspect', 'health', 'scope'],
  },
  {
    id: 'pleo_introspect_auth',
    title: 'Introspect Pleo Authentication',
    description: 'Return Pleo auth method, client id, scope string, application name, and subject URN.',
    risk: 'read',
    requiredScopes: [],
    examples: [{}],
    identifierFormats: ['Subject URN such as urn:pleo:company:... may include the connected company context.'],
    safetyNotes: ['Read-only. Useful before calling scoped endpoints.'],
    keywords: ['auth', 'scope', 'subject', 'application'],
  },
  {
    id: 'pleo_search_companies',
    title: 'Search Companies',
    description: 'Search companies associated with the authenticated organisation.',
    risk: 'read',
    requiredScopes: ['companies:read'],
    examples: [{ limit: 20 }],
    identifierFormats: ['Pleo company UUID, cursor, offset.'],
    safetyNotes: ['Read-only. Use company ids to scope multi-entity requests.'],
    keywords: ['companies', 'company', 'organisation', 'multi-entity'],
  },
  {
    id: 'pleo_get_company',
    title: 'Get Company',
    description: 'Fetch a specific Pleo company by company UUID.',
    risk: 'read',
    requiredScopes: ['companies:read'],
    examples: [{ companyId: '00000000-0000-0000-0000-000000000000' }],
    identifierFormats: ['Pleo company UUID.'],
    safetyNotes: ['Read-only.'],
    keywords: ['company', 'entity', 'details'],
  },
  {
    id: 'pleo_search_employees',
    title: 'Search Employees',
    description: 'Search employees by company, email, code, and pagination.',
    risk: 'read',
    requiredScopes: ['employees:read'],
    examples: [{ companyId: '00000000-0000-0000-0000-000000000000', email: 'finance@example.com' }],
    identifierFormats: ['Employee UUID, company UUID, email, external code.'],
    safetyNotes: ['Read-only. May return personal data; keep audit logs hashed.'],
    keywords: ['employees', 'users', 'people', 'email', 'hr'],
  },
  {
    id: 'pleo_get_employee',
    title: 'Get Employee',
    description: 'Fetch a specific employee by employee UUID.',
    risk: 'read',
    requiredScopes: ['employees:read'],
    examples: [{ employeeId: '00000000-0000-0000-0000-000000000000' }],
    identifierFormats: ['Pleo employee UUID.'],
    safetyNotes: ['Read-only. May return personal data.'],
    keywords: ['employee', 'user', 'person'],
  },
  {
    id: 'pleo_search_accounts',
    title: 'Search Chart Of Accounts',
    description: 'Search Pleo chart-of-accounts records for a company.',
    risk: 'read',
    requiredScopes: ['accounts:read'],
    examples: [{ companyId: '00000000-0000-0000-0000-000000000000', codes: ['2400'] }],
    identifierFormats: ['Pleo account UUID, company UUID, account code, external id.'],
    safetyNotes: ['Read-only. Does not create, update, or archive accounts.'],
    keywords: ['accounts', 'chart of accounts', 'coa', 'bookkeeping'],
  },
  {
    id: 'pleo_search_vendors',
    title: 'Search Vendors',
    description: 'Search vendors for a company by name, code, country, external id, state, or tax registration number.',
    risk: 'read',
    requiredScopes: ['vendors:read'],
    examples: [{ companyId: '00000000-0000-0000-0000-000000000000', name: 'Pleo' }],
    identifierFormats: ['Pleo vendor UUID, company UUID, external id, VAT/tax registration number.'],
    safetyNotes: ['Read-only. Does not activate, archive, or update vendors.'],
    keywords: ['vendors', 'suppliers', 'ap', 'accounts payable'],
  },
  {
    id: 'pleo_get_vendor',
    title: 'Get Vendor',
    description: 'Retrieve a vendor in Pleo by vendor UUID.',
    risk: 'read',
    requiredScopes: ['vendors:read'],
    examples: [{ vendorId: '123e4567-e89b-12d3-a456-426614174000' }],
    identifierFormats: ['Pleo vendor UUID.'],
    safetyNotes: ['Read-only.'],
    keywords: ['vendor', 'supplier'],
  },
  {
    id: 'pleo_list_export_jobs',
    title: 'List Export Jobs',
    description: 'List Pleo Export API v3 export jobs by company, status, and pagination.',
    risk: 'read',
    requiredScopes: ['export-jobs:read'],
    examples: [{ companyId: '00000000-0000-0000-0000-000000000000', status: 'pending', limit: 20 }],
    identifierFormats: ['Export job UUID, company UUID, cursor.'],
    safetyNotes: ['Read-only. Polling alternative when webhooks are not available.'],
    keywords: ['export jobs', 'exports', 'accounting', 'pending', 'erp'],
  },
  {
    id: 'pleo_get_export_job',
    title: 'Get Export Job',
    description: 'Retrieve a Pleo Export API v3 export job by id.',
    risk: 'read',
    requiredScopes: ['export-jobs:read'],
    examples: [{ jobId: '00000000-0000-0000-0000-000000000000' }],
    identifierFormats: ['Export job UUID.'],
    safetyNotes: ['Read-only.'],
    keywords: ['export job', 'status', 'history'],
  },
  {
    id: 'pleo_list_export_job_items',
    title: 'List Export Job Items',
    description: 'Track accounting-entry export progress for one export job.',
    risk: 'read',
    requiredScopes: ['export-jobs:read'],
    examples: [{ jobId: '00000000-0000-0000-0000-000000000000', status: 'failed' }],
    identifierFormats: ['Export job UUID, accounting entry UUID.'],
    safetyNotes: ['Read-only. Does not update item status.'],
    keywords: ['export job items', 'failed', 'successful', 'progress'],
  },
  {
    id: 'pleo_list_export_items',
    title: 'List Export Items',
    description: 'Read Pleo Export API v3 export items containing transformed accounting and bookkeeping data.',
    risk: 'read',
    requiredScopes: ['export-items:read'],
    examples: [{ jobId: '00000000-0000-0000-0000-000000000000', limit: 50 }],
    identifierFormats: ['Export job UUID, accounting entry UUID, cursor.'],
    safetyNotes: ['Read-only. Can include receipts/files URLs and personal data; avoid broad dumps.'],
    keywords: ['export items', 'expenses', 'receipts', 'accounting entries', 'bookkeeping'],
  },
  {
    id: 'pleo_rest_read',
    title: 'Run Guarded Pleo REST Read',
    description: 'Run an allowlisted GET request for long-tail Pleo read coverage.',
    risk: 'read',
    requiredScopes: ['depends on path'],
    examples: [{ path: '/v3/export-jobs', query: { company_id: '00000000-0000-0000-0000-000000000000' } }],
    identifierFormats: ['Allowlisted Pleo REST path.'],
    safetyNotes: ['GET only. Rejects deprecated legacy endpoints and non-allowlisted paths.'],
    keywords: ['rest', 'read', 'long-tail', 'api'],
  },
  {
    id: 'pleo_prepare_request',
    title: 'Prepare Pleo Write Request',
    description: 'Dry-run a governed Pleo write request and return an operation hash to inspect before commit.',
    risk: 'dry-run',
    requiredScopes: ['depends on operation'],
    examples: [{ method: 'PUT', path: '/v3/export-jobs/00000000-0000-0000-0000-000000000000/items', reason: 'Mark ERP export result after reconciliation' }],
    identifierFormats: ['Allowlisted Pleo write path.'],
    safetyNotes: ['Does not call Pleo. Commits require explicit environment and policy approval.'],
    keywords: ['prepare', 'dry-run', 'write', 'policy'],
  },
  {
    id: 'pleo_commit_prepared_request',
    title: 'Commit Prepared Pleo Request',
    description: 'Execute a prepared Pleo write request after hash confirmation and policy checks.',
    risk: 'write',
    requiredScopes: ['depends on operation'],
    examples: [{ confirmOperationHash: 'sha256...', idempotencyKey: 'erp-export-job-123' }],
    identifierFormats: ['Prepared request operation hash.'],
    safetyNotes: ['Writes are disabled unless PLEO_ENABLE_WRITES=true and policy allows the operation.'],
    keywords: ['commit', 'write', 'mutation', 'policy'],
  },
];

export function searchCapabilities(query: string, limit: number): PleoCapability[] {
  const normalized = query.trim().toLowerCase();
  const scored = PLEO_CAPABILITIES.map(capability => ({
    capability,
    score: capabilityScore(capability, normalized),
  }))
    .filter(item => !normalized || item.score > 0)
    .sort((left, right) => right.score - left.score || left.capability.id.localeCompare(right.capability.id));

  return scored.slice(0, limit).map(item => item.capability);
}

function capabilityScore(capability: PleoCapability, query: string): number {
  if (!query) {
    return 1;
  }

  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    capability.risk,
    ...capability.requiredScopes,
    ...capability.keywords,
    ...capability.safetyNotes,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
