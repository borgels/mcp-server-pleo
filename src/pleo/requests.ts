import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PleoHttpMethod } from './client.js';

export interface PreparedPleoRequest {
  type: 'pleo_prepared_request';
  createdAt: string;
  expiresAt: string;
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
  assertSafeRequestPath(path);
  const operation = `${method} ${operationPattern(path)}`;
  assertAllowedWriteOperation(operation);

  const createdAt = new Date();
  const preparedWithoutHash = {
    type: 'pleo_prepared_request' as const,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + PREPARED_REQUEST_TTL_MS).toISOString(),
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

/**
 * Verify a prepared request at commit time. The request must carry a valid
 * HMAC signature from this server, match the confirmation hash, be unexpired,
 * and its operation is re-derived from method + path and re-checked against
 * the write allowlist. Returns the request with the derived operation.
 */
export function verifyPreparedRequest(
  prepared: PreparedPleoRequest,
  confirmOperationHash: string,
  now: Date = new Date(),
): PreparedPleoRequest {
  const expected = Buffer.from(hashPreparedRequest(prepared), 'hex');
  const given = Buffer.from(String(prepared.operationHash ?? ''), 'hex');
  const confirm = Buffer.from(String(confirmOperationHash ?? ''), 'hex');
  if (
    expected.length !== given.length ||
    !timingSafeEqual(expected, given) ||
    expected.length !== confirm.length ||
    !timingSafeEqual(expected, confirm)
  ) {
    throw new Error('Prepared request hash mismatch. Re-run preparation and inspect the operation.');
  }

  const expiresAt = Date.parse(prepared.expiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    throw new Error('Prepared request has expired (15 minutes). Re-run preparation.');
  }

  const method = String(prepared.method).toUpperCase();
  if (!isWritableMethod(method)) {
    throw new Error('Prepared Pleo requests only support POST, PUT, and PATCH.');
  }

  const path = normalizePath(prepared.path);
  assertSafeRequestPath(path);
  const operation = `${method} ${operationPattern(path)}`;
  if (operation !== prepared.operation) {
    throw new Error('Prepared request operation does not match its method and path.');
  }
  assertAllowedWriteOperation(operation);

  return { ...prepared, method, path, operation };
}

/** @deprecated Use verifyPreparedRequest, which also re-derives the operation. */
export function assertPreparedRequestHash(prepared: PreparedPleoRequest, confirmOperationHash: string): void {
  verifyPreparedRequest(prepared, confirmOperationHash);
}

export function assertAllowedReadPath(path: string): void {
  const normalized = normalizePath(path);
  assertSafeRequestPath(normalized);
  const pattern = operationPattern(normalized);
  const allowed = READ_PATH_PATTERNS.some(candidate => candidate === pattern);
  if (!allowed) {
    throw new Error(`Pleo read path is not allowlisted: ${path}`);
  }
}

/**
 * Reject paths that could change meaning after URL parsing: query/fragment
 * delimiters, dot segments, backslashes, and encoded dots or slashes.
 */
export function assertSafeRequestPath(path: string): void {
  if (/[?#\\]/.test(path) || /%2e|%2f|%5c/i.test(path) || path.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new Error('Pleo request path contains disallowed characters or segments.');
  }
}

/**
 * Guard and encode one caller-supplied path parameter.
 */
export function pathParam(value: string): string {
  const text = String(value);
  if (
    text === '' ||
    text === '.' ||
    text === '..' ||
    /[/\\?#]/.test(text) ||
    /%2e|%2f|%5c/i.test(text)
  ) {
    throw new Error('Invalid path parameter.');
  }
  return encodeURIComponent(text);
}

export function hashPreparedRequest(
  prepared: Omit<PreparedPleoRequest, 'operationHash'> | PreparedPleoRequest,
): string {
  const { operationHash: _operationHash, ...payload } = prepared as PreparedPleoRequest;
  return createHmac('sha256', prepareSecret()).update(stableJson(payload)).digest('hex');
}

const PREPARED_REQUEST_TTL_MS = 15 * 60 * 1000;
const processSecret = randomBytes(32);

function prepareSecret(): Buffer {
  const configured = process.env.PLEO_PREPARE_SECRET;
  return configured ? Buffer.from(configured, 'utf8') : processSecret;
}

export function normalizePath(path: string): string {
  if (!path.startsWith('/')) {
    return `/${path}`;
  }

  return path;
}

export function operationPattern(path: string): string {
  return normalizePath(path).replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=[/:]|$)/gi,
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
