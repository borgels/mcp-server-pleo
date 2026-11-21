# Changelog

## 0.5.0 (2026-11-21)

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.5.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.4.0 (2026-11-21)

### Changes

- Gateway error results carry failure metadata: when Pleo answered with an
  HTTP error (a refused redirect included), the result has `failure: {
  httpStatus, requestId? }`, so a host can count failures by status without
  reading their text. `requestId` is the vendor's own id from a response
  header (`REQUEST_ID_HEADERS`: Pleo's `pleo-request-id` first, then the
  common list), kept only when it is a hex id of 8 to 64 characters (one run
  of hex digits, or groups of four or more joined by single hyphens, as in a
  UUID) and does not hold the shape of a personal number. It is checked
  again after redaction, so an id that shared a piece with the key is
  dropped. Never the body, the vendor's error code or message. The shared
  helpers are in `src/errors.ts` (`vendorRequestId`, `requestIdFrom`,
  `failureMetadata`). `PleoHttpError.requestId` now holds only an id in that
  form (before, any value of `x-request-id` or `pleo-request-id`).

### Fixes

- A Basic or Bearer value that holds the secrets' marker is masked whole,
  whatever the length of its tail (`basic ‹redacted›abcdef`).
- A registered secret inside a Bearer token or a JSON Web Token no longer
  leaves the rest of the token behind: credential-shaped text is masked
  before the secrets, and again after, until nothing changes, and the
  patterns take the secrets' marker as part of a value.
- A credential assignment whose value holds both `=` and `:` (`secret=abc:def`)
  is masked whole: the first separator ends the name. Before, a `:` later in
  the value was taken as the separator and the text before it was kept.
- A tool failure is written to the audit by its code again: `http_<status>`
  for an error from Pleo (so `http_429` for a rate limit) and `timeout` for a
  request or an answer that timed out. The error was turned into text before
  the audit classified it, so every failure was written as `error`. Timeouts
  keep their text and are now named `TimeoutError`.

## 0.3.0 (2026-11-19)

The gateway entry point (`./gateway`) in the shape of `mcp-server-template`,
for hosts that run one instance per tenant in a shared process.

### Changes

- `createPleoGateway({ apiKey, baseUrl?, fetchImpl?, timeoutMs?, policy? })`:
  `apiKey` (the standalone API key, sent as Basic auth) is required and never
  read from the environment; `baseUrl` defaults to `https://external.pleo.io`
  and is never read from `PLEO_BASE_URL`. The OAuth `accessToken` option is
  gone from the gateway (the stdio and HTTP transports keep it).
- Results are also masked for credentials the upstream echoes that are not
  the instance's key: Authorization headers, Bearer and Basic values,
  `token=`-style text, and the whole value of credential-named fields
  (`accessToken`, `refresh_token`, `client_secret`, `password` and the like).
  Bearer and Basic in any case when followed by a credential-like value, JSON
  Web Tokens anywhere, and credential-named fields whatever their value's type
  and however the name is written (`X-Api-Key`, `x-auth-token`, `api-key`).
- Any value of 8 or more token characters after `bearer`/`basic` in any case
  is masked (a short word such as "basic plan" is not), and so are
  credential assignments in text (`X-Api-Key: …`, `client_secret=…`,
  `?api_key=…`).
- A successful answer that is not JSON (`application/json` or a `+json` type),
  or JSON that does not parse, is refused with a fixed text instead of being
  passed on as text.
- The audit never holds the host's text: an unknown tool is recorded as
  `unknown_tool` (and the answer no longer repeats its name), the caller only
  as an HMAC pseudonym with a per-process key, and the request id is the
  server's own.
- An error in an audit record is a fixed code (`http_<status>`, `timeout` or
  `error`), never the error's message, also when the audit sink itself fails.
- Key admission: printable ASCII, at least 16 characters, no piece of 6
  characters shared with the server's own texts, its fixed fallbacks or the
  tool list. A refused key throws `GatewayConfigError` at construction with a
  fixed text that holds no piece of it; construction errors are sealed (no
  `cause`, no stack frames).
- Host policy `{ enableWrites, disabledTools, audit }` per instance: with it
  the instance reads none of `PLEO_ENABLE_WRITES`, `PLEO_POLICY_PATH` or
  `PLEO_AUDIT_LOG`. Every call runs in its own call scope with the caller and
  request id from the call context.
