import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRequestPolicy, checkToolPolicy } from '../src/pleo/policy.js';
import { preparePleoRequest } from '../src/pleo/requests.js';

const originalEnv = { ...process.env };
let tempDir: string;

describe('Pleo policy', () => {
  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempDir = await mkdtemp(join(tmpdir(), 'pleo-policy-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it('allows read and dry-run tools without write opt-in', () => {
    expect(checkToolPolicy('pleo_list_export_items')).toMatchObject({ allowed: true });
    expect(checkToolPolicy('pleo_prepare_request')).toMatchObject({ allowed: true });
  });

  it('blocks commit tools unless writes are enabled', () => {
    expect(checkToolPolicy('pleo_commit_prepared_request')).toMatchObject({ allowed: false });
    process.env.PLEO_ENABLE_WRITES = 'true';
    expect(checkToolPolicy('pleo_commit_prepared_request')).toMatchObject({ allowed: true });
  });

  it('applies policy allowlists and body size limits', async () => {
    process.env.PLEO_ENABLE_WRITES = 'true';
    const policyPath = join(tempDir, 'policy.json');
    process.env.PLEO_POLICY_PATH = policyPath;
    await writeFile(
      policyPath,
      JSON.stringify({
        writesEnabled: true,
        allowedOperations: ['PUT /v3/export-jobs/:id/items'],
        maxBodyBytes: 1000,
      }),
    );

    const prepared = preparePleoRequest({
      method: 'PUT',
      path: '/v3/export-jobs/00000000-0000-0000-0000-000000000000/items',
      body: { items: [{ status: 'successful' }] },
      reason: 'ERP export completed',
    });

    await expect(checkRequestPolicy(prepared)).resolves.toMatchObject({ allowed: true });
  });

  it('rejects operations denied by policy', async () => {
    process.env.PLEO_ENABLE_WRITES = 'true';
    const policyPath = join(tempDir, 'policy.json');
    process.env.PLEO_POLICY_PATH = policyPath;
    await writeFile(
      policyPath,
      JSON.stringify({
        writesEnabled: true,
        allowedOperations: ['POST /v3/export-job-events'],
      }),
    );

    const prepared = preparePleoRequest({
      method: 'PUT',
      path: '/v3/export-jobs/00000000-0000-0000-0000-000000000000/items',
      reason: 'ERP export completed',
    });

    await expect(checkRequestPolicy(prepared)).resolves.toMatchObject({ allowed: false });
  });
});
