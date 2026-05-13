import { readFile } from 'node:fs/promises';
import type { PreparedPleoRequest } from './requests.js';

export interface PleoPolicy {
  writesEnabled?: boolean;
  allowedOperations?: string[];
  deniedOperationPatterns?: string[];
  maxBodyBytes?: number;
}

export interface PleoPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_READ_TOOLS = new Set([
  'pleo_search_capabilities',
  'pleo_check_connection',
  'pleo_introspect_auth',
  'pleo_search_companies',
  'pleo_get_company',
  'pleo_search_employees',
  'pleo_get_employee',
  'pleo_search_accounts',
  'pleo_search_vendors',
  'pleo_get_vendor',
  'pleo_list_export_jobs',
  'pleo_get_export_job',
  'pleo_list_export_job_items',
  'pleo_list_export_items',
  'pleo_rest_read',
  'pleo_prepare_request',
]);

export function checkToolPolicy(toolName: string): PleoPolicyDecision {
  if (ALLOWED_READ_TOOLS.has(toolName)) {
    return { allowed: true, reason: 'read-only or dry-run Pleo tool' };
  }

  if (toolName === 'pleo_commit_prepared_request') {
    return checkWritesEnabled();
  }

  return { allowed: false, reason: `tool is not allowlisted: ${toolName}` };
}

export async function checkRequestPolicy(
  prepared: PreparedPleoRequest,
): Promise<PleoPolicyDecision> {
  const writesDecision = checkWritesEnabled();
  if (!writesDecision.allowed) {
    return writesDecision;
  }

  const policy = await readPolicy();
  if (policy.writesEnabled === false) {
    return { allowed: false, reason: 'policy file disables writes' };
  }

  const bodyBytes = prepared.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(prepared.body), 'utf8');
  if (policy.maxBodyBytes !== undefined && bodyBytes > policy.maxBodyBytes) {
    return {
      allowed: false,
      reason: `request body exceeds policy maxBodyBytes=${policy.maxBodyBytes}`,
    };
  }

  for (const pattern of policy.deniedOperationPatterns ?? []) {
    const regex = new RegExp(pattern);
    if (regex.test(prepared.operation)) {
      return { allowed: false, reason: `operation denied by policy pattern: ${pattern}` };
    }
  }

  if (policy.allowedOperations?.length) {
    const allowed = new Set(policy.allowedOperations);
    if (!allowed.has(prepared.operation)) {
      return { allowed: false, reason: `operation not allowlisted: ${prepared.operation}` };
    }
  }

  return { allowed: true, reason: 'request allowed by Pleo write policy' };
}

async function readPolicy(): Promise<PleoPolicy> {
  const policyPath = process.env.PLEO_POLICY_PATH;
  if (!policyPath) {
    return {};
  }

  const text = await readFile(policyPath, 'utf8');
  return JSON.parse(text) as PleoPolicy;
}

function checkWritesEnabled(): PleoPolicyDecision {
  if (process.env.PLEO_ENABLE_WRITES !== 'true') {
    return {
      allowed: false,
      reason: 'writes are disabled. Set PLEO_ENABLE_WRITES=true to permit commit tools.',
    };
  }

  return { allowed: true, reason: 'writes enabled by environment' };
}
