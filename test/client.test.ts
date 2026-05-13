import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUnknownError, PleoHttpError, redactSecrets } from '../src/errors.js';
import { PleoClient } from '../src/pleo/client.js';

const originalTimeout = process.env.PLEO_TIMEOUT_MS;

describe('PleoClient', () => {
  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.PLEO_TIMEOUT_MS;
    } else {
      process.env.PLEO_TIMEOUT_MS = originalTimeout;
    }
  });

  it('sends standalone API keys using Basic auth', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { ok: true } }));
    const client = new PleoClient({
      apiKey: 'pleo-api-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/v1/introspect');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: 'application/json;charset=UTF-8',
      Authorization: `Basic ${Buffer.from('pleo-api-key:', 'utf8').toString('base64')}`,
    });
  });

  it('prefers OAuth access tokens using Bearer auth when configured', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { ok: true } }));
    const client = new PleoClient({
      apiKey: 'pleo-api-key',
      accessToken: 'oauth-token',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/v1/introspect');

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer oauth-token',
    });
  });

  it('serializes repeated array query parameters', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: [] }));
    const client = new PleoClient({
      apiKey: 'pleo-api-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/v3/export-items', { sorting_keys: ['date', 'type'], limit: 20 });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('sorting_keys=date');
    expect(url).toContain('sorting_keys=type');
    expect(url).toContain('limit=20');
  });

  it('includes retry-after and request id guidance for HTTP failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ message: 'Too many requests' }, 429, {
        'retry-after': '12',
        'x-request-id': 'req-123',
      }),
    );
    const client = new PleoClient({
      apiKey: 'pleo-api-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.get('/v1/introspect')).rejects.toThrow(/retry-after=12s/);

    try {
      await client.get('/v1/introspect');
    } catch (error) {
      expect(error).toBeInstanceOf(PleoHttpError);
      expect((error as PleoHttpError).requestId).toBe('req-123');
    }
  });

  it('redacts credential material from formatted errors', () => {
    expect(redactSecrets('Authorization: Bearer secret-test-token')).toBe('Authorization: [REDACTED]');
    expect(redactSecrets('Authorization: Basic secret-test-token')).toBe('Authorization: [REDACTED]');
    expect(formatUnknownError(new Error('PLEO_API_KEY=secret-test-token'))).toBe(
      'PLEO_API_KEY= [REDACTED]',
    );
  });

  it('uses PLEO_TIMEOUT_MS when timeout is not passed explicitly', async () => {
    process.env.PLEO_TIMEOUT_MS = '1234';
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ data: { ok: true } }));
    const client = new PleoClient({
      apiKey: 'pleo-api-key',
      baseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.get('/v1/introspect');

    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });

  it('fails clearly when credentials are missing', async () => {
    const client = new PleoClient({
      apiKey: '',
      accessToken: '',
      baseUrl: 'https://example.test',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    await expect(client.get('/v1/introspect')).rejects.toThrow('Missing Pleo credentials');
  });

  it('refuses non-https base URLs to protect credentials', () => {
    expect(
      () =>
        new PleoClient({
          apiKey: 'pleo-api-key',
          baseUrl: 'http://external.pleo.io',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/https/);
  });

  it('allows http:// for loopback mocks', () => {
    expect(
      () =>
        new PleoClient({
          apiKey: 'pleo-api-key',
          baseUrl: 'http://localhost:8080',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).not.toThrow();
  });
});

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}
