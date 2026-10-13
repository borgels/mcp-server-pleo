import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { PleoClient } from '../src/pleo/client.js';
import {
  assertAllowedReadPath,
  hashPreparedRequest,
  pathParam,
  preparePleoRequest,
  verifyPreparedRequest,
  type PreparedPleoRequest,
} from '../src/pleo/requests.js';
import { assertAuthorized, HttpRequestError } from '../src/transports/http-helpers.js';

const originalEnv = { ...process.env };
const JOB_ID = '00000000-0000-0000-0000-000000000000';

function prepareExportItems(): PreparedPleoRequest {
  return preparePleoRequest({
    method: 'PUT',
    path: `/v3/export-jobs/${JOB_ID}/items`,
    body: { items: [] },
    reason: 'ERP export completed',
  });
}

function resign(prepared: PreparedPleoRequest): PreparedPleoRequest {
  return { ...prepared, operationHash: hashPreparedRequest(prepared) };
}

describe('prepared request integrity', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('accepts an untouched prepared request and returns the derived operation', () => {
    const prepared = prepareExportItems();
    expect(prepared.expiresAt).toBeTruthy();
    const verified = verifyPreparedRequest(prepared, prepared.operationHash);
    expect(verified.operation).toBe('PUT /v3/export-jobs/:id/items');
  });

  it('rejects a prepared request whose path was changed after preparation', () => {
    const prepared = prepareExportItems();
    const tampered = { ...prepared, path: '/v1/webhook-subscriptions' };
    expect(() => verifyPreparedRequest(tampered, prepared.operationHash)).toThrow(/hash mismatch/);
  });

  it('rejects a hash recomputed without the server secret', () => {
    const prepared = prepareExportItems();
    const { operationHash: _ignored, ...payload } = { ...prepared, path: '/v1/webhook-subscriptions' };
    const unkeyed = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const forged = { ...prepared, path: '/v1/webhook-subscriptions', operationHash: unkeyed };
    expect(() => verifyPreparedRequest(forged, unkeyed)).toThrow(/hash mismatch/);
  });

  it('rejects a request signed by a server with a different secret', () => {
    process.env.PLEO_PREPARE_SECRET = 'secret-one';
    const prepared = prepareExportItems();
    process.env.PLEO_PREPARE_SECRET = 'secret-two';
    expect(() => verifyPreparedRequest(prepared, prepared.operationHash)).toThrow(/hash mismatch/);
  });

  it('rejects a mismatched confirmation hash', () => {
    const prepared = prepareExportItems();
    expect(() => verifyPreparedRequest(prepared, 'a'.repeat(64))).toThrow(/hash mismatch/);
  });

  it('re-derives the operation from method and path instead of trusting the supplied string', () => {
    const prepared = resign({
      ...prepareExportItems(),
      path: '/v1/webhook-subscriptions',
      operation: 'PUT /v3/export-jobs/:id/items',
    });
    expect(() => verifyPreparedRequest(prepared, prepared.operationHash)).toThrow(/does not match/);
  });

  it('re-runs the write allowlist on the derived operation', () => {
    const prepared = resign({
      ...prepareExportItems(),
      method: 'POST',
      path: '/v1/webhook-subscriptions',
      operation: 'POST /v1/webhook-subscriptions',
    });
    expect(() => verifyPreparedRequest(prepared, prepared.operationHash)).toThrow(/not allowlisted/);
  });

  it('rejects expired prepared requests', () => {
    const prepared = prepareExportItems();
    const later = new Date(Date.parse(prepared.expiresAt) + 1000);
    expect(() => verifyPreparedRequest(prepared, prepared.operationHash, later)).toThrow(/expired/);
  });

  it.each([
    `/v3/export-jobs/${JOB_ID}/items?x=1`,
    `/v3/export-jobs/${JOB_ID}/items#frag`,
    `/v3/export-jobs/${JOB_ID}/../items`,
    `/v3/export-jobs/${JOB_ID}/%2e%2e/items`,
    `/v3/export-jobs/${JOB_ID}%2Fitems`,
  ])('rejects unsafe paths at prepare and commit: %s', path => {
    expect(() => preparePleoRequest({ method: 'PUT', path, reason: 'x' })).toThrow(/disallowed/);
    const prepared = resign({ ...prepareExportItems(), path });
    expect(() => verifyPreparedRequest(prepared, prepared.operationHash)).toThrow();
  });

  it('allowlists vendor action operations with an id', () => {
    const prepared = preparePleoRequest({
      method: 'POST',
      path: `/v1/vendors/${JOB_ID}:archive`,
      reason: 'cleanup',
    });
    expect(prepared.operation).toBe('POST /v1/vendors/:id:archive');
  });
});

describe('path guards', () => {
  it('rejects unsafe read paths', () => {
    expect(() => assertAllowedReadPath('/v3/export-items?x=1')).toThrow(/disallowed/);
    expect(() => assertAllowedReadPath('/v1/companies/../v1/expenses')).toThrow(/disallowed/);
  });

  it.each(['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', '%2e%2e', 'a%2Fb'])('rejects path parameter %j', value => {
    expect(() => pathParam(value)).toThrow(/Invalid path parameter/);
  });

  it('encodes safe path parameters', () => {
    expect(pathParam(JOB_ID)).toBe(JOB_ID);
    expect(pathParam('a b')).toBe('a%20b');
  });
});

describe('client base URL handling', () => {
  it('trims trailing slashes in linear time', () => {
    const start = Date.now();
    const client = new PleoClient({ apiKey: 'k', baseUrl: `https://external.pleo.io${'/'.repeat(50_000)}` });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(client).toBeInstanceOf(PleoClient);
  });
});

describe('HTTP bearer token', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects wrong or differently sized tokens without throwing type errors', () => {
    process.env.MCP_HTTP_TOKEN = 'secret';
    for (const authorization of ['Bearer secreT', 'Bearer s', 'Bearer secret-longer', '']) {
      expect(() => assertAuthorized({ headers: { authorization } } as never)).toThrow(HttpRequestError);
    }
    expect(() => assertAuthorized({ headers: { authorization: 'Bearer secret' } } as never)).not.toThrow();
  });
});
