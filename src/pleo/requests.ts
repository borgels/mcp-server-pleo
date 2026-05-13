import { createHash } from 'node:crypto';
import type { PleoHttpMethod } from './client.js';

export interface PreparedPleoRequest {
  type: 'pleo_prepared_request';
  createdAt: string;
  method: Exclude<PleoHttpMethod, 'GET' | 'DELETE'>;
  path: string;
  query: Record<string, unknown>;
  body?: unknown;
  reason: string;
  operation: string;
  operationHash: string;
}

export function preparePleoRequest(input: {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  reason: string;
}): PreparedPleoRequest {
  const method = input.method.toUpperCase();
  if (!isWritableMethod(method)) {
    throw new Error('Prepared Pleo requests only support POST, PUT, and PATCH.');
  }

  const path = normalizePath(input.path);
  const operation = `${method} ${operationPattern(path)}`;
  assertAllowedWriteOperation(operation);

  const preparedWithoutHash = {
    type: 'pleo_prepared_request' as const,
    createdAt: new Date().toISOString(),
    method,
    path,
    query: input.query ?? {},
    body: input.body,
    reason: input.reason,
    operation,
  };

  return {
    ...preparedWithoutHash,
    operationHash: hashPreparedRequest(preparedWithoutHash),
  };
}

export function assertPreparedRequestHash(prepared: PreparedPleoRequest, confirmOperationHash: string): void {
  const actualHash = hashPreparedRequest(prepared);
  if (actualHash !== prepared.operationHash || actualHash !== confirmOperationHash) {
    throw new Error('Prepared request hash mismatch. Re-run preparation and inspect the operation.');
  }
}

export function assertAllowedReadPath(path: string): void {
  const pattern = operationPattern(normalizePath(path));
  const allowed = READ_PATH_PATTERNS.some(candidate => candidate === pattern);
  if (!allowed) {
    throw new Error(`Pleo read path is not allowlisted: ${path}`);
  }
}

export function hashPreparedRequest(
  prepared: Omit<PreparedPleoRequest, 'operationHash'> | PreparedPleoRequest,
): string {
  const { operationHash: _operationHash, ...payload } = prepared as PreparedPleoRequest;
  return stableHash(payload);
}

export function normalizePath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }

  return path;
}

export function operationPattern(path: string): string {
  return normalizePath(path).replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi,
    '/:id',
  );
}

const READ_PATH_PATTERNS = [
  '/v1/introspect',
  '/v1/companies',
  '/v1/companies/:id',
  '/v2/employees',
  '/v2/employees/:id',
  '/v1/vendors/:id',
  '/v3/export-jobs',
  '/v3/export-jobs/:id',
  '/v3/export-jobs/:id/items',
  '/v3/export-items',
];

const WRITE_OPERATIONS = new Set([
  'POST /v1/chart-of-accounts:search',
  'POST /v1/vendors:search',
  'POST /v3/export-jobs',
  'POST /v3/export-job-events',
  'PUT /v3/export-jobs/:id/items',
  'POST /v1/vendors',
  'PUT /v1/vendors/:id',
  'POST /v1/vendors/:id:activate',
  'POST /v1/vendors/:id:archive',
]);

function assertAllowedWriteOperation(operation: string): void {
  if (!WRITE_OPERATIONS.has(operation)) {
    throw new Error(`Pleo write operation is not allowlisted: ${operation}`);
  }
}

function isWritableMethod(method: string): method is PreparedPleoRequest['method'] {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
