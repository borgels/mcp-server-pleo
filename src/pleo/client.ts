import { PleoHttpError } from '../errors.js';

export type PleoHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PleoClientOptions {
  apiKey?: string;
  accessToken?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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

  constructor(options: PleoClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.PLEO_API_KEY;
    this.accessToken = options.accessToken ?? process.env.PLEO_ACCESS_TOKEN;
    this.baseUrl = trimTrailingSlash(
      options.baseUrl ?? process.env.PLEO_BASE_URL ?? 'https://external.pleo.io',
    );
    assertSafeBaseUrl(this.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.PLEO_TIMEOUT_MS ?? 30_000);
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

    const response = await this.fetchImpl(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const responseBody = await readResponseBody(response);

    if (!response.ok) {
      throw new PleoHttpError({
        status: response.status,
        method: request.method,
        url,
        payload: responseBody,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        requestId:
          response.headers.get('x-request-id') ??
          response.headers.get('pleo-request-id') ??
          undefined,
        fallbackMessage: typeof responseBody === 'string' ? responseBody : undefined,
      });
    }

    return responseBody as T;
  }

  private authorizationHeader(): string {
    if (this.accessToken) {
      return `Bearer ${this.accessToken}`;
    }

    if (this.apiKey) {
      return `Basic ${Buffer.from(`${this.apiKey}:`, 'utf8').toString('base64')}`;
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

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
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
    throw new Error(`PLEO_BASE_URL is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send Pleo credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