- `pleoToolCatalog`: a deeply frozen catalog with `inputSchema` derived from
  the zod schema the call is validated with (strict: unknown fields are
  refused), `upstream` (method and path of every Pleo request) and `broad`.
  The tool set is unchanged: `search_capabilities`, `check_connection`,
  `introspect_auth`, `search_companies`, `search_employees`,
  `search_vendors`, `list_export_jobs`, `list_export_items`, all `read`.
- Handlers, schemas, policy and audit are shared with the MCP server; the
  gateway no longer has its own switch over tool names.
- Results: data redacted twice against the instance's key and Basic
  credential, then checked at the sink (a result still holding a piece of
  the key is withheld); the text block holds a short summary followed by the
  data as compact JSON, equal to `structuredContent`.
- Errors are our own texts: an HTTP failure reads
  `Pleo API request failed with HTTP <status>` with our hint and the parsed
  `retry-after`, never Pleo's response body, message or request id (also in
  the MCP server). Redirects, network failures and timeouts are worded by
  us and quote neither the address nor the cause. Failures nested in a
  successful answer are reduced to the status and our own text.
- `search_capabilities` in a gateway lists only the tools the instance offers.

### Upgrade notes

- `createPleoGateway()` without `apiKey` now throws; pass the key explicitly.
  `PLEO_API_KEY`, `PLEO_ACCESS_TOKEN` and `PLEO_BASE_URL` are ignored by the
  gateway.
- Input schemas are the MCP server's: `search_vendors` requires `companyId`,
  enums are enforced, and unknown fields are refused instead of ignored.
- Error texts no longer include Pleo's error message, the request URL or the
  request id.

## 0.2.0

### Changes

- HTTP: the server refuses to start without `MCP_HTTP_TOKEN` when bound to a
  non-loopback address or with `MCP_ALLOW_ANY_ORIGIN=true`.
  `MCP_HTTP_ALLOW_UNAUTHENTICATED=true` is an explicit escape hatch.
- HTTP: `MCP_HTTP_TOKEN` must be at least 32 printable ASCII characters.
- HTTP: failed authentications are limited per client address (429 with
  `Retry-After`); valid tokens are never throttled. New `MCP_AUTH_FAILURE_LIMIT`
  (default 20, `0` disables) and `MCP_AUTH_FAILURE_WINDOW_MS` (default 60000).
- HTTP: `Host` header check for loopback binds (`MCP_ALLOWED_HOSTS`).
- HTTP: 401 responses carry `WWW-Authenticate: Bearer`; invalid JSON returns 400
  (JSON-RPC parse error) instead of 500; oversized bodies are refused from
  `Content-Length` before reading; one log line per rejected request.
- HTTP: `GET /healthz`; graceful shutdown on SIGTERM/SIGINT.
- `PORT`, `MCP_MAX_BODY_BYTES`, `PLEO_TIMEOUT_MS` and the boolean `MCP_*` flags
  are validated at startup; invalid values stop the server instead of becoming
  `NaN`.
- Pleo client: redirects are never followed (`redirect: 'manual'`); error bodies
  are read up to 64 KB.
- The MCP server reports the package version.
- Dependency updates (`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7, patched
  transitive dependencies); CI uses pinned actions and fails on high/critical
  production advisories.
- Prepared write requests are HMAC-signed (`PLEO_PREPARE_SECRET`, random per
  process when unset) and expire after 15 minutes; at commit the operation is
  re-derived from method and path and re-checked; stricter request path
  validation.
- Gateway library export (`./gateway`).

### Upgrade notes

- A non-loopback bind (`HOST`/`MCP_HTTP_HOST=0.0.0.0`) or
  `MCP_ALLOW_ANY_ORIGIN=true` now requires `MCP_HTTP_TOKEN` of at least 32
  characters (e.g. `openssl rand -hex 32`). A shorter token stops the server.
- Invalid values for the variables above now stop the server at startup.
- Existing variable names are unchanged.

## 0.1.0

- Initial Pleo MCP server.
- Added credential-safe Pleo REST client supporting standalone API keys and
  OAuth access tokens.
- Added read-first tools for capability discovery, connection introspection,
  companies, employees, chart of accounts, vendors, export jobs, export job
  items, and export items.
- Added guarded long-tail REST reads for allowlisted Pleo endpoints.
- Added dry-run request preparation and policy-gated commit flow for selected
  Pleo write operations.
- Added audit logging, tests, stdio transport, Streamable HTTP transport,
  Apache-2.0 licensing, `SECURITY.md`, CI, Dependabot, package publish
  allowlisting, and hardened HTTP defaults.
