# mcp-server-pleo

TypeScript MCP server for the Pleo API. It is intentionally boring good: typed,
documented, read-first, policy-aware, credential-sane, and audit-friendly.

> **Disclaimer:** This is an independent, unofficial project by Borgels. Borgels
> is not affiliated with, endorsed by, or supported by Pleo. "Pleo" and the Pleo
> API are referenced only to describe what this server talks to. You need your
> own Pleo API credentials, and use of the API is subject to Pleo's own terms.

## Scope

The server exposes the current Pleo API through three layers:

- Curated MCP tools for connection checks, auth introspection, companies,
  employees, chart of accounts, vendors, export jobs, export job items, and
  export items.
- A guarded REST read tool for long-tail GET coverage on allowlisted current
  endpoints.
- A dry-run + commit flow for selected write operations, disabled by default
  and gated by policy.

Default install mode is read-first. Write commits require explicit environment
opt-in, a prepared request hash, a business reason, an idempotency key for the
audit trail, and optional policy-file approval.

The first version intentionally avoids Pleo's deprecated legacy API surface.

## Setup

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Set one Pleo credential in the MCP server environment. The server never accepts
credentials as tool arguments.

For standalone API keys:

```sh
export PLEO_API_KEY="your-pleo-api-key"
```

For OAuth access tokens:

```sh
export PLEO_ACCESS_TOKEN="your-oauth-access-token"
```

Optional hardening settings:

```sh
export PLEO_BASE_URL="https://external.pleo.io"
export PLEO_TIMEOUT_MS=30000
export PLEO_AUDIT_LOG="/absolute/path/to/pleo-audit.jsonl"
```

## Claude Or Cursor Config

Use the stdio server for local MCP clients:

```json
{
  "mcpServers": {
    "pleo": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-pleo/dist/stdio.js"],
      "env": {
        "PLEO_API_KEY": "your-pleo-api-key",
        "PLEO_TIMEOUT_MS": "30000"
      }
    }
  }
}
```

During development:

```json
{
  "mcpServers": {
    "pleo": {
      "command": "npm",
      "args": ["run", "dev", "--prefix", "/absolute/path/to/mcp-server-pleo"],
      "env": {
        "PLEO_API_KEY": "your-pleo-api-key",
        "PLEO_AUDIT_LOG": "/absolute/path/to/pleo-audit.jsonl"
      }
    }
  }
}
```

## Start Here

Ask the MCP client to call:

- `pleo_search_capabilities` to find tools and examples.
- `pleo_check_connection` to verify credentials.
- `pleo_introspect_auth` to see auth method, subject, and granted scopes.

## Tools

All read tools are registered with MCP tool annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint`) so clients can reason
about safety.

### Discovery

- `pleo_search_capabilities` — search this MCP server's capabilities.
- `pleo_check_connection` — verify the configured credential through
  `/v1/introspect`.
- `pleo_introspect_auth` — return Pleo auth metadata and granted scopes.

### Master Data

- `pleo_search_companies` — search companies available to the credential.
- `pleo_get_company` — fetch one company by UUID.
- `pleo_search_employees` — search employees by company, email, code, and
  pagination.
- `pleo_get_employee` — fetch one employee by UUID.
- `pleo_search_accounts` — search chart-of-accounts records for a company.
- `pleo_search_vendors` — search vendors for a company.
- `pleo_get_vendor` — fetch one vendor by UUID.

Example:

```json
{
  "companyId": "00000000-0000-0000-0000-000000000000",
  "email": "finance@example.com",
  "limit": 20
}
```

### Export API

- `pleo_list_export_jobs` — list Export API v3 jobs by company, status, and
  pagination.
- `pleo_get_export_job` — fetch one export job.
- `pleo_list_export_job_items` — track accounting-entry export progress for one
  export job.
- `pleo_list_export_items` — read transformed accounting/bookkeeping export
  items.

Example:

```json
{
  "companyId": "00000000-0000-0000-0000-000000000000",
  "status": "pending",
  "limit": 50
}
```

### Long-Tail Reads

`pleo_rest_read` runs allowlisted `GET` requests only.

```json
{
  "path": "/v3/export-items",
  "query": {
    "job_id": "00000000-0000-0000-0000-000000000000",
    "limit": 50
  }
}
```

## Write Policy

Writes are blocked unless explicitly enabled:

```sh
export PLEO_ENABLE_WRITES=true
export PLEO_POLICY_PATH="/absolute/path/to/pleo-policy.json"
export PLEO_AUDIT_LOG="/absolute/path/to/pleo-audit.jsonl"
```

Example policy:

```json
{
  "writesEnabled": true,
  "allowedOperations": ["PUT /v3/export-jobs/:id/items", "POST /v3/export-job-events"],
  "deniedOperationPatterns": ["DELETE", "archive"],
  "maxBodyBytes": 20000
}
```

Write flow:

1. Call `pleo_prepare_request` with the method, path, query, body, and business
   reason.
2. Inspect the returned `preparedRequest`, `operation`, and `operationHash`.
3. Call `pleo_commit_prepared_request` with the full prepared request, matching
   `confirmOperationHash`, and an `idempotencyKey`.

The idempotency key is stored only as a hash in the audit log. When provided,
the server sends it upstream as `Idempotency-Key`.

## Security And Audit

- Credentials are read from environment variables only.
- `PLEO_BASE_URL` must be `https://`; loopback `http://` is allowed for local
  mocks.
- Formatted errors redact `Authorization`, `PLEO_API_KEY`, `PLEO_ACCESS_TOKEN`,
  and bearer/basic token material.
- Optional JSONL audit logging stores hashed targets and hashed idempotency
  keys, not raw request bodies.
- The Streamable HTTP transport binds to `127.0.0.1` by default.
- Set `MCP_HTTP_TOKEN` to require bearer auth for HTTP transport access.
- Set `MCP_ALLOWED_ORIGINS` for browser-based local clients. Without it,
  loopback origins are allowed and other origins are rejected.
- `MCP_MAX_BODY_BYTES` defaults to `10485760` (10 MiB).

Security reports: security@borgels.com.

## HTTP Transport

The default transport is stdio. A Streamable HTTP endpoint is available for
clients that need it:

```sh
npm run dev:http
```

Environment:

```sh
export MCP_HTTP_HOST=127.0.0.1
export PORT=3000
export MCP_HTTP_TOKEN="local-shared-token"
export MCP_ALLOWED_ORIGINS="http://localhost:5173"
```

Endpoint:

```text
POST http://127.0.0.1:3000/mcp
```

## API Sources

Implementation is based on the public Pleo developer documentation:

- Pleo docs index: https://developers.pleo.io/llms.txt
- API overview: https://developers.pleo.io/docs/current/getting-started/platform-api-overview
- Authentication: https://developers.pleo.io/docs/current/how-tos/oauth/how-to-call-pleo-apis-using-access-tokens
- Standalone API keys: https://developers.pleo.io/docs/for-partners
- Export API: https://developers.pleo.io/reference/export-api/export-api-overview
- Employees API: https://developers.pleo.io/reference/employees/search-for-employees
- Chart of Accounts API: https://developers.pleo.io/reference/accounts/fetch-a-list-of-accounts
- Vendors API: https://developers.pleo.io/reference/external-vendors/fetches-vendors-by-search-criteria

## License

Apache-2.0
