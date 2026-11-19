# mcp-server-pleo

TypeScript MCP server for the Pleo API. It is intentionally boring good: typed,
documented, read-first, policy-aware, credential-sane, and audit-friendly.

This is an independent, unofficial project. It is not developed, endorsed or supported by Pleo.

> "Pleo" and the Pleo
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

Prepared requests are signed with HMAC-SHA256 and expire after 15 minutes. At
commit the server verifies the signature, re-derives the operation from the
method and path, and re-applies the write allowlist and policy file. Set
`PLEO_PREPARE_SECRET` to share the signing key across server instances or
restarts; when unset, a random per-process key is used.

The idempotency key is stored only as a hash in the audit log. When provided,
the server sends it upstream as `Idempotency-Key`.

## Security And Audit

- The MCP server reads credentials from environment variables only; an
  embedded gateway takes them only from its options (see [Embedding](#embedding-gateway)).
- `PLEO_BASE_URL` must be `https://`; loopback `http://` is allowed for local
  mocks.
- Errors are our own texts with the HTTP status; Pleo's response bodies are
  never read into an error. Formatted errors also redact `Authorization`,
  `PLEO_API_KEY`, `PLEO_ACCESS_TOKEN`, and bearer/basic token material.
- Optional JSONL audit logging stores hashed targets and hashed idempotency
  keys, not raw request bodies.
- The Streamable HTTP transport binds to `127.0.0.1` by default.
- The HTTP transport requires `MCP_HTTP_TOKEN` (bearer auth, compared in
  constant time) for any non-loopback bind; see [HTTP Transport](#http-transport).
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
export MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
export MCP_ALLOWED_ORIGINS="http://localhost:5173"
```

| Variable | Default | Meaning |
|---|---|---|
| `MCP_HTTP_HOST` / `HOST` | `127.0.0.1` | Bind address. |
| `PORT` | `3000` | Listen port (1-65535). |
| `MCP_HTTP_TOKEN` | - | Bearer token required on `/mcp`; at least 32 printable ASCII characters (e.g. `openssl rand -hex 32`). Required for a non-loopback bind or `MCP_ALLOW_ANY_ORIGIN=true`. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Serve `/mcp` without a token on a non-loopback bind or with `MCP_ALLOW_ANY_ORIGIN` (logs a warning). Only when access is restricted by other means. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Largest accepted request body; larger bodies get 413. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated exact `Origin` values allowed. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any `Origin`; requires `MCP_HTTP_TOKEN`. |
| `MCP_ALLOWED_HOSTS` | see below | Comma-separated host names accepted in the `Host` header. |
| `MCP_AUTH_FAILURE_LIMIT` | `20` | Failed authentications per client address and window before further failures get 429; `0` disables. |
| `MCP_AUTH_FAILURE_WINDOW_MS` | `60000` | Window for the limit above. |
| `PLEO_TIMEOUT_MS` | `30000` | Upstream request timeout (1-600000 ms). |

The server refuses to start when it would expose `/mcp` without a token: a
non-loopback bind or `MCP_ALLOW_ANY_ORIGIN=true` without `MCP_HTTP_TOKEN`
(unless `MCP_HTTP_ALLOW_UNAUTHENTICATED=true`). Invalid numbers or booleans in
these variables also stop it at startup instead of being ignored. On a loopback
bind, only `localhost`, `127.0.0.1`, `[::1]` or the bind address are accepted
in the `Host` header (DNS-rebinding protection); set `MCP_ALLOWED_HOSTS` to
change this. `GET /healthz` answers without authentication.

Endpoint:

```text
POST http://127.0.0.1:3000/mcp
```

## Embedding (`./gateway`)

`mcp-server-pleo/gateway` lets a host application run the tools in-process
instead of over MCP, in the same shape as `mcp-server-template`. One process
can run several gateway instances, for example one per tenant.

```ts
import { createPleoGateway, pleoToolCatalog } from 'mcp-server-pleo/gateway';

const gateway = createPleoGateway({ apiKey: tenant.pleoApiKey, policy: { audit: record => log(record) } });
const result = await gateway.callTool('search_employees', { companyId }, { caller: 'user-1', requestId: 'r-1' });
```

The module exports:

- `createPleoGateway({ apiKey, baseUrl?, fetchImpl?, timeoutMs?, policy? })`.
  `apiKey` is the customer's standalone Pleo API key, sent as Basic auth. It
  is required and never read from `PLEO_API_KEY`; the gateway has no OAuth
  access-token option and never reads `PLEO_ACCESS_TOKEN` (the stdio and HTTP
  transports still accept it). `baseUrl` defaults to
  `https://external.pleo.io` and is never read from `PLEO_BASE_URL`.
- `gateway.tools` (the tools enabled on the instance) and
  `gateway.callTool(name, input, { caller, requestId })`. Names are accepted
  with or without the `pleo_` prefix. Input is validated with the tool's zod
  schema before anything is sent, and unknown fields are refused. The audit
  records of the call hold `caller` only as an HMAC pseudonym (a per-process
  key) and a request id of the server's own, the same for every record of the
  call; the host's `requestId` is not written. An error is recorded as a fixed
  code (`http_<status>`, `timeout` or `error`), never as its message.
- `pleoGatewayTools`: the definitions (`name` without prefix, `title`,
  `description`, `riskLevel`, `enabledByDefault`, `inputSchema` as JSON
  Schema derived from the zod schema the call is validated with).
- `pleoToolCatalog`: the same tools, deeply frozen, with `upstream` (method
  and path of every Pleo request the tool may make) and `broad` (true when
  the input chooses what kind of thing is read). Hosts can build their own
  permission model from it without creating an instance.
- `GatewayConfigError` and the types (`PleoGatewayOptions`, `PleoGateway`,
  `InstancePolicy`, `AuditSink`, `GatewayToolDefinition`,
  `GatewayToolCatalogEntry`, `GatewayUpstreamOperation`, `GatewayToolResult`,
  `GatewayCallContext` and the JSON types).

| Tool | Risk | Broad | Pleo requests |
|---|---|---|---|
| `search_capabilities` | read | no | none |
| `check_connection` | read | no | `GET /v1/introspect` |
| `introspect_auth` | read | no | `GET /v1/introspect` |
| `search_companies` | read | no | `GET /v1/companies` |
| `search_employees` | read | no | `GET /v2/employees` |
| `search_vendors` | read | no | `POST /v1/vendors:search` |
| `list_export_jobs` | read | no | `GET /v3/export-jobs` |
| `list_export_items` | read | no | `GET /v3/export-items` |

The guarded REST read (`pleo_rest_read`) and the prepare/commit write tools
stay in the MCP server only: a free-form read cannot be described by one
upstream path, and the gateway has no write tools.

**Instance policy.** With `policy: { enableWrites, disabledTools, audit }`
the host decides the instance's policy: the instance then reads none of
`PLEO_ENABLE_WRITES`, `PLEO_POLICY_PATH` or `PLEO_AUDIT_LOG`, leaves the
disabled tools out of `tools` (and out of `search_capabilities`), refuses
them when called, and sends its audit records to `audit` (none without it).
`disabledTools` must name gateway tools. A sink that throws on a start
record refuses the call. Without `policy` the instance uses the environment,
like the MCP server. Every call runs in a call scope of its own
(AsyncLocalStorage), so a call made from inside another instance's call
never inherits its policy, sink, redactor or caller. There is no
process-wide registry of keys. With `policy`, the only variable an instance
still reads is `PLEO_TIMEOUT_MS`, and only when `timeoutMs` is not given.
Without `policy` it also reads `PLEO_ENABLE_WRITES`, `PLEO_POLICY_PATH` and
`PLEO_AUDIT_LOG`, as described above.

**Results.** A successful result has `structuredContent` and one text block:
a short summary, a blank line, and the same data as compact JSON. The data
is redacted twice against the instance's secrets (the key and the Basic
credential built from it: exact values, URL- and JSON-encoded forms and any
piece of 6 characters or more, in strings, object keys and the string form
of numbers and booleans) before it is serialised. A failure reported inside
a successful answer is reduced to its HTTP status and our own text.

**Errors.** An error result carries our own English text, never Pleo's
response body, message or request id, nor a redirect's `Location` or the
configured address. An HTTP failure starts with
`Pleo API request failed with HTTP <status>`, followed by our own hint and
the parsed `retry-after` where there is one, so a host can map it by status.
Other errors start with `Invalid input for <tool>:`,
`Unsupported Pleo gateway tool:`, `Pleo API responded with a redirect (HTTP <status>)`,
`Network error calling the Pleo API`, `Pleo API request timed out after`, or
the policy refusal.

**Key admission and the sink check.** A gateway accepts only a key of
printable ASCII (0x21-0x7E) of at least 16 characters that shares no piece
of 6 characters with a string literal in `src/`
(`src/fixed-corpus.generated.ts`, kept up to date by a test), with the fixed
fallbacks (`src/fallbacks.ts`) or with the tool list. A refused key throws
`GatewayConfigError` when the gateway is created, before anything is built
or sent; the refusal is a fixed text that holds no piece of the key, and
every error a gateway throws has no `cause` and a `stack` of only
`name: message`. As the very last step, every output (the tool list, each
result as a whole, each audit record or line) is checked in its final
form, and one that still holds a piece of the key is replaced by a fixed
fallback. Residual risk: Pleo echoing the key back otherwise transformed
(split into pieces shorter than 6 characters, reversed, hashed) is not
recognised; such data reaches only the tenant whose key it is.

## Security model

- This server uses one shared upstream identity: every caller acts with the
  credentials configured in the environment. It does not authenticate or
  distinguish end users itself.
- Per-user authentication and authorization belong in an identity-aware gateway
  in front of the HTTP transport, which holds `MCP_HTTP_TOKEN`.
- Tool access is not data access control: anyone who can call the tools can
  reach whatever the configured Pleo credentials can reach. Use credentials with
  the narrowest scope that works.
- Upstream requests never follow redirects, so credentials are only sent to the
  configured API origin.
- The HTTP server does not terminate TLS. Put it behind a TLS-terminating proxy
  or keep it on a private network.

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
