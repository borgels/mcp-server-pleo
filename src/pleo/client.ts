import { readEnvInteger } from '../config-env.js';
import { limitDepth, nestedFailuresAsStatus, PleoHttpError } from '../errors.js';
import { basicCredential, describeUrl, discardBody, isRedirect, registerSecret, SecretRedactor } from '../upstream-http.js';

/** Pleo's production external API. */
export const DEFAULT_BASE_URL = 'https://external.pleo.io';

export type PleoHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PleoClientOptions {
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Where a missing apiKey, accessToken or baseUrl is read from. Default
   * process.env (the MCP server). The gateway passes {}: an embedded instance
   * never reads credentials from the environment.
   */
  credentialEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * The instance's own redactor (the gateway). Without one the credentials
   * are redacted by the MCP server's process-wide redactor.
   */
  redactor?: SecretRedactor;
}

export interface PleoRequest {
  method: PleoHttpMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

export class PleoClient {
  private readonly apiKey?: string;
  private readonly accessToken?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  /** Redacts this client's credentials; the gateway runs every call with it in scope. */
  readonly redactor: SecretRedactor;

  constructor(options: PleoClientOptions = {}) {
    const env = options.credentialEnv ?? process.env;
    this.apiKey = options.apiKey ?? env.PLEO_API_KEY;
    this.accessToken = options.accessToken ?? env.PLEO_ACCESS_TOKEN;
    this.redactor = options.redactor ?? new SecretRedactor();
    for (const secret of [this.apiKey, this.apiKey ? basicCredential(this.apiKey) : undefined, this.accessToken]) {
      this.redactor.addSecret(secret);
      if (!options.redactor) {
        // The MCP server: its errors are redacted outside any call scope.
        registerSecret(secret);
      }
    }
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? env.PLEO_BASE_URL ?? DEFAULT_BASE_URL);
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? readEnvInteger('PLEO_TIMEOUT_MS', 30_000, { min: 1, max: 600_000 });
  }

  async get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return this.request<T>({ method: 'GET', path, query });
  }

  async post<T>(path: string, query?: Record<string, unknown>, body?: unknown): Promise<T> {
    return this.request<T>({ method: 'POST', path, query, body });
  }

  async put<T>(path: string, query?: Record<string, unknown>, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>({ method: 'PUT', path, query, body, idempotencyKey });
  }

  async request<T>(request: PleoRequest): Promise<T> {
    const authHeader = this.authorizationHeader();
    const url = this.url(request.path, request.query);
    const headers: Record<string, string> = {
      Accept: 'application/json;charset=UTF-8',
      Authorization: authHeader,
    };

    if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
    }

    if (request.idempotencyKey) {
      headers['Idempotency-Key'] = request.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        // Never follow redirects: credentials must only reach the configured API origin.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw transportError(error, request.method, this.timeoutMs);
    }

    if (isRedirect(response.status)) {
      // The Location is Pleo's text and is never quoted, and the address is configuration.
      await discardBody(response);
      throw new Error(
        `Pleo API responded with a redirect (HTTP ${response.status}) for ${request.method}; ` +
          'redirects are not followed, so credentials are never sent to another host. Check the configured base URL.',
      );
    }

    if (!response.ok) {
      // The body is Pleo's text: it is never read into an error, a result or an audit record.
      await discardBody(response);
      throw new PleoHttpError({
        status: response.status,
        method: request.method,
        url: describeUrl(url),
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('pleo-request-id') ?? undefined,
      });
    }

    // A failure reported inside a successful answer keeps only its status and our own text.
    return nestedFailuresAsStatus(await readResponseBody(response, request.method)) as T;
  }

  private authorizationHeader(): string {
    if (this.accessToken) {
      return `Bearer ${this.accessToken}`;
    }

    if (this.apiKey) {
      return `Basic ${basicCredential(this.apiKey)}`;
    }

    throw new Error('Missing Pleo credentials. Set PLEO_API_KEY or PLEO_ACCESS_TOKEN in the MCP server environment.');
  }

  private url(path: string, query: Record<string, unknown> = {}): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);

    for (const [key, value] of Object.entries(query)) {
      appendQueryValue(url.searchParams, key, value);
    }

    return url.toString();
  }
}

export interface PleoPaginationInput {
  before?: string;
  after?: string;
  offset?: number;
  limit?: number;
  sortingKeys?: string[];
  sortingOrder?: string[];
}

export function paginationQuery(input: PleoPaginationInput): Record<string, unknown> {
  return {
    before: input.before,
    after: input.after,
    offset: input.offset,
    limit: input.limit,
    sorting_keys: input.sortingKeys,
    sorting_order: input.sortingOrder,
  };
}

/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A network failure in our own words: only a system error code from a fixed list, never a message. */
function transportError(error: unknown, method: string, timeoutMs: number): Error {
  // The address is configuration and is not quoted.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return timeoutError(`Pleo API request timed out after ${timeoutMs} ms (${method}).`);
  }
  const code = error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
  const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
  return new Error(`Network error calling the Pleo API (${method})${shown}.`);
}

/** Our own text for a timeout, named TimeoutError so the audit records it as `timeout`. */
function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

/** Whether a content type is JSON: application/json or a +json type, with or without parameters. */
function isJsonContentType(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

/**
 * Reads a successful response body: JSON (depth-limited). Anything else (another content type, or JSON that does not
 * parse) is refused with a fixed text: it would reach the caller without the field masking that applies to data.
 */
async function readResponseBody(response: Response, method: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // Anything thrown while reading the body is replaced by our own text: its message is not ours.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw timeoutError(`Pleo API response timed out while it was being read (${method}).`);
    }
    throw new Error(`The Pleo API response could not be read (${method}).`);
  }

  if (!text) {
    return null;
  }

  if (!isJsonContentType(response.headers.get('content-type') ?? '')) {
    throw new Error(`Pleo API answered with a content type this server does not read (${method}).`);
  }

  try {
    // Depth-limited at once, so nothing downstream (a handler's JSON text, the gateway) can exhaust the stack.
    return limitDepth(JSON.parse(text) as unknown);
  } catch {
    throw new Error(`Pleo API answered with JSON that could not be read (${method}).`);
  }
}

function appendQueryValue(searchParams: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(searchParams, key, item);
    }
    return;
  }

  searchParams.append(key, String(value));
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

function assertSafeBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // The value is not quoted: configuration is never echoed.
    throw new Error('The Pleo base URL is not a valid URL.');
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    'Refusing to send Pleo credentials over a connection that is not https. Use https:// (loopback http:// is allowed for local mocks).',
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
