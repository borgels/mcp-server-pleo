# Changelog

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
