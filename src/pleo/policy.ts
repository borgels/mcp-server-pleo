import { readFile } from 'node:fs/promises';
import type { PreparedPleoRequest } from './requests.js';
import { currentInstancePolicy } from './scope.js';

/*
 * Outside a gateway call (the MCP server) the policy comes from the
 * environment: PLEO_ENABLE_WRITES and PLEO_POLICY_PATH. Inside a gateway call
 * under a host's InstancePolicy (src/pleo/scope.ts) neither is read: writes
 * follow policy.enableWrites, tools in policy.disabledTools are refused, and
 * refusals are worded for the host.
 */

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
  const hosted = currentInstancePolicy();
  if (hosted?.disabledTools.has(toolName)) {
    return { allowed: false, reason: `tool is disabled on this instance by the embedding host: ${toolName}` };
  }

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
  if (currentInstancePolicy()) {
    // Under a host's policy the host decides; no file is read from the environment.
    return {};
  }
  const policyPath = process.env.PLEO_POLICY_PATH;
  if (!policyPath) {
    return {};
  }

  const text = await readFile(policyPath, 'utf8');
  return JSON.parse(text) as PleoPolicy;
}

/** Whether write tools may run on the instance whose call is in progress. */
export function writesEnabled(): boolean {
  const hosted = currentInstancePolicy();
  return hosted ? hosted.enableWrites : process.env.PLEO_ENABLE_WRITES === 'true';
}

function checkWritesEnabled(): PleoPolicyDecision {
  if (currentInstancePolicy()) {
    return writesEnabled()
      ? { allowed: true, reason: 'writes enabled by the embedding host' }
      : { allowed: false, reason: 'writes are disabled. The embedding host has not enabled writes for this instance.' };
  }

  if (process.env.PLEO_ENABLE_WRITES !== 'true') {
    return {
      allowed: false,
      reason: 'writes are disabled. Set PLEO_ENABLE_WRITES=true to permit commit tools.',
    };
  }

  return { allowed: true, reason: 'writes enabled by environment' };
}
