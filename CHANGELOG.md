# Changelog

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
