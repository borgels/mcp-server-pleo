import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets } from '../src/errors.js';
import {
  createPleoGateway,
  GatewayConfigError,
  pleoGatewayTools,
  pleoToolCatalog,
  type GatewayJsonObject,
} from '../src/gateway.js';
import { registerPleoTools } from '../src/tools/pleo.js';
import { PleoClient } from '../src/pleo/client.js';

const KEY = 'tenant-a-key-0123456789abcdef';
const OTHER = 'tenant-b-key-fedcba9876543210';
const BASE = 'https://pleo.example.test';
const COMPANY = '3f1c2a4e-5b6d-4c7e-8f90-1a2b3c4d5e6f';

const basic = (key: string) => `Basic ${Buffer.from(`${key}:`, 'utf8').toString('base64')}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pleo-gateway-'));
  vi.unstubAllEnvs();
  // The MCP server's variables, set as a shared process would have them: an embedded instance must ignore them.
  vi.stubEnv('PLEO_API_KEY', 'env-key-must-not-be-used-000000');
  vi.stubEnv('PLEO_ACCESS_TOKEN', 'env-token-must-not-be-used-0000');
  vi.stubEnv('PLEO_BASE_URL', 'https://env-base.example.test');
  vi.stubEnv('PLEO_ENABLE_WRITES', '');
  vi.stubEnv('PLEO_AUDIT_LOG', '');
  vi.stubEnv('PLEO_POLICY_PATH', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function okFetch() {
  return vi.fn<typeof fetch>(async () => jsonResponse({ data: [{ id: 'c1', name: 'Testfirma ApS' }] }));
}

function sink() {
  const records: Array<Record<string, unknown>> = [];
  return { records, audit: (record: Readonly<Record<string, unknown>>) => void records.push({ ...record }) };
}

/** A valid minimal input per gateway tool. */
const MINIMAL_INPUT: Record<string, GatewayJsonObject> = {
  search_capabilities: {},
  check_connection: {},
  introspect_auth: {},
  search_companies: {},
  search_employees: {},
  search_vendors: { companyId: COMPANY },
  list_export_jobs: {},
  list_export_items: {},
};

describe('Pleo gateway surface', () => {
  it('keeps the read-only tool set, enabled by default', () => {
    expect(pleoGatewayTools.map(tool => [tool.name, tool.riskLevel, tool.enabledByDefault])).toEqual([
      ['search_capabilities', 'read', true],
      ['check_connection', 'read', true],
      ['introspect_auth', 'read', true],
      ['search_companies', 'read', true],
      ['search_employees', 'read', true],
      ['search_vendors', 'read', true],
      ['list_export_jobs', 'read', true],
      ['list_export_items', 'read', true],
    ]);
    expect(Object.keys(MINIMAL_INPUT)).toEqual(pleoGatewayTools.map(tool => tool.name));
  });

  it('has a deeply frozen catalog with the upstream requests and the broad mark', () => {
    expect(Object.isFrozen(pleoToolCatalog)).toBe(true);
    for (const entry of pleoToolCatalog) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.inputSchema)).toBe(true);
      expect(Object.isFrozen(entry.upstream)).toBe(true);
      for (const op of entry.upstream) expect(Object.isFrozen(op)).toBe(true);
      expect(entry.broad).toBe(false);
      expect(entry.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(pleoToolCatalog.map(entry => entry.name)).toEqual(pleoGatewayTools.map(tool => tool.name));
    expect(pleoToolCatalog.map(entry => [entry.name, entry.upstream.map(op => `${op.method} ${op.path}`)])).toEqual([
      ['search_capabilities', []],
      ['check_connection', ['GET /v1/introspect']],
      ['introspect_auth', ['GET /v1/introspect']],
      ['search_companies', ['GET /v1/companies']],
      ['search_employees', ['GET /v2/employees']],
      ['search_vendors', ['POST /v1/vendors:search']],
      ['list_export_jobs', ['GET /v3/export-jobs']],
      ['list_export_items', ['GET /v3/export-items']],
    ]);
    expect(() => {
      (pleoToolCatalog[0] as { broad: boolean }).broad = true;
    }).toThrow();
    expect(() => {
      (pleoToolCatalog[1]!.upstream as unknown as GatewayJsonObject[]).push({ method: 'GET', path: '/v1/expenses' });
    }).toThrow();
  });

  it('matches the registered handlers: every catalog entry is a registered MCP tool', () => {
    const registered = new Set<string>();
    registerPleoTools(
      { registerTool: (name: string) => void registered.add(name) } as never,
      new PleoClient({ apiKey: 'schema-only-key', credentialEnv: {}, timeoutMs: 1 }),
    );
    for (const entry of pleoToolCatalog) expect(registered.has(`pleo_${entry.name}`), entry.name).toBe(true);
    // The free REST read and the write tools are registered on the MCP server but are not in the gateway.
    for (const name of ['rest_read', 'prepare_request', 'commit_prepared_request']) {
      expect(registered.has(`pleo_${name}`)).toBe(true);
      expect(pleoToolCatalog.map(entry => entry.name)).not.toContain(name);
    }
    const vendors = pleoToolCatalog.find(entry => entry.name === 'search_vendors')!;
    expect(vendors.inputSchema).toMatchObject({ required: ['companyId'] });
    expect(Object.keys(vendors.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(['companyId', 'name', 'codes', 'states', 'limit', 'after']),
    );
  });
});

describe('Pleo gateway credentials', () => {
  it('requires apiKey and never reads PLEO_API_KEY or PLEO_ACCESS_TOKEN', () => {
    expect(() => createPleoGateway({} as never)).toThrow(GatewayConfigError);
    expect(() => createPleoGateway(undefined as never)).toThrow(/requires options\.apiKey/);
    expect(() => createPleoGateway({ apiKey: '   ' })).toThrow(GatewayConfigError);
  });

  it('admits keys only of printable ASCII and at least 16 characters, before anything is sent', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => createPleoGateway({ apiKey: 'short7!', fetchImpl })).toThrow(/key was refused/);
    expect(() => createPleoGateway({ apiKey: '123456789012345', fetchImpl })).toThrow(/key was refused/);
    expect(() => createPleoGateway({ apiKey: 'Zq7pX2vK9mWb4TnRé', fetchImpl })).toThrow(/key was refused/);
    expect(() => createPleoGateway({ apiKey: 'Zq7pX2 vK9mWb4TnR8y', fetchImpl })).toThrow(/key was refused/);
    expect(() => createPleoGateway({ apiKey: 'Zq7pXsearch_vendors2vK', fetchImpl })).toThrow(/key was refused/);
    expect(() => createPleoGateway({ apiKey: '1234567890123456', fetchImpl })).not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses with a fixed text that holds no piece of the key, as a sealed error', () => {
    const key = 'Zq7pXsearch_vendors2vK';
    let caught: Error | undefined;
    try {
      createPleoGateway({ apiKey: key });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(GatewayConfigError);
    expect(caught!.stack).toBe(`${caught!.name}: ${caught!.message}`);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    for (let i = 0; i + 6 <= key.length; i += 1) expect(caught!.message).not.toContain(key.slice(i, i + 6));
  });

  it('uses the Pleo API with Basic auth of its own key, never the PLEO_* environment', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ authMethod: 'API_KEY' }));
    const gateway = createPleoGateway({ apiKey: KEY, fetchImpl });

    const result = await gateway.callTool('check_connection');

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, introspection: { authMethod: 'API_KEY' } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://external.pleo.io/v1/introspect');
    expect(init?.headers).toMatchObject({ Authorization: basic(KEY) });
    expect(JSON.stringify(init?.headers)).not.toContain('Bearer');
  });

  it('drops an access token a host passes anyway: the gateway has no OAuth path', async () => {
    const fetchImpl = okFetch();
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, accessToken: 'host-oauth-token-000' } as never);
    await gateway.callTool('search_companies');
    expect(fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: basic(KEY) });
  });

  it('accepts names with or without the prefix', async () => {
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: okFetch() });
    await expect(gateway.callTool('pleo_check_connection')).resolves.not.toHaveProperty('isError');
  });
});

describe('Pleo gateway upstream requests', () => {
  it('sends only the requests the catalog declares for each tool', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      seen.push(`${init?.method ?? 'GET'} ${decodeURIComponent(new URL(String(url)).pathname)}`);
      return jsonResponse({ data: [] });
    });
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    for (const entry of pleoToolCatalog) {
      seen.length = 0;
      const result = await gateway.callTool(entry.name, MINIMAL_INPUT[entry.name]);
      expect(result.isError, entry.name).toBeUndefined();
      const declared = entry.upstream.map(op => `${op.method} ${op.path}`);
      expect(seen.length, entry.name).toBe(declared.length === 0 ? 0 : 1);
      for (const request of seen) expect(declared, entry.name).toContain(request);
    }
  });

  it('lists only the tools the instance offers in search_capabilities', async () => {
    const gateway = createPleoGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(),
      policy: { disabledTools: ['list_export_items'] },
    });
    const result = await gateway.callTool('search_capabilities', { limit: 50 });
    const ids = (result.structuredContent as Array<{ id: string }>).map(entry => entry.id).sort();
    expect(ids).toEqual(
      pleoGatewayTools
        .map(tool => `pleo_${tool.name}`)
        .filter(name => name !== 'pleo_list_export_items')
        .sort(),
    );
  });
});

describe('Pleo gateway input', () => {
  it('validates input with the tool schema before anything is sent, and refuses unknown fields', async () => {
    const fetchImpl = okFetch();
    const { records, audit } = sink();
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { audit } });

    for (const [tool, input] of [
      ['search_vendors', {}],
      ['search_vendors', { companyId: 'not-a-uuid' }],
      ['search_employees', { apiKey: 'smuggled' }],
      ['check_connection', { anything: true }],
      ['list_export_jobs', { status: 'whatever' }],
    ] as const) {
      const result = await gateway.callTool(tool, input as never);
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]?.text, tool).toMatch(/^Invalid input for /);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => [record.action, record.reason])).toEqual(
      Array.from({ length: 5 }, () => ['rejected', 'invalid input']),
    );
  });

  it('returns an error for unsupported tools, also for MCP server tools outside the gateway', async () => {
    const fetchImpl = okFetch();
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });

    await expect(gateway.callTool('unknown_tool')).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Unsupported Pleo gateway tool: unknown_tool' }],
    });
    for (const name of ['rest_read', 'prepare_request', 'commit_prepared_request', 'get_company']) {
      const result = await gateway.callTool(name, { path: '/v1/companies' });
      expect(result.isError, name).toBe(true);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Pleo gateway policy', () => {
  it('under a host policy reads no policy or audit variables', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    vi.stubEnv('PLEO_ENABLE_WRITES', 'true');
    vi.stubEnv('PLEO_AUDIT_LOG', auditFile);
    vi.stubEnv('PLEO_POLICY_PATH', join(dir, 'missing-policy.json'));
    const { records, audit } = sink();
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: okFetch(), policy: { audit } });

    const result = await gateway.callTool('search_companies', {}, { caller: 'person-1', requestId: 'call-1' });

    expect(result.isError).toBeUndefined();
    expect(existsSync(auditFile)).toBe(false);
    expect(records.map(record => [record.tool, record.action, record.caller, record.requestId])).toEqual([
      ['pleo_search_companies', 'start', 'person-1', 'call-1'],
      ['pleo_search_companies', 'finish', 'person-1', 'call-1'],
    ]);
  });

  it('without a host policy uses the environment, like the MCP server', async () => {
    const auditFile = join(dir, 'audit.jsonl');
    vi.stubEnv('PLEO_AUDIT_LOG', auditFile);
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: okFetch() });
    await gateway.callTool('search_companies');
    expect(existsSync(auditFile)).toBe(true);
  });

  it('leaves out and refuses the tools the host disables, and refuses an unknown tool in the policy', async () => {
    const fetchImpl = okFetch();
    const { records, audit } = sink();
    const gateway = createPleoGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl,
      policy: { disabledTools: ['check_connection', 'pleo_list_export_items'], audit },
    });

    expect(gateway.tools.map(tool => tool.name)).not.toContain('check_connection');
    expect(gateway.tools.map(tool => tool.name)).not.toContain('list_export_items');
    expect(gateway.tools).toHaveLength(pleoGatewayTools.length - 2);
    const result = await gateway.callTool('check_connection');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disabled on this instance by the embedding host');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records.map(record => record.action)).toEqual(['policy_denied']);

    expect(() => createPleoGateway({ apiKey: KEY, policy: { disabledTools: ['rest_read'] } })).toThrow(
      GatewayConfigError,
    );
    expect(() => createPleoGateway({ apiKey: KEY, policy: { enableWrites: 'yes' as never } })).toThrow(
      GatewayConfigError,
    );
    expect(() => createPleoGateway({ apiKey: KEY, policy: { audit: 'file' as never } })).toThrow(GatewayConfigError);
  });

  it('does not run a tool whose start record the sink refuses', async () => {
    const fetchImpl = okFetch();
    const gateway = createPleoGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl,
      policy: {
        audit: () => {
          throw new Error('sink down');
        },
      },
    });
    const result = await gateway.callTool('search_companies');
    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Pleo gateway results', () => {
  it('puts the summary, then the data as compact JSON, in the text block, exactly the structured content', async () => {
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: okFetch() });
    const result = await gateway.callTool('search_companies', { limit: 5 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ data: [{ id: 'c1', name: 'Testfirma ApS' }] });
    expect(result.content).toHaveLength(1);
    const [summary, data, ...rest] = result.content[0]!.text.split('\n\n');
    expect(summary).toBe('Pleo companies.');
    expect(rest).toEqual([]);
    expect(data).toBe(JSON.stringify(result.structuredContent));
  });

  it('redacts the key from values, object keys, numbers and the Basic credential, in text and data', async () => {
    const numeric = '8273645190827364';
    const echo = (key: string) =>
      vi.fn<typeof fetch>(async () =>
        jsonResponse({
          data: [
            { id: 'e1', note: `key ${key}`, [`k-${key}`]: 'value', header: basic(key), piece: key.slice(3, 12) },
            { id: 'e2', number: Number(key) },
          ],
        }),
      );
    for (const key of [KEY, numeric]) {
      const gateway = createPleoGateway({ apiKey: key, baseUrl: BASE, fetchImpl: echo(key) });
      const result = await gateway.callTool('search_employees');
      expect(result.isError, key).toBeUndefined();
      const everything = JSON.stringify(result);
      for (const secret of [key, key.slice(3, 12), basic(key).slice(6)]) expect(everything, key).not.toContain(secret);
      expect(everything).toContain('‹redacted›');
      const [, data] = result.content[0]!.text.split('\n\n');
      expect(JSON.parse(data!)).toEqual(result.structuredContent);
    }
  });

  it('reduces failures nested in a successful answer to the status and our own text', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          { id: 'j1', status: 'completed' },
          { id: 'j2', error: { message: 'Vendor diagnostic text' } },
          { id: 'j3', status: 502, detail: 'Vendor diagnostic text' },
        ],
        errors: [{ code: 'Vendor diagnostic text', status: 409 }],
      }),
    );
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });
    const result = await gateway.callTool('list_export_jobs');
    expect(result.structuredContent).toEqual({
      data: [
        { id: 'j1', status: 'completed' },
        { error: 'Pleo reported a failure.' },
        { status: 502, error: 'Pleo reported a failure with HTTP 502.' },
      ],
      errors: [{ status: 409, message: 'Pleo reported a failure with HTTP 409.' }],
    });
    expect(JSON.stringify(result)).not.toContain('Vendor diagnostic');
  });
});

describe('Pleo gateway errors', () => {
  it('starts with the HTTP status in our own text and never carries the Pleo body', async () => {
    for (const [status, hint] of [
      [400, undefined],
      [401, 'The Pleo API key was rejected'],
      [403, 'no access'],
      [404, 'Pleo found nothing'],
      [429, 'throttling'],
      [500, undefined],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        jsonResponse({ message: `Vendor diagnostic for ${KEY}`, errors: ['Vendor diagnostic'] }, status, {
          'retry-after': '12',
          'x-request-id': 'vendor-request-id',
        }),
      );
      const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl });
      const result = await gateway.callTool('search_companies');
      expect(result.isError, String(status)).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = result.content[0]!.text;
      expect(text.startsWith(`Pleo API request failed with HTTP ${status}`), text).toBe(true);
      if (hint) expect(text).toContain(hint);
      expect(text).toContain('retry-after=12s');
      expect(text).not.toContain('Vendor diagnostic');
      expect(text).not.toContain('vendor-request-id');
      expect(text).not.toContain(KEY);
    }
  });

  it('refuses redirects and network failures in our own words, without the address or the cause', async () => {
    const redirect = createPleoGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }),
      ),
    });
    const redirected = await redirect.callTool('search_companies');
    expect(redirected.content[0]!.text).toMatch(/^Pleo API responded with a redirect \(HTTP 302\)/);
    expect(redirected.content[0]!.text).not.toContain('elsewhere');

    const network = createPleoGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(`connect to ${BASE} failed`), { code: 'ECONNREFUSED' }),
        });
      }),
    });
    const failed = await network.callTool('search_companies');
    expect(failed.content[0]!.text).toBe('Network error calling the Pleo API (GET) (ECONNREFUSED).');
  });

  it('does not quote a refused base URL', () => {
    let caught: Error | undefined;
    try {
      createPleoGateway({ apiKey: KEY, baseUrl: 'http://pleo.example.test/secret-path' });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(GatewayConfigError);
    expect(caught!.message).not.toContain('secret-path');
  });
});

describe('Pleo gateway redaction and call scopes', () => {
  it('redacts the key from every audit record field', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`key ${KEY} rejected`, { status: 401 }));
    const { records, audit } = sink();
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { audit } });

    const result = await gateway.callTool('check_connection', {}, { caller: `person ${KEY}`, requestId: KEY });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(records[0]?.caller).toBe('person ‹redacted›');
  });

  it('redacts an unknown tool name before cutting it short, so no part of the key is left', async () => {
    const { records, audit } = sink();
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: okFetch(), policy: { audit } });

    const result = await gateway.callTool(`${'x'.repeat(90)}${KEY}`);

    const everything = JSON.stringify([result, records]);
    for (const piece of [KEY, KEY.slice(0, 10), KEY.slice(0, 8)]) expect(everything).not.toContain(piece);
    expect(records.map(record => [record.action, record.reason])).toEqual([['rejected', 'unsupported tool']]);
  });

  it('keeps no process-wide registry: an instance key is not redacted outside its calls', async () => {
    const gateway = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl: okFetch() });
    await gateway.callTool('check_connection');
    expect(redactSecrets(`plain ${KEY}`)).toBe(`plain ${KEY}`);
  });

  it('keeps two tenants apart when they call at the same time', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const seen: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const authorization = String((init?.headers as Record<string, string>).Authorization);
      seen.push(authorization);
      await gate;
      // Pleo echoing the credential it received, in the data.
      return jsonResponse({
        data: [{ received: authorization, key: Buffer.from(authorization.slice(6), 'base64').toString() }],
      });
    });
    const a = sink();
    const b = sink();
    const gatewayA = createPleoGateway({ apiKey: KEY, baseUrl: BASE, fetchImpl, policy: { audit: a.audit } });
    const gatewayB = createPleoGateway({ apiKey: OTHER, baseUrl: BASE, fetchImpl, policy: { audit: b.audit } });

    const both = Promise.all([
      gatewayA.callTool('search_companies', {}, { caller: 'a' }),
      gatewayB.callTool('search_companies', {}, { caller: 'b' }),
    ]);
    for (let i = 0; i < 50 && seen.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect(seen.sort()).toEqual([basic(KEY), basic(OTHER)].sort());
    release();
    const [ra, rb] = await both;

    for (const [result, own] of [
      [ra, KEY],
      [rb, OTHER],
    ] as const) {
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(own);
      expect(JSON.stringify(result)).not.toContain(basic(own).slice(6));
    }
    expect(a.records.every(record => record.caller === 'a')).toBe(true);
    expect(b.records.every(record => record.caller === 'b')).toBe(true);
    expect(JSON.stringify(a.records)).not.toContain(KEY);
    expect(JSON.stringify(b.records)).not.toContain(OTHER);
  });

  it('runs a call made from inside another instance’s sink under its own scope, not the outer policy', async () => {
    const outer = sink();
    const innerFetch = okFetch();
    const inner = createPleoGateway({ apiKey: OTHER, baseUrl: BASE, fetchImpl: innerFetch });
    let innerResult: unknown;
    const gateway = createPleoGateway({
      apiKey: KEY,
      baseUrl: BASE,
      fetchImpl: okFetch(),
      policy: {
        disabledTools: ['search_companies'],
        audit: async record => {
          outer.audit(record);
          if (record.action === 'start' && innerResult === undefined) {
            innerResult = 'pending';
            innerResult = await inner.callTool('search_companies', {}, { caller: 'inner' });
          }
        },
      },
    });

    await gateway.callTool('check_connection', {}, { caller: 'outer' });

    // The inner instance has no policy: search_companies, disabled on the outer one, runs there.
    expect(innerResult).toMatchObject({ structuredContent: { data: [{ id: 'c1' }] } });
    expect(innerFetch).toHaveBeenCalledOnce();
    expect(outer.records.map(record => record.caller)).toEqual(['outer', 'outer']);
  });
});
