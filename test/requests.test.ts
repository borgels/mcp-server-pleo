import { describe, expect, it } from 'vitest';
import {
  assertAllowedReadPath,
  assertPreparedRequestHash,
  operationPattern,
  preparePleoRequest,
} from '../src/pleo/requests.js';

describe('Pleo request guards', () => {
  it('normalizes UUID paths into operation patterns', () => {
    expect(operationPattern('/v3/export-jobs/00000000-0000-0000-0000-000000000000/items')).toBe(
      '/v3/export-jobs/:id/items',
    );
  });

  it('allowlists current read paths and rejects legacy or unknown reads', () => {
    expect(() => assertAllowedReadPath('/v3/export-items')).not.toThrow();
    expect(() => assertAllowedReadPath('/v2/employees/00000000-0000-0000-0000-000000000000')).not.toThrow();
    expect(() => assertAllowedReadPath('/v1/expenses')).toThrow(/not allowlisted/);
    expect(() => assertAllowedReadPath('/v1/accounts')).toThrow(/not allowlisted/);
  });

  it('prepares allowlisted write requests with a stable hash', () => {
    const prepared = preparePleoRequest({
      method: 'PUT',
      path: '/v3/export-jobs/00000000-0000-0000-0000-000000000000/items',
      body: { items: [{ accountingEntryId: 'entry', status: 'successful' }] },
      reason: 'ERP export completed',
    });

    expect(prepared.operation).toBe('PUT /v3/export-jobs/:id/items');
    expect(prepared.operationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertPreparedRequestHash(prepared, prepared.operationHash)).not.toThrow();
  });

  it('rejects read methods and unallowlisted write operations', () => {
    expect(() =>
      preparePleoRequest({
        method: 'GET',
        path: '/v3/export-items',
        reason: 'not a write',
      }),
    ).toThrow(/POST, PUT, and PATCH/);

    expect(() =>
      preparePleoRequest({
        method: 'POST',
        path: '/v1/webhook-subscriptions',
        reason: 'not in first release',
      }),
    ).toThrow(/not allowlisted/);
  });
});
