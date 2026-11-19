// The sink check (README, "Embedding"): nothing that leaves a gateway holds a piece of 6 characters of the key or of
// the Basic credential built from it. Every output is checked in its final form; known counterexamples and keys
// spliced from real outputs.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPleoGateway } from '../src/gateway.js';
import { nestedFailuresAsStatus } from '../src/errors.js';
import { visibleTexts } from '../src/key-admission.js';

const BASE = 'https://pleo.example.test';
let dir: string;

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const name of ['PLEO_ENABLE_WRITES', 'PLEO_AUDIT_LOG', 'PLEO_POLICY_PATH', 'PLEO_TIMEOUT_MS']) {
    vi.stubEnv(name, '');
  }
  dir = mkdtempSync(join(tmpdir(), 'pleo-sink-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const upstream: typeof fetch = async url => {
  const path = new URL(String(url)).pathname;
  if (path === '/v1/introspect') return json({ authMethod: 'API_KEY', scope: 'companies:read employees:read' });
  if (path === '/v1/companies') return json({ data: [{ id: 'c1', name: 'Testfirma ApS' }], pagination: { hasNextPage: false } });
  return json({ message: 'not found' }, 404);
};

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  const basic = Buffer.from(`${key}:`, 'utf8').toString('base64');
  return [...pieces(key), ...pieces(basic)].filter(piece => texts.some(text => text.includes(piece)));
}

/** Every output of a normal session with this key, or the refusal when it is not admitted. */
async function outputs(apiKey: string, viaFile = false): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  const auditPath = join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  if (viaFile) vi.stubEnv('PLEO_AUDIT_LOG', auditPath);
  let gw: ReturnType<typeof createPleoGateway>;
  try {
    gw = createPleoGateway({
      apiKey,
      baseUrl: BASE,
      timeoutMs: 5_000,
      fetchImpl: upstream,
      ...(viaFile ? {} : { policy: { audit: (record: Record<string, unknown>) => void records.push(record) } }),
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('check_connection', {}, { caller: 'person-1', requestId: 'r1' }),
    await gw.callTool('search_companies', { limit: 5 }),
    await gw.callTool('search_capabilities', { query: 'export' }),
    await gw.callTool('list_export_items', {}),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('check_connection', { unknown: 1 }),
  ];
  let lines = '';
  try {
    lines = readFileSync(auditPath, 'utf8');
  } catch {
    lines = '';
  }
  return { outputs: [gw.tools, ...results, ...records, lines] };
}

describe('the sink check', () => {
  it('holds for known counterexamples, through the audit sink and the audit file', async () => {
    for (const apiKey of [
      'qz7":"staV8k2mP9',
      'x"ok":y-0123456789',
      'riskLevelQz7pX2vK9mWb',
      'Zq7pX2visError9mWb4TnR',
      'URI malformedQz7pX2vK9mWb\uD800',
      'x"ok": y-0123456789',
      'Qz7pX2vK9"data":[{"id"',
    ]) {
      for (const viaFile of [false, true]) {
        const { refused, outputs: seen } = await outputs(apiKey, viaFile);
        if (refused !== undefined) expect(refused, apiKey).toMatch(/key was refused/);
        expect(leaked(apiKey, seen), `${apiKey} ${viaFile}`).toEqual([]);
      }
    }
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('Zq7pX2vK9mWb4TnR8yLc3HdJ6fGs1QeU', true);
    expect(base.refused).toBeUndefined();
    const texts = base.outputs
      .flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)))
      .filter(text => text.length >= 6);
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 40; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiKey = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiKey, round % 2 === 0);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiKey, seen), apiKey).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });

  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [apiKey, baseUrl] of [
      ['Qz7way.jsV8k2mP9X', 'invalid'],
      ['Qz7way.tsV8k2mP9X', 'invalid'],
      ['short', 'invalid'],
    ] as const) {
      let caught: Error | undefined;
      try {
        createPleoGateway({ apiKey, baseUrl, timeoutMs: 1_000, policy: {} });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiKey).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(apiKey, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });
});

describe('failure texts', () => {
  it('replaces texts in failure lists inside the data, and keeps texts elsewhere', () => {
    expect(
      nestedFailuresAsStatus({ data: { failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'], amount: '12.00', name: 'kept' } }),
    ).toEqual({
      data: {
        failures: [{ message: 'Pleo reported a failure.' }],
        errors: [{ message: 'Pleo reported a failure.' }],
        amount: '12.00',
        name: 'kept',
      },
    });
  });

  it('reduces every element of a failure list, whatever its fields, also below a wrapper', () => {
    expect(
      nestedFailuresAsStatus({ data: { failures: [{ reason: 'Vendor diagnostic' }], errors: [{ code: 'Vendor diagnostic', status: 409 }] } }),
    ).toEqual({
      data: {
        failures: [{ message: 'Pleo reported a failure.' }],
        errors: [{ status: 409, message: 'Pleo reported a failure with HTTP 409.' }],
      },
    });
  });
});
